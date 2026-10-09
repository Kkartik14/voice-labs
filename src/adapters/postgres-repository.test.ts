import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createLabService } from "../application/service.js";
import { DeterministicRunner } from "./deterministic-runner.js";
import { createSeedState } from "./seed.js";
import { PostgresRepository } from "./postgres-repository.js";
import { MAX_CONCURRENT_PROVIDER_RUNS, MAX_PROJECT_CATALOG_REVISIONS } from "../domain/limits.js";
import { ProjectCatalogCapacityError, ProjectPurgeBlockedError } from "./repository.js";

const connectionString = process.env.VOICE_LABS_TEST_DATABASE_URL;
let repository: PostgresRepository | undefined;

afterAll(async () => repository?.close());

describe.skipIf(!connectionString)("PostgresRepository", () => {
  it("backfills run status from legacy payloads exactly once during schema upgrade", async () => {
    const adminPool = new Pool({ connectionString });
    const schemaName = `voice_labs_run_status_upgrade_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    const scopedPool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
    const projectId = `voice-labs-legacy-status-${randomUUID()}`;
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId);
    const experiment = seed.experiments[0];
    const startedAt = "2026-01-01T00:00:00.000Z";
    const insertLegacyRun = async (id: string, status?: string) => scopedPool.query(
      `INSERT INTO voice_labs_runs (project_id, experiment_id, experiment_revision_id, id, started_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [projectId, experiment.experimentId, experiment.id, id, startedAt, JSON.stringify(status ? { status } : {})],
    );

    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    const upgradedRepository = new PostgresRepository(scopedPool);
    try {
      await scopedPool.query(`
        CREATE TABLE voice_labs_runs (
          project_id text NOT NULL,
          experiment_id text NOT NULL,
          experiment_revision_id text NOT NULL,
          id text NOT NULL,
          started_at timestamptz NOT NULL,
          payload jsonb NOT NULL,
          PRIMARY KEY (project_id, id)
        )
      `);
      await insertLegacyRun("legacy-running", "running");
      await insertLegacyRun("legacy-queued", "queued");
      await insertLegacyRun("legacy-passed", "passed");
      await insertLegacyRun("legacy-without-status");

      await upgradedRepository.initialize();
      await upgradedRepository.addExperimentRevision(projectId, experiment);

      await expect(upgradedRepository.getRunProgressWithProjectStatus(projectId, "legacy-running"))
        .resolves.toMatchObject({ progress: { id: "legacy-running", status: "running" } });
      await expect(upgradedRepository.getExperimentRunProgressWithProjectStatus(
        projectId,
        experiment.experimentId,
        experiment.id,
        50,
      )).resolves.toMatchObject({
        experimentFound: true,
        runs: expect.arrayContaining([
          { id: "legacy-queued", status: "queued" },
          { id: "legacy-running", status: "running" },
          { id: "legacy-passed", status: "passed" },
          { id: "legacy-without-status", status: "unknown" },
        ]),
      });

      await scopedPool.query(
        "UPDATE voice_labs_runs SET status = 'passed' WHERE project_id = $1 AND id = 'legacy-running'",
        [projectId],
      );
      await upgradedRepository.initialize();
      await expect(upgradedRepository.getRunProgressWithProjectStatus(projectId, "legacy-running"))
        .resolves.toMatchObject({ progress: { id: "legacy-running", status: "passed" } });
      await expect(scopedPool.query(
        "SELECT name FROM voice_labs_schema_migrations WHERE name = 'run_status_backfill_v1'",
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await upgradedRepository.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("includes active runs outside the bounded recent status window", async () => {
    const adminPool = new Pool({ connectionString });
    const schemaName = `voice_labs_active_status_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    const scopedPool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
    const isolatedRepository = new PostgresRepository(scopedPool);
    const projectId = `voice-labs-active-status-${randomUUID()}`;
    const experiment = createSeedState("2026-01-01T00:00:00.000Z", projectId).experiments[0];

    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    try {
      await isolatedRepository.initialize();
      await isolatedRepository.addExperimentRevision(projectId, experiment);
      const storedRuns = [
        { id: "long-running-old", status: "running", startedAt: "2000-01-01T00:00:00.000Z" },
        ...Array.from({ length: 51 }, (_, index) => ({
          id: `recent-terminal-${String(index).padStart(2, "0")}`,
          status: "passed",
          startedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
        })),
      ];
      const values = storedRuns.flatMap((run) => [
        projectId,
        experiment.experimentId,
        experiment.id,
        run.id,
        run.startedAt,
        run.status,
        "{}",
      ]);
      const rows = storedRuns.map((_, index) => {
        const start = index * 7 + 1;
        return `($${start}, $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}::jsonb)`;
      });
      await scopedPool.query(
        `INSERT INTO voice_labs_runs (project_id, experiment_id, experiment_revision_id, id, started_at, status, payload)
         VALUES ${rows.join(", ")}`,
        values,
      );

      const activeResult = await isolatedRepository.getExperimentRunProgressWithProjectStatus(
        projectId,
        experiment.experimentId,
        experiment.id,
        50,
      );

      expect(activeResult.runs).toHaveLength(51);
      expect(activeResult.runs).toContainEqual({ id: "long-running-old", status: "running" });
      expect(activeResult.runs).not.toContainEqual({ id: "recent-terminal-00", status: "passed" });

      await scopedPool.query(
        "UPDATE voice_labs_runs SET status = 'passed' WHERE project_id = $1 AND id = 'long-running-old'",
        [projectId],
      );
      const terminalResult = await isolatedRepository.getExperimentRunProgressWithProjectStatus(
        projectId,
        experiment.experimentId,
        experiment.id,
        50,
        ["long-running-old", "deleted-run"],
      );

      expect(terminalResult.runs).toHaveLength(51);
      expect(terminalResult.runs).toContainEqual({ id: "long-running-old", status: "passed" });
      expect(terminalResult.missingRunIds).toEqual(["deleted-run"]);
    } finally {
      await isolatedRepository.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("persists project-scoped revisions, runs, and evidence across repository restart", async () => {
    const projectId = `voice-labs-test-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);
    const service = createLabService(repository, new DeterministicRunner());
    const result = await service.runExperiment(context, seed.experiments[0].experimentId);
    const firstRun = result.runs[0];
    const progress = await service.getExperimentRunProgress(context, seed.experiments[0].experimentId, seed.experiments[0].id);
    expect(progress.runs.map(({ id, status }) => ({ id, status })).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(result.runs.map(({ id, status }) => ({ id, status })).sort((left, right) => left.id.localeCompare(right.id)));
    const evidence = {
      source: "earshot" as const,
      incidentId: "voice-labs-test-incident",
      sessionId: "voice-labs-test-session",
      bundleDigest: "a".repeat(64),
      endpoint: "http://127.0.0.1:4319/v1/incidents",
      status: "attached" as const,
    };
    await repository.saveRunEvidence(projectId, firstRun.id, evidence);
    await service.promoteScenario(context, seed.scenarios[0].scenarioId);
    await repository.close();

    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    const persisted = await repository.read(projectId);
    const persistedRuns = await repository.listRuns(projectId);
    expect(persisted.scenarios).toHaveLength(seed.scenarios.length);
    expect(persisted.variants).toHaveLength(seed.variants.length);
    expect(persisted.experiments).toHaveLength(1);
    expect(persisted.runs).toHaveLength(0);
    expect(persistedRuns).toHaveLength(4);
    expect(persistedRuns.find((run) => run.id === firstRun.id)?.evidence).toEqual(evidence);
    const newestPage = await repository.listRuns(projectId, { limit: 2 });
    const nextPage = await repository.listRuns(projectId, {
      limit: 2,
      before: { startedAt: newestPage[1].startedAt ?? newestPage[1].queuedAt ?? "", id: newestPage[1].id },
    });
    expect([...newestPage, ...nextPage].map((run) => run.id)).toHaveLength(4);
    expect(await repository.listRecentRunSummaries(projectId, 2)).toHaveLength(2);
    const recentSummary = (await repository.listRecentRunSummaries(projectId, 1))[0];
    expect("transcript" in recentSummary).toBe(false);
    expect(recentSummary).toMatchObject({
      experimentName: seed.experiments[0].name,
      scenarioName: seed.scenarios[0].name,
      variantName: seed.variants.find((variant) => variant.id === recentSummary.variantId)?.name,
    });
    expect(persisted.regressionSet[0].promotedBy).toBe(context.userId);
    expect(await repository.listRuns(`${projectId}-other`)).toHaveLength(0);
    const providerRuns = persistedRuns.slice(0, 2).map((run, index) => ({
      ...run,
      id: `provider-quota-${index}-${randomUUID()}`,
      mode: "tvic" as const,
      startedAt: new Date().toISOString(),
    }));
    await repository.appendRuns(projectId, providerRuns);
    expect(await repository.countProviderRunsSince(projectId, new Date(Date.now() - 60_000).toISOString())).toBe(2);
    expect(await repository.deleteRun(projectId, providerRuns[0].id)).toBe(true);
    expect(await repository.countProviderRunsSince(projectId, new Date(Date.now() - 60_000).toISOString())).toBe(2);
    await repository.pruneRunsBefore("2050-01-01T00:00:00.000Z");
    expect(await repository.countProviderRunsSince(projectId, "2000-01-01T00:00:00.000Z")).toBe(2);
  });

  it("retains the only Earshot reference when Postgres retention prunes its run", async () => {
    const projectId = `voice-labs-retention-reference-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    const experiment = seed.experiments[0];
    experiment.scenarioIds = [seed.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [seed.scenarios[0].id];
    experiment.variantIds = [seed.variants[0].variantId];
    experiment.variantRevisionIds = [seed.variants[0].id];
    experiment.repetitions = 1;
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    await repository.addScenarioRevision(projectId, seed.scenarios[0]);
    await repository.addVariantRevision(projectId, seed.variants[0]);
    await repository.addExperimentRevision(projectId, experiment);

    const completed = await createLabService(repository, new DeterministicRunner()).runExperiment(context, experiment.experimentId);
    const run = { ...completed.runs[0], startedAt: "2000-01-01T00:00:00.000Z" };
    const evidence = {
      source: "earshot" as const,
      incidentId: `retention-${randomUUID()}`,
      endpoint: "https://earshot-retention.example/v1/incidents",
      status: "attached" as const,
    };
    await repository.updateRun(projectId, run);
    await repository.saveRunEvidence(projectId, run.id, evidence);

    expect(await repository.pruneRunsBefore("2050-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(1);
    expect(await repository.listRuns(projectId)).toHaveLength(0);
    const receipt = await repository.purgeProject(projectId, "2050-01-02T00:00:00.000Z");
    expect(receipt.linkedEarshotIncidents).toEqual([{
      incidentId: evidence.incidentId,
      endpoint: evidence.endpoint,
      deliveryStatus: "attached",
    }]);
  });

  it("replays a durable run-start receipt after repository restart without executing again", async () => {
    const projectId = `voice-labs-run-start-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);
    let executions = 0;
    const executor = {
      async execute(request: Parameters<DeterministicRunner["execute"]>[0]) {
        executions += 1;
        return new DeterministicRunner().execute(request);
      },
    };
    const request = { idempotencyKey: `postgres-${randomUUID()}`, revisionId: seed.experiments[0].id };
    const first = await createLabService(repository, executor).startExperiment(context, seed.experiments[0].experimentId, request);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await repository.listRuns(projectId);
      if (runs.length === first.runIds.length && runs.every((run) => run.status !== "queued" && run.status !== "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await repository.close();

    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    const retry = await createLabService(repository, executor).startExperiment(context, seed.experiments[0].experimentId, request);
    expect(retry).toEqual(first);
    expect(await repository.listRuns(projectId)).toHaveLength(first.runIds.length);
    expect(executions).toBe(first.runIds.length);
  });

  it("deletes Voice Labs project records atomically and retains an idempotent Earshot receipt", async () => {
    const projectId = `voice-labs-purge-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);
    await createLabService(repository, new DeterministicRunner()).runExperiment(context, seed.experiments[0].experimentId);
    await repository.recordEarshotReference(projectId, {
      incidentId: "voice-labs-purge-incident",
      endpoint: "https://earshot.example/v1/incidents",
      deliveryStatus: "attached",
      upstreamProjectId: "earshot-purge-project",
    });

    const receipt = await repository.purgeProject(projectId, "2026-01-02T00:00:00.000Z");
    expect(receipt.linkedEarshotIncidents).toEqual([{
      incidentId: "voice-labs-purge-incident",
      endpoint: "https://earshot.example/v1/incidents",
      deliveryStatus: "attached",
      upstreamProjectId: "earshot-purge-project",
    }]);
    expect(await repository.listRuns(projectId)).toHaveLength(0);
    expect((await repository.read(projectId)).experiments).toHaveLength(0);
    await repository.close();

    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    expect(await repository.purgeProject(projectId, "2026-01-03T00:00:00.000Z")).toEqual(receipt);
    expect((await repository.read(projectId)).projectPurge).toEqual(receipt);
    await expect(repository.getExperimentRunProgressWithProjectStatus(
      projectId,
      seed.experiments[0].experimentId,
      seed.experiments[0].id,
      50,
    )).resolves.toMatchObject({ experimentFound: false, projectPurged: true, runs: [] });
    expect(await repository.listRuns(projectId)).toHaveLength(0);
    await expect(repository.addScenarioRevision(projectId, seed.scenarios[0])).rejects.toThrow("This Voice Labs project has been purged");
  });

  it("blocks delete, retention, and project purge while runtime cleanup is unconfirmed", async () => {
    const adminPool = new Pool({ connectionString });
    const schemaName = `voice_labs_unconfirmed_cleanup_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    const isolatedPool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
    const isolatedRepository = new PostgresRepository(isolatedPool);
    const projectId = `voice-labs-unconfirmed-cleanup-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    const experiment = seed.experiments[0];
    experiment.scenarioIds = [seed.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [seed.scenarios[0].id];
    experiment.variantIds = [seed.variants[0].variantId];
    experiment.variantRevisionIds = [seed.variants[0].id];
    experiment.repetitions = 1;
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    try {
      await isolatedRepository.initialize();
      await isolatedRepository.addScenarioRevision(projectId, seed.scenarios[0]);
      await isolatedRepository.addVariantRevision(projectId, seed.variants[0]);
      await isolatedRepository.addExperimentRevision(projectId, experiment);
      const result = await createLabService(isolatedRepository, new DeterministicRunner()).runExperiment(context, experiment.experimentId);
      const run = { ...result.runs[0], startedAt: "2000-01-01T00:00:00.000Z", status: "error" as const,
        mode: "tvic" as const,
        error: { code: "cancellation_unconfirmed", message: "TVIC runtime cleanup could not be confirmed." } };
      await isolatedRepository.updateRun(projectId, { ...run, status: "running", error: undefined });
      expect(await isolatedRepository.acquireProjectRunLock(projectId, `stale-retry-${randomUUID()}`, "2050-01-01T00:00:00.000Z")).toBe(false);
      const staleSlots = Array.from({ length: MAX_CONCURRENT_PROVIDER_RUNS - 1 }, () => ({
        projectId: `voice-labs-stale-provider-slot-${randomUUID()}`,
        ownerId: `worker-${randomUUID()}`,
      }));
      for (const slot of staleSlots) {
        expect(await isolatedRepository.acquireProviderRunSlot(slot.projectId, slot.ownerId, "2050-01-01T00:00:00.000Z")).toBe(true);
      }
      expect(await isolatedRepository.acquireProviderRunSlot(`voice-labs-stale-provider-overflow-${randomUUID()}`, `worker-${randomUUID()}`, "2050-01-01T00:00:00.000Z")).toBe(false);
      for (const slot of staleSlots) await isolatedRepository.releaseProviderRunSlot(slot.projectId, slot.ownerId);
      expect(await createLabService(isolatedRepository, new DeterministicRunner()).recoverStaleRunsBefore("2001-01-01T00:00:00.000Z")).toBe(1);
      expect(await isolatedRepository.listRuns(projectId, { runId: run.id })).toMatchObject([{
        status: "error",
        error: { code: "cancellation_unconfirmed" },
      }]);

      expect(await isolatedRepository.deleteRun(projectId, run.id)).toBe(false);
      await isolatedRepository.pruneRunsBefore("2050-01-01T00:00:00.000Z");
      expect(await isolatedRepository.listRuns(projectId, { runId: run.id })).toMatchObject([{
        status: "error",
        error: { code: "cancellation_unconfirmed" },
      }]);
      expect(await isolatedRepository.acquireProjectRunLock(projectId, `retry-${randomUUID()}`, "2050-01-01T00:00:00.000Z")).toBe(false);

      const occupiedSlots = Array.from({ length: MAX_CONCURRENT_PROVIDER_RUNS - 1 }, () => ({
        projectId: `voice-labs-unconfirmed-slot-${randomUUID()}`,
        ownerId: `worker-${randomUUID()}`,
      }));
      for (const slot of occupiedSlots) {
        expect(await isolatedRepository.acquireProviderRunSlot(slot.projectId, slot.ownerId, "2050-01-01T00:00:00.000Z")).toBe(true);
      }
      expect(await isolatedRepository.acquireProviderRunSlot(`voice-labs-unconfirmed-overflow-${randomUUID()}`, `worker-${randomUUID()}`, "2050-01-01T00:00:00.000Z")).toBe(false);
      for (const slot of occupiedSlots) await isolatedRepository.releaseProviderRunSlot(slot.projectId, slot.ownerId);

      await expect(isolatedRepository.purgeProject(projectId, "2050-01-02T00:00:00.000Z"))
        .rejects.toBeInstanceOf(ProjectPurgeBlockedError);
    } finally {
      await isolatedRepository.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("backfills legacy Earshot references and preserves destination history when runs are deleted", async () => {
    const adminPool = new Pool({ connectionString });
    const schemaName = `voice_labs_earshot_upgrade_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    const scopedPool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
    const projectId = `voice-labs-legacy-earshot-${randomUUID()}`;
    const incidentId = "same-incident-id-on-two-earshot-hosts";
    const endpoints = [
      "https://earshot-old.example/v1/incidents",
      "https://earshot-current.example/v1/incidents",
      "https://earshot-next.example/v1/incidents",
    ];
    const insertRun = async (runId: string, endpoint: string, status = "attached") => {
      const payload = {
        evidence: {
          incidentId,
          endpoint,
          status,
          upstreamProjectId: "earshot-project",
        },
      };
      await scopedPool.query(
        `INSERT INTO voice_labs_runs (project_id, experiment_id, experiment_revision_id, id, started_at, status, payload)
         VALUES ($1, 'legacy-experiment', 'legacy-revision', $2, now(), 'passed', $3::jsonb)`,
        [projectId, runId, JSON.stringify(payload)],
      );
    };

    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    try {
      await scopedPool.query(`
        CREATE TABLE voice_labs_runs (
          project_id text NOT NULL,
          experiment_id text NOT NULL,
          experiment_revision_id text NOT NULL,
          id text NOT NULL,
          started_at timestamptz NOT NULL,
          status text NOT NULL DEFAULT 'unknown',
          payload jsonb NOT NULL,
          PRIMARY KEY (project_id, id)
        )
      `);
      await scopedPool.query(`
        CREATE TABLE voice_labs_earshot_references (
          project_id text NOT NULL,
          incident_id text NOT NULL,
          endpoint text NOT NULL,
          upstream_project_id text,
          delivery_status text NOT NULL DEFAULT 'attempted',
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, incident_id)
        )
      `);
      await scopedPool.query(
        `INSERT INTO voice_labs_earshot_references (project_id, incident_id, endpoint, upstream_project_id, delivery_status)
         VALUES ($1, $2, $3, 'earshot-project', 'attached')`,
        [projectId, incidentId, endpoints[0]],
      );
      await insertRun("legacy-run-old-host", endpoints[0]);
      await insertRun("legacy-run-current-host", endpoints[1], "attempted");

      const upgradedRepository = new PostgresRepository(scopedPool);
      await upgradedRepository.initialize();
      const migrated = await scopedPool.query<{ endpoint: string; delivery_status: string }>(
        "SELECT endpoint, delivery_status FROM voice_labs_earshot_references WHERE project_id = $1 ORDER BY endpoint",
        [projectId],
      );
      expect(migrated.rows).toEqual([
        { endpoint: endpoints[1], delivery_status: "attempted" },
        { endpoint: endpoints[0], delivery_status: "attached" },
      ].sort((left, right) => left.endpoint.localeCompare(right.endpoint)));

      await upgradedRepository.deleteRun(projectId, "legacy-run-old-host");
      await upgradedRepository.deleteRun(projectId, "legacy-run-current-host");
      await insertRun("new-run-next-host", endpoints[2]);
      await upgradedRepository.deleteRun(projectId, "new-run-next-host");

      const receipt = await upgradedRepository.purgeProject(projectId, new Date().toISOString());
      expect(receipt.linkedEarshotIncidents).toHaveLength(3);
      expect(receipt.linkedEarshotIncidents.map((reference) => reference.endpoint).sort()).toEqual([...endpoints].sort());
      const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId);
      await expect(upgradedRepository.addScenarioRevision(projectId, seed.scenarios[0]))
        .rejects.toThrow("This Voice Labs project has been purged");
    } finally {
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
      await adminPool.end();
    }
  });

  it("migrates existing reference ledgers to preserve remapped Earshot project destinations", async () => {
    const adminPool = new Pool({ connectionString });
    const schemaName = `voice_labs_earshot_project_upgrade_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    const scopedPool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
    const projectId = `voice-labs-remapped-earshot-${randomUUID()}`;
    const incidentId = "voice-labs-remapped-incident";
    const endpoint = "https://earshot.example/v1/incidents";

    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    try {
      await scopedPool.query(`
        CREATE TABLE voice_labs_schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await scopedPool.query("INSERT INTO voice_labs_schema_migrations (name) VALUES ('earshot_reference_history_v1')");
      await scopedPool.query(`
        CREATE TABLE voice_labs_runs (
          project_id text NOT NULL,
          experiment_id text NOT NULL,
          experiment_revision_id text NOT NULL,
          id text NOT NULL,
          started_at timestamptz NOT NULL,
          status text NOT NULL DEFAULT 'unknown',
          payload jsonb NOT NULL,
          PRIMARY KEY (project_id, id)
        )
      `);
      await scopedPool.query(`
        CREATE TABLE voice_labs_earshot_references (
          project_id text NOT NULL,
          incident_id text NOT NULL,
          endpoint text NOT NULL,
          upstream_project_id text,
          delivery_status text NOT NULL DEFAULT 'attempted',
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, incident_id, endpoint)
        )
      `);
      await scopedPool.query(
        `INSERT INTO voice_labs_earshot_references (project_id, incident_id, endpoint, upstream_project_id, delivery_status)
         VALUES ($1, $2, $3, 'earshot-project-before-remap', 'attempted')`,
        [projectId, incidentId, endpoint],
      );
      await scopedPool.query(
        `INSERT INTO voice_labs_runs (project_id, experiment_id, experiment_revision_id, id, started_at, status, payload)
         VALUES ($1, 'experiment', 'revision', 'run-after-remap', '2000-01-01T00:00:00.000Z', 'passed', $2::jsonb)`,
        [projectId, JSON.stringify({ evidence: {
          incidentId,
          endpoint,
          upstreamProjectId: "earshot-project-after-remap",
          status: "attached",
        } })],
      );

      const upgradedRepository = new PostgresRepository(scopedPool);
      await upgradedRepository.initialize();
      expect(await upgradedRepository.pruneRunsBefore("2050-01-01T00:00:00.000Z")).toBe(1);
      const receipt = await upgradedRepository.purgeProject(projectId, "2050-01-02T00:00:00.000Z");

      expect(receipt.linkedEarshotIncidents).toEqual([
        {
          incidentId,
          endpoint,
          upstreamProjectId: "earshot-project-after-remap",
          deliveryStatus: "attached",
        },
        {
          incidentId,
          endpoint,
          upstreamProjectId: "earshot-project-before-remap",
          deliveryStatus: "attempted",
        },
      ].sort((left, right) => left.upstreamProjectId.localeCompare(right.upstreamProjectId)));
    } finally {
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
      await adminPool.end();
    }
  });

  it("does not purge while another worker holds a run or evidence lease", async () => {
    const projectId = `voice-labs-purge-active-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);

    await repository.acquireProjectRunLock(projectId, "remote-run-worker", new Date(Date.now() + 60_000).toISOString());
    await expect(repository.purgeProject(projectId, new Date().toISOString())).rejects.toBeInstanceOf(ProjectPurgeBlockedError);
    expect((await repository.read(projectId)).projectPurge).toBeNull();
    await repository.releaseProjectRunLock(projectId, "remote-run-worker");

    const result = await createLabService(repository, new DeterministicRunner()).runExperiment(context, seed.experiments[0].experimentId);
    const pendingEvidenceRun = {
      ...result.runs[0],
      evidence: { source: "earshot" as const, endpoint: "https://earshot.example/v1/incidents", status: "pending" as const },
    };
    await repository.updateRun(projectId, pendingEvidenceRun);
    const retryOwner = "remote-earshot-worker";
    const retryLease = await repository.claimPendingEvidenceDue(
      new Date().toISOString(),
      retryOwner,
      new Date(Date.now() + 60_000).toISOString(),
      1,
    );
    expect(retryLease.map((run) => run.id)).toContain(pendingEvidenceRun.id);
    await expect(repository.purgeProject(projectId, new Date().toISOString())).rejects.toBeInstanceOf(ProjectPurgeBlockedError);
    await repository.releasePendingEvidenceClaim(projectId, pendingEvidenceRun.id, retryOwner);

    const receipt = await repository.purgeProject(projectId, new Date().toISOString());
    expect(receipt.status).toBe("local_data_deleted");
  });

  it("serializes project run leases and preserves active runs during retention", async () => {
    const projectId = `voice-labs-lock-test-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);

    const result = await createLabService(repository, new DeterministicRunner()).runExperiment(context, seed.experiments[0].experimentId);
    const activeRun = { ...result.runs[0], status: "running" as const, startedAt: "2000-01-01T00:00:00.000Z" };
    await repository.updateRun(projectId, activeRun);
    const pendingEvidenceRun = {
      ...result.runs[1],
      startedAt: "2000-01-01T00:00:00.000Z",
      evidence: { source: "earshot" as const, endpoint: "http://earshot.test", status: "pending" as const },
    };
    await repository.updateRun(projectId, pendingEvidenceRun);
    expect(await repository.deleteRun(projectId, pendingEvidenceRun.id)).toBe(false);
    expect(await repository.acquireProjectRunLock(projectId, "worker-one", new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(await repository.acquireProjectRunLock(projectId, "worker-two", new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(await repository.acquireProjectRunLock(`${projectId}-other`, "worker-two", new Date(Date.now() + 60_000).toISOString())).toBe(true);
    await repository.releaseProjectRunLock(projectId, "worker-one");
    expect(await repository.acquireProjectRunLock(projectId, "worker-two", new Date(Date.now() + 60_000).toISOString())).toBe(true);
    await repository.releaseProjectRunLock(projectId, "worker-two");
    await repository.releaseProjectRunLock(`${projectId}-other`, "worker-two");

    expect(await repository.pruneRunsBefore("2050-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(2);
    const remaining = await repository.listRuns(projectId);
    expect(remaining).toHaveLength(2);
    expect(remaining.some((run) => run.status === "running")).toBe(true);
    expect(await createLabService(repository, new DeterministicRunner()).recoverStaleRunsBefore("2050-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(1);
    expect((await repository.listRuns(projectId)).find((run) => run.id === activeRun.id)?.status).toBe("error");
    expect((await repository.listRuns(projectId)).find((run) => run.id === pendingEvidenceRun.id)?.evidence?.status).toBe("pending");
    const evidenceLeaseUntil = new Date(Date.parse("2050-01-01T00:00:00.000Z") + 120_000).toISOString();
    const evidenceClaims = await Promise.all([
      repository.claimPendingEvidenceDue("2050-01-01T00:00:00.000Z", "evidence-worker-one", evidenceLeaseUntil, 16),
      repository.claimPendingEvidenceDue("2050-01-01T00:00:00.000Z", "evidence-worker-two", evidenceLeaseUntil, 16),
    ]);
    expect(evidenceClaims.flat().map((run) => run.id)).toEqual([pendingEvidenceRun.id]);
    const winningWorker = evidenceClaims[0].length > 0 ? "evidence-worker-one" : "evidence-worker-two";
    const losingWorker = winningWorker === "evidence-worker-one" ? "evidence-worker-two" : "evidence-worker-one";
    const reservedEvidence = {
      ...pendingEvidenceRun.evidence!,
      attemptCount: 1,
      retryAt: new Date(Date.parse("2050-01-01T00:00:00.000Z") + 60_000).toISOString(),
    };
    expect(await repository.reservePendingEvidenceAttempt(projectId, pendingEvidenceRun.id, winningWorker, 0, reservedEvidence)).toBe(true);
    expect(await repository.reservePendingEvidenceAttempt(projectId, pendingEvidenceRun.id, losingWorker, 0, reservedEvidence)).toBe(false);
    expect(await repository.pruneRunsBefore("2050-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(1);
    expect((await repository.listRuns(projectId)).map((run) => run.id)).toEqual([pendingEvidenceRun.id]);
    const attachedEvidence = { ...pendingEvidenceRun.evidence!, status: "attached" as const, incidentId: "recovered-incident" };
    await repository.saveRunEvidence(projectId, pendingEvidenceRun.id, attachedEvidence);
    expect(await repository.savePendingRunEvidence(projectId, pendingEvidenceRun.id, pendingEvidenceRun.evidence!)).toBe(false);
    expect((await repository.listRuns(projectId))[0].evidence).toMatchObject({ status: "attached", incidentId: "recovered-incident" });
    await repository.releasePendingEvidenceClaim(projectId, pendingEvidenceRun.id, "evidence-worker-one");
    await repository.releasePendingEvidenceClaim(projectId, pendingEvidenceRun.id, "evidence-worker-two");
  });

  it("advances reserved Earshot delivery attempts through PostgreSQL and allows retention afterward", async () => {
    const projectId = `voice-labs-evidence-retry-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    const experiment = seed.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [seed.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [seed.scenarios[0].id];
    experiment.variantIds = [seed.variants[0].variantId];
    experiment.variantRevisionIds = [seed.variants[0].id];
    experiment.repetitions = 1;
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const revision of seed.experiments) await repository.addExperimentRevision(projectId, revision);

    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = { now: () => new Date(now) };
    let initialPosts = 0;
    const failingSink = {
      endpoint: "http://earshot.test/v1/incidents",
      async attach() {
        initialPosts += 1;
        throw new Error("Simulated lost Earshot response.");
      },
    };
    const firstService = createLabService(repository, new DeterministicRunner({ now: clock.now }), { clock, evidenceSink: failingSink });
    const completed = await firstService.runExperiment(context, experiment.experimentId);
    const runId = completed.runs[0].id;
    expect(completed.runs[0].evidence).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(initialPosts).toBe(1);
    expect(await repository.countPendingEvidence(projectId)).toBe(1);

    const restartedService = createLabService(repository, new DeterministicRunner({ now: clock.now }), { clock });
    const run = await restartedService.getRun(context, runId);
    now = Date.parse(run.evidence!.retryAt!) - 1;
    expect(await restartedService.retryPendingEvidenceBefore(new Date(now).toISOString())).toBe(0);
    await expect(restartedService.getRun(context, runId)).resolves.toMatchObject({
      evidence: { status: "pending", attemptCount: 1 },
    });

    for (let attempt = 1; attempt < 8; attempt += 1) {
      now += 60_001;
      await restartedService.retryPendingEvidenceBefore(new Date(now).toISOString());
    }
    await expect(restartedService.getRun(context, runId)).resolves.toMatchObject({
      evidence: { status: "unavailable", attemptCount: 8 },
    });
    expect(await repository.countPendingEvidence(projectId)).toBe(0);
    expect(await repository.pruneRunsBefore(new Date(now + 24 * 60 * 60 * 1000).toISOString())).toBeGreaterThanOrEqual(1);
    await expect(restartedService.getRun(context, runId)).rejects.toThrow(`Run not found: ${runId}`);
  });

  it("marks a queued Postgres run without a start timestamp unavailable during recovery", async () => {
    const projectId = `voice-labs-abandoned-evidence-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    seed.experiments[0].scenarioIds = [seed.scenarios[0].scenarioId];
    seed.experiments[0].scenarioRevisionIds = [seed.scenarios[0].id];
    seed.experiments[0].variantIds = [seed.variants[0].variantId];
    seed.experiments[0].variantRevisionIds = [seed.variants[0].id];
    seed.experiments[0].repetitions = 1;
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const revision of seed.experiments) await repository.addExperimentRevision(projectId, revision);

    const service = createLabService(repository, new DeterministicRunner());
    const completed = await service.runExperiment(context, seed.experiments[0].experimentId);
    const run = completed.runs[0];
    await repository.updateRun(projectId, {
      ...run,
      status: "queued",
      queuedAt: "2000-01-01T00:00:00.000Z",
      startedAt: undefined,
      completedAt: undefined,
      evidence: { source: "earshot", endpoint: "http://earshot.test", status: "pending" },
    });

    expect(await service.recoverStaleRunsBefore("2001-01-01T00:00:00.000Z")).toBe(1);
    await expect(service.getRun(context, run.id)).resolves.toMatchObject({
      status: "error",
      evidence: { status: "unavailable" },
    });
    expect(await repository.deleteRun(projectId, run.id)).toBe(true);
  });

  it("caps provider execution slots across projects and releases capacity", async () => {
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    const claims = Array.from({ length: MAX_CONCURRENT_PROVIDER_RUNS }, () => ({
      projectId: `voice-labs-slot-${randomUUID()}`,
      ownerId: `worker-${randomUUID()}`,
    }));
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const acquired = await Promise.all(claims.map((claim) => repository!.acquireProviderRunSlot(claim.projectId, claim.ownerId, expiry)));
    expect(acquired).toEqual(Array.from({ length: MAX_CONCURRENT_PROVIDER_RUNS }, () => true));

    const overflow = { projectId: `voice-labs-slot-${randomUUID()}`, ownerId: `worker-${randomUUID()}` };
    expect(await repository.acquireProviderRunSlot(overflow.projectId, overflow.ownerId, expiry)).toBe(false);
    await Promise.all(claims.map((claim) => repository!.releaseProviderRunSlot(claim.projectId, claim.ownerId)));
    expect(await repository.acquireProviderRunSlot(overflow.projectId, overflow.ownerId, expiry)).toBe(true);
    await repository.releaseProviderRunSlot(overflow.projectId, overflow.ownerId);
  });

  it("enforces the catalog history cap inside the project-scoped write transaction", async () => {
    const projectId = `voice-labs-catalog-limit-${randomUUID()}`;
    const seed = createSeedState(new Date().toISOString(), projectId, "postgres-test-user");
    const pool = new Pool({ connectionString });
    repository = new PostgresRepository(pool);
    await repository.initialize();
    await pool.query(
      "INSERT INTO voice_labs_project_catalog_usage (project_id, revision_count, payload_bytes) VALUES ($1, $2, 0)",
      [projectId, MAX_PROJECT_CATALOG_REVISIONS],
    );

    await expect(repository.addScenarioRevision(projectId, seed.scenarios[0])).rejects.toBeInstanceOf(ProjectCatalogCapacityError);
    expect((await repository.read(projectId)).scenarios).toHaveLength(0);
  });

  it("bounds latest-catalog reads and resolves selected immutable experiment revisions", async () => {
    const projectId = `voice-labs-revision-test-${randomUUID()}`;
    const context = { userId: "postgres-test-user", projectId };
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId, context.userId);
    repository = new PostgresRepository(new Pool({ connectionString }));
    await repository.initialize();
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(projectId, experiment);

    const newerScenarios = seed.scenarios.map((scenario) => ({
      ...scenario,
      id: `${scenario.id}-revision-2`,
      revision: scenario.revision + 1,
      goal: `${scenario.goal} (revision 2)`,
    }));
    const newerVariants = seed.variants.map((variant) => ({
      ...variant,
      id: `${variant.id}-revision-2`,
      revision: variant.revision + 1,
      name: `${variant.name} revision 2`,
    }));
    for (const scenario of newerScenarios) await repository.addScenarioRevision(projectId, scenario);
    for (const variant of newerVariants) await repository.addVariantRevision(projectId, variant);
    const originalExperiment = seed.experiments[0];
    const scenarioById = new Map(newerScenarios.map((scenario) => [scenario.scenarioId, scenario.id]));
    const variantById = new Map(newerVariants.map((variant) => [variant.variantId, variant.id]));
    const latestExperiment = {
      ...originalExperiment,
      id: `${originalExperiment.id}-revision-2`,
      revision: originalExperiment.revision + 1,
      name: "Experiment revision 2",
      scenarioRevisionIds: originalExperiment.scenarioIds.map((id) => scenarioById.get(id)!),
      variantRevisionIds: originalExperiment.variantIds.map((id) => variantById.get(id)!),
    };
    await repository.addExperimentRevision(projectId, latestExperiment);
    await repository.appendRegressionEntry(projectId, {
      projectId,
      scenarioId: seed.scenarios[0].scenarioId,
      revision: seed.scenarios[0].revision,
      promotedAt: "2026-01-01T00:00:00.000Z",
      promotedBy: context.userId,
    });

    const overview = await repository.read(projectId, { latestCatalogOnly: true });
    expect(overview.scenarios).toHaveLength(seed.scenarios.length);
    expect(overview.scenarios.every((scenario) => scenario.revision === 2)).toBe(true);
    expect(overview.variants).toHaveLength(seed.variants.length);
    expect(overview.variants.every((variant) => variant.revision === 2)).toBe(true);
    expect(overview.experiments).toEqual([expect.objectContaining({ id: latestExperiment.id })]);
    expect(overview.regressionSet).toEqual([]);
    expect((await repository.read(projectId)).regressionSet).toHaveLength(1);
    expect((await repository.read(projectId, { latestCatalogOnly: true, includeRegressionSet: true })).regressionSet).toHaveLength(1);

    const historicalState = await repository.read(projectId, { experimentId: originalExperiment.experimentId });
    expect(historicalState.experiments).toHaveLength(2);
    expect(historicalState.scenarios.some((scenario) => scenario.id === originalExperiment.scenarioRevisionIds[0])).toBe(true);
    expect(historicalState.scenarios.some((scenario) => scenario.id === latestExperiment.scenarioRevisionIds[0])).toBe(true);

    const service = createLabService(repository, new DeterministicRunner());
    const run = (await service.runExperiment(context, originalExperiment.experimentId)).runs[0];
    const summary = await service.getPlatformSummary(context, run.id);
    expect(summary.items[0]).toMatchObject({ id: run.id, title: expect.stringContaining("Experiment revision 2") });
    expect("transcript" in summary.items[0]).toBe(false);
  });
});
