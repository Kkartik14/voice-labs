/** Maximum scenario × variant × repetition cells accepted in one experiment run. */
export const MAX_RUN_CELLS = 8;

/** Bound provider-backed caller turns accepted in one experiment run. */
export const MAX_PROVIDER_TURNS = 8;

/** Deployment-wide provider sessions are bounded in Postgres, across server replicas. */
export const MAX_CONCURRENT_PROVIDER_RUNS = 4;

/** Bound provider-backed attempts per project over a rolling day, independent of concurrency. */
export const MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY = 100;
export const PROVIDER_RUN_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Immutable scenario, variant, and experiment revisions share a per-project storage budget. */
export const MAX_PROJECT_CATALOG_REVISIONS = 1_000;
export const MAX_PROJECT_CATALOG_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Bound database cleanup statements; startup may process several bounded batches. */
export const MAX_MAINTENANCE_RUN_BATCH = 100;
export const MAX_MAINTENANCE_BATCHES_PER_SWEEP = 5;
/** Bound metadata-only Earshot retries during each maintenance pass. */
export const MAX_EARSHOT_EVIDENCE_RETRY_BATCH = 16;
export const MAX_EARSHOT_EVIDENCE_ATTEMPTS = 8;
export const EARSHOT_EVIDENCE_RETRY_DELAY_MS = 60 * 1_000;
export const EARSHOT_EVIDENCE_RETRY_LEASE_MS = 2 * 60 * 1_000;
export const MAX_EXPIRED_EVIDENCE_LEASES_CLEANED_PER_SWEEP = 256;
/** Bound retained transcript-bearing runs waiting for Earshot, independently per project. */
export const MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT = 250;

/** A persisted per-project lease outlives the maximum bounded provider run. */
export const PROJECT_RUN_LOCK_MS = 30 * 60 * 1_000;
export const RUN_START_PREPARATION_LEASE_MS = 30 * 1_000;
export const RUN_START_RECONCILE_WAIT_MS = 10 * 1_000;
export const RUN_SHUTDOWN_GRACE_MS = 25 * 1_000;
