import { newId, stableRatio, stableSeed } from "../domain/ids.js";
import type { Clock, RunExecutor, RunRequest } from "../domain/ports.js";
import type { RunArtifact, ToolCall, TranscriptTurn } from "../domain/model.js";

const systemClock: Clock = { now: () => new Date() };

export class DeterministicRunner implements RunExecutor {
  public constructor(private readonly options: { now?: () => Date } = {}) {}

  public async execute(request: RunRequest): Promise<RunArtifact> {
    const clock = this.options.now ? { now: this.options.now } : systemClock;
    const started = clock.now();
    const seed = request.seed || stableSeed(request.experimentId, request.scenario.id, request.variant.id, request.repetition);
    const reliableEnough = stableRatio(seed, request.variant.id, "completion") <= request.variant.reliability;
    const toolCalls: ToolCall[] = request.scenario.expectedToolCalls.map((name, index) => {
      const succeeded = stableRatio(seed, name, index, "tool") <= request.variant.toolSuccessRate;
      return {
        id: newId("tool"),
        name,
        arguments: { request: request.scenario.goal },
        status: succeeded ? "succeeded" : "failed",
        elapsedMs: Math.max(20, Math.round(request.variant.latencyMs / 3)),
        ...(succeeded ? {} : { error: "Deterministic tool fixture rejected the request." }),
      };
    });
    const allToolsSucceeded = toolCalls.every((call) => call.status === "succeeded");
    const completed = reliableEnough && allToolsSucceeded;
    const shouldIncludeRequiredPhrases = request.variant.strategy === "reliable" || completed;
    const response = completed
      ? [
          request.variant.strategy === "concise" ? "Done." : "I understood the request and completed it.",
          shouldIncludeRequiredPhrases ? request.scenario.requiredPhrases.join(" ") : "",
          request.variant.strategy === "concise" ? "Your appointment is confirmed." : "The updated appointment is confirmed.",
        ].filter(Boolean).join(" ")
      : "I couldn't complete that request yet. I need another attempt before I can confirm the change.";
    const transcript: TranscriptTurn[] = [];
    let offsetMs = 0;
    request.scenario.userTurns.forEach((text, index) => {
      transcript.push({ index: transcript.length, speaker: "user", text, offsetMs });
      offsetMs += request.variant.latencyMs;
      transcript.push({ index: transcript.length, speaker: "assistant", text: index === request.scenario.userTurns.length - 1 ? response : "I’m checking that now.", offsetMs });
    });
    const durationMs = Math.max(1, request.variant.latencyMs * request.scenario.userTurns.length + toolCalls.reduce((sum, call) => sum + call.elapsedMs, 0));
    const completedAt = new Date(started.getTime() + durationMs);
    const finalFacts = completed ? [...request.scenario.expectedOutcomeFacts] : request.scenario.expectedOutcomeFacts.slice(0, 1);

    return {
      id: newId("run"),
      experimentId: request.experimentId,
      scenarioId: request.scenario.id,
      variantId: request.variant.id,
      repetition: request.repetition,
      seed,
      mode: request.mode,
      startedAt: started.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      transcript,
      toolCalls,
      finalFacts,
      metrics: {
        turnCount: request.scenario.userTurns.length,
        toolCallCount: toolCalls.length,
        audioExercised: request.mode === "audio",
        totalLatencyMs: durationMs,
        firstResponseMs: request.variant.latencyMs,
      },
    };
  }
}
