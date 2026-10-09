import type {
  EvaluatorDefinition,
  AcceptedRunStart,
  EarshotIncidentReference,
  Experiment,
  ExperimentDetail,
  ExperimentRevisionSummary,
  ExperimentRunStatusSnapshot,
  LabState,
  RegressionEntry,
  RunArtifact,
  RunProgressSnapshot,
  RunStartRequestRecord,
  ProjectPurgeReceipt,
  RunPageCursor,
  RunSummary,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";
import { MAX_PROJECT_CATALOG_PAYLOAD_BYTES, MAX_PROJECT_CATALOG_REVISIONS } from "../domain/limits.js";
import { hasUnconfirmedRuntimeCleanup } from "../domain/run-lifecycle.js";

export class ProjectCatalogCapacityError extends Error {
  public constructor() {
    super(`This project has reached its catalog limit of ${MAX_PROJECT_CATALOG_REVISIONS} revisions or ${MAX_PROJECT_CATALOG_PAYLOAD_BYTES} payload bytes.`);
    this.name = "ProjectCatalogCapacityError";
  }
}

export class ProjectPurgeBlockedError extends Error {
  public constructor() {
    super("Project deletion is blocked by active work or unresolved TVIC runtime cleanup. Voice Labs has no automated cleanup reconciliation.");
    this.name = "ProjectPurgeBlockedError";
  }
}

export class ProjectPurgedError extends Error {
  public constructor() {
    super("This Voice Labs project has been purged.");
    this.name = "ProjectPurgedError";
  }
}

export function assertProjectPurgeQuiescent(
  state: LabState,
  hasActiveRunLease: boolean,
  hasActiveEvidenceLease: boolean,
): void {
  if (hasActiveRunLease || hasActiveEvidenceLease || state.runs.some((run) =>
    run.status === "queued" || run.status === "running" || hasUnconfirmedRuntimeCleanup(run))) {
    throw new ProjectPurgeBlockedError();
  }
}

export function assertProjectCatalogCapacity(state: LabState, incoming: ScenarioRevision | VariantRevision | Experiment): void {
  const revisions = [...state.scenarios, ...state.variants, ...state.experiments];
  const payloadBytes = revisions.reduce((total, revision) => total + Buffer.byteLength(JSON.stringify(revision)), 0);
  const incomingBytes = Buffer.byteLength(JSON.stringify(incoming));
  if (revisions.length >= MAX_PROJECT_CATALOG_REVISIONS || payloadBytes + incomingBytes > MAX_PROJECT_CATALOG_PAYLOAD_BYTES) {
    throw new ProjectCatalogCapacityError();
  }
}

export interface RunQuery {
  readonly limit?: number;
  readonly experimentRevisionId?: string;
  readonly runId?: string;
  readonly status?: RunArtifact["status"];
  readonly before?: RunPageCursor;
}

/** Optional bounded catalog reads; ordinary reads preserve the complete local repository state. */
export interface RepositoryReadOptions {
  readonly latestCatalogOnly?: boolean;
  readonly latestExperimentOnly?: boolean;
  readonly experimentId?: string;
  readonly experimentRevisionIds?: readonly string[];
  /** Include project-wide regression membership in otherwise bounded catalog reads. */
  readonly includeRegressionSet?: boolean;
  /** Include the full deletion receipt; availability checks should use the boolean projection. */
  readonly includeProjectPurgeReceipt?: boolean;
}

export type RunStartRequestClaim =
  | { readonly state: "claimed" }
  | { readonly state: "pending"; readonly leaseExpiresAt: string }
  | { readonly state: "accepted"; readonly acceptance: AcceptedRunStart }
  | { readonly state: "conflict" };

export interface RunWithProjectStatus {
  readonly run: RunArtifact | undefined;
  readonly projectPurged: boolean;
}

export interface RunProgressWithProjectStatus {
  readonly progress: RunProgressSnapshot | undefined;
  readonly projectPurged: boolean;
}

export interface ExperimentRunProgressWithProjectStatus {
  readonly experimentFound: boolean;
  readonly runs: ExperimentRunStatusSnapshot[];
  readonly missingRunIds: string[];
  readonly projectPurged: boolean;
}

export function toRunProgressSnapshot(run: RunArtifact): RunProgressSnapshot {
  return {
    id: run.id,
    ...(run.status !== undefined ? { status: run.status } : {}),
    ...(run.evidence ? {
      evidence: {
        status: run.evidence.status,
        ...(run.evidence.sessionId === undefined ? {} : { sessionId: run.evidence.sessionId }),
        ...(run.evidence.message === undefined ? {} : { message: run.evidence.message }),
      },
    } : {}),
  };
}

export interface LabRepository {
  read(projectId: string, options?: RepositoryReadOptions): Promise<LabState>;
  isProjectPurged(projectId: string): Promise<boolean>;
  getProjectPurgeReceipt(projectId: string): Promise<ProjectPurgeReceipt | null>;
  getRunWithProjectStatus(projectId: string, runId: string): Promise<RunWithProjectStatus>;
  getRunProgressWithProjectStatus(projectId: string, runId: string): Promise<RunProgressWithProjectStatus>;
  getExperimentRunProgressWithProjectStatus(
    projectId: string,
    experimentId: string,
    revisionId: string,
    limit: number,
    knownRunIds?: readonly string[],
  ): Promise<ExperimentRunProgressWithProjectStatus>;
  getScenarioRevision(projectId: string, scenarioId: string, revisionId?: string): Promise<ScenarioRevision | undefined>;
  listExperimentRevisionSummaries(projectId: string, experimentId: string): Promise<ExperimentRevisionSummary[]>;
  getExperimentRevisionSummary(projectId: string, experimentId: string, revisionId?: string): Promise<ExperimentRevisionSummary | undefined>;
  listRuns(projectId: string, query?: RunQuery): Promise<RunArtifact[]>;
  countPendingEvidence(projectId: string): Promise<number>;
  claimPendingEvidenceDue(cutoff: string, ownerId: string, leaseExpiresAt: string, limit: number): Promise<RunArtifact[]>;
  releasePendingEvidenceClaim(projectId: string, runId: string, ownerId: string): Promise<void>;
  listRecentRunSummaries(projectId: string, limit: number, runId?: string): Promise<RunSummary[]>;
  countProviderRunsSince(projectId: string, cutoff: string): Promise<number>;
  acquireProjectRunLock(projectId: string, ownerId: string, expiresAt: string): Promise<boolean>;
  releaseProjectRunLock(projectId: string, ownerId: string): Promise<void>;
  acquireProviderRunSlot(projectId: string, ownerId: string, expiresAt: string): Promise<boolean>;
  releaseProviderRunSlot(projectId: string, ownerId: string): Promise<void>;
  addScenarioRevision(projectId: string, revision: ScenarioRevision): Promise<void>;
  addVariantRevision(projectId: string, revision: VariantRevision): Promise<void>;
  addExperimentRevision(projectId: string, revision: Experiment): Promise<void>;
  appendRun(projectId: string, run: RunArtifact): Promise<void>;
  appendRuns(projectId: string, runs: readonly RunArtifact[]): Promise<void>;
  claimRunStartRequest(
    projectId: string,
    record: RunStartRequestRecord,
    now: string,
  ): Promise<RunStartRequestClaim>;
  completeRunStartRequest(
    projectId: string,
    requestKeyHash: string,
    ownerId: string,
    acceptance: AcceptedRunStart,
    runs: readonly RunArtifact[],
  ): Promise<boolean>;
  releaseRunStartRequest(projectId: string, requestKeyHash: string, ownerId: string): Promise<void>;
  recordEarshotReference(projectId: string, reference: EarshotIncidentReference): Promise<void>;
  purgeProject(projectId: string, completedAt: string): Promise<ProjectPurgeReceipt>;
  pruneProviderAttemptUsageBefore(cutoff: string): Promise<number>;
  updateRun(projectId: string, run: RunArtifact): Promise<void>;
  saveRunEvidence(projectId: string, runId: string, evidence: NonNullable<RunArtifact["evidence"]>): Promise<void>;
  savePendingRunEvidence(projectId: string, runId: string, evidence: NonNullable<RunArtifact["evidence"]>): Promise<boolean>;
  reservePendingEvidenceAttempt(projectId: string, runId: string, ownerId: string, expectedAttemptCount: number, evidence: NonNullable<RunArtifact["evidence"]>): Promise<boolean>;
  deleteRun(projectId: string, runId: string): Promise<boolean>;
  expireStaleRunsBefore(cutoff: string, transition: (run: RunArtifact) => RunArtifact): Promise<number>;
  pruneRunsBefore(cutoff: string): Promise<number>;
  appendRegressionEntry(projectId: string, entry: RegressionEntry): Promise<void>;
  removeRegressionEntry(projectId: string, scenarioId: string): Promise<boolean>;
}

export function cloneState(state: LabState): LabState {
  return structuredClone(state);
}

export function summarizeRun(run: RunArtifact, names?: Pick<RunSummary, "experimentName" | "scenarioName" | "variantName">): RunSummary {
  return {
    id: run.id,
    experimentId: run.experimentId,
    experimentRevisionId: run.experimentRevisionId,
    scenarioId: run.scenarioId,
    variantId: run.variantId,
    repetition: run.repetition,
    startedAt: run.startedAt ?? run.queuedAt ?? "",
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.status === undefined ? {} : { status: run.status }),
    ...(names?.experimentName === undefined ? {} : { experimentName: names.experimentName }),
    ...(names?.scenarioName === undefined ? {} : { scenarioName: names.scenarioName }),
    ...(names?.variantName === undefined ? {} : { variantName: names.variantName }),
  };
}

export function listExperimentRunStatusSnapshots(
  runs: readonly RunArtifact[],
  experimentId: string,
  revisionId: string,
  limit: number,
  knownRunIds: readonly string[] = [],
): ExperimentRunStatusSnapshot[] {
  const matchingRuns = runs
    .filter((run) => run.experimentId === experimentId && run.experimentRevisionId === revisionId)
    .sort((left, right) =>
      (right.startedAt ?? right.queuedAt ?? "").localeCompare(left.startedAt ?? left.queuedAt ?? "") ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
  const recentCount = Math.max(0, Math.trunc(limit));
  const recentRuns = matchingRuns.slice(0, recentCount);
  const includedIds = new Set(recentRuns.map((run) => run.id));
  const requestedIds = new Set(knownRunIds);
  const snapshots = recentRuns.map((run) => ({ id: run.id, status: run.status ?? "unknown" }));

  for (let index = recentRuns.length; index < matchingRuns.length; index += 1) {
    const run = matchingRuns[index];
    if (((run.status === "queued" || run.status === "running") || requestedIds.has(run.id)) && !includedIds.has(run.id)) {
      snapshots.push({ id: run.id, status: run.status ?? "unknown" });
      includedIds.add(run.id);
    }
  }

  return snapshots;
}

export function missingExperimentRunStatusIds(
  knownRunIds: readonly string[],
  snapshots: readonly ExperimentRunStatusSnapshot[],
): string[] {
  const returnedIds = new Set(snapshots.map(({ id }) => id));
  return [...new Set(knownRunIds)].filter((id) => !returnedIds.has(id));
}

export function emptyState(): LabState {
  return { scenarios: [], variants: [], evaluators: [], experiments: [], runs: [], providerAttemptUsage: [], runStartRequests: [], earshotReferences: [], projectPurge: null, regressionSet: [] };
}

export function latestScenario(state: LabState, scenarioId: string): ScenarioRevision | undefined {
  return state.scenarios.filter((scenario) => scenario.scenarioId === scenarioId).sort((a, b) => b.revision - a.revision)[0];
}

export function latestVariant(state: LabState, variantId: string): VariantRevision | undefined {
  return state.variants.filter((variant) => variant.variantId === variantId).sort((a, b) => b.revision - a.revision)[0];
}

export function scenarioRevision(state: LabState, revisionId: string): ScenarioRevision | undefined {
  return state.scenarios.find((scenario) => scenario.id === revisionId);
}

export function variantRevision(state: LabState, revisionId: string): VariantRevision | undefined {
  return state.variants.find((variant) => variant.id === revisionId);
}

export function latestExperiment(state: LabState, experimentId: string): Experiment | undefined {
  return state.experiments
    .filter((experiment) => experiment.experimentId === experimentId)
    .sort((a, b) => b.revision - a.revision)[0];
}

export function findExperiment(state: LabState, id: string): Experiment | undefined {
  return latestExperiment(state, id) ?? state.experiments.find((experiment) => experiment.id === id);
}

export function findRun(state: LabState, id: string): RunArtifact | undefined {
  return state.runs.find((run) => run.id === id);
}

export function currentEvaluators(state: LabState): EvaluatorDefinition[] {
  return state.evaluators;
}

export type { ExperimentDetail, RegressionEntry };
