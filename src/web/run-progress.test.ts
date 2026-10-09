import { describe, expect, it } from "vitest";
import type { RunArtifact } from "../domain/model.js";
import { mergeRunProgress } from "./run-progress.js";

describe("run progress state updates", () => {
  it("preserves identity for unchanged polls and only replaces changed progress fields", () => {
    const transcript: RunArtifact["transcript"] = [];
    const original: RunArtifact = {
      id: "run-a",
      projectId: "project-a",
      experimentId: "experiment-a",
      experimentRevisionId: "revision-a",
      scenarioId: "scenario-a",
      variantId: "variant-a",
      repetition: 1,
      seed: 1,
      mode: "deterministic",
      latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
      transcript,
      toolCalls: [],
      finalFacts: [],
      metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
      status: "passed",
      evidence: { source: "earshot", endpoint: "https://earshot.example", status: "pending", sessionId: "session-a", message: "Waiting." },
    };

    const unchanged = mergeRunProgress(original, {
      id: original.id,
      status: "passed",
      evidence: { status: "pending", sessionId: "session-a", message: "Waiting." },
    });
    const updated = mergeRunProgress(original, {
      id: original.id,
      status: "passed",
      evidence: { status: "attached", sessionId: "session-a", message: "Delivered." },
    });

    expect(unchanged).toBe(original);
    expect(updated).not.toBe(original);
    expect(updated.status).toBe("passed");
    expect(updated.evidence).toEqual({ ...original.evidence, status: "attached", message: "Delivered." });
    expect(updated.transcript).toBe(transcript);
  });
});
