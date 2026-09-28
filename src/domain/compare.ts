import type { Comparison, RunArtifact, VariantComparisonRow, VariantRevision } from "./model.js";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function compareRuns(runs: RunArtifact[], variants: VariantRevision[]): Comparison {
  const baselineVariantId = variants[0]?.id ?? null;
  const rows: VariantComparisonRow[] = variants.map((variant) => {
    const variantRuns = runs.filter((run) => run.variantId === variant.id);
    const passedRuns = variantRuns.filter((run) => run.status === "passed").length;
    const failedRuns = variantRuns.filter((run) => run.status === "failed" || run.status === "error").length;
    const unknownRuns = variantRuns.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length;
    const knownEvaluationScores = variantRuns
      .flatMap((run) => run.evaluations ?? [])
      .filter((evaluation) => evaluation.status !== "unknown");
    const latencyValues = variantRuns.map((run) => run.durationMs).filter(Number.isFinite);
    const qualityScore = knownEvaluationScores.length === 0
      ? null
      : round(knownEvaluationScores.reduce((sum, evaluation) => sum + evaluation.score * evaluation.weight, 0) / knownEvaluationScores.reduce((sum, evaluation) => sum + evaluation.weight, 0));
    return {
      variantId: variant.id,
      variantName: variant.name,
      providerLabel: variant.providerLabel,
      runCount: variantRuns.length,
      passedRuns,
      failedRuns,
      unknownRuns,
      passRate: variantRuns.length === 0 ? 0 : round(passedRuns / variantRuns.length),
      unknownRate: variantRuns.length === 0 ? 0 : round(unknownRuns / variantRuns.length),
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
    totalPassed: runs.filter((run) => run.status === "passed").length,
    totalFailed: runs.filter((run) => run.status === "failed" || run.status === "error").length,
    totalUnknown: runs.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length,
  };
}
