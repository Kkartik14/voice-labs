import { describe, expect, it } from "vitest";
import { compareRuns } from "./compare.js";
import { evaluateRun } from "./evaluate.js";
import type { RunArtifact, ScenarioRevision, VariantRevision } from "./model.js";

const scenario: ScenarioRevision = {
  id: "scn_appointment_1",
  scenarioId: "scenario_appointment",
  revision: 1,
  name: "Reschedule an appointment",
  description: "A caller changes an existing appointment.",
  persona: "A busy caller who gives details out of order.",
  goal: "Move the appointment to tomorrow morning",
  userTurns: ["I need to move my appointment to tomorrow morning."],
  expectedOutcomeFacts: ["appointment.rescheduled", "confirmation.shared"],
  forbiddenPhrases: ["I cannot help"],
  requiredPhrases: ["tomorrow"],
  expectedToolCalls: ["appointments.reschedule"],
  latencyBudgetMs: 1_000,
  tags: ["critical"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const variant: VariantRevision = {
  id: "var_reliable_1",
  variantId: "variant_reliable",
  revision: 1,
  name: "Reliable baseline",
  description: "Completes the request and confirms the result.",
  instructions: "Be reliable.",
  strategy: "reliable",
  reliability: 1,
  toolSuccessRate: 1,
  latencyMs: 120,
  providerLabel: "deterministic",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const secondVariant: VariantRevision = {
  ...variant,
  id: "var_fragile_1",
  variantId: "variant_fragile",
  name: "Fragile candidate",
  strategy: "fragile",
};

function run(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    id: "run_1",
    experimentId: "exp_1",
    scenarioId: scenario.id,
    variantId: variant.id,
    repetition: 1,
    seed: 42,
    mode: "deterministic",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.200Z",
    durationMs: 200,
    transcript: [
      { index: 0, speaker: "user", text: scenario.userTurns[0], offsetMs: 0 },
      { index: 1, speaker: "assistant", text: "Done for tomorrow.", offsetMs: 120 },
    ],
    toolCalls: [
      {
        id: "tool_1",
        name: "appointments.reschedule",
        arguments: { date: "tomorrow" },
        status: "succeeded",
        elapsedMs: 40,
      },
    ],
    finalFacts: ["appointment.rescheduled", "confirmation.shared"],
    metrics: { turnCount: 1, toolCallCount: 1, audioExercised: false },
    status: "passed",
    ...overrides,
  };
}

describe("evaluateRun", () => {
  it("passes deterministic outcome, guardrail, phrase, tool, and latency checks", () => {
    const results = evaluateRun(run(), scenario);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.status === "passed")).toBe(true);
    expect(results.every((result) => result.score === 1)).toBe(true);
  });

  it("fails on missing outcome evidence and failed tool calls", () => {
    const results = evaluateRun(
      run({
        transcript: [
          { index: 0, speaker: "user", text: scenario.userTurns[0], offsetMs: 0 },
          { index: 1, speaker: "assistant", text: "I cannot help with that.", offsetMs: 120 },
        ],
        toolCalls: [
          {
            id: "tool_1",
            name: "appointments.reschedule",
            arguments: {},
            status: "failed",
            elapsedMs: 40,
          },
        ],
        finalFacts: ["appointment.rescheduled"],
      }),
      scenario,
    );

    expect(results.find((result) => result.kind === "outcome")?.status).toBe("failed");
    expect(results.find((result) => result.kind === "tool_call")?.status).toBe("failed");
    expect(results.find((result) => result.kind === "guardrail")?.status).toBe("failed");
  });
});

describe("compareRuns", () => {
  it("shows per-variant pass rates and keeps unknown evaluations visible", () => {
    const incomplete = run({
      id: "run_2",
      variantId: "var_fragile_1",
      durationMs: 2_000,
      finalFacts: [],
      status: "failed",
    });
    const comparison = compareRuns([run(), incomplete], [variant, secondVariant]);

    expect(comparison.rows).toHaveLength(2);
    expect(comparison.rows.find((row) => row.variantId === variant.id)?.passRate).toBe(1);
    expect(comparison.rows.find((row) => row.variantId === "var_fragile_1")?.failedRuns).toBeGreaterThan(0);
    expect(comparison.rows.find((row) => row.variantId === "var_fragile_1")?.unknownRate).toBe(0);
  });
});
