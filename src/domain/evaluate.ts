import { normalizeText, newId } from "./ids.js";
import type {
  EvaluationResult,
  EvaluatorDefinition,
  RunArtifact,
  ScenarioRevision,
} from "./model.js";

const defaultDefinitions: Array<Pick<EvaluatorDefinition, "kind" | "name" | "weight">> = [
  { kind: "outcome", name: "Outcome facts", weight: 3 },
  { kind: "guardrail", name: "Guardrails", weight: 3 },
  { kind: "phrase", name: "Required language", weight: 1 },
  { kind: "tool_call", name: "Tool execution", weight: 2 },
  { kind: "latency", name: "Latency budget", weight: 1 },
];

export function defaultEvaluators(): EvaluatorDefinition[] {
  return defaultDefinitions.map((definition) => ({ id: `eval_${definition.kind}`, ...definition }));
}

function result(
  kind: EvaluationResult["kind"],
  name: string,
  weight: number,
  status: EvaluationResult["status"],
  score: number,
  reason: string,
  evidence: string[],
): EvaluationResult {
  return { id: newId("evaluation"), kind, name, weight, status, score, reason, evidence };
}

function includesAll(haystack: string[], needles: string[]): string[] {
  const normalizedHaystack = haystack.map(normalizeText);
  return needles.filter((needle) => normalizedHaystack.includes(normalizeText(needle)));
}

export function evaluateRun(
  run: RunArtifact,
  scenario: ScenarioRevision,
  definitions: EvaluatorDefinition[] = defaultEvaluators(),
): EvaluationResult[] {
  const assistantText = normalizeText(run.transcript
    .filter((turn) => turn.speaker === "assistant")
    .map((turn) => turn.text)
    .join(" "));
  const results: EvaluationResult[] = [];

  for (const definition of definitions) {
    switch (definition.kind) {
      case "outcome": {
        const matched = includesAll(run.finalFacts, scenario.expectedOutcomeFacts);
        if (scenario.expectedOutcomeFacts.length === 0) {
          results.push(result("outcome", definition.name, definition.weight, "unknown", 0, "No expected outcome facts were defined.", []));
        } else {
          const score = matched.length / scenario.expectedOutcomeFacts.length;
          results.push(
            result(
              "outcome",
              definition.name,
              definition.weight,
              score === 1 ? "passed" : "failed",
              score,
              score === 1 ? "Every expected final-state fact was observed." : `${scenario.expectedOutcomeFacts.length - matched.length} expected fact(s) were missing.`,
              matched,
            ),
          );
        }
        break;
      }
      case "guardrail": {
        const violations = scenario.forbiddenPhrases.filter((phrase) => assistantText.includes(normalizeText(phrase)));
        results.push(
          result(
            "guardrail",
            definition.name,
            definition.weight,
            violations.length > 0 ? "failed" : "passed",
            violations.length > 0 ? 0 : 1,
            violations.length > 0 ? `Forbidden language appeared in assistant output: ${violations.join(", ")}.` : "No forbidden language appeared in assistant output.",
            violations,
          ),
        );
        break;
      }
      case "phrase": {
        if (scenario.requiredPhrases.length === 0) {
          results.push(result("phrase", definition.name, definition.weight, "unknown", 0, "No required phrases were defined.", []));
        } else {
          const matched = scenario.requiredPhrases.filter((phrase) => assistantText.includes(normalizeText(phrase)));
          const score = matched.length / scenario.requiredPhrases.length;
          results.push(
            result(
              "phrase",
              definition.name,
              definition.weight,
              score === 1 ? "passed" : "failed",
              score,
              score === 1 ? "Every required phrase appeared in assistant output." : `${scenario.requiredPhrases.length - matched.length} required phrase(s) were missing from assistant output.`,
              matched,
            ),
          );
        }
        break;
      }
      case "tool_call": {
        if (scenario.expectedToolCalls.length === 0) {
          results.push(result("tool_call", definition.name, definition.weight, "unknown", 0, "No expected tool calls were defined.", []));
        } else {
          const successful = scenario.expectedToolCalls.filter((name) => run.toolCalls.some((call) => call.name === name && call.status === "succeeded"));
          const score = successful.length / scenario.expectedToolCalls.length;
          results.push(
            result(
              "tool_call",
              definition.name,
              definition.weight,
              score === 1 ? "passed" : "failed",
              score,
              score === 1 ? "Every expected tool call succeeded." : `${scenario.expectedToolCalls.length - successful.length} expected tool call(s) did not succeed.`,
              successful,
            ),
          );
        }
        break;
      }
      case "latency": {
        const budget = scenario.latencyBudgetMs;
        if (run.durationMs === undefined || !Number.isFinite(run.durationMs) || budget <= 0) {
          results.push(result("latency", definition.name, definition.weight, "unknown", 0, "Latency evidence or budget is unavailable.", []));
        } else {
          const passed = run.durationMs <= budget;
          const score = passed ? 1 : Math.max(0, budget / run.durationMs);
          results.push(
            result(
              "latency",
              definition.name,
              definition.weight,
              passed ? "passed" : "failed",
              score,
              passed ? `Completed in ${run.durationMs}ms within the ${budget}ms budget.` : `Completed in ${run.durationMs}ms, over the ${budget}ms budget.`,
              [`${run.durationMs}ms / ${budget}ms`],
            ),
          );
        }
        break;
      }
    }
  }

  return results;
}
