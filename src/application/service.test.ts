import { describe, expect, it, vi } from "vitest";
import { createLabService } from "./service.js";
import { MemoryRepository } from "../adapters/memory-repository.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createSeedState } from "../adapters/seed.js";
import { MAX_CONCURRENT_PROVIDER_RUNS, MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT, MAX_PROJECT_CATALOG_REVISIONS, MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY, MAX_RUN_CELLS } from "../domain/limits.js";

describe("LabService", () => {
  const context = { userId: "local-development", projectId: "local" };

  it("returns the same accepted run IDs when a start request is retried", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const runner = new DeterministicRunner();
    const execute = runner.execute.bind(runner);
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executions = 0;
    runner.execute = async (request, preparation, signal) => {
      executions += 1;
      await executionGate;
      return execute(request, preparation, signal);
    };
    const service = createLabService(repository, runner);
    const experiment = (await service.listExperiments(context))[0];
    const request = { idempotencyKey: "run-start-key-1", revisionId: experiment.id };

    try {
      const first = await service.startExperiment(context, experiment.experimentId, request);
      const retry = await service.startExperiment(context, experiment.experimentId, request);

      expect(retry).toEqual(first);
      expect(retry.runIds).toHaveLength(4);
      expect(await repository.listRuns(context.projectId)).toHaveLength(4);
      expect(executions).toBe(1);
    } finally {
      releaseExecution();
    }
  });

  it("polls run status without reading catalog or run artifacts", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const completed = await service.runExperiment(context, experiment.experimentId);
    repository.read = async () => { throw new Error("Run status polling must not hydrate project state."); };
    repository.listRuns = async () => { throw new Error("Run status polling must not hydrate run artifacts."); };

    await expect(service.getRunStatus(context, completed.runs[0].id)).resolves.toMatchObject({
      id: completed.runs[0].id,
    });
  });

  it("returns only status and evidence fields for lightweight run polling", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const completed = await service.runExperiment(context, experiment.experimentId);
    await repository.saveRunEvidence(context.projectId, completed.runs[0].id, {
      source: "earshot",
      incidentId: "incident-private-ref",
      upstreamProjectId: "earshot-project-private-ref",
      bundleDigest: "a".repeat(64),
      endpoint: "https://earshot.example/v1/incidents",
      sessionId: "session-visible-link",
      status: "pending",
      attemptCount: 2,
      retryAt: "2026-01-01T00:01:00.000Z",
    });

    const progress = await service.getRunStatus(context, completed.runs[0].id);
    expect(progress).toEqual({
      id: completed.runs[0].id,
      status: completed.runs[0].status,
      evidence: {
        sessionId: "session-visible-link",
        status: "pending",
      },
    });
    expect(progress).not.toHaveProperty("transcript");
    expect(progress).not.toHaveProperty("toolCalls");
    expect(progress.evidence).not.toHaveProperty("source");
    expect(progress.evidence).not.toHaveProperty("endpoint");
    expect(progress.evidence).not.toHaveProperty("incidentId");
    expect(progress.evidence).not.toHaveProperty("upstreamProjectId");
    expect(progress.evidence).not.toHaveProperty("bundleDigest");
    expect(progress.evidence).not.toHaveProperty("attemptCount");
    expect(progress.evidence).not.toHaveProperty("retryAt");
  });

  it("lists experiment run statuses without loading run artifacts or the catalog", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const completed = await service.runExperiment(context, experiment.experimentId);
    const longRunningRun = {
      ...completed.runs[0],
      queuedAt: "2000-01-01T00:00:00.000Z",
      startedAt: "2000-01-01T00:00:00.000Z",
      status: "running" as const,
    };
    await repository.updateRun(context.projectId, longRunningRun);
    const newerTerminalRuns = Array.from({ length: 51 }, (_, index) => {
      const startedAt = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
      return {
        ...completed.runs[0],
        id: `newer-terminal-${String(index).padStart(2, "0")}`,
        queuedAt: startedAt,
        startedAt,
      };
    });
    await repository.appendRuns(context.projectId, newerTerminalRuns);
    repository.read = async () => { throw new Error("Experiment status polling must not hydrate project state."); };
    repository.listRuns = async () => { throw new Error("Experiment status polling must not hydrate run artifacts."); };

    const progress = await service.getExperimentRunProgress(context, experiment.experimentId, experiment.id, [longRunningRun.id]);
    expect(progress.runs).toHaveLength(51);
    expect(progress.runs).toContainEqual({ id: longRunningRun.id, status: "running" });
    expect(progress.runs).not.toContainEqual({ id: "newer-terminal-00", status: "passed" });
    expect(progress.missingRunIds).toEqual([]);

    const completedOldRun = { ...longRunningRun, status: "passed" as const };
    await repository.updateRun(context.projectId, completedOldRun);
    const reconciled = await service.getExperimentRunProgress(context, experiment.experimentId, experiment.id, [longRunningRun.id]);
    expect(reconciled.runs).toHaveLength(51);
    expect(reconciled.runs).toContainEqual({ id: longRunningRun.id, status: "passed" });
    expect(reconciled.missingRunIds).toEqual([]);

    await repository.deleteRun(context.projectId, longRunningRun.id);
    const deleted = await service.getExperimentRunProgress(context, experiment.experimentId, experiment.id, [longRunningRun.id]);
    expect(deleted.runs).not.toContainEqual({ id: longRunningRun.id, status: "passed" });
    expect(deleted.missingRunIds).toEqual([longRunningRun.id]);
    await expect(service.getExperimentRunProgress(
      context,
      experiment.experimentId,
      experiment.id,
      Array.from({ length: MAX_RUN_CELLS + 1 }, () => longRunningRun.id),
    )).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects reuse of a run-start key for another immutable experiment revision", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = (await service.listExperiments(context))[0];
    const first = await service.startExperiment(context, experiment.experimentId, {
      idempotencyKey: "run-start-key-conflict",
      revisionId: experiment.id,
    });
    const revised = await service.updateExperiment(context, experiment.experimentId, { name: "Revised baseline" });

    await expect(service.startExperiment(context, experiment.experimentId, {
      idempotencyKey: "run-start-key-conflict",
      revisionId: revised.id,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await repository.listRuns(context.projectId)).toHaveLength(first.runIds.length);
  });

  it("does not let a late worker replace a terminal stale-run recovery result", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const runner = new DeterministicRunner();
    const execute = runner.execute.bind(runner);
    let releaseExecution!: () => void;
    let signalExecutionStarted!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
    runner.execute = async (request, preparation, signal) => {
      signalExecutionStarted();
      await executionGate;
      return execute(request, preparation, signal);
    };
    const service = createLabService(repository, runner);
    const experiment = (await service.listExperiments(context))[0];

    try {
      await service.startExperiment(context, experiment.experimentId);
      await executionStarted;
      expect(await service.recoverStaleRunsBefore("2050-01-01T00:00:00.000Z")).toBe(4);
      expect((await repository.listRuns(context.projectId)).every((run) => run.status === "error")).toBe(true);
    } finally {
      releaseExecution();
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await repository.listRuns(context.projectId)).every((run) => run.status === "error")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await repository.listRuns(context.projectId)).every((run) => run.status === "error")).toBe(true);
  });

  it("stops new starts and persists cancellation for accepted work during drain", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    let signalExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
    let executions = 0;
    const executor = {
      async execute(_request: Parameters<DeterministicRunner["execute"]>[0], _preparation?: unknown, signal?: AbortSignal) {
        executions += 1;
        signalExecutionStarted();
        return new Promise<Awaited<ReturnType<DeterministicRunner["execute"]>>>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const service = createLabService(repository, executor);
    const experiment = (await service.listExperiments(context))[0];

    await service.startExperiment(context, experiment.experimentId);
    await executionStarted;
    await service.drainAcceptedRuns(0);

    const runs = await repository.listRuns(context.projectId);
    expect(executions).toBe(1);
    expect(runs).toHaveLength(4);
    expect(runs.every((run) => run.status === "cancelled" && run.completedAt)).toBe(true);
    await expect(service.startExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("keeps purge blocked when TVIC cannot confirm runtime cleanup after cancellation", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    let signalExecutionStarted!: () => void;
    let signalDeletionObserved!: () => void;
    const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
    const deletionObserved = new Promise<void>((resolve) => { signalDeletionObserved = resolve; });
    const executor = {
      async execute(_request: Parameters<DeterministicRunner["execute"]>[0], _preparation?: unknown, signal?: AbortSignal) {
        signalExecutionStarted();
        return new Promise<Awaited<ReturnType<DeterministicRunner["execute"]>>>((_resolve, reject) => {
          const unconfirmed = () => {
            signalDeletionObserved();
            reject(Object.assign(new Error("TVIC cleanup could not be confirmed."), { code: "cancellation_unconfirmed" }));
          };
          if (signal?.aborted) unconfirmed();
          else signal?.addEventListener("abort", unconfirmed, { once: true });
        });
      },
    };
    const service = createLabService(repository, executor);
    const experiment = (await service.listExperiments(context))[0];

    await service.startExperiment(context, experiment.experimentId);
    await executionStarted;
    const purgeAttempt = expect(service.purgeProject(context)).rejects.toMatchObject({ statusCode: 409 });
    await deletionObserved;
    await expect(service.getBootstrap(context)).rejects.toMatchObject({ statusCode: 409 });
    await purgeAttempt;
    await expect(service.getBootstrap(context)).resolves.toMatchObject({ projectId: context.projectId });

    const runs = await repository.listRuns(context.projectId);
    const uncertainRun = runs.find((run) => run.error?.code === "cancellation_unconfirmed");
    expect(uncertainRun).toMatchObject({
      status: "error",
      error: { code: "cancellation_unconfirmed" },
    });
    expect((await repository.read(context.projectId)).projectPurge).toBeNull();
    await repository.pruneRunsBefore("2050-01-01T00:00:00.000Z");
    expect(await repository.listRuns(context.projectId, { runId: uncertainRun!.id })).toContainEqual(uncertainRun);
    await expect(service.deleteRun(context, uncertainRun!.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not start later cells or later runs after TVIC cleanup becomes unconfirmed", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    const scenario = initial.scenarios[0];
    const variant = initial.variants[0];
    experiment.mode = "tvic";
    experiment.scenarioIds = [scenario.scenarioId];
    experiment.scenarioRevisionIds = [scenario.id];
    experiment.variantIds = [variant.variantId];
    experiment.variantRevisionIds = [variant.id];
    experiment.repetitions = 2;
    const repository = new MemoryRepository(initial);
    let executions = 0;
    const executor = {
      async execute() {
        executions += 1;
        throw Object.assign(new Error("TVIC could not confirm runtime cleanup."), { code: "cancellation_unconfirmed" });
      },
    };
    const service = createLabService(repository, new DeterministicRunner(), { executors: { tvic: executor } });

    const result = await service.runExperiment(context, experiment.experimentId);

    expect(executions).toBe(1);
    expect(result.runs.map((run) => run.status)).toEqual(["error", "error"]);
    expect(result.runs.map((run) => run.error?.code)).toEqual([
      "cancellation_unconfirmed",
      "prior_runtime_cleanup_unconfirmed",
    ]);
    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists the cleanup marker and retains capacity after one transient marker-write failure", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    const scenario = initial.scenarios[0];
    const variant = initial.variants[0];
    experiment.mode = "tvic";
    experiment.scenarioIds = [scenario.scenarioId];
    experiment.scenarioRevisionIds = [scenario.id];
    experiment.variantIds = [variant.variantId];
    experiment.variantRevisionIds = [variant.id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const persistRun = repository.updateRun.bind(repository);
    let failMarkerWriteOnce = true;
    vi.spyOn(repository, "updateRun").mockImplementation(async (projectId, run) => {
      if (failMarkerWriteOnce && run.error?.code === "cancellation_unconfirmed") {
        failMarkerWriteOnce = false;
        throw new Error("Transient storage failure while writing runtime cleanup status.");
      }
      await persistRun(projectId, run);
    });
    const executor = {
      async execute() {
        throw Object.assign(new Error("TVIC could not confirm runtime cleanup."), { code: "cancellation_unconfirmed" });
      },
    };
    const service = createLabService(repository, new DeterministicRunner(), { executors: { tvic: executor } });

    await service.startExperiment(context, experiment.experimentId);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const [run] = await repository.listRuns(context.projectId);
      if (run?.status !== "queued" && run?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const [run] = await repository.listRuns(context.projectId);
    expect(failMarkerWriteOnce).toBe(false);
    expect(run).toMatchObject({ status: "error", error: { code: "cancellation_unconfirmed" } });
    expect(await repository.acquireProjectRunLock(context.projectId, "retry-after-marker", new Date(Date.now() + 60_000).toISOString())).toBe(false);

    const occupiedSlots = Array.from({ length: MAX_CONCURRENT_PROVIDER_RUNS - 1 }, (_, index) => ({
      projectId: `occupied-after-marker-${index}`,
      ownerId: `worker-after-marker-${index}`,
    }));
    for (const slot of occupiedSlots) {
      expect(await repository.acquireProviderRunSlot(slot.projectId, slot.ownerId, new Date(Date.now() + 60_000).toISOString())).toBe(true);
    }
    expect(await repository.acquireProviderRunSlot("overflow-after-marker", "worker-overflow", new Date(Date.now() + 60_000).toISOString())).toBe(false);
    for (const slot of occupiedSlots) await repository.releaseProviderRunSlot(slot.projectId, slot.ownerId);
  });

  it("purges one project idempotently and preserves linked Earshot references for Platform", async () => {
    const projectA = createSeedState("2026-01-01T00:00:00.000Z", "project-a", "user-a");
    const projectB = createSeedState("2026-01-01T00:00:00.000Z", "project-b", "user-b");
    const repository = new MemoryRepository(projectA, "project-a");
    for (const scenario of projectB.scenarios) await repository.addScenarioRevision("project-b", scenario);
    for (const variant of projectB.variants) await repository.addVariantRevision("project-b", variant);
    for (const experiment of projectB.experiments) await repository.addExperimentRevision("project-b", experiment);
    await repository.recordEarshotReference("project-a", {
      incidentId: "voice-labs-run-123",
      endpoint: "https://earshot.example/v1/incidents",
      deliveryStatus: "attached",
      upstreamProjectId: "earshot-project-a",
    });
    await repository.recordEarshotReference("project-a", {
      incidentId: "voice-labs-run-123",
      endpoint: "https://earshot.example/v1/incidents",
      deliveryStatus: "attempted",
      upstreamProjectId: "earshot-project-b",
    });
    const service = createLabService(repository, new DeterministicRunner());

    const receipt = await service.purgeProject({ userId: "user-a", projectId: "project-a" });
    expect(await service.purgeProject({ userId: "user-a", projectId: "project-a" })).toEqual(receipt);
    expect(receipt).toMatchObject({
      projectId: "project-a",
      status: "local_data_deleted",
      linkedEarshotIncidents: [
        { incidentId: "voice-labs-run-123", endpoint: "https://earshot.example/v1/incidents", deliveryStatus: "attached", upstreamProjectId: "earshot-project-a" },
        { incidentId: "voice-labs-run-123", endpoint: "https://earshot.example/v1/incidents", deliveryStatus: "attempted", upstreamProjectId: "earshot-project-b" },
      ],
    });
    expect((await repository.read("project-a")).scenarios).toHaveLength(0);
    expect((await repository.read("project-a")).projectPurge).toEqual(receipt);
    expect((await repository.read("project-b")).scenarios).toHaveLength(projectB.scenarios.length);
    const fullReceiptLookup = vi.spyOn(repository, "getProjectPurgeReceipt").mockRejectedValue(new Error("Availability must not load the full purge receipt."));
    await expect(service.getBootstrap({ userId: "user-a", projectId: "project-a" })).rejects.toMatchObject({ statusCode: 410 });
    expect(fullReceiptLookup).not.toHaveBeenCalled();
    await expect(service.getRun({ userId: "user-a", projectId: "project-a" }, "run-missing")).rejects.toMatchObject({ statusCode: 410 });
    await expect(service.getExperimentRunProgress({ userId: "user-a", projectId: "project-a" }, "missing", "missing-revision"))
      .rejects.toMatchObject({ statusCode: 410 });
    await expect(service.createScenario({ userId: "user-a", projectId: "project-a" }, {
      name: "Blocked after deletion",
      description: "",
      persona: "A caller",
      goal: "Resolve the request",
      userTurns: ["Please help."],
      expectedOutcomeFacts: [],
      forbiddenPhrases: [],
      requiredPhrases: [],
      expectedToolCalls: [],
      latencyBudgetMs: 1_000,
      tags: [],
    })).rejects.toMatchObject({ statusCode: 410 });
  });

  it("keeps Earshot references after run deletion and retains every destination", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = (await service.listExperiments(context))[0];
    const result = await service.runExperiment(context, experiment.experimentId);
    const incidentId = "shared-earshot-incident";
    const endpoints = [
      "https://earshot-old.example/v1/incidents",
      "https://earshot-current.example/v1/incidents",
    ];

    for (const [index, run] of result.runs.slice(0, 2).entries()) {
      await repository.saveRunEvidence(context.projectId, run.id, {
        source: "earshot",
        incidentId,
        endpoint: endpoints[index],
        status: "attached",
      });
      await service.deleteRun(context, run.id);
    }

    const receipt = await service.purgeProject(context);
    expect(receipt.linkedEarshotIncidents).toHaveLength(2);
    expect(receipt.linkedEarshotIncidents.map((reference) => reference.endpoint).sort()).toEqual([...endpoints].sort());
  });

  it("stops an in-flight Earshot retry before returning the project purge receipt", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    let signalAttachStarted!: () => void;
    let observedAbort = false;
    const attachStarted = new Promise<void>((resolve) => { signalAttachStarted = resolve; });
    const evidenceSink = {
      endpoint: "https://earshot.example/v1/incidents",
      referenceFor: () => ({ incidentId: "voice-labs-run-purge-race", endpoint: "https://earshot.example/v1/incidents", upstreamProjectId: "earshot-project", deliveryStatus: "attempted" as const }),
      async attach(_context: { projectId: string }, _run: unknown, signal?: AbortSignal) {
        signalAttachStarted();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const service = createLabService(repository, new DeterministicRunner(), { evidenceSink });

    await service.startExperiment(context, experiment.experimentId);
    await attachStarted;
    const receipt = await service.purgeProject(context);

    expect(observedAbort).toBe(true);
    expect(receipt.linkedEarshotIncidents).toEqual([{
      incidentId: "voice-labs-run-purge-race",
      endpoint: "https://earshot.example/v1/incidents",
      deliveryStatus: "attempted",
      upstreamProjectId: "earshot-project",
    }]);
    expect(await repository.listRuns(context.projectId)).toHaveLength(0);
  });

  it("does not purge project data while another worker owns an active run", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const runner = new DeterministicRunner();
    const execute = runner.execute.bind(runner);
    let releaseExecution!: () => void;
    let signalExecutionStarted!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
    runner.execute = async (request, preparation, signal) => {
      signalExecutionStarted();
      await executionGate;
      return execute(request, preparation, signal);
    };
    const runService = createLabService(repository, runner);
    const purgeService = createLabService(repository, new DeterministicRunner());
    const experiment = (await runService.listExperiments(context))[0];

    try {
      await runService.startExperiment(context, experiment.experimentId);
      await executionStarted;
      await expect(purgeService.purgeProject(context)).rejects.toMatchObject({ statusCode: 409 });
      expect((await repository.read(context.projectId)).projectPurge).toBeNull();
      expect((await repository.listRuns(context.projectId)).some((run) => run.status === "running")).toBe(true);
    } finally {
      releaseExecution();
    }

    await runService.drainAcceptedRuns(0);
    const receipt = await purgeService.purgeProject(context);
    expect(receipt.status).toBe("local_data_deleted");
    expect(await repository.listRuns(context.projectId)).toHaveLength(0);
  });

  it("plans and executes every scenario/variant/repetition cell", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner({ now: () => new Date("2026-01-01T00:00:00.000Z") }));
    const experiment = (await service.listExperiments(context))[0];

    const result = await service.runExperiment(context, experiment.experimentId);

    expect(result.runs).toHaveLength(4);
    expect(result.runs.map((run) => `${run.scenarioId}:${run.variantId}:${run.repetition}`)).toEqual([
      "scn_reschedule:var_reliable:1",
      "scn_reschedule:var_reliable:2",
      "scn_reschedule:var_fragile:1",
      "scn_reschedule:var_fragile:2",
    ]);
    expect(result.comparison.rows.map((row) => row.variantId)).toEqual(["var_reliable", "var_fragile"]);
  });

  it("keeps later attempts queued until their executor starts", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const runner = new DeterministicRunner();
    const originalUpdateRun = repository.updateRun.bind(repository);
    const originalExecute = runner.execute.bind(runner);
    let signalRunningAttempt!: () => void;
    let signalPersistedAttempt!: () => void;
    let releaseRunUpdate!: () => void;
    let releaseExecutor!: () => void;
    const runningAttemptStarted = new Promise<void>((resolve) => { signalRunningAttempt = resolve; });
    const runningAttemptPersisted = new Promise<void>((resolve) => { signalPersistedAttempt = resolve; });
    const runUpdateGate = new Promise<void>((resolve) => { releaseRunUpdate = resolve; });
    const executorGate = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    repository.updateRun = async (projectId, run) => {
      if (run.status === "running") {
        signalRunningAttempt();
        await runUpdateGate;
      }
      await originalUpdateRun(projectId, run);
      if (run.status === "running") signalPersistedAttempt();
    };
    runner.execute = async (request) => {
      await executorGate;
      return originalExecute(request);
    };
    const service = createLabService(repository, runner);
    const experiment = (await service.listExperiments(context))[0];

    try {
      await service.startExperiment(context, experiment.experimentId);
      await runningAttemptStarted;
      const beforeStart = await repository.listRuns(context.projectId);
      expect(beforeStart).toHaveLength(4);
      expect(beforeStart.every((run) => run.status === "queued" && run.startedAt === undefined && Boolean(run.queuedAt))).toBe(true);

      releaseRunUpdate();
      await runningAttemptPersisted;
      const whileExecuting = await repository.listRuns(context.projectId);
      expect(whileExecuting.filter((run) => run.status === "running")).toHaveLength(1);
      expect(whileExecuting.filter((run) => run.status === "queued")).toHaveLength(3);
      expect(whileExecuting.filter((run) => run.status === "running").every((run) => Boolean(run.startedAt))).toBe(true);
    } finally {
      releaseRunUpdate();
      releaseExecutor();
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const runs = await repository.listRuns(context.projectId);
      if (runs.every((run) => run.status !== "queued" && run.status !== "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await repository.listRuns(context.projectId)).every((run) => run.status !== "queued" && run.status !== "running")).toBe(true);
  });

  it("pages experiment history and returns metadata-only overview runs", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = (await service.listExperiments(context))[0];
    for (let run = 0; run < 13; run += 1) await service.runExperiment(context, experiment.experimentId);

    const firstPage = await service.getExperimentDetail(context, experiment.experimentId);
    expect(firstPage.runs).toHaveLength(50);
    expect(firstPage.runsHasMore).toBe(true);
    expect(firstPage.runsCursor).not.toBeNull();
    const olderPage = await service.getExperimentRuns(context, experiment.experimentId, firstPage.runsCursor!);
    expect(olderPage.runs).toHaveLength(2);
    expect(olderPage.hasMore).toBe(false);
    expect(olderPage.runs.some((run) => firstPage.runs.some((loaded) => loaded.id === run.id))).toBe(false);

    const bootstrap = await service.getBootstrap(context);
    expect(bootstrap.recentRuns).toHaveLength(24);
    expect("transcript" in bootstrap.recentRuns[0]).toBe(false);
  });

  it("promotes a scenario without mutating its immutable revision", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());

    const promoted = await service.promoteScenario(context, "scenario_reschedule");

    expect(promoted.scenarioId).toBe("scenario_reschedule");
    expect(promoted.revision).toBe(1);
    const updated = await service.updateScenario(context, "scenario_reschedule", { goal: "Move the appointment to Friday." });
    expect((await service.getBootstrap(context)).regressionScenarioRevisions).toEqual([{ scenarioId: "scenario_reschedule", revision: 1 }]);
    await service.promoteScenario(context, "scenario_reschedule", updated.id);
    expect((await service.getBootstrap(context)).regressionScenarioRevisions).toEqual([{ scenarioId: "scenario_reschedule", revision: 2 }]);
    await service.removePromotedScenario(context, "scenario_reschedule");
    expect((await service.getBootstrap(context)).regressionScenarioRevisions).toEqual([]);
  });

  it("fails closed when an external execution mode has no real adapter", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    initial.experiments[0].mode = "tvic";
    const service = createLabService(new MemoryRepository(initial), new DeterministicRunner());

    await expect(service.runExperiment(context, initial.experiments[0].experimentId)).rejects.toThrow("not configured locally: tvic");
  });

  it("rejects audio experiments before saving when a selected scenario lacks one fixture per turn", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const state = await repository.read(context.projectId);
    await expect(service.createExperiment(context, {
      name: "Audio without fixtures",
      description: "",
      scenarioIds: [state.scenarios[0].scenarioId],
      variantIds: [state.variants[0].variantId],
      repetitions: 1,
      mode: "audio",
    })).rejects.toMatchObject({ statusCode: 422 });
    expect((await service.listExperiments(context))).toHaveLength(1);
  });

  it("bounds immutable project catalog history", async () => {
    const initial = createSeedState();
    const scenario = initial.scenarios[0];
    initial.variants = [];
    initial.experiments = [];
    initial.scenarios = Array.from({ length: MAX_PROJECT_CATALOG_REVISIONS }, (_, index) => ({
      ...scenario,
      id: `scenario-revision-${index}`,
      scenarioId: `scenario-${index}`,
    }));
    const service = createLabService(new MemoryRepository(initial), new DeterministicRunner());

    await expect(service.createScenario(context, {
      name: "One more scenario",
      description: "",
      persona: "A caller",
      goal: "Complete the request",
      userTurns: ["Please help me."],
      expectedOutcomeFacts: [],
      forbiddenPhrases: [],
      requiredPhrases: [],
      expectedToolCalls: [],
      latencyBudgetMs: 1_000,
      tags: [],
    })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("preflights configured audio fixtures before persisting attempts or charging quota", async () => {
    const initial = createSeedState();
    initial.scenarios[0].audioFixtures = ["missing-first.wav", "missing-second.wav"];
    const experiment = initial.experiments[0];
    experiment.mode = "audio";
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const fallback = new DeterministicRunner();
    const audioExecutor = {
      async preflight(mode: string, scenarios?: readonly { audioFixtures?: string[] }[]) {
        expect(mode).toBe("audio");
        expect(scenarios?.[0]?.audioFixtures).toEqual(initial.scenarios[0].audioFixtures);
        throw Object.assign(new Error("Audio fixture was not found."), { statusCode: 422 });
      },
      execute: (request: Parameters<DeterministicRunner["execute"]>[0]) => fallback.execute(request),
    };
    const service = createLabService(repository, fallback, { executors: { audio: audioExecutor } });

    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 422 });
    expect(await repository.listRuns(context.projectId)).toHaveLength(0);
    expect(await repository.countProviderRunsSince(context.projectId, new Date(Date.now() - 60_000).toISOString())).toBe(0);
  });

  it("passes prepared executor inputs to each accepted attempt", async () => {
    const initial = createSeedState();
    initial.scenarios[0].audioFixtures = ["caller-1.wav", "caller-2.wav"];
    const experiment = initial.experiments[0];
    experiment.mode = "audio";
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const preparedInput = { kind: "test-preparation" };
    const fallback = new DeterministicRunner();
    const audioExecutor = {
      async preflight(mode: string, scenarios?: readonly { id: string }[]) {
        expect(mode).toBe("audio");
        expect(scenarios?.map((scenario) => scenario.id)).toEqual([initial.scenarios[0].id]);
        return preparedInput;
      },
      async execute(request: Parameters<DeterministicRunner["execute"]>[0], preparation?: unknown) {
        expect(preparation).toBe(preparedInput);
        const result = await fallback.execute(request);
        return { ...result, mode: request.mode };
      },
    };
    const service = createLabService(new MemoryRepository(initial), fallback, { executors: { audio: audioExecutor } });

    await expect(service.runExperiment(context, experiment.experimentId)).resolves.toMatchObject({ runs: [{ mode: "audio" }] });
  });

  it("retries pending Earshot metadata from the durable completed run and reconciles the same incident", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    let calls = 0;
    const evidenceSink = {
      endpoint: "http://earshot.test/v1/incidents",
      async attach() {
        calls += 1;
        if (calls === 1) throw new Error("The first response was lost after ingest.");
        return {
          source: "earshot" as const,
          incidentId: "voice-labs-run-run_reconciled",
          sessionId: "session-reconciled",
          bundleDigest: "digest-reconciled",
          endpoint: this.endpoint,
          status: "attached" as const,
        };
      },
    };
    const service = createLabService(repository, new DeterministicRunner(), { evidenceSink });

    const completed = await service.runExperiment(context, experiment.experimentId);
    const run = completed.runs[0];
    expect(run.evidence).toMatchObject({ status: "pending", attemptCount: 1 });
    const progress = await service.getRunStatus(context, run.id);
    expect(progress).toMatchObject({
      id: run.id,
      status: run.status,
      evidence: { status: "pending" },
    });
    expect(progress.evidence).not.toHaveProperty("attemptCount");
    const now = Date.now();
    expect(await repository.claimPendingEvidenceDue(
      new Date(now + 120_000).toISOString(),
      "other-evidence-worker",
      new Date(now + 240_000).toISOString(),
      1,
    )).toHaveLength(1);
    expect(await service.retryPendingEvidenceBefore(new Date(now + 120_000).toISOString())).toBe(0);
    await repository.releasePendingEvidenceClaim(context.projectId, run.id, "other-evidence-worker");
    expect(await service.retryPendingEvidenceBefore(new Date(Date.now() + 120_000).toISOString())).toBe(1);
    expect(await service.getRun(context, run.id)).toMatchObject({
      evidence: { status: "attached", incidentId: "voice-labs-run-run_reconciled" },
    });
    expect(await service.retryPendingEvidenceBefore(new Date(Date.now() + 120_000).toISOString())).toBe(0);
    expect(calls).toBe(2);
  });

  it("marks Earshot evidence unavailable only after its bounded retry budget is exhausted", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const evidenceSink = {
      endpoint: "http://earshot.test/v1/incidents",
      async attach() { throw new Error("Earshot is temporarily unavailable."); },
    };
    const service = createLabService(repository, new DeterministicRunner(), { evidenceSink });
    const completed = await service.runExperiment(context, experiment.experimentId);
    const run = completed.runs[0];

    for (let attempt = 1; attempt < 8; attempt += 1) {
      await service.retryPendingEvidenceBefore(new Date(Date.now() + 120_000).toISOString());
    }
    expect(await service.getRun(context, run.id)).toMatchObject({
      evidence: { status: "unavailable", attemptCount: 8 },
    });
    await expect(service.deleteRun(context, run.id)).resolves.toBeUndefined();
  });

  it("uses the bounded retry budget when the Earshot sink is missing after restart", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const evidenceSink = {
      endpoint: "http://earshot.test/v1/incidents",
      async attach() { throw new Error("The connection failed after the POST was sent."); },
    };
    const configuredService = createLabService(repository, new DeterministicRunner(), { evidenceSink });
    const completed = await configuredService.runExperiment(context, experiment.experimentId);
    const run = completed.runs[0];
    expect(run.evidence).toMatchObject({ status: "pending", attemptCount: 1 });

    const restartedService = createLabService(repository, new DeterministicRunner());
    const beforeRetryAt = new Date(Date.parse(run.evidence!.retryAt!) - 1).toISOString();
    expect(await restartedService.retryPendingEvidenceBefore(beforeRetryAt)).toBe(0);
    await expect(restartedService.getRun(context, run.id)).resolves.toMatchObject({
      evidence: { status: "pending", attemptCount: 1 },
    });
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await restartedService.retryPendingEvidenceBefore(new Date(Date.now() + 120_000).toISOString());
    }

    await expect(restartedService.getRun(context, run.id)).resolves.toMatchObject({
      evidence: { status: "unavailable", attemptCount: 8 },
    });
    await expect(restartedService.deleteRun(context, run.id)).resolves.toBeUndefined();
  });

  it("rejects evidence-capturing runs when the project outbox backlog is full", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    const scenario = initial.scenarios[0];
    const variant = initial.variants[0];
    initial.runs = Array.from({ length: MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT }, (_, index) => ({
      id: `pending-evidence-${index}`,
      projectId: context.projectId,
      experimentId: experiment.experimentId,
      experimentRevisionId: experiment.id,
      scenarioId: scenario.id,
      variantId: variant.id,
      repetition: 1,
      seed: index,
      mode: "deterministic" as const,
      queuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.001Z",
      durationMs: 1,
      latencyScope: "executor_wall_clock_including_setup_excluding_persistence" as const,
      transcript: [],
      toolCalls: [],
      finalFacts: [],
      metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
      status: "passed" as const,
      evidence: { source: "earshot" as const, endpoint: "http://earshot.test", status: "pending" as const },
    }));
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());

    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 429 });
    expect(await repository.countPendingEvidence(context.projectId)).toBe(MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT);
  });

  it("keeps run summary names tied to the exact revisions after catalog edits", async () => {
    const initial = createSeedState();
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    await service.runExperiment(context, experiment.experimentId);
    await service.updateScenario(context, initial.scenarios[0].scenarioId, { name: "Updated scenario" });

    const run = (await service.getBootstrap(context)).recentRuns[0];
    expect(run.scenarioName).toBe(initial.scenarios[0].name);
    expect(run.variantName).toBe(initial.variants.find((variant) => variant.id === run.variantId)?.name);
    expect(run.experimentName).toBe(experiment.name);
  });

  it("checks the rolling provider-attempt quota before accepting another run", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.mode = "tvic";
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner(), { executors: { tvic: new DeterministicRunner() } });
    const firstRun = (await service.runExperiment(context, experiment.experimentId)).runs[0];
    const additionalAttempts = Array.from({ length: MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY - 1 }, (_, index) => ({
      ...firstRun,
      id: `provider-attempt-${index}`,
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    }));
    await repository.appendRuns(context.projectId, additionalAttempts);
    await service.deleteRun(context, firstRun.id);
    expect(await repository.countProviderRunsSince(context.projectId, new Date(Date.now() - 60_000).toISOString()))
      .toBe(MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY);

    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("checks provider quota before reading audio fixtures", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    const scenario = initial.scenarios.find((item) => item.id === experiment.scenarioRevisionIds[0])!;
    scenario.audioFixtures = scenario.userTurns.map((_, index) => `fixture-${index}.wav`);
    experiment.mode = "audio";
    experiment.scenarioIds = [scenario.scenarioId];
    experiment.scenarioRevisionIds = [scenario.id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    vi.spyOn(repository, "countProviderRunsSince").mockResolvedValue(MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY);
    const fallback = new DeterministicRunner();
    const preflight = vi.fn();
    const service = createLabService(repository, fallback, {
      executors: { audio: {
        preflight,
        execute: (request) => fallback.execute(request),
      } },
    });

    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 429 });
    expect(preflight).not.toHaveBeenCalled();
    expect(await repository.listRuns(context.projectId)).toHaveLength(0);
  });

  it("checks provider capacity before reading audio fixtures", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    const scenario = initial.scenarios.find((item) => item.id === experiment.scenarioRevisionIds[0])!;
    scenario.audioFixtures = scenario.userTurns.map((_, index) => `fixture-${index}.wav`);
    experiment.mode = "audio";
    experiment.scenarioIds = [scenario.scenarioId];
    experiment.scenarioRevisionIds = [scenario.id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    for (let index = 0; index < MAX_CONCURRENT_PROVIDER_RUNS; index += 1) {
      await repository.acquireProviderRunSlot(`occupied-project-${index}`, `occupied-owner-${index}`, new Date(Date.now() + 60_000).toISOString());
    }
    const fallback = new DeterministicRunner();
    const preflight = vi.fn();
    const service = createLabService(repository, fallback, {
      executors: { audio: {
        preflight,
        execute: (request) => fallback.execute(request),
      } },
    });

    await expect(service.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("no automated cleanup reconciliation"),
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(await repository.listRuns(context.projectId)).toHaveLength(0);
  });

  it("uses the repository lease to serialize runs across service instances", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deterministic = new DeterministicRunner();
    const gatedExecutor = {
      async execute(request: Parameters<DeterministicRunner["execute"]>[0]) {
        signalStarted();
        await gate;
        return deterministic.execute(request);
      },
    };
    const firstService = createLabService(repository, gatedExecutor);
    const secondService = createLabService(repository, deterministic);

    const firstRun = firstService.runExperiment(context, experiment.experimentId);
    await started;
    await expect(secondService.runExperiment(context, experiment.experimentId)).rejects.toMatchObject({ statusCode: 409 });
    release();
    await expect(firstRun).resolves.toMatchObject({ runs: [{ status: "passed" }] });
    await expect(secondService.runExperiment(context, experiment.experimentId)).resolves.toMatchObject({ runs: [{ status: "passed" }] });
  });

  it("preserves active attempts and marks abandoned attempts as errors", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 2;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const result = await service.runExperiment(context, experiment.experimentId);
    const activeRun = { ...result.runs[0], status: "running" as const, startedAt: "2000-01-01T00:00:00.000Z" };
    await repository.updateRun(context.projectId, activeRun);
    const pendingEvidenceRun = {
      ...result.runs[1],
      startedAt: "2000-01-01T00:00:00.000Z",
      evidence: { source: "earshot" as const, endpoint: "http://earshot.test", status: "pending" as const },
    };
    await repository.updateRun(context.projectId, pendingEvidenceRun);

    await expect(service.deleteRun(context, activeRun.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.deleteRun(context, pendingEvidenceRun.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await repository.pruneRunsBefore("2001-01-01T00:00:00.000Z")).toBe(0);
    expect(await service.recoverStaleRunsBefore("2001-01-01T00:00:00.000Z")).toBe(1);
    await expect(service.getRun(context, activeRun.id)).resolves.toMatchObject({
      status: "error",
      error: { code: "run_abandoned" },
    });
    await expect(service.getRun(context, pendingEvidenceRun.id)).resolves.toMatchObject({
      status: "passed",
      evidence: { status: "pending" },
    });
  });

  it("keeps a stale provider runtime blocked through recovery and after a repository restart", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const experiment = initial.experiments[0];
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const firstRepository = new MemoryRepository(initial);
    const firstService = createLabService(firstRepository, new DeterministicRunner());
    const completed = await firstService.runExperiment(context, experiment.experimentId);
    await firstRepository.updateRun(context.projectId, {
      ...completed.runs[0],
      mode: "tvic",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      completedAt: undefined,
      error: undefined,
    });

    // A new repository instance has no in-process lock leases, as after a worker restart.
    const restartedRepository = new MemoryRepository(await firstRepository.read(context.projectId));
    const restartedService = createLabService(restartedRepository, new DeterministicRunner());
    expect(await restartedRepository.acquireProjectRunLock(context.projectId, "new-worker", "2050-01-01T00:00:00.000Z")).toBe(false);

    expect(await restartedService.recoverStaleRunsBefore("2001-01-01T00:00:00.000Z")).toBe(1);
    await expect(restartedService.getRun(context, completed.runs[0].id)).resolves.toMatchObject({
      status: "error",
      error: { code: "cancellation_unconfirmed" },
    });
    expect(await restartedRepository.acquireProjectRunLock(context.projectId, "new-worker", "2050-01-01T00:00:00.000Z")).toBe(false);

    for (let slot = 0; slot < MAX_CONCURRENT_PROVIDER_RUNS - 1; slot += 1) {
      expect(await restartedRepository.acquireProviderRunSlot(`other-${slot}`, `worker-${slot}`, "2050-01-01T00:00:00.000Z")).toBe(true);
    }
    expect(await restartedRepository.acquireProviderRunSlot("last-slot", "last-worker", "2050-01-01T00:00:00.000Z")).toBe(false);
  });

  it("does not retry Earshot evidence for an abandoned run that never started", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = (await service.listExperiments(context))[0];
    const completed = await service.runExperiment(context, experiment.experimentId);
    const completedRun = completed.runs[0];
    const abandonedQueuedRun = {
      ...completedRun,
      status: "queued" as const,
      queuedAt: "2000-01-01T00:00:00.000Z",
      startedAt: undefined,
      completedAt: undefined,
      evidence: {
        source: "earshot" as const,
        endpoint: "http://earshot.test/v1/incidents",
        status: "pending" as const,
      },
    };
    await repository.updateRun(context.projectId, abandonedQueuedRun);

    expect(await service.recoverStaleRunsBefore("2001-01-01T00:00:00.000Z")).toBe(1);
    await expect(service.getRun(context, completedRun.id)).resolves.toMatchObject({
      status: "error",
      evidence: { status: "unavailable", message: "The run did not start, so there is no completed result to attach to Earshot." },
    });
    await expect(service.deleteRun(context, completedRun.id)).resolves.toBeUndefined();
  });

  it("pins experiment revisions to immutable scenario and candidate revisions", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const originalExperiment = (await service.listExperiments(context))[0];
    const originalScenarioRevision = originalExperiment.scenarioRevisionIds[0];

    await service.updateScenario(context, originalExperiment.scenarioIds[0], { goal: "Move the appointment to Friday." });
    const originalRun = await service.runExperiment(context, originalExperiment.experimentId);
    expect(originalRun.runs.every((run) => run.scenarioId === originalScenarioRevision)).toBe(true);

    const nextExperiment = await service.updateExperiment(context, originalExperiment.experimentId, { name: "Friday reschedule" });
    expect(nextExperiment.revision).toBe(2);
    expect(nextExperiment.scenarioRevisionIds[0]).not.toBe(originalScenarioRevision);
    const nextRun = await service.runExperiment(context, originalExperiment.experimentId);
    expect(nextRun.runs.every((run) => run.scenarioId === nextExperiment.scenarioRevisionIds[0])).toBe(true);
    const latestDetail = await service.getExperimentDetail(context, originalExperiment.experimentId);
    expect(latestDetail.revisions).toHaveLength(2);
    const historicalDetail = await service.getExperimentDetail(context, originalExperiment.experimentId, originalExperiment.id);
    expect(historicalDetail.experiment.id).toBe(originalExperiment.id);
    expect(historicalDetail.runs).toHaveLength(originalRun.runs.length);
    expect(historicalDetail.runs.every((run) => run.scenarioId === originalScenarioRevision)).toBe(true);
    expect((await service.exportExperiment(context, originalExperiment.experimentId, originalExperiment.id)).runs).toHaveLength(originalRun.runs.length);
  });

  it("does not expose partial attempt sets when batch preparation fails", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    repository.appendRuns = async () => {
      throw new Error("simulated storage failure");
    };
    const service = createLabService(repository, new DeterministicRunner());
    const experiment = (await service.listExperiments(context))[0];

    await expect(service.startExperiment(context, experiment.experimentId)).rejects.toThrow("simulated storage failure");
    const attempts = await repository.listRuns(context.projectId);
    expect(attempts).toHaveLength(0);
  });

  it("resolves pending evidence if persisting the executor-start transition fails", async () => {
    const initial = createSeedState();
    const experiment = initial.experiments[0];
    experiment.captureEvidence = true;
    experiment.scenarioIds = [initial.scenarios[0].scenarioId];
    experiment.scenarioRevisionIds = [initial.scenarios[0].id];
    experiment.variantIds = [initial.variants[0].variantId];
    experiment.variantRevisionIds = [initial.variants[0].id];
    experiment.repetitions = 1;
    const repository = new MemoryRepository(initial);
    const originalUpdateRun = repository.updateRun.bind(repository);
    let failRunningTransition = true;
    let notifyRecovery!: () => void;
    const recoveryCompleted = new Promise<void>((resolve) => { notifyRecovery = resolve; });
    repository.updateRun = async (projectId, run) => {
      if (run.status === "running" && failRunningTransition) {
        failRunningTransition = false;
        throw new Error("Could not persist executor start.");
      }
      await originalUpdateRun(projectId, run);
      if (run.status === "error") notifyRecovery();
    };
    const service = createLabService(repository, new DeterministicRunner());

    const accepted = await service.startExperiment(context, experiment.experimentId);
    expect(accepted).toMatchObject({ status: "queued" });
    await recoveryCompleted;

    await expect(service.getRun(context, accepted.runIds[0])).resolves.toMatchObject({
      status: "error",
      evidence: { status: "unavailable", message: "The run did not start, so there is no completed result to attach to Earshot." },
    });
  });

  it("keeps records isolated by project and user context", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());
    const other = { userId: "other-user", projectId: "other-project" };
    const localBefore = await service.getBootstrap(context);
    expect((await service.getBootstrap(other)).scenarios).toHaveLength(0);

    await service.createScenario(other, {
      name: "Other project case", description: "", persona: "Caller", goal: "Resolve an issue", userTurns: ["Please help."],
      expectedOutcomeFacts: [], forbiddenPhrases: [], requiredPhrases: [], expectedToolCalls: [], latencyBudgetMs: 1_000, tags: [],
    });

    expect((await service.getBootstrap(context)).scenarios).toHaveLength(localBefore.scenarios.length);
    expect((await service.getBootstrap(other)).scenarios[0].projectId).toBe(other.projectId);
    await expect(service.getRun(other, localBefore.recentRuns[0]?.id ?? "run-missing")).rejects.toThrow("Run not found");
  });

  it("retains a completed run while Earshot metadata capture retries and hides upstream errors", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    initial.experiments[0].scenarioIds = [initial.scenarios[0].scenarioId];
    initial.experiments[0].scenarioRevisionIds = [initial.scenarios[0].id];
    initial.experiments[0].variantIds = [initial.variants[0].variantId];
    initial.experiments[0].variantRevisionIds = [initial.variants[0].id];
    initial.experiments[0].repetitions = 1;
    initial.experiments[0].captureEvidence = true;
    const repository = new MemoryRepository(initial);
    const service = createLabService(repository, new DeterministicRunner(), {
      evidenceSink: { endpoint: "http://127.0.0.1:4319/v1/incidents", async attach() { throw new Error("private upstream response"); } },
    });

    const result = await service.runExperiment(context, initial.experiments[0].experimentId);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].evidence).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(result.runs[0].evidence?.message ?? "").not.toContain("private upstream response");
    expect((await repository.read(context.projectId)).runs).toHaveLength(1);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await service.retryPendingEvidenceBefore(new Date(Date.now() + 120_000).toISOString());
    }
    await expect(service.getRun(context, result.runs[0].id)).resolves.toMatchObject({
      evidence: { status: "unavailable", attemptCount: 8 },
    });
  });

  it("preserves an executor error instead of scoring a failed provider run as healthy", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    initial.experiments[0].mode = "tvic";
    initial.experiments[0].variantIds = [initial.variants[0].variantId];
    initial.experiments[0].variantRevisionIds = [initial.variants[0].id];
    initial.experiments[0].repetitions = 1;
    const service = createLabService(new MemoryRepository(initial), new DeterministicRunner(), {
      executors: {
        tvic: {
          async execute(request) {
            return {
              id: "run_provider_error",
              projectId: request.context.projectId,
              experimentId: request.experimentId,
              experimentRevisionId: request.experimentRevisionId,
              scenarioId: request.scenario.id,
              variantId: request.variant.id,
              repetition: request.repetition,
              seed: request.seed,
              mode: request.mode,
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:00.001Z",
              durationMs: 1,
              latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
              transcript: [],
              toolCalls: [],
              finalFacts: [],
              metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
              error: { code: "provider.auth_failed", message: "Provider rejected the request." },
              status: "error",
            };
          },
        },
      },
    });

    const result = await service.runExperiment(context, initial.experiments[0].experimentId);

    expect(result.runs[0].status).toBe("error");
    expect(result.comparison.totalFailed).toBe(1);
  });
});
