import { describe, expect, it } from "vitest";
import { createLabService } from "./service.js";
import { MemoryRepository } from "../adapters/memory-repository.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createSeedState } from "../adapters/seed.js";

describe("LabService", () => {
  it("plans and executes every scenario/variant/repetition cell", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner({ now: () => new Date("2026-01-01T00:00:00.000Z") }));
    const experiment = (await service.listExperiments())[0];

    const result = await service.runExperiment(experiment.id);

    expect(result.runs).toHaveLength(4);
    expect(result.runs.map((run) => `${run.scenarioId}:${run.variantId}:${run.repetition}`)).toEqual([
      "scn_reschedule:var_reliable:1",
      "scn_reschedule:var_reliable:2",
      "scn_reschedule:var_fragile:1",
      "scn_reschedule:var_fragile:2",
    ]);
    expect(result.comparison.rows.map((row) => row.variantId)).toEqual(["var_reliable", "var_fragile"]);
  });

  it("promotes a scenario without mutating its immutable revision", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    const service = createLabService(repository, new DeterministicRunner());

    const promoted = await service.promoteScenario("scenario_reschedule");

    expect(promoted.scenarioId).toBe("scenario_reschedule");
    expect(promoted.revision).toBe(1);
    expect((await service.getBootstrap()).regressionScenarioIds).toContain("scenario_reschedule");
  });

  it("fails closed when an external execution mode has no real adapter", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    initial.experiments[0].mode = "tvic";
    const service = createLabService(new MemoryRepository(initial), new DeterministicRunner());

    await expect(service.runExperiment(initial.experiments[0].id)).rejects.toThrow("not configured locally: tvic");
  });

  it("preserves an executor error instead of scoring a failed provider run as healthy", async () => {
    const initial = createSeedState("2026-01-01T00:00:00.000Z");
    initial.experiments[0].mode = "tvic";
    initial.experiments[0].variantIds = [initial.variants[0].variantId];
    initial.experiments[0].repetitions = 1;
    const service = createLabService(new MemoryRepository(initial), new DeterministicRunner(), {
      executors: {
        tvic: {
          async execute(request) {
            return {
              id: "run_provider_error",
              experimentId: request.experimentId,
              scenarioId: request.scenario.id,
              variantId: request.variant.id,
              repetition: request.repetition,
              seed: request.seed,
              mode: request.mode,
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:00.001Z",
              durationMs: 1,
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

    const result = await service.runExperiment(initial.experiments[0].id);

    expect(result.runs[0].status).toBe("error");
    expect(result.comparison.totalFailed).toBe(1);
  });
});
