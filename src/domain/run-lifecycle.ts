import type { RunArtifact } from "./model.js";

/** A runtime could not confirm cleanup, so deletion must retain the run record. */
export const UNCONFIRMED_RUNTIME_CLEANUP_CODE = "cancellation_unconfirmed";
export const UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE = "TVIC runtime cleanup could not be confirmed.";
export const PRIOR_RUNTIME_CLEANUP_BLOCKED_CODE = "prior_runtime_cleanup_unconfirmed";
export const PRIOR_RUNTIME_CLEANUP_BLOCKED_MESSAGE = "This attempt was not started because prior TVIC runtime cleanup is unconfirmed. Voice Labs has no automated reconciliation; contact the service owner.";

export function mayHaveUnconfirmedProviderRuntime(run: Pick<RunArtifact, "mode" | "status" | "startedAt" | "error">): boolean {
  return run.mode !== "deterministic"
    && run.status === "running"
    && Boolean(run.startedAt)
    && !hasUnconfirmedRuntimeCleanup(run);
}

export function hasUnconfirmedRuntimeCleanup(run: Pick<RunArtifact, "error">): boolean {
  return run.error?.code === UNCONFIRMED_RUNTIME_CLEANUP_CODE;
}
