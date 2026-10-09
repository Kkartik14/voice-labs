import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresRepository } from "./postgres-repository.js";

describe("PostgresRepository keyed status lookups", () => {
  it("reads the run and project purge fence in one query without hydrating the catalog", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({
      rows: [{ run: null, project_purged: true }],
    }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.getRunWithProjectStatus("project-a", "run-a")).resolves.toEqual({
      run: undefined,
      projectPurged: true,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual(["project-a", "run-a"]);
    expect(sql).toContain("voice_labs_runs");
    expect(sql).toContain("voice_labs_project_purge_receipts");
    expect(sql).toContain("project_purged");
    expect(sql).not.toContain("purge_row.receipt");
    expect(sql).not.toMatch(/voice_labs_(experiments|scenarios|variants)/);
  });

  it("loads the full purge receipt by key for idempotent deletion responses", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [] }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.getProjectPurgeReceipt("project-a")).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual(["project-a"]);
    expect(sql).toContain("voice_labs_project_purge_receipts");
    expect(sql).not.toMatch(/voice_labs_(experiments|scenarios|variants|runs)/);
  });

  it("checks project availability with an indexed existence query", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [{ purged: true }] }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.isProjectPurged("project-a")).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual(["project-a"]);
    expect(sql).toMatch(/SELECT EXISTS\s*\(SELECT 1 FROM voice_labs_project_purge_receipts/);
    expect(sql).not.toContain("SELECT receipt");
  });

  it("skips purge receipt JSON when catalog state only needs availability checked separately", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [] }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.read("project-a", {
      latestCatalogOnly: true,
      includeProjectPurgeReceipt: false,
    })).resolves.toMatchObject({ projectPurge: null });

    expect(query.mock.calls.some(([sql]) => sql.includes("SELECT receipt FROM voice_labs_project_purge_receipts"))).toBe(false);
  });

  it("projects only run status, evidence, and purge state for polling", async () => {
    const evidence = {
      status: "pending" as const,
      sessionId: "session-a",
    };
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({
      rows: [{ id: "run-a", status: "passed", evidence, project_purged: false }],
    }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.getRunProgressWithProjectStatus("project-a", "run-a")).resolves.toEqual({
      progress: { id: "run-a", status: "passed", evidence },
      projectPurged: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual(["project-a", "run-a"]);
    expect(sql).toContain("run_row.payload->'evidence'");
    expect(sql).not.toContain("payload->'error'");
    expect(sql).not.toContain("run_row.payload AS run");
    expect(sql).not.toContain("purge_row.receipt");
    expect(sql).not.toMatch(/source|endpoint/);
    expect(sql).not.toMatch(/incidentId|upstreamProjectId|bundleDigest|attemptCount|retryAt/);
    expect(sql).not.toMatch(/voice_labs_(experiments|scenarios|variants)/);
  });

  it("lists bounded experiment statuses without reading run payloads", async () => {
    const progress = [{ id: "run-a", status: "running" }];
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({
      rows: [{ experiment_found: true, project_purged: false, runs: progress, missing_run_ids: [] }],
    }));
    const repository = new PostgresRepository({ query } as unknown as Pool);

    await expect(repository.getExperimentRunProgressWithProjectStatus("project-a", "experiment-a", "revision-a", 50, ["run-a"])).resolves.toEqual({
      experimentFound: true,
      runs: progress,
      missingRunIds: [],
      projectPurged: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual(["project-a", "experiment-a", "revision-a", 50, ["run-a"]]);
    expect(sql).toContain("voice_labs_runs");
    expect(sql).toContain("voice_labs_project_purge_receipts");
    expect(sql).not.toContain("purge_row.receipt");
    expect(sql).toContain("jsonb_build_object('id', status_rows.id, 'status', status_rows.status)");
    expect(sql).toContain("active_run.status IN ('queued', 'running')");
    expect(sql).not.toContain("payload AS");
    expect(sql).not.toMatch(/payload->|voice_labs_(scenarios|variants)/);
  });
});
