import type { RunStatus } from "../domain/model.js";

export function isActiveRunStatus(status: RunStatus | undefined): boolean {
  return status === "queued" || status === "running";
}

export function buildExperimentRunStatusUrl(
  experimentId: string | undefined,
  revisionId: string | undefined,
  runs: readonly { id: string; status?: RunStatus }[],
): string | null {
  if (!experimentId || !revisionId) return null;

  const query = new URLSearchParams({ revision_id: revisionId });
  for (const run of runs) {
    if (isActiveRunStatus(run.status)) query.append("run_id", run.id);
  }
  return `/api/experiments/${encodeURIComponent(experimentId)}/run-status?${query}`;
}
