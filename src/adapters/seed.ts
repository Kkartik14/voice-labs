import { defaultEvaluators } from "../domain/evaluate.js";
import type { LabState } from "../domain/model.js";

export function createSeedState(now = new Date().toISOString()): LabState {
  const scenario = {
    id: "scn_reschedule",
    scenarioId: "scenario_reschedule",
    revision: 1,
    name: "Reschedule an appointment",
    description: "A caller changes an existing appointment and needs a trustworthy confirmation.",
    persona: "A busy caller who gives details out of order and wants a concise answer.",
    goal: "Move the appointment to tomorrow morning",
    userTurns: [
      "Hi, I need to move my appointment to tomorrow morning.",
      "Tuesday at 10 works for me. Can you confirm it?",
    ],
    expectedOutcomeFacts: ["appointment.rescheduled", "confirmation.shared"],
    forbiddenPhrases: ["I cannot help", "I don't know"],
    requiredPhrases: ["tomorrow", "10"],
    expectedToolCalls: ["appointments.reschedule"],
    latencyBudgetMs: 1_400,
    tags: ["critical", "scheduling"],
    createdAt: now,
  };
  const reliable = {
    id: "var_reliable",
    variantId: "variant_reliable",
    revision: 1,
    name: "Reliable baseline",
    description: "A careful candidate that confirms state after a successful tool call.",
    instructions: "Be clear, complete the request, and confirm the final state.",
    strategy: "reliable" as const,
    reliability: 1,
    toolSuccessRate: 1,
    latencyMs: 180,
    providerLabel: "deterministic / baseline",
    createdAt: now,
  };
  const fragile = {
    id: "var_fragile",
    variantId: "variant_fragile",
    revision: 1,
    name: "Fast but fragile",
    description: "A faster candidate that occasionally loses the confirmation step.",
    instructions: "Be brief and move quickly.",
    strategy: "fragile" as const,
    reliability: 0.55,
    toolSuccessRate: 0.72,
    latencyMs: 80,
    providerLabel: "deterministic / candidate",
    createdAt: now,
  };
  const experiment = {
    id: "exp_reschedule_baseline",
    name: "Appointment rescheduling baseline",
    description: "Compare a reliable confirmation flow with a faster candidate.",
    scenarioIds: [scenario.scenarioId],
    variantIds: [reliable.variantId, fragile.variantId],
    repetitions: 2,
    mode: "deterministic" as const,
    evaluatorIds: defaultEvaluators().map((evaluator) => evaluator.id),
    createdAt: now,
  };

  return {
    scenarios: [scenario],
    variants: [reliable, fragile],
    evaluators: defaultEvaluators(),
    experiments: [experiment],
    runs: [],
    regressionSet: [],
  };
}
