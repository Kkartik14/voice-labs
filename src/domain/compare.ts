import type { Comparison, RunArtifact, VariantComparisonRow, VariantRevision } from "./model.js";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function compareRuns(runs: RunArtifact[], variants: VariantRevision[]): Comparison {
  const baselineVariantId = variants[0]?.id ?? null;
  const rows: VariantComparisonRow[] = variants.map((variant) => {
    const variantRuns = runs.filter((run) => run.variantId === variant.id);
    const runningRuns = variantRuns.filter((run) => run.status === "running" || run.status === "queued").length;
    const completedRuns = variantRuns.filter((run) => run.status !== "running" && run.status !== "queued");
    const passedRuns = completedRuns.filter((run) => run.status === "passed").length;
    const failedRuns = completedRuns.filter((run) => run.status === "failed" || run.status === "error").length;
    const unknownRuns = completedRuns.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length;
    const knownEvaluationScores = completedRuns
      .flatMap((run) => run.evaluations ?? [])
      .filter((evaluation) => evaluation.status !== "unknown");
    const latencyValues = completedRuns.map((run) => run.durationMs).filter((value): value is number => value !== undefined && Number.isFinite(value));
    const qualityScore = knownEvaluationScores.length === 0
      ? null
      : round(knownEvaluationScores.reduce((sum, evaluation) => sum + evaluation.score * evaluation.weight, 0) / knownEvaluationScores.reduce((sum, evaluation) => sum + evaluation.weight, 0));
    return {
      variantId: variant.id,
      variantName: variant.name,
      providerLabel: providerLabelForRuns(variant.providerLabel, variantRuns),
      runCount: completedRuns.length,
      runningRuns,
      passedRuns,
      failedRuns,
      unknownRuns,
      passRate: completedRuns.length === 0 ? 0 : round(passedRuns / completedRuns.length),
      unknownRate: completedRuns.length === 0 ? 0 : round(unknownRuns / completedRuns.length),
      qualityScore,
      averageLatencyMs: latencyValues.length === 0 ? null : Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length),
      deltaFromBaseline: null,
    };
  });

  const baseline = rows.find((row) => row.variantId === baselineVariantId)?.qualityScore;
  for (const row of rows) {
    row.deltaFromBaseline = baseline === null || baseline === undefined || row.qualityScore === null ? null : round(row.qualityScore - baseline);
  }

  return {
    baselineVariantId,
    rows,
    totalRuns: runs.length,
    totalRunning: runs.filter((run) => run.status === "running" || run.status === "queued").length,
    totalPassed: runs.filter((run) => run.status === "passed").length,
    totalFailed: runs.filter((run) => run.status === "failed" || run.status === "error").length,
    totalUnknown: runs.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length,
  };
}

function providerLabelForRuns(fallback: string, runs: RunArtifact[]): string {
  const labels = [...new Set(runs.flatMap((run) => {
    if (run.status === "running" || run.status === "queued") return [];
    if (run.mode === "deterministic") return ["Deterministic simulation"];
    const trace = run.providerTrace;
    if (!trace) return [run.status === "error" ? "Provider run failed" : "Provider details unavailable"];
    const useStt = trace.inputMode === "audio_fixture";
    const providers = [useStt ? trace.stt : undefined, trace.llm, trace.tts].filter(Boolean);
    const models = [useStt ? trace.sttModel : undefined, trace.llmModel, trace.ttsModel].filter(Boolean);
    return [models.length > 0 ? models.join(" / ") : providers.join(" / ")];
  }))];
  if (labels.length === 0) return runs.length > 0 ? "Run in progress" : fallback;
  if (labels.length <= 2) return labels.join(" + ");
  return `${labels.length} runtime configurations`;
}
