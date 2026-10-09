import { createHash } from "node:crypto";
import { compareRuns } from "../domain/compare.js";
import { defaultEvaluators, evaluateRun } from "../domain/evaluate.js";
import { newId, stableSeed } from "../domain/ids.js";
import { hasUnconfirmedRuntimeCleanup, mayHaveUnconfirmedProviderRuntime, PRIOR_RUNTIME_CLEANUP_BLOCKED_CODE, PRIOR_RUNTIME_CLEANUP_BLOCKED_MESSAGE, UNCONFIRMED_RUNTIME_CLEANUP_CODE, UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE } from "../domain/run-lifecycle.js";
import {
  EARSHOT_EVIDENCE_RETRY_DELAY_MS,
  EARSHOT_EVIDENCE_RETRY_LEASE_MS,
  MAX_EARSHOT_EVIDENCE_ATTEMPTS,
  MAX_EARSHOT_EVIDENCE_RETRY_BATCH,
  MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY,
  MAX_PROVIDER_TURNS,
  MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT,
  MAX_RUN_CELLS,
  PROJECT_RUN_LOCK_MS,
  PROVIDER_RUN_QUOTA_WINDOW_MS,
  RUN_START_PREPARATION_LEASE_MS,
  RUN_START_RECONCILE_WAIT_MS,
  RUN_SHUTDOWN_GRACE_MS,
} from "../domain/limits.js";
import type { Clock, EvidenceSink, RunExecutor } from "../domain/ports.js";
import type {
  BootstrapPayload,
  AcceptedRunStart,
  EvaluatorDefinition,
  Experiment,
  ExperimentDetail,
  ExperimentRevisionSummary,
  ExperimentRunProgressSnapshot,
  ExecutionMode,
  EvidenceReference,
  ProjectPurgeReceipt,
  ExperimentRunPage,
  LabState,
  RunPageCursor,
  ProjectContext,
  RunArtifact,
  RunProgressSnapshot,
  RunStatus,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";
import {
  findExperiment,
  latestExperiment,
  latestScenario,
  latestVariant,
  scenarioRevision,
  variantRevision,
  type LabRepository,
  type RepositoryReadOptions,
  ProjectCatalogCapacityError,
  ProjectPurgedError,
  ProjectPurgeBlockedError,
} from "../adapters/repository.js";

const systemClock: Clock = { now: () => new Date() };
const EXPERIMENT_RUN_PAGE_SIZE = 50;
const EXPERIMENT_EXPORT_RUN_LIMIT = 500;
const PROVIDER_CAPACITY_UNAVAILABLE_MESSAGE = "Provider capacity is full. Active runs may release slots on completion; unresolved TVIC cleanup may hold capacity indefinitely. Voice Labs has no automated cleanup reconciliation. If capacity remains unavailable, contact the service owner.";
const PROJECT_DELETION_IN_PROGRESS_MESSAGE = "This Voice Labs project is being deleted. Retry after deletion finishes.";

function projectDeletionInProgressError(): Error & { statusCode: number } {
  return Object.assign(new Error(PROJECT_DELETION_IN_PROGRESS_MESSAGE), { statusCode: 409 });
}

function latestScenarios(state: LabState): ScenarioRevision[] {
  const latest = new Map<string, ScenarioRevision>();
  for (const scenario of state.scenarios) {
    const current = latest.get(scenario.scenarioId);
    if (!current || scenario.revision > current.revision) latest.set(scenario.scenarioId, scenario);
  }
  return [...latest.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

function latestVariants(state: LabState): VariantRevision[] {
  const latest = new Map<string, VariantRevision>();
  for (const variant of state.variants) {
    const current = latest.get(variant.variantId);
    if (!current || variant.revision > current.revision) latest.set(variant.variantId, variant);
  }
  return [...latest.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

function statusFor(artifact: RunArtifact, evaluations: RunArtifact["evaluations"]): RunStatus {
  if (artifact.status === "queued") return "queued";
  if (artifact.status === "running") return "running";
  if (artifact.status === "error") return "error";
  if (artifact.status === "cancelled") return "cancelled";
  if (!evaluations || evaluations.length === 0) return "unknown";
  if (evaluations.some((evaluation) => evaluation.status === "failed")) return "failed";
  if (evaluations.some((evaluation) => evaluation.status === "unknown")) return "unknown";
  return "passed";
}

function reserveEvidenceAttempt(evidence: EvidenceReference, now: Date): EvidenceReference {
  const attemptCount = (evidence.attemptCount ?? 0) + 1;
  return {
    source: "earshot",
    endpoint: evidence.endpoint,
    status: "pending",
    attemptCount,
    retryAt: new Date(now.getTime() + EARSHOT_EVIDENCE_RETRY_DELAY_MS).toISOString(),
  };
}

function evidenceAfterReservedAttemptFailed(evidence: EvidenceReference, now: Date): EvidenceReference {
  const attemptCount = evidence.attemptCount ?? 0;
  if (attemptCount >= MAX_EARSHOT_EVIDENCE_ATTEMPTS) {
    return {
      source: "earshot",
      endpoint: evidence.endpoint,
      status: "unavailable",
      attemptCount,
      message: "Earshot could not confirm this metadata incident after repeated attempts.",
    };
  }
  return {
      source: "earshot",
      endpoint: evidence.endpoint,
      status: "pending",
      attemptCount,
      retryAt: new Date(now.getTime() + EARSHOT_EVIDENCE_RETRY_DELAY_MS).toISOString(),
  };
}

function evidenceUnavailableBeforeStart(evidence: EvidenceReference): EvidenceReference {
  return {
    ...evidence,
    status: "unavailable",
    message: "The run did not start, so there is no completed result to attach to Earshot.",
  };
}

function latestRevisions<T extends { revision: number }>(revisions: T[]): T[] {
  return [...revisions].sort((a, b) => a.revision - b.revision);
}

function unknownEvaluations(definitions: EvaluatorDefinition[], reason: string) {
  return definitions.map((definition) => ({
    id: newId("evaluation"),
    kind: definition.kind,
    name: definition.name,
    status: "unknown" as const,
    score: 0,
    weight: definition.weight,
    reason,
    evidence: [],
  }));
}

function failedRun(request: {
  context: ProjectContext;
  experiment: Experiment;
  scenario: ScenarioRevision;
  variant: VariantRevision;
  repetition: number;
  seed: number;
  startedAt: Date;
}): RunArtifact {
  const completedAt = new Date();
  return {
    id: newId("run"),
    projectId: request.context.projectId,
    experimentId: request.experiment.experimentId,
    experimentRevisionId: request.experiment.id,
    scenarioId: request.scenario.id,
    variantId: request.variant.id,
    repetition: request.repetition,
    seed: request.seed,
    mode: request.experiment.mode,
    startedAt: request.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - request.startedAt.getTime()),
    latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
    transcript: [],
    toolCalls: [],
    finalFacts: [],
    metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
    error: { code: "executor_failed", message: "The runtime failed before returning a result." },
    status: "error",
  };
}

function cancelledBeforeStart(run: RunArtifact, completedAt: string): RunArtifact {
  return {
    ...run,
    completedAt,
    transcript: [],
    toolCalls: [],
    finalFacts: [],
    metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
    ...(run.evidence?.status === "pending" ? { evidence: evidenceUnavailableBeforeStart(run.evidence) } : {}),
    error: { code: "shutdown_cancelled", message: "Voice Labs cancelled this accepted attempt during graceful shutdown before execution began." },
    status: "cancelled",
  };
}

function blockedBeforeStartAfterRuntimeCleanupFailure(run: RunArtifact, completedAt: string): RunArtifact {
  return {
    ...run,
    completedAt,
    transcript: [],
    toolCalls: [],
    finalFacts: [],
    metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
    ...(run.evidence?.status === "pending" ? { evidence: evidenceUnavailableBeforeStart(run.evidence) } : {}),
    error: {
      code: PRIOR_RUNTIME_CLEANUP_BLOCKED_CODE,
      message: PRIOR_RUNTIME_CLEANUP_BLOCKED_MESSAGE,
    },
    status: "error",
  };
}

export interface LabService {
  getBootstrap(context: ProjectContext): Promise<BootstrapPayload>;
  listScenarios(context: ProjectContext): Promise<ScenarioRevision[]>;
  listVariants(context: ProjectContext): Promise<VariantRevision[]>;
  listExperiments(context: ProjectContext): Promise<Experiment[]>;
  getExperimentDetail(context: ProjectContext, id: string, revisionId?: string): Promise<ExperimentDetail>;
  getExperimentRuns(context: ProjectContext, id: string, before?: RunPageCursor, revisionId?: string): Promise<ExperimentRunPage>;
  getExperimentRunProgress(
    context: ProjectContext,
    id: string,
    revisionId: string,
    knownRunIds?: readonly string[],
  ): Promise<ExperimentRunProgressSnapshot>;
  exportExperiment(context: ProjectContext, id: string, revisionId?: string): Promise<ExperimentDetail>;
  getPlatformSummary(context: ProjectContext, recordId?: string): Promise<PlatformLabSummary>;
  purgeProject(context: ProjectContext): Promise<ProjectPurgeReceipt>;
  stopAcceptingRunStarts(): void;
  drainAcceptedRuns(graceMs?: number): Promise<void>;
  recoverStaleRunsBefore(cutoff: string): Promise<number>;
  retryPendingEvidenceBefore(cutoff: string): Promise<number>;
  getRun(context: ProjectContext, id: string): Promise<RunArtifact>;
  getRunStatus(context: ProjectContext, id: string): Promise<RunProgressSnapshot>;
  deleteRun(context: ProjectContext, id: string): Promise<void>;
  createScenario(context: ProjectContext, input: CreateScenarioInput): Promise<ScenarioRevision>;
  updateScenario(context: ProjectContext, id: string, input: UpdateScenarioInput): Promise<ScenarioRevision>;
  createVariant(context: ProjectContext, input: CreateVariantInput): Promise<VariantRevision>;
  updateVariant(context: ProjectContext, id: string, input: UpdateVariantInput): Promise<VariantRevision>;
  createExperiment(context: ProjectContext, input: CreateExperimentInput): Promise<Experiment>;
  updateExperiment(context: ProjectContext, id: string, input: UpdateExperimentInput): Promise<Experiment>;
  startExperiment(context: ProjectContext, id: string, request?: ExperimentRunStartRequest): Promise<ExperimentRunAccepted>;
  runExperiment(
    context: ProjectContext,
    id: string,
    onPrepared?: (accepted: ExperimentRunAccepted) => void,
    onAttemptPrepared?: (attempt: RunArtifact) => void,
    request?: { revisionId?: string; requestKeyHash: string; ownerId: string },
    signal?: AbortSignal,
  ): Promise<ExperimentDetail>;
  promoteScenario(context: ProjectContext, scenarioId: string, revisionId?: string): Promise<ScenarioRevision>;
  removePromotedScenario(context: ProjectContext, scenarioId: string): Promise<void>;
}

export interface PlatformLabSummary {
  summary: string;
  items: Array<{ id: string; title: string; status: string; created_at: string; href: string }>;
}

export type ExperimentRunAccepted = AcceptedRunStart;

export interface ExperimentRunStartRequest {
  readonly idempotencyKey: string;
  readonly revisionId: string;
}

export interface CreateScenarioInput {
  name: string;
  description: string;
  persona: string;
  goal: string;
  userTurns: string[];
  expectedOutcomeFacts: string[];
  forbiddenPhrases: string[];
  requiredPhrases: string[];
  expectedToolCalls: string[];
  latencyBudgetMs: number;
  tags: string[];
  audioFixtures?: string[];
}

export type UpdateScenarioInput = Partial<CreateScenarioInput>;

export interface CreateVariantInput {
  name: string;
  description: string;
  instructions: string;
  strategy: VariantRevision["strategy"];
  reliability: number;
  toolSuccessRate: number;
  latencyMs: number;
  providerLabel: string;
}

export type UpdateVariantInput = Partial<CreateVariantInput>;

export interface CreateExperimentInput {
  name: string;
  description: string;
  scenarioIds: string[];
  variantIds: string[];
  repetitions: number;
  mode: Experiment["mode"];
  captureEvidence?: boolean;
  evaluatorIds?: string[];
}

export type UpdateExperimentInput = Partial<CreateExperimentInput>;

export function createLabService(
  repository: LabRepository,
  executor: RunExecutor,
  options: { clock?: Clock; evidenceSink?: EvidenceSink; executors?: Partial<Record<ExecutionMode, RunExecutor>> } = {},
): LabService {
  const clock = options.clock ?? systemClock;
  const activeRunProjects = new Set<string>();
  const activeRunStartCalls = new Set<Promise<ExperimentRunAccepted>>();
  const activeRunExecutions = new Set<Promise<void>>();
  const runAbortControllers = new Set<AbortController>();
  const runAbortControllersByProject = new Map<string, Set<AbortController>>();
  const activeRunExecutionsByProject = new Map<string, Set<Promise<void>>>();
  const activeRunStartCallsByProject = new Map<string, Set<Promise<ExperimentRunAccepted>>>();
  const evidenceControllersByProject = new Map<string, Set<AbortController>>();
  const activeEvidenceWorkByProject = new Map<string, Set<Promise<unknown>>>();
  const pendingRuntimeCleanupByProject = new Map<string, RunArtifact>();
  const deletingProjects = new Set<string>();
  let acceptingRunStarts = true;
  const runLockOwnerId = newId("worker");

  function addProjectWork<T>(map: Map<string, Set<T>>, projectId: string, work: T): void {
    const workForProject = map.get(projectId) ?? new Set<T>();
    workForProject.add(work);
    map.set(projectId, workForProject);
  }

  function removeProjectWork<T>(map: Map<string, Set<T>>, projectId: string, work: T): void {
    const workForProject = map.get(projectId);
    workForProject?.delete(work);
    if (workForProject?.size === 0) map.delete(projectId);
  }

  function projectWork(projectId: string): Promise<unknown>[] {
    return [
      ...(activeRunStartCallsByProject.get(projectId) ?? []),
      ...(activeRunExecutionsByProject.get(projectId) ?? []),
      ...(activeEvidenceWorkByProject.get(projectId) ?? []),
    ];
  }

  async function assertProjectAvailable(context: ProjectContext): Promise<void> {
    if (deletingProjects.has(context.projectId)) {
      throw projectDeletionInProgressError();
    }
    if (await repository.isProjectPurged(context.projectId)) {
      throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
    }
  }

  async function getAvailableRun(context: ProjectContext, runId: string): Promise<RunArtifact> {
    if (deletingProjects.has(context.projectId)) {
      throw projectDeletionInProgressError();
    }
    const { run, projectPurged } = await repository.getRunWithProjectStatus(context.projectId, runId);
    if (projectPurged) throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  async function getAvailableRunProgress(context: ProjectContext, runId: string): Promise<RunProgressSnapshot> {
    if (deletingProjects.has(context.projectId)) {
      throw projectDeletionInProgressError();
    }
    const { progress, projectPurged } = await repository.getRunProgressWithProjectStatus(context.projectId, runId);
    if (projectPurged) throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
    if (!progress) throw new Error(`Run not found: ${runId}`);
    return progress;
  }

  async function read(context: ProjectContext, readOptions?: RepositoryReadOptions): Promise<LabState> {
    if (deletingProjects.has(context.projectId)) {
      throw projectDeletionInProgressError();
    }
    const [state, projectPurged] = await Promise.all([
      repository.read(context.projectId, { ...readOptions, includeProjectPurgeReceipt: false }),
      repository.isProjectPurged(context.projectId),
    ]);
    if (projectPurged) throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
    state.runs = [];
    if (state.evaluators.length === 0) state.evaluators = defaultEvaluators();
    return state;
  }

  function detailFor(state: LabState, experiment: Experiment, runs?: RunArtifact[], revisions?: ExperimentRevisionSummary[]): ExperimentDetail {
    const selectedScenarios = experiment.scenarioRevisionIds
      .map((revisionId) => scenarioRevision(state, revisionId))
      .filter((scenario): scenario is ScenarioRevision => Boolean(scenario));
    const selectedVariants = experiment.variantRevisionIds
      .map((revisionId) => variantRevision(state, revisionId))
      .filter((variant): variant is VariantRevision => Boolean(variant));
    const availableRuns = (runs ?? state.runs).filter((run) => run.experimentRevisionId === experiment.id);
    const experimentRuns = runs
      ? availableRuns
      : availableRuns.sort((a, b) => (b.startedAt ?? b.queuedAt ?? "").localeCompare(a.startedAt ?? a.queuedAt ?? "") || b.id.localeCompare(a.id));
    return {
      experiment,
      revisions: revisions ?? latestRevisions(state.experiments.filter((revision) => revision.experimentId === experiment.experimentId)),
      scenarios: selectedScenarios,
      variants: selectedVariants,
      runs: experimentRuns,
      comparison: compareRuns(experimentRuns, selectedVariants),
    };
  }

  async function loadExperimentRevision(context: ProjectContext, experimentId: string, revisionId?: string) {
    const revisions = await repository.listExperimentRevisionSummaries(context.projectId, experimentId);
    const selectedRevision = revisionId
      ? revisions.find((revision) => revision.id === revisionId)
      : revisions[revisions.length - 1];
    if (!selectedRevision) throw new Error(`Experiment not found: ${experimentId}`);
    const state = await read(context, { experimentRevisionIds: [selectedRevision.id] });
    const experiment = state.experiments.find((item) => item.id === selectedRevision.id && item.experimentId === experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    return { state, experiment, revisions };
  }

  function requireExperiment(state: LabState, id: string): Experiment {
    const experiment = findExperiment(state, id);
    if (!experiment) throw new Error(`Experiment not found: ${id}`);
    return experiment;
  }

  function requireScenario(state: LabState, id: string): ScenarioRevision {
    const scenario = latestScenario(state, id);
    if (!scenario) throw new Error(`Scenario not found: ${id}`);
    return scenario;
  }

  function requireVariant(state: LabState, id: string): VariantRevision {
    const variant = latestVariant(state, id);
    if (!variant) throw new Error(`Variant not found: ${id}`);
    return variant;
  }

  async function nextScenarioRevision(context: ProjectContext, scenarioId: string, input: CreateScenarioInput): Promise<ScenarioRevision> {
    const state = await read(context, { latestCatalogOnly: true });
    const current = latestScenario(state, scenarioId);
    const revision: ScenarioRevision = {
      ...input,
      id: newId("scenario_revision"),
      scenarioId,
      projectId: context.projectId,
      revision: (current?.revision ?? 0) + 1,
      createdAt: clock.now().toISOString(),
      createdBy: context.userId,
    };
    await persistCatalogRevision(() => repository.addScenarioRevision(context.projectId, revision));
    return revision;
  }

  async function nextVariantRevision(context: ProjectContext, variantId: string, input: CreateVariantInput): Promise<VariantRevision> {
    const state = await read(context, { latestCatalogOnly: true });
    const current = latestVariant(state, variantId);
    const revision: VariantRevision = {
      ...input,
      id: newId("variant_revision"),
      variantId,
      projectId: context.projectId,
      revision: (current?.revision ?? 0) + 1,
      createdAt: clock.now().toISOString(),
      createdBy: context.userId,
    };
    await persistCatalogRevision(() => repository.addVariantRevision(context.projectId, revision));
    return revision;
  }

  async function makeExperimentRevision(
    context: ProjectContext,
    experimentId: string,
    revisionNumber: number,
    input: CreateExperimentInput,
    state: LabState,
  ): Promise<Experiment> {
    const runCellCount = input.scenarioIds.length * input.variantIds.length * input.repetitions;
    if (runCellCount > MAX_RUN_CELLS) {
      throw Object.assign(new Error(`An experiment may contain at most ${MAX_RUN_CELLS} run cells.`), { statusCode: 422 });
    }
    const scenarios = input.scenarioIds.map((id) => requireScenario(state, id));
    const variants = input.variantIds.map((id) => requireVariant(state, id));
    if (input.mode === "audio") {
      const invalidScenario = scenarios.find((scenario) => (scenario.audioFixtures?.length ?? 0) !== scenario.userTurns.length);
      if (invalidScenario) {
        throw Object.assign(new Error(`Audio mode needs one fixture per caller turn in scenario “${invalidScenario.name}”.`), { statusCode: 422 });
      }
    }
    const providerTurns = scenarios.reduce((count, scenario) => count + scenario.userTurns.length, 0) * variants.length * input.repetitions;
    if (input.mode !== "deterministic" && providerTurns > MAX_PROVIDER_TURNS) {
      throw Object.assign(new Error(`A provider experiment may contain at most ${MAX_PROVIDER_TURNS} caller turns.`), { statusCode: 422 });
    }
    const revision: Experiment = {
      id: newId("experiment_revision"),
      experimentId,
      projectId: context.projectId,
      revision: revisionNumber,
      name: input.name,
      description: input.description,
      scenarioIds: [...input.scenarioIds],
      variantIds: [...input.variantIds],
      scenarioRevisionIds: scenarios.map((scenario) => scenario.id),
      variantRevisionIds: variants.map((variant) => variant.id),
      repetitions: input.repetitions,
      mode: input.mode,
      captureEvidence: input.captureEvidence ?? false,
      evaluatorIds: input.evaluatorIds ?? state.evaluators.map((evaluator) => evaluator.id),
      createdAt: clock.now().toISOString(),
      createdBy: context.userId,
    };
    await persistCatalogRevision(() => repository.addExperimentRevision(context.projectId, revision));
    return revision;
  }

  async function persistCatalogRevision(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (error instanceof ProjectCatalogCapacityError) {
        throw Object.assign(new Error(error.message), { statusCode: 429 });
      }
      throw error;
    }
  }

  let service: LabService;
  service = {
    stopAcceptingRunStarts() {
      acceptingRunStarts = false;
    },

    async drainAcceptedRuns(graceMs = RUN_SHUTDOWN_GRACE_MS) {
      acceptingRunStarts = false;
      const pendingWork = () => [...activeRunStartCalls, ...activeRunExecutions];
      const settle = Promise.allSettled(pendingWork());
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const graceElapsed = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, graceMs));
      });
      await Promise.race([settle, graceElapsed]);
      if (timeout) clearTimeout(timeout);
      if (pendingWork().length > 0) {
        for (const controller of runAbortControllers) {
          controller.abort(Object.assign(new Error("Voice Labs is shutting down."), { code: "shutdown_cancelled" }));
        }
      }
      while (pendingWork().length > 0) await Promise.allSettled(pendingWork());
    },

    async purgeProject(context) {
      while (deletingProjects.has(context.projectId)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const persisted = await repository.getProjectPurgeReceipt(context.projectId);
      if (persisted) return persisted;
      deletingProjects.add(context.projectId);
      try {
        for (const controller of runAbortControllersByProject.get(context.projectId) ?? []) {
          controller.abort(Object.assign(new Error("Voice Labs project deletion is stopping this run."), { code: "shutdown_cancelled" }));
        }
        for (const controller of evidenceControllersByProject.get(context.projectId) ?? []) {
          controller.abort(Object.assign(new Error("Voice Labs project deletion is stopping evidence delivery."), { code: "project_deleted" }));
        }
        while (projectWork(context.projectId).length > 0) {
          await Promise.allSettled(projectWork(context.projectId));
        }
        try {
          return await repository.purgeProject(context.projectId, clock.now().toISOString());
        } catch (error) {
          if (error instanceof ProjectPurgeBlockedError) {
            throw Object.assign(new Error("Project deletion is blocked while work is active or TVIC runtime cleanup is unconfirmed. Voice Labs has no automated cleanup reconciliation."), { statusCode: 409 });
          }
          throw error;
        }
      } finally {
        deletingProjects.delete(context.projectId);
      }
    },

    async getBootstrap(context) {
      const [state, recentRuns] = await Promise.all([
        read(context, { latestCatalogOnly: true, includeRegressionSet: true }),
        repository.listRecentRunSummaries(context.projectId, 24),
      ]);
      const latestExperiments = [...new Map(state.experiments.map((item) => [item.experimentId, latestExperiment(state, item.experimentId)!])).values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        product: "voice-labs",
        projectId: context.projectId,
        scenarios: latestScenarios(state),
        variants: latestVariants(state),
        evaluators: state.evaluators,
        experiments: latestExperiments,
        recentRuns,
        regressionScenarioIds: state.regressionSet.map((entry) => entry.scenarioId),
        regressionScenarioRevisions: state.regressionSet.map(({ scenarioId, revision }) => ({ scenarioId, revision })),
      };
    },

    async listScenarios(context) {
      return latestScenarios(await read(context, { latestCatalogOnly: true }));
    },

    async listVariants(context) {
      return latestVariants(await read(context, { latestCatalogOnly: true }));
    },

    async listExperiments(context) {
      const state = await read(context, { latestCatalogOnly: true });
      return [...new Map(state.experiments.map((item) => [item.experimentId, latestExperiment(state, item.experimentId)!])).values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async getExperimentDetail(context, id, revisionId) {
      const { state, experiment, revisions } = await loadExperimentRevision(context, id, revisionId);
      const fetched = await repository.listRuns(context.projectId, { experimentRevisionId: experiment.id, limit: EXPERIMENT_RUN_PAGE_SIZE + 1 });
      const runs = fetched.slice(0, EXPERIMENT_RUN_PAGE_SIZE);
      return {
        ...detailFor(state, experiment, runs, revisions),
        runsHasMore: fetched.length > EXPERIMENT_RUN_PAGE_SIZE,
        runsCursor: fetched.length > EXPERIMENT_RUN_PAGE_SIZE && runs.length > 0
          ? { startedAt: runs[runs.length - 1].startedAt ?? runs[runs.length - 1].queuedAt ?? "", id: runs[runs.length - 1].id }
          : null,
      };
    },

    async getExperimentRuns(context, id, before, revisionId) {
      const experiment = await repository.getExperimentRevisionSummary(context.projectId, id, revisionId);
      if (!experiment) throw new Error(`Experiment not found: ${id}`);
      const fetched = await repository.listRuns(context.projectId, {
        experimentRevisionId: experiment.id,
        limit: EXPERIMENT_RUN_PAGE_SIZE + 1,
        ...(before ? { before } : {}),
      });
      const runs = fetched.slice(0, EXPERIMENT_RUN_PAGE_SIZE);
      const hasMore = fetched.length > EXPERIMENT_RUN_PAGE_SIZE;
      return {
        runs,
        hasMore,
        nextCursor: hasMore && runs.length > 0
          ? { startedAt: runs[runs.length - 1].startedAt ?? runs[runs.length - 1].queuedAt ?? "", id: runs[runs.length - 1].id }
          : null,
      };
    },

    async getExperimentRunProgress(context, id, revisionId, knownRunIds = []) {
      if (deletingProjects.has(context.projectId)) {
        throw projectDeletionInProgressError();
      }
      if (knownRunIds.length > MAX_RUN_CELLS) {
        throw Object.assign(new Error(`At most ${MAX_RUN_CELLS} known runs may be reconciled at once.`), { statusCode: 422 });
      }
      const uniqueRunIds = [...new Set(knownRunIds)];
      if (uniqueRunIds.some((runId) => !/^[A-Za-z0-9_-]{1,200}$/.test(runId))) {
        throw Object.assign(new Error("Known run IDs must be valid Voice Labs identifiers."), { statusCode: 400 });
      }
      const result = await repository.getExperimentRunProgressWithProjectStatus(
        context.projectId,
        id,
        revisionId,
        EXPERIMENT_RUN_PAGE_SIZE,
        uniqueRunIds,
      );
      if (result.projectPurged) throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
      if (!result.experimentFound) throw new Error(`Experiment not found: ${id}`);
      return { runs: result.runs, missingRunIds: result.missingRunIds };
    },

    async exportExperiment(context, id, revisionId) {
      const { state, experiment, revisions } = await loadExperimentRevision(context, id, revisionId);
      const fetched = await repository.listRuns(context.projectId, { experimentRevisionId: experiment.id, limit: EXPERIMENT_EXPORT_RUN_LIMIT + 1 });
      return {
        ...detailFor(state, experiment, fetched.slice(0, EXPERIMENT_EXPORT_RUN_LIMIT), revisions),
        runsTruncated: fetched.length > EXPERIMENT_EXPORT_RUN_LIMIT,
      };
    },

    async getPlatformSummary(context, recordId) {
      await assertProjectAvailable(context);
      const runs = await repository.listRecentRunSummaries(context.projectId, recordId ? 1 : 50, recordId);
      const items = runs.map((run) => {
        const title = `${run.experimentName ?? "Voice Lab run"} · ${run.scenarioName ?? "Scenario"}`.slice(0, 160);
        return {
          id: run.id,
          title,
          status: run.status ?? "unknown",
          created_at: run.startedAt ?? "",
          href: `/lab?runId=${encodeURIComponent(run.id)}`,
        };
      });
      return {
        summary: recordId
          ? (items.length ? `${items[0].status} Voice Labs run.` : "The selected Voice Labs run is not available.")
          : items.length ? `${items.length} recent Voice Labs runs.` : "No Voice Labs runs yet.",
        items,
      };
    },

    async recoverStaleRunsBefore(cutoff) {
      return repository.expireStaleRunsBefore(cutoff, (run) => {
        const completedAt = clock.now().toISOString();
        const abandoned = run.status === "queued" || run.status === "running";
        const runtimeCleanupUnconfirmed = mayHaveUnconfirmedProviderRuntime(run);
        return {
          ...run,
            ...(abandoned ? {
            completedAt,
            ...(run.startedAt ? { durationMs: Math.max(1, Date.parse(completedAt) - Date.parse(run.startedAt)) } : {}),
            transcript: [],
            toolCalls: [],
            finalFacts: [],
            metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
            error: runtimeCleanupUnconfirmed
              ? { code: UNCONFIRMED_RUNTIME_CLEANUP_CODE, message: UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE }
              : { code: "run_abandoned", message: "Run did not complete before its execution lease expired." },
            status: "error" as const,
            ...(run.evidence?.status === "pending" && !run.startedAt
              ? { evidence: evidenceUnavailableBeforeStart(run.evidence) }
              : {}),
          } : {}),
        };
      });
    },

    async retryPendingEvidenceBefore(cutoff) {
      const ownerId = newId("earshot_retry_worker");
      const dueRuns = await repository.claimPendingEvidenceDue(
        cutoff,
        ownerId,
        new Date(clock.now().getTime() + EARSHOT_EVIDENCE_RETRY_LEASE_MS).toISOString(),
        MAX_EARSHOT_EVIDENCE_RETRY_BATCH,
      );
      let updated = 0;
      for (let offset = 0; offset < dueRuns.length; offset += 4) {
        const batch = dueRuns.slice(offset, offset + 4);
        const results = await Promise.all(batch.map(async (run) => {
          if (deletingProjects.has(run.projectId)) return false;
          const controller = new AbortController();
          addProjectWork(evidenceControllersByProject, run.projectId, controller);
          const operation = (async () => {
            const evidence = run.evidence;
            try {
              if (!evidence || evidence.status !== "pending" || deletingProjects.has(run.projectId)) return false;
              const attemptCount = evidence.attemptCount ?? 0;
              if (attemptCount >= MAX_EARSHOT_EVIDENCE_ATTEMPTS) {
                const unavailable = evidenceAfterReservedAttemptFailed(evidence, clock.now());
                return repository.savePendingRunEvidence(run.projectId, run.id, unavailable);
              }
              const reserved = reserveEvidenceAttempt(evidence, clock.now());
              if (!await repository.reservePendingEvidenceAttempt(run.projectId, run.id, ownerId, attemptCount, reserved)) return false;
              if (!options.evidenceSink) {
                const retry = evidenceAfterReservedAttemptFailed(reserved, clock.now());
                return repository.savePendingRunEvidence(run.projectId, run.id, retry);
              }
              let attached: EvidenceReference;
              try {
                const reference = options.evidenceSink.referenceFor?.({ projectId: run.projectId }, run);
                if (reference) await repository.recordEarshotReference(run.projectId, reference);
                attached = await options.evidenceSink.attach({ projectId: run.projectId }, run, controller.signal);
              } catch {
                const retry = evidenceAfterReservedAttemptFailed(reserved, clock.now());
                return repository.savePendingRunEvidence(run.projectId, run.id, retry);
              }
              if (attached.incidentId) {
                await repository.recordEarshotReference(run.projectId, {
                  incidentId: attached.incidentId,
                  endpoint: attached.endpoint,
                  deliveryStatus: "attached",
                  ...(attached.upstreamProjectId ? { upstreamProjectId: attached.upstreamProjectId } : {}),
                });
              }
              await repository.saveRunEvidence(run.projectId, run.id, attached);
              return true;
            } finally {
              try {
                await repository.releasePendingEvidenceClaim(run.projectId, run.id, ownerId);
              } catch {
                // The lease expires automatically if storage is unavailable during release.
              }
            }
          })();
          addProjectWork(activeEvidenceWorkByProject, run.projectId, operation);
          try {
            return await operation;
          } finally {
            removeProjectWork(activeEvidenceWorkByProject, run.projectId, operation);
            removeProjectWork(evidenceControllersByProject, run.projectId, controller);
          }
        }));
        updated += results.filter(Boolean).length;
      }
      return updated;
    },

    async getRun(context, id) {
      return getAvailableRun(context, id);
    },

    async getRunStatus(context, id) {
      return getAvailableRunProgress(context, id);
    },

    async deleteRun(context, id) {
      const run = await getAvailableRun(context, id);
      if (run.status === "running" || run.status === "queued") {
        throw Object.assign(new Error("An active or queued run cannot be deleted."), { statusCode: 409 });
      }
      if (hasUnconfirmedRuntimeCleanup(run)) {
        throw Object.assign(new Error("This run cannot be deleted while TVIC runtime cleanup is unconfirmed. Voice Labs has no automated cleanup reconciliation."), { statusCode: 409 });
      }
      if (run.evidence?.status === "pending") {
        throw Object.assign(new Error("A run cannot be deleted while its Earshot evidence attachment is pending."), { statusCode: 409 });
      }
      let deleted: boolean;
      try {
        deleted = await repository.deleteRun(context.projectId, id);
      } catch (error) {
        if (error instanceof ProjectPurgedError) {
          throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
        }
        throw error;
      }
      if (!deleted) {
        const latest = (await repository.listRuns(context.projectId, { runId: id }))[0];
        if (latest?.status === "queued" || latest?.status === "running") {
          throw Object.assign(new Error("An active or queued run cannot be deleted."), { statusCode: 409 });
        }
        if (latest && hasUnconfirmedRuntimeCleanup(latest)) {
          throw Object.assign(new Error("This run cannot be deleted while TVIC runtime cleanup is unconfirmed. Voice Labs has no automated cleanup reconciliation."), { statusCode: 409 });
        }
        if (latest?.evidence?.status === "pending") {
          throw Object.assign(new Error("A run cannot be deleted while its Earshot evidence attachment is pending."), { statusCode: 409 });
        }
        throw new Error(`Run not found: ${id}`);
      }
    },

    async createScenario(context, input) {
      return nextScenarioRevision(context, newId("scenario"), input);
    },

    async updateScenario(context, id, input) {
      const state = await read(context, { latestCatalogOnly: true });
      const current = requireScenario(state, id);
      return nextScenarioRevision(context, id, { ...current, ...input });
    },

    async createVariant(context, input) {
      return nextVariantRevision(context, newId("variant"), input);
    },

    async updateVariant(context, id, input) {
      const state = await read(context, { latestCatalogOnly: true });
      const current = requireVariant(state, id);
      return nextVariantRevision(context, id, { ...current, ...input });
    },

    async createExperiment(context, input) {
      const state = await read(context, { latestCatalogOnly: true });
      const id = newId("experiment");
      return makeExperimentRevision(context, id, 1, input, state);
    },

    async updateExperiment(context, id, input) {
      const state = await read(context, { latestCatalogOnly: true });
      const current = requireExperiment(state, id);
      const merged: CreateExperimentInput = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        scenarioIds: input.scenarioIds ?? current.scenarioIds,
        variantIds: input.variantIds ?? current.variantIds,
        repetitions: input.repetitions ?? current.repetitions,
        mode: input.mode ?? current.mode,
        captureEvidence: input.captureEvidence ?? current.captureEvidence,
        evaluatorIds: input.evaluatorIds ?? current.evaluatorIds,
      };
      return makeExperimentRevision(context, current.experimentId, current.revision + 1, merged, state);
    },

    async startExperiment(context, id, request) {
      if (!acceptingRunStarts) {
        throw Object.assign(new Error("Voice Labs is stopping and is not accepting new run starts."), { statusCode: 503 });
      }
      if (deletingProjects.has(context.projectId)) {
        throw projectDeletionInProgressError();
      }
      const operation = (async () => {
      await assertProjectAvailable(context);
      let requestKeyHash: string | undefined;
      let requestFingerprint: string | undefined;
      if (request) {
        if (!/^[!#-~]{1,200}$/.test(request.idempotencyKey)) {
          throw Object.assign(new Error("Idempotency-Key must contain 1 to 200 visible ASCII characters."), { statusCode: 400 });
        }
        if (!request.revisionId.trim() || request.revisionId.length > 200) {
          throw Object.assign(new Error("revision_id must be a non-empty experiment revision identifier."), { statusCode: 400 });
        }
        requestKeyHash = createHash("sha256").update(request.idempotencyKey).digest("hex");
        requestFingerprint = createHash("sha256")
          .update(JSON.stringify([context.projectId, id, request.revisionId]))
          .digest("hex");
      }

      const reconcileStartedAt = Date.now();
      while (request && requestKeyHash && requestFingerprint) {
        if (deletingProjects.has(context.projectId)) {
          throw projectDeletionInProgressError();
        }
        if (!acceptingRunStarts) {
          throw Object.assign(new Error("Voice Labs is stopping and is not accepting new run starts."), { statusCode: 503 });
        }
        const ownerId = newId("run_start");
        const now = clock.now();
        const claim = await repository.claimRunStartRequest(context.projectId, {
          requestKeyHash,
          requestFingerprint,
          status: "preparing",
          ownerId,
          leaseExpiresAt: new Date(now.getTime() + RUN_START_PREPARATION_LEASE_MS).toISOString(),
          createdAt: now.toISOString(),
        }, now.toISOString());

        if (claim.state === "accepted") return claim.acceptance;
        if (claim.state === "conflict") {
          throw Object.assign(new Error("Idempotency-Key was already used for a different experiment revision."), { statusCode: 409 });
        }
        if (claim.state === "claimed") {
          return launch({ revisionId: request.revisionId, requestKeyHash, ownerId });
        }

        if (Date.now() - reconcileStartedAt >= RUN_START_RECONCILE_WAIT_MS) {
          throw Object.assign(new Error("The matching run-start request is still being prepared. Retry with the same Idempotency-Key."), { statusCode: 503 });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return launch();

      async function launch(startRequest?: { revisionId: string; requestKeyHash: string; ownerId: string }): Promise<ExperimentRunAccepted> {
      const controller = new AbortController();
      runAbortControllers.add(controller);
      addProjectWork(runAbortControllersByProject, context.projectId, controller);
      let resolveAccepted!: (accepted: ExperimentRunAccepted) => void;
      let rejectAccepted!: (error: unknown) => void;
      let acceptedRunIds: string[] = [];
      const preparedRunIds: string[] = [];
      const accepted = new Promise<ExperimentRunAccepted>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      const execution = service.runExperiment(context, id, (value) => {
        acceptedRunIds = value.runIds;
        resolveAccepted(value);
      }, (attempt) => preparedRunIds.push(attempt.id), startRequest, controller.signal);
      const trackedExecution: Promise<void> = execution.then(() => undefined).catch(async (error: unknown) => {
        const cleanupUnconfirmed = typeof error === "object" && error !== null && "code" in error && error.code === UNCONFIRMED_RUNTIME_CLEANUP_CODE;
        if (startRequest) {
          try {
            await repository.releaseRunStartRequest(context.projectId, startRequest.requestKeyHash, startRequest.ownerId);
          } catch {
            // An expired preparation lease allows a later retry to recover this request.
          }
        }
        const runIdsToFail = acceptedRunIds.length > 0 ? acceptedRunIds : preparedRunIds;
        for (const runId of runIdsToFail) {
          try {
            const current = (await repository.listRuns(context.projectId, { runId }))[0];
            if (current && hasUnconfirmedRuntimeCleanup(current)) {
              if (pendingRuntimeCleanupByProject.get(context.projectId)?.id === runId) {
                pendingRuntimeCleanupByProject.delete(context.projectId);
              }
              continue;
            }
            if (!current || (current.status !== "running" && current.status !== "queued")) continue;
            const completedAt = clock.now().toISOString();
            const pendingCleanup = pendingRuntimeCleanupByProject.get(context.projectId);
            if (cleanupUnconfirmed && pendingCleanup?.id === runId) {
              await repository.updateRun(context.projectId, pendingCleanup);
              pendingRuntimeCleanupByProject.delete(context.projectId);
              continue;
            }
            await repository.updateRun(context.projectId, {
              ...current,
              completedAt,
              ...(current.startedAt ? { durationMs: Math.max(1, Date.parse(completedAt) - Date.parse(current.startedAt)) } : {}),
              ...(current.evidence?.status === "pending" && !current.startedAt
                ? { evidence: evidenceUnavailableBeforeStart(current.evidence) }
                : {}),
              transcript: [],
              toolCalls: [],
              finalFacts: [],
              metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
              error: acceptedRunIds.length > 0
                ? cleanupUnconfirmed
                  ? {
                      code: PRIOR_RUNTIME_CLEANUP_BLOCKED_CODE,
                      message: PRIOR_RUNTIME_CLEANUP_BLOCKED_MESSAGE,
                    }
                  : { code: "worker_failed", message: "The run worker could not complete this attempt." }
                : { code: "run_preparation_failed", message: "The experiment could not prepare this attempt." },
              status: "error",
            });
          } catch {
            // Stale-run recovery will record an error when storage becomes available again.
          }
        }
        if (cleanupUnconfirmed && !pendingRuntimeCleanupByProject.has(context.projectId)) {
          await repository.releaseProviderRunSlot(context.projectId, runLockOwnerId).catch(() => undefined);
          await repository.releaseProjectRunLock(context.projectId, runLockOwnerId).catch(() => undefined);
        }
        if (acceptedRunIds.length === 0) rejectAccepted(error);
      });
      activeRunExecutions.add(trackedExecution);
      addProjectWork(activeRunExecutionsByProject, context.projectId, trackedExecution);
      void trackedExecution.finally(() => {
        activeRunExecutions.delete(trackedExecution);
        removeProjectWork(activeRunExecutionsByProject, context.projectId, trackedExecution);
        runAbortControllers.delete(controller);
        removeProjectWork(runAbortControllersByProject, context.projectId, controller);
      }).catch(() => undefined);
      return accepted;
      }
      })();
      activeRunStartCalls.add(operation);
      addProjectWork(activeRunStartCallsByProject, context.projectId, operation);
      try {
        return await operation;
      } finally {
        activeRunStartCalls.delete(operation);
        removeProjectWork(activeRunStartCallsByProject, context.projectId, operation);
      }
    },

    async runExperiment(context, id, onPrepared, onAttemptPrepared, startRequest, signal) {
      if (activeRunProjects.has(context.projectId)) {
        throw Object.assign(new Error("A Voice Labs experiment is already running for this project."), { statusCode: 409 });
      }
      activeRunProjects.add(context.projectId);
      let acquiredRunLock = false;
      let acquiredProviderSlot = false;
      try {
      acquiredRunLock = await repository.acquireProjectRunLock(
        context.projectId,
        runLockOwnerId,
        new Date(Date.now() + PROJECT_RUN_LOCK_MS).toISOString(),
      );
      if (!acquiredRunLock) {
        throw Object.assign(new Error("A Voice Labs experiment is already running for this project, or prior TVIC runtime cleanup is unconfirmed. Voice Labs has no automated cleanup reconciliation."), { statusCode: 409 });
      }
      const initialState = await read(context, startRequest?.revisionId
        ? { experimentRevisionIds: [startRequest.revisionId] }
        : { experimentId: id, latestExperimentOnly: true });
      const experiment = startRequest?.revisionId
        ? initialState.experiments.find((revision) => revision.id === startRequest.revisionId && revision.experimentId === id)
        : requireExperiment(initialState, id);
      if (!experiment) throw Object.assign(new Error(`Experiment revision not found: ${startRequest?.revisionId ?? id}`), { statusCode: 404 });
      const runCellCount = experiment.scenarioRevisionIds.length * experiment.variantRevisionIds.length * experiment.repetitions;
      if (runCellCount > MAX_RUN_CELLS) {
        throw Object.assign(new Error(`This run contains ${runCellCount} cells; the limit is ${MAX_RUN_CELLS}. Split the experiment into smaller runs.`), { statusCode: 422 });
      }
      if (experiment.captureEvidence) {
        const pendingEvidenceCount = await repository.countPendingEvidence(context.projectId);
        if (pendingEvidenceCount + runCellCount > MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT) {
          throw Object.assign(new Error(`This project has reached its limit of ${MAX_PENDING_EARSHOT_EVIDENCE_PER_PROJECT} pending Earshot attachments. Wait for delivery retries to clear the backlog before starting another evidence-capturing experiment.`), { statusCode: 429 });
        }
      }
      const selectedScenarios = experiment.scenarioRevisionIds.map((revisionId) => {
        const scenario = scenarioRevision(initialState, revisionId);
        if (!scenario) throw new Error(`Scenario revision not found: ${revisionId}`);
        return scenario;
      });
      const providerTurnCount = selectedScenarios.reduce((count, scenario) => count + scenario.userTurns.length, 0)
        * experiment.variantRevisionIds.length * experiment.repetitions;
      if (experiment.mode !== "deterministic" && providerTurnCount > MAX_PROVIDER_TURNS) {
        throw Object.assign(new Error(`This provider experiment contains ${providerTurnCount} caller turns; the limit is ${MAX_PROVIDER_TURNS}.`), { statusCode: 422 });
      }
      if (experiment.mode === "audio") {
        const invalidScenario = selectedScenarios.find((scenario) => (scenario.audioFixtures?.length ?? 0) !== scenario.userTurns.length);
        if (invalidScenario) {
          throw Object.assign(new Error(`Audio mode needs one fixture per caller turn in scenario “${invalidScenario.name}”.`), { statusCode: 422 });
        }
      }
      const selectedExecutor = experiment.mode === "deterministic" ? executor : options.executors?.[experiment.mode];
      if (!selectedExecutor) throw Object.assign(new Error(`Execution mode is not configured locally: ${experiment.mode}`), { statusCode: 503 });
      if (experiment.mode !== "deterministic") {
        const quotaCutoff = new Date(clock.now().getTime() - PROVIDER_RUN_QUOTA_WINDOW_MS).toISOString();
        const recentProviderAttempts = await repository.countProviderRunsSince(context.projectId, quotaCutoff);
        if (recentProviderAttempts + runCellCount > MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY) {
          throw Object.assign(new Error(`This run would exceed the project limit of ${MAX_PROVIDER_RUNS_PER_PROJECT_PER_DAY} provider-backed attempts in 24 hours. Try again after older attempts leave the quota window.`), { statusCode: 429 });
        }
      }
      const evaluators = experiment.evaluatorIds.length > 0
        ? initialState.evaluators.filter((evaluator) => experiment.evaluatorIds.includes(evaluator.id))
        : defaultEvaluators();
      if (experiment.mode !== "deterministic") {
        acquiredProviderSlot = await repository.acquireProviderRunSlot(
          context.projectId,
          runLockOwnerId,
          new Date(Date.now() + PROJECT_RUN_LOCK_MS).toISOString(),
        );
        if (!acquiredProviderSlot) {
          throw Object.assign(new Error(PROVIDER_CAPACITY_UNAVAILABLE_MESSAGE), { statusCode: 503 });
        }
      }
      const executorPreparation = await selectedExecutor.preflight?.(experiment.mode, selectedScenarios, signal);
      const plannedRuns: Array<{ scenario: ScenarioRevision; variant: VariantRevision; repetition: number; seed: number; attempt: RunArtifact }> = [];
      for (const scenarioRevisionId of experiment.scenarioRevisionIds) {
        const scenario = scenarioRevision(initialState, scenarioRevisionId);
        if (!scenario) throw new Error(`Scenario revision not found: ${scenarioRevisionId}`);
        for (const variantRevisionId of experiment.variantRevisionIds) {
          const variant = variantRevision(initialState, variantRevisionId);
          if (!variant) throw new Error(`Variant revision not found: ${variantRevisionId}`);
          for (let repetition = 1; repetition <= experiment.repetitions; repetition += 1) {
            const seed = stableSeed(experiment.experimentId, scenario.id, variant.id, repetition);
            const queuedAt = clock.now().toISOString();
            const attempt: RunArtifact = {
              id: newId("run"),
              projectId: context.projectId,
              experimentId: experiment.experimentId,
              experimentRevisionId: experiment.id,
              scenarioId: scenario.id,
              variantId: variant.id,
              repetition,
              seed,
              mode: experiment.mode,
              queuedAt,
              latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
              transcript: [],
              toolCalls: [],
              finalFacts: [],
              metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
              status: "queued",
              ...(experiment.captureEvidence ? { evidence: {
                source: "earshot" as const,
                endpoint: options.evidenceSink?.endpoint ?? "not-configured",
                status: "pending" as const,
            } } : {}),
            };
            plannedRuns.push({ scenario, variant, repetition, seed, attempt });
          }
        }
      }
      const accepted: ExperimentRunAccepted = {
        experimentId: experiment.experimentId,
        runIds: plannedRuns.map(({ attempt }) => attempt.id),
        status: "queued",
      };
      if (!acceptingRunStarts || signal?.aborted) {
        throw Object.assign(new Error("Voice Labs stopped before accepting this run request."), { statusCode: 503 });
      }
      if (startRequest) {
        const recorded = await repository.completeRunStartRequest(
          context.projectId,
          startRequest.requestKeyHash,
          startRequest.ownerId,
          accepted,
          plannedRuns.map(({ attempt }) => attempt),
        );
        if (!recorded) {
          throw Object.assign(new Error("The run-start preparation lease expired before acceptance. Retry with the same Idempotency-Key."), { statusCode: 409 });
        }
      } else {
        await repository.appendRuns(context.projectId, plannedRuns.map(({ attempt }) => attempt));
      }
      for (const { attempt } of plannedRuns) onAttemptPrepared?.(attempt);
      onPrepared?.(accepted);

      const executedRuns: RunArtifact[] = [];
      for (let taskIndex = 0; taskIndex < plannedRuns.length; taskIndex += 1) {
            if (signal?.aborted) {
              for (const queued of plannedRuns.slice(taskIndex)) {
                const cancelled = cancelledBeforeStart(queued.attempt, clock.now().toISOString());
                await repository.updateRun(context.projectId, cancelled);
                executedRuns.push(cancelled);
              }
              break;
            }
            const task = plannedRuns[taskIndex];
            const { scenario, variant, repetition, seed, attempt } = task;
            if (experiment.mode !== "deterministic" && !acquiredProviderSlot) {
              acquiredProviderSlot = await repository.acquireProviderRunSlot(
                context.projectId,
                runLockOwnerId,
                new Date(Date.now() + PROJECT_RUN_LOCK_MS).toISOString(),
              );
              if (!acquiredProviderSlot) {
                throw Object.assign(new Error(PROVIDER_CAPACITY_UNAVAILABLE_MESSAGE), { statusCode: 503 });
              }
            }
            const runningAttempt: RunArtifact = { ...attempt, startedAt: clock.now().toISOString(), status: "running" };
            await repository.updateRun(context.projectId, runningAttempt);
            const startedAt = clock.now();
            let artifact: RunArtifact;
            try {
              artifact = await selectedExecutor.execute({
                context,
                experimentId: experiment.experimentId,
                experimentRevisionId: experiment.id,
                scenario,
                variant,
                repetition,
                seed,
                mode: experiment.mode,
              }, executorPreparation, signal);
            } catch (error) {
              const cancellationUnconfirmed = typeof error === "object" && error !== null && "code" in error && error.code === UNCONFIRMED_RUNTIME_CLEANUP_CODE;
              artifact = signal?.aborted && !cancellationUnconfirmed
                ? {
                    ...failedRun({ context, experiment, scenario, variant, repetition, seed, startedAt }),
                    error: { code: "shutdown_cancelled", message: "Voice Labs cancelled this accepted attempt during graceful shutdown." },
                    status: "cancelled",
                  }
                : {
                    ...failedRun({ context, experiment, scenario, variant, repetition, seed, startedAt }),
                    ...(cancellationUnconfirmed ? {
                      error: { code: UNCONFIRMED_RUNTIME_CLEANUP_CODE, message: UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE },
                    } : {}),
                  };
            }

            if (signal?.aborted && artifact.status === "error" && artifact.error?.code !== UNCONFIRMED_RUNTIME_CLEANUP_CODE) {
              artifact = {
                ...artifact,
                error: { code: "shutdown_cancelled", message: "Voice Labs cancelled this accepted attempt during graceful shutdown." },
                status: "cancelled",
              };
            }

            const evaluations = artifact.status === "error" || artifact.status === "cancelled"
              ? unknownEvaluations(evaluators, "The runtime did not complete; evaluator evidence is unavailable.")
              : evaluateRun(artifact, scenario, evaluators);
            let completed: RunArtifact = {
              ...runningAttempt,
              ...artifact,
              id: attempt.id,
              projectId: context.projectId,
              experimentId: experiment.experimentId,
              experimentRevisionId: experiment.id,
              scenarioId: scenario.id,
              variantId: variant.id,
              startedAt: artifact.startedAt ?? runningAttempt.startedAt,
              latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
              status: statusFor(artifact, evaluations),
              evaluations,
              ...(experiment.captureEvidence ? { evidence: options.evidenceSink
                ? { ...attempt.evidence! }
                : { source: "earshot" as const, endpoint: "not-configured", status: "unavailable" as const, message: "Earshot capture is not configured." } } : {}),
            };
            const cleanupUnconfirmed = hasUnconfirmedRuntimeCleanup(completed);
            if (cleanupUnconfirmed) pendingRuntimeCleanupByProject.set(context.projectId, completed);
            try {
              await repository.updateRun(context.projectId, completed);
              if (cleanupUnconfirmed) pendingRuntimeCleanupByProject.delete(context.projectId);
            } catch (error) {
              if (cleanupUnconfirmed) {
                throw Object.assign(new Error(UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE), {
                  code: UNCONFIRMED_RUNTIME_CLEANUP_CODE,
                  cause: error,
                });
              }
              throw error;
            }

            if (acquiredProviderSlot) {
              await repository.releaseProviderRunSlot(context.projectId, runLockOwnerId);
              acquiredProviderSlot = false;
            }

            executedRuns.push(completed);
            if (hasUnconfirmedRuntimeCleanup(completed)) {
              for (const queued of plannedRuns.slice(taskIndex + 1)) {
                const blocked = blockedBeforeStartAfterRuntimeCleanupFailure(queued.attempt, clock.now().toISOString());
                await repository.updateRun(context.projectId, blocked);
                executedRuns.push(blocked);
              }
              break;
            }
      }

      if (experiment.captureEvidence) {
        if (acquiredProviderSlot) {
          await repository.releaseProviderRunSlot(context.projectId, runLockOwnerId);
          acquiredProviderSlot = false;
        }
        if (acquiredRunLock) {
          await repository.releaseProjectRunLock(context.projectId, runLockOwnerId);
          acquiredRunLock = false;
        }
        activeRunProjects.delete(context.projectId);
        await service.retryPendingEvidenceBefore(clock.now().toISOString());
      }

      const persistedRuns = await Promise.all(executedRuns.map(async (run) =>
        (await repository.listRuns(context.projectId, { runId: run.id }))[0] ?? run,
      ));
      const revisions = await repository.listExperimentRevisionSummaries(context.projectId, experiment.experimentId);
      return detailFor(initialState, experiment, persistedRuns, revisions);
      } finally {
        activeRunProjects.delete(context.projectId);
        const cleanupPersistencePending = pendingRuntimeCleanupByProject.has(context.projectId);
        if (acquiredProviderSlot && !cleanupPersistencePending) {
          try {
            await repository.releaseProviderRunSlot(context.projectId, runLockOwnerId);
          } catch {
            // The provider slot lease expires automatically if storage is unavailable during release.
          }
        }
        if (acquiredRunLock && !cleanupPersistencePending) {
          try {
            await repository.releaseProjectRunLock(context.projectId, runLockOwnerId);
          } catch {
            // The persisted lease expires automatically if storage is unavailable during release.
          }
        }
      }
    },

    async promoteScenario(context, scenarioId, revisionId) {
      await assertProjectAvailable(context);
      const scenario = await repository.getScenarioRevision(context.projectId, scenarioId, revisionId);
      if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`);
      await repository.appendRegressionEntry(context.projectId, {
        projectId: context.projectId,
        scenarioId,
        revision: scenario.revision,
        promotedAt: clock.now().toISOString(),
        promotedBy: context.userId,
      });
      return scenario;
    },

    async removePromotedScenario(context, scenarioId) {
      await assertProjectAvailable(context);
      if (!await repository.removeRegressionEntry(context.projectId, scenarioId)) {
        throw new Error(`Regression scenario not found: ${scenarioId}`);
      }
    },
  };
  return service;
}
