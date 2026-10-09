import { ApiNetworkError, ApiRequestError } from "./api-request.js";
import { EARSHOT_EVIDENCE_RETRY_DELAY_MS } from "../domain/limits.js";

export type StatusPollMode = "active-run" | "pending-evidence";

const STATUS_POLL_INTERVAL_MS = 1_500;
const ACTIVE_RUN_MAX_BACKOFF_MS = 30_000;
const EVIDENCE_MAX_BACKOFF_MS = 5 * 60_000;

export function shouldRetryStatusPoll(error: unknown): boolean {
  if (error instanceof ApiNetworkError) return true;
  if (!(error instanceof ApiRequestError)) return false;
  return error.status === 408
    || error.status === 409
    || error.status === 425
    || error.status === 429
    || error.status >= 500;
}

export function statusPollDelay(consecutiveFailures: number, mode: StatusPollMode = "active-run"): number {
  const failures = Number.isFinite(consecutiveFailures) ? Math.max(0, Math.trunc(consecutiveFailures)) : 0;
  const interval = mode === "pending-evidence" ? EARSHOT_EVIDENCE_RETRY_DELAY_MS : STATUS_POLL_INTERVAL_MS;
  const maximum = mode === "pending-evidence" ? EVIDENCE_MAX_BACKOFF_MS : ACTIVE_RUN_MAX_BACKOFF_MS;
  return Math.min(maximum, interval * (2 ** Math.max(0, failures - 1)));
}
