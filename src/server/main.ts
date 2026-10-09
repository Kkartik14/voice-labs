import "dotenv/config";
import { Pool } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLabService } from "../application/service.js";
import { JsonFileRepository } from "../adapters/json-repository.js";
import { PostgresRepository } from "../adapters/postgres-repository.js";
import { createSeedState } from "../adapters/seed.js";
import { createEarshotSinkFromEnvironment } from "../adapters/earshot-evidence-sink.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createTvicRunnerFromEnvironment, loadTvicEnvironment } from "../adapters/tvic-runner.js";
import { createAuthenticatorFromEnvironment } from "./auth.js";
import { createHttpServer } from "./http.js";
import { MAX_MAINTENANCE_BATCHES_PER_SWEEP, MAX_MAINTENANCE_RUN_BATCH, PROJECT_RUN_LOCK_MS } from "../domain/limits.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataDir = resolve(process.env.VOICE_LABS_DATA_DIR ?? resolve(projectRoot, "data"));
const dataFile = resolve(dataDir, "voice-labs.json");
const port = Number(process.env.VOICE_LABS_PORT ?? 4320);
const host = process.env.VOICE_LABS_HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const runRetentionDays = Number(process.env.VOICE_LABS_RUN_RETENTION_DAYS ?? 30);
if (!Number.isInteger(runRetentionDays) || runRetentionDays < 1 || runRetentionDays > 3_650) {
  throw new Error("VOICE_LABS_RUN_RETENTION_DAYS must be an integer between 1 and 3650.");
}
const auth = createAuthenticatorFromEnvironment(host);
const storage = process.env.VOICE_LABS_STORAGE ?? (auth.mode === "jwt" ? "postgres" : "json");
if (storage !== "json" && storage !== "postgres") throw new Error("VOICE_LABS_STORAGE must be json or postgres.");
if (auth.mode === "jwt" && storage !== "postgres") throw new Error("JWT-authenticated Voice Labs requires Postgres persistence.");

loadTvicEnvironment(process.env.TVIC_ROOT);
let repository: JsonFileRepository | PostgresRepository;
if (storage === "postgres") {
  const connectionString = process.env.VOICE_LABS_DATABASE_URL;
  if (!connectionString) throw new Error("Missing required environment variable VOICE_LABS_DATABASE_URL.");
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  repository = new PostgresRepository(pool);
  await repository.initialize();
} else {
  repository = new JsonFileRepository(dataFile, process.env.VOICE_LABS_LOCAL_PROJECT_ID ?? "local");
  const existing = await repository.read(process.env.VOICE_LABS_LOCAL_PROJECT_ID ?? "local");
  if (existing.scenarios.length === 0 && existing.variants.length === 0 && existing.experiments.length === 0) {
    const seed = createSeedState(new Date().toISOString(), process.env.VOICE_LABS_LOCAL_PROJECT_ID ?? "local", process.env.VOICE_LABS_LOCAL_USER_ID ?? "local-development");
    for (const scenario of seed.scenarios) await repository.addScenarioRevision(scenario.projectId, scenario);
    for (const variant of seed.variants) await repository.addVariantRevision(variant.projectId, variant);
    for (const experiment of seed.experiments) await repository.addExperimentRevision(experiment.projectId, experiment);
  }
}

const tvicRunner = createTvicRunnerFromEnvironment();
if (tvicRunner) {
  console.log("TVIC provider executor enabled; secrets remain process-local.");
} else {
  console.log("TVIC provider executor disabled; deterministic mode remains available.");
}
const evidenceSink = createEarshotSinkFromEnvironment();
const service = createLabService(repository, new DeterministicRunner(), {
  ...(tvicRunner ? { executors: { tvic: tvicRunner, audio: tvicRunner } } : {}),
  ...(evidenceSink ? { evidenceSink } : {}),
});
const server = createHttpServer(service, { auth, staticDir: resolve(projectRoot, "dist/web"), serviceToken: process.env.VOICE_LABS_SERVICE_TOKEN });
const retentionIntervalMs = 24 * 60 * 60 * 1_000;
let staleSweepRunning = false;
let retentionSweepRunning = false;
let retentionBacklog = false;
let nextRetentionSweepAt = Date.now() + retentionIntervalMs;
const expireStaleRuns = async () => {
  if (staleSweepRunning) return;
  staleSweepRunning = true;
  const cutoff = new Date(Date.now() - PROJECT_RUN_LOCK_MS).toISOString();
  let expired = 0;
  try {
    for (let batch = 0; batch < MAX_MAINTENANCE_BATCHES_PER_SWEEP; batch += 1) {
      const count = await service.recoverStaleRunsBefore(cutoff);
      expired += count;
      if (count < MAX_MAINTENANCE_RUN_BATCH) break;
    }
    if (expired > 0) console.log(`Run recovery marked ${expired} abandoned run(s) as errors.`);
    const retriedEvidence = await service.retryPendingEvidenceBefore(new Date().toISOString());
    if (retriedEvidence > 0) console.log(`Earshot evidence recovery processed ${retriedEvidence} pending incident(s).`);
  } finally {
    staleSweepRunning = false;
  }
};
const activeMaintenance = new Set<Promise<void>>();
const trackMaintenance = (task: Promise<unknown>, label: string) => {
  const tracked = task.then(() => undefined).catch((error: unknown) => {
    console.error(label, error instanceof Error ? error.message : "Unexpected error");
  });
  activeMaintenance.add(tracked);
  void tracked.finally(() => activeMaintenance.delete(tracked));
};
const pruneExpiredRuns = async () => {
  if (retentionSweepRunning) return;
  retentionSweepRunning = true;
  const cutoff = new Date(Date.now() - runRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const providerUsageCutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  let removed = 0;
  let removedProviderUsage = 0;
  let runBacklog = false;
  let providerUsageBacklog = false;
  try {
    for (let batch = 0; batch < MAX_MAINTENANCE_BATCHES_PER_SWEEP; batch += 1) {
      const count = await repository.pruneRunsBefore(cutoff);
      removed += count;
      runBacklog = count === MAX_MAINTENANCE_RUN_BATCH;
      if (!runBacklog) break;
    }
    for (let batch = 0; batch < MAX_MAINTENANCE_BATCHES_PER_SWEEP; batch += 1) {
      const count = await repository.pruneProviderAttemptUsageBefore(providerUsageCutoff);
      removedProviderUsage += count;
      providerUsageBacklog = count === MAX_MAINTENANCE_RUN_BATCH;
      if (!providerUsageBacklog) break;
    }
    retentionBacklog = runBacklog || providerUsageBacklog;
    nextRetentionSweepAt = Date.now() + retentionIntervalMs;
    if (removed > 0) console.log(`Run retention removed ${removed} expired run(s).`);
    if (removedProviderUsage > 0) console.log(`Provider usage retention removed ${removedProviderUsage} expired attempt record(s).`);
  } finally {
    retentionSweepRunning = false;
  }
};
const staleRunTimer = setInterval(() => {
  trackMaintenance(expireStaleRuns(), "Stale run recovery failed.");
}, 60 * 1_000);
staleRunTimer.unref();
const retentionTimer = setInterval(() => {
  if (!retentionBacklog && Date.now() < nextRetentionSweepAt) return;
  trackMaintenance(pruneExpiredRuns(), "Run retention cleanup failed:");
}, 60 * 1_000);
retentionTimer.unref();
server.listen(port, host, () => {
  console.log(`Voice Labs listening at http://${host}:${port}`);
  console.log(`Storage adapter: ${storage}; authentication mode: ${auth.mode}.`);
  trackMaintenance(Promise.all([expireStaleRuns(), pruneExpiredRuns()]), "Startup maintenance failed.");
});

let shutdownStarted = false;
function shutdown(signal: string): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  service.stopAcceptingRunStarts();
  clearInterval(staleRunTimer);
  clearInterval(retentionTimer);
  const serverClosed = new Promise<void>((resolveClosed) => {
    server.close((error) => {
      if (error) {
        console.error(`${signal}: failed to close server`, error.message);
        process.exitCode = 1;
      }
      resolveClosed();
    });
  });
  void (async () => {
    await Promise.all([serverClosed, service.drainAcceptedRuns()]);
    while (activeMaintenance.size > 0) await Promise.all([...activeMaintenance]);
    if (repository instanceof PostgresRepository) await repository.close();
  })().catch((error: unknown) => {
    console.error(`${signal}: graceful shutdown failed`, error instanceof Error ? error.message : "Unexpected error");
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
