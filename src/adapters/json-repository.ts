import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultEvaluators } from "../domain/evaluate.js";
import { earshotIncidentReferenceFromRun, mergeEarshotIncidentReference, mergeEarshotIncidentReferences, sortEarshotIncidentReferences } from "../domain/earshot-reference.js";
import { hasUnconfirmedRuntimeCleanup, mayHaveUnconfirmedProviderRuntime } from "../domain/run-lifecycle.js";
import { MAX_CONCURRENT_PROVIDER_RUNS, MAX_MAINTENANCE_RUN_BATCH } from "../domain/limits.js";
import type { AcceptedRunStart, EarshotIncidentReference, EvidenceReference, Experiment, ExperimentRevisionSummary, LabState, ProjectPurgeReceipt, RegressionEntry, RunArtifact, RunStartRequestRecord, ScenarioRevision, VariantRevision } from "../domain/model.js";
import { assertProjectCatalogCapacity, assertProjectPurgeQuiescent, cloneState, emptyState, listExperimentRunStatusSnapshots, missingExperimentRunStatusIds, summarizeRun, toRunProgressSnapshot, type ExperimentRunProgressWithProjectStatus, type LabRepository, type RepositoryReadOptions, type RunProgressWithProjectStatus, type RunQuery, type RunStartRequestClaim, type RunWithProjectStatus } from "./repository.js";

/** Single-project adapter retained for loopback-only local development. */
export class JsonFileRepository implements LabRepository {
  private state: LabState | undefined;
  private stateLoad: Promise<LabState> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  readonly #runLocks = new Map<string, { ownerId: string; expiresAt: number }>();
  readonly #providerRunSlots = new Map<string, { ownerId: string; expiresAt: number }>();
  readonly #evidenceRetryLeases = new Map<string, { ownerId: string; expiresAt: number }>();

  public constructor(private readonly filePath: string, private readonly localProjectId = "local") {}

  public async read(projectId: string, options?: RepositoryReadOptions): Promise<LabState> {
    this.#assertLocalProject(projectId);
    const state = await this.#loadState();
    return cloneState(options?.includeProjectPurgeReceipt === false ? { ...state, projectPurge: null } : state);
  }

  public async isProjectPurged(projectId: string): Promise<boolean> {
    this.#assertLocalProject(projectId);
    return Boolean((await this.#loadState()).projectPurge);
  }

  public async getProjectPurgeReceipt(projectId: string): Promise<ProjectPurgeReceipt | null> {
    this.#assertLocalProject(projectId);
    const receipt = (await this.#loadState()).projectPurge;
    return receipt ? structuredClone(receipt) : null;
  }

  public async getRunWithProjectStatus(projectId: string, runId: string): Promise<RunWithProjectStatus> {
    this.#assertLocalProject(projectId);
    const state = await this.#loadState();
    const run = state.runs.find((candidate) => candidate.id === runId);
    return {
      run: run ? structuredClone(run) : undefined,
      projectPurged: Boolean(state.projectPurge),
    };
  }

  public async getRunProgressWithProjectStatus(projectId: string, runId: string): Promise<RunProgressWithProjectStatus> {
    this.#assertLocalProject(projectId);
    const state = await this.#loadState();
    const run = state.runs.find((candidate) => candidate.id === runId);
    return {
      progress: run ? toRunProgressSnapshot(run) : undefined,
      projectPurged: Boolean(state.projectPurge),
    };
  }

  public async getExperimentRunProgressWithProjectStatus(
    projectId: string,
    experimentId: string,
    revisionId: string,
    limit: number,
    knownRunIds: readonly string[] = [],
  ): Promise<ExperimentRunProgressWithProjectStatus> {
    this.#assertLocalProject(projectId);
    const state = await this.#loadState();
    const experimentFound = state.experiments.some((experiment) =>
      experiment.experimentId === experimentId && experiment.id === revisionId);
    const runs = experimentFound
      ? listExperimentRunStatusSnapshots(state.runs, experimentId, revisionId, limit, knownRunIds)
      : [];
    return {
      experimentFound,
      runs,
      missingRunIds: missingExperimentRunStatusIds(knownRunIds, runs),
      projectPurged: Boolean(state.projectPurge),
    };
  }

  public async getScenarioRevision(projectId: string, scenarioId: string, revisionId?: string): Promise<ScenarioRevision | undefined> {
    const revisions = (await this.read(projectId)).scenarios.filter((scenario) => scenario.scenarioId === scenarioId);
    return revisionId
      ? revisions.find((scenario) => scenario.id === revisionId)
      : revisions.sort((a, b) => b.revision - a.revision)[0];
  }

  public async listExperimentRevisionSummaries(projectId: string, experimentId: string): Promise<ExperimentRevisionSummary[]> {
    const state = await this.read(projectId);
    return state.experiments
      .filter((experiment) => experiment.experimentId === experimentId)
      .map(({ id, experimentId: stableId, revision, name, createdAt }) => ({ id, experimentId: stableId, revision, name, createdAt }))
      .sort((a, b) => a.revision - b.revision);
  }

  public async getExperimentRevisionSummary(projectId: string, experimentId: string, revisionId?: string): Promise<ExperimentRevisionSummary | undefined> {
    const summaries = await this.listExperimentRevisionSummaries(projectId, experimentId);
    return revisionId ? summaries.find((revision) => revision.id === revisionId) : summaries[summaries.length - 1];
  }

  public async listRuns(projectId: string, query: RunQuery = {}): Promise<RunArtifact[]> {
    const state = await this.read(projectId);
    let runs = state.runs;
    if (query.runId) runs = runs.filter((run) => run.id === query.runId);
    if (query.experimentRevisionId) runs = runs.filter((run) => run.experimentRevisionId === query.experimentRevisionId);
    if (query.status) runs = runs.filter((run) => run.status === query.status);
    runs = [...runs].sort((a, b) => (b.startedAt ?? b.queuedAt ?? "").localeCompare(a.startedAt ?? a.queuedAt ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (query.before) {
      runs = runs.filter((run) => {
        const timestamp = run.startedAt ?? run.queuedAt ?? "";
        return timestamp < query.before!.startedAt || (timestamp === query.before!.startedAt && run.id < query.before!.id);
      });
    }
    return query.limit === undefined ? runs : runs.slice(0, query.limit);
  }

  public async countPendingEvidence(projectId: string): Promise<number> {
    return (await this.read(projectId)).runs.filter((run) => run.evidence?.status === "pending").length;
  }

  public async claimPendingEvidenceDue(cutoff: string, ownerId: string, leaseExpiresAt: string, limit: number): Promise<RunArtifact[]> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Evidence retry cutoff must be a valid timestamp.");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Evidence retry limit must be a positive integer.");
    const expiration = Date.parse(leaseExpiresAt);
    if (!ownerId.trim() || !Number.isFinite(expiration)) throw new Error("Evidence retry lease requires an owner and valid expiry.");
    return this.#enqueue(async () => {
      for (const [key, lease] of this.#evidenceRetryLeases) {
        if (lease.expiresAt <= threshold) this.#evidenceRetryLeases.delete(key);
      }
      const state = await this.read(this.localProjectId);
      if (state.projectPurge) return [];
      const candidates = state.runs
        .filter((run) => {
          const evidence = run.evidence;
          if (!evidence || evidence.status !== "pending" || run.status === "queued" || run.status === "running") return false;
          const retryAt = evidence.retryAt ? Date.parse(evidence.retryAt) : Number.NEGATIVE_INFINITY;
          return !Number.isFinite(retryAt) || retryAt <= threshold;
        })
        .sort((left, right) => (left.startedAt ?? left.queuedAt ?? "").localeCompare(right.startedAt ?? right.queuedAt ?? ""))
        .slice(0, MAX_MAINTENANCE_RUN_BATCH);
      const claimed: RunArtifact[] = [];
      for (const run of candidates) {
        if (claimed.length >= Math.min(limit, MAX_MAINTENANCE_RUN_BATCH)) break;
        const key = `${run.projectId}\0${run.id}`;
        if (this.#evidenceRetryLeases.has(key)) continue;
        this.#evidenceRetryLeases.set(key, { ownerId, expiresAt: expiration });
        claimed.push(run);
      }
      return claimed;
    });
  }

  public async releasePendingEvidenceClaim(projectId: string, runId: string, ownerId: string): Promise<void> {
    this.#assertLocalProject(projectId);
    const key = `${projectId}\0${runId}`;
    if (this.#evidenceRetryLeases.get(key)?.ownerId === ownerId) this.#evidenceRetryLeases.delete(key);
  }

  public async listRecentRunSummaries(projectId: string, limit: number, runId?: string) {
    const state = await this.read(projectId);
    const namesByRevision = (items: Array<{ id: string; name: string }>) => new Map(items.map(({ id, name }) => [id, name]));
    const scenarioNames = namesByRevision(state.scenarios);
    const variantNames = namesByRevision(state.variants);
    const experimentNames = namesByRevision(state.experiments);
    return (await this.listRuns(projectId, { limit, ...(runId ? { runId } : {}) })).map((run) => summarizeRun(run, {
      experimentName: experimentNames.get(run.experimentRevisionId),
      scenarioName: scenarioNames.get(run.scenarioId),
      variantName: variantNames.get(run.variantId),
    }));
  }

  public async countProviderRunsSince(projectId: string, cutoff: string): Promise<number> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Provider run quota cutoff must be a valid timestamp.");
    return (await this.read(projectId)).providerAttemptUsage.filter((attempt) =>
      Date.parse(attempt.queuedAt) >= threshold,
    ).length;
  }

  public async acquireProjectRunLock(projectId: string, ownerId: string, expiresAt: string): Promise<boolean> {
    this.#assertLocalProject(projectId);
    const expiration = Date.parse(expiresAt);
    if (!Number.isFinite(expiration)) throw new Error("Run lock expiry must be a valid timestamp.");
    return this.#enqueue(async () => {
      if ((await this.read(projectId)).projectPurge) {
        throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
      }
      const current = this.#runLocks.get(projectId);
      if (current && current.expiresAt > Date.now()) return false;
      const state = await this.read(projectId);
      if (state.runs.some(hasUnconfirmedRuntimeCleanup) || state.runs.some(mayHaveUnconfirmedProviderRuntime)) return false;
      this.#runLocks.set(projectId, { ownerId, expiresAt: expiration });
      return true;
    });
  }

  public async releaseProjectRunLock(projectId: string, ownerId: string): Promise<void> {
    this.#assertLocalProject(projectId);
    if (this.#runLocks.get(projectId)?.ownerId === ownerId) this.#runLocks.delete(projectId);
  }

  public async acquireProviderRunSlot(projectId: string, ownerId: string, expiresAt: string): Promise<boolean> {
    this.#assertLocalProject(projectId);
    const expiration = Date.parse(expiresAt);
    if (!Number.isFinite(expiration)) throw new Error("Provider run slot expiry must be a valid timestamp.");
    return this.#enqueue(async () => {
      if ((await this.read(projectId)).projectPurge) {
        throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
      }
      for (const [project, current] of this.#providerRunSlots) {
        if (current.expiresAt <= Date.now()) this.#providerRunSlots.delete(project);
      }
      const state = await this.read(projectId);
      const unresolvedProviderMarkers = state.runs.filter(
        (run) => run.mode !== "deterministic" && hasUnconfirmedRuntimeCleanup(run),
      ).length;
      const currentRunLock = this.#runLocks.get(projectId);
      const activeRunLock = currentRunLock !== undefined && currentRunLock.expiresAt > Date.now();
      const staleProviderRuns = !activeRunLock && !this.#providerRunSlots.has(projectId)
        ? state.runs.filter(mayHaveUnconfirmedProviderRuntime).length
        : 0;
      const unresolvedProviderRuns = unresolvedProviderMarkers + staleProviderRuns;
      if (this.#providerRunSlots.has(projectId) || this.#providerRunSlots.size + unresolvedProviderRuns >= MAX_CONCURRENT_PROVIDER_RUNS) return false;
      this.#providerRunSlots.set(projectId, { ownerId, expiresAt: expiration });
      return true;
    });
  }

  public async releaseProviderRunSlot(projectId: string, ownerId: string): Promise<void> {
    this.#assertLocalProject(projectId);
    if (this.#providerRunSlots.get(projectId)?.ownerId === ownerId) this.#providerRunSlots.delete(projectId);
  }

  public addScenarioRevision(projectId: string, revision: ScenarioRevision): Promise<void> {
    return this.#change(projectId, (state) => {
      assertProjectCatalogCapacity(state, revision);
      state.scenarios.push(revision);
    });
  }

  public addVariantRevision(projectId: string, revision: VariantRevision): Promise<void> {
    return this.#change(projectId, (state) => {
      assertProjectCatalogCapacity(state, revision);
      state.variants.push(revision);
    });
  }

  public addExperimentRevision(projectId: string, revision: Experiment): Promise<void> {
    return this.#change(projectId, (state) => {
      assertProjectCatalogCapacity(state, revision);
      state.experiments.push(revision);
    });
  }

  public appendRun(projectId: string, run: RunArtifact): Promise<void> {
    return this.appendRuns(projectId, [run]);
  }

  public appendRuns(projectId: string, runs: readonly RunArtifact[]): Promise<void> {
    return this.#change(projectId, (state) => {
      state.runs.push(...runs);
      state.providerAttemptUsage.push(...runs
        .filter((run) => run.mode === "tvic" || run.mode === "audio")
        .map((run) => ({ projectId, runId: run.id, queuedAt: run.queuedAt ?? run.startedAt ?? new Date().toISOString() })));
    });
  }

  public async claimRunStartRequest(projectId: string, record: RunStartRequestRecord, now: string): Promise<RunStartRequestClaim> {
    let claim: RunStartRequestClaim = { state: "conflict" };
    await this.#change(projectId, (state) => {
      const existing = state.runStartRequests.find((item) => item.requestKeyHash === record.requestKeyHash);
      if (!existing) {
        state.runStartRequests.push(record);
        claim = { state: "claimed" };
      } else if (existing.requestFingerprint !== record.requestFingerprint) {
        claim = { state: "conflict" };
      } else if (existing.status === "accepted" && existing.acceptance) {
        claim = { state: "accepted", acceptance: existing.acceptance };
      } else if (Date.parse(existing.leaseExpiresAt) <= Date.parse(now)) {
        Object.assign(existing, record);
        claim = { state: "claimed" };
      } else {
        claim = { state: "pending", leaseExpiresAt: existing.leaseExpiresAt };
      }
    });
    return claim;
  }

  public async completeRunStartRequest(
    projectId: string,
    requestKeyHash: string,
    ownerId: string,
    acceptance: AcceptedRunStart,
    runs: readonly RunArtifact[],
  ): Promise<boolean> {
    let completed = false;
    await this.#change(projectId, (state) => {
      const request = state.runStartRequests.find((item) => item.requestKeyHash === requestKeyHash);
      if (!request || request.status !== "preparing" || request.ownerId !== ownerId) return;
      state.runs.push(...runs);
      state.providerAttemptUsage.push(...runs
        .filter((run) => run.mode === "tvic" || run.mode === "audio")
        .map((run) => ({ projectId, runId: run.id, queuedAt: run.queuedAt ?? run.startedAt ?? new Date().toISOString() })));
      request.status = "accepted";
      request.acceptance = acceptance;
      completed = true;
    });
    return completed;
  }

  public async releaseRunStartRequest(projectId: string, requestKeyHash: string, ownerId: string): Promise<void> {
    await this.#change(projectId, (state) => {
      state.runStartRequests = state.runStartRequests.filter((item) =>
        item.requestKeyHash !== requestKeyHash || item.status !== "preparing" || item.ownerId !== ownerId,
      );
    });
  }

  public async recordEarshotReference(projectId: string, reference: EarshotIncidentReference): Promise<void> {
    await this.#change(projectId, (state) => {
      state.earshotReferences = mergeEarshotIncidentReference(state.earshotReferences, reference);
    });
  }

  public async purgeProject(projectId: string, completedAt: string): Promise<ProjectPurgeReceipt> {
    this.#assertLocalProject(projectId);
    let receipt!: ProjectPurgeReceipt;
    await this.#change(projectId, (state) => {
      if (state.projectPurge) {
        receipt = state.projectPurge;
        return;
      }
      const now = Date.now();
      assertProjectPurgeQuiescent(
        state,
        (this.#runLocks.get(projectId)?.expiresAt ?? 0) > now,
        [...this.#evidenceRetryLeases].some(([key, lease]) => key.startsWith(`${projectId}\0`) && lease.expiresAt > now),
      );
      const references = sortEarshotIncidentReferences(mergeEarshotIncidentReferences(
        state.earshotReferences,
        state.runs.map(earshotIncidentReferenceFromRun),
      ));
      receipt = {
        projectId,
        status: "local_data_deleted",
        linkedEarshotIncidents: references,
        completedAt,
      };
      Object.assign(state, emptyState(), { projectPurge: receipt });
    }, true);
    this.#runLocks.delete(projectId);
    this.#providerRunSlots.delete(projectId);
    for (const key of this.#evidenceRetryLeases.keys()) {
      if (key.startsWith(`${projectId}\0`)) this.#evidenceRetryLeases.delete(key);
    }
    return receipt;
  }

  public async pruneProviderAttemptUsageBefore(cutoff: string): Promise<number> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Provider usage retention cutoff must be a valid timestamp.");
    let removed = 0;
    await this.#change(this.localProjectId, (state) => {
      const remaining = state.providerAttemptUsage.filter((attempt) => Date.parse(attempt.queuedAt) >= threshold);
      removed = state.providerAttemptUsage.length - remaining.length;
      state.providerAttemptUsage = remaining;
    });
    return removed;
  }

  public updateRun(projectId: string, run: RunArtifact): Promise<void> {
    return this.#change(projectId, (state) => {
      const index = state.runs.findIndex((item) => item.id === run.id);
      if (index < 0) throw new Error(`Run not found: ${run.id}`);
      state.runs[index] = run;
    });
  }

  public saveRunEvidence(projectId: string, runId: string, evidence: EvidenceReference): Promise<void> {
    return this.#change(projectId, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new Error("Run not found.");
      run.evidence = evidence;
    });
  }

  public async savePendingRunEvidence(projectId: string, runId: string, evidence: EvidenceReference): Promise<boolean> {
    let saved = false;
    await this.#change(projectId, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || run.evidence?.status !== "pending" || (run.evidence.attemptCount ?? 0) !== (evidence.attemptCount ?? 0)) return;
      run.evidence = evidence;
      saved = true;
    });
    return saved;
  }

  public async reservePendingEvidenceAttempt(projectId: string, runId: string, ownerId: string, expectedAttemptCount: number, evidence: EvidenceReference): Promise<boolean> {
    if (!Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 0 || evidence.attemptCount !== expectedAttemptCount + 1) {
      throw new Error("Evidence retry reservation must increment the expected attempt count by one.");
    }
    let reserved = false;
    await this.#change(projectId, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      const lease = this.#evidenceRetryLeases.get(`${projectId}\0${runId}`);
      if (!run || run.evidence?.status !== "pending" || lease?.ownerId !== ownerId ||
        (run.evidence.attemptCount ?? 0) !== expectedAttemptCount || evidence.attemptCount !== expectedAttemptCount + 1) return;
      run.evidence = evidence;
      reserved = true;
    });
    return reserved;
  }

  public async deleteRun(projectId: string, runId: string): Promise<boolean> {
    let deleted = false;
    await this.#change(projectId, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || run.status === "running" || run.status === "queued" || run.evidence?.status === "pending" || hasUnconfirmedRuntimeCleanup(run)) return;
      state.earshotReferences = mergeEarshotIncidentReferences(
        state.earshotReferences,
        [earshotIncidentReferenceFromRun(run)],
      );
      const remaining = state.runs.filter((item) => item.id !== runId);
      deleted = remaining.length !== state.runs.length;
      state.runs = remaining;
    });
    return deleted;
  }

  public async pruneRunsBefore(cutoff: string): Promise<number> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Run retention cutoff must be a valid timestamp.");
    let removed = 0;
    await this.#change(this.localProjectId, (state) => {
      const remaining = state.runs.filter((run) => run.status === "running" || run.status === "queued" || run.evidence?.status === "pending" || hasUnconfirmedRuntimeCleanup(run) || Date.parse(run.startedAt ?? run.queuedAt ?? "") >= threshold);
      const retainedRunIds = new Set(remaining.map((run) => run.id));
      state.earshotReferences = mergeEarshotIncidentReferences(
        state.earshotReferences,
        state.runs.filter((run) => !retainedRunIds.has(run.id)).map(earshotIncidentReferenceFromRun),
      );
      removed = state.runs.length - remaining.length;
      state.runs = remaining;
    });
    return removed;
  }

  public async expireStaleRunsBefore(cutoff: string, transition: (run: RunArtifact) => RunArtifact): Promise<number> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Stale run cutoff must be a valid timestamp.");
    let expired = 0;
    await this.#change(this.localProjectId, (state) => {
      state.runs = state.runs.map((run) => {
        if ((run.status !== "running" && run.status !== "queued") || Date.parse(run.startedAt ?? run.queuedAt ?? "") >= threshold) return run;
        expired += 1;
        return transition(run);
      });
    });
    return expired;
  }

  public appendRegressionEntry(projectId: string, entry: RegressionEntry): Promise<void> {
    return this.#change(projectId, (state) => {
      state.regressionSet = state.regressionSet.filter((existing) => existing.scenarioId !== entry.scenarioId);
      state.regressionSet.push(entry);
    });
  }

  public async removeRegressionEntry(projectId: string, scenarioId: string): Promise<boolean> {
    let removed = false;
    await this.#change(projectId, (state) => {
      const remaining = state.regressionSet.filter((entry) => entry.scenarioId !== scenarioId);
      removed = remaining.length !== state.regressionSet.length;
      state.regressionSet = remaining;
    });
    return removed;
  }

  async #loadState(): Promise<LabState> {
    if (this.state) return this.state;
    const loading = this.stateLoad ??= (async () => {
      try {
        const raw = await readFile(this.filePath, "utf8");
        this.state = this.#upgradeLegacyState(JSON.parse(raw) as Partial<LabState>);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT") throw error;
        this.state = { ...emptyState(), evaluators: defaultEvaluators() };
      }
      return this.state;
    })();
    try {
      return await loading;
    } catch (error) {
      if (this.stateLoad === loading) this.stateLoad = undefined;
      throw error;
    }
  }

  async #change(projectId: string, change: (state: LabState) => void, allowPurged = false): Promise<void> {
    this.#assertLocalProject(projectId);
    await this.#enqueue(async () => {
      const state = await this.read(projectId);
      if (state.projectPurge && !allowPurged) {
        throw Object.assign(new Error("This Voice Labs project has been purged."), { statusCode: 410 });
      }
      change(state);
      this.state = cloneState(state);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#writeQueue.then(operation);
    this.#writeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #assertLocalProject(projectId: string): void {
    if (projectId !== this.localProjectId) throw new Error("The JSON repository only serves its configured local project.");
  }

  #upgradeLegacyState(input: Partial<LabState>): LabState {
    const now = new Date().toISOString();
    const scenarios: ScenarioRevision[] = (input.scenarios ?? []).map((scenario) => ({
      ...scenario,
      projectId: this.localProjectId,
      createdBy: "local-development",
    }));
    const variants: VariantRevision[] = (input.variants ?? []).map((variant) => ({
      ...variant,
      projectId: this.localProjectId,
      createdBy: "local-development",
    }));
    const scenarioByLogicalId = new Map<string, ScenarioRevision>();
    for (const scenario of scenarios) {
      const current = scenarioByLogicalId.get(scenario.scenarioId);
      if (!current || scenario.revision > current.revision) scenarioByLogicalId.set(scenario.scenarioId, scenario);
    }
    const variantByLogicalId = new Map<string, VariantRevision>();
    for (const variant of variants) {
      const current = variantByLogicalId.get(variant.variantId);
      if (!current || variant.revision > current.revision) variantByLogicalId.set(variant.variantId, variant);
    }
    const experiments: Experiment[] = (input.experiments ?? []).map((experiment) => {
      const legacy = experiment as Experiment & { experimentId?: string; revision?: number; scenarioRevisionIds?: string[]; variantRevisionIds?: string[]; createdBy?: string };
      return {
        ...legacy,
        experimentId: legacy.experimentId ?? legacy.id,
        projectId: this.localProjectId,
        revision: legacy.revision ?? 1,
        captureEvidence: legacy.captureEvidence ?? false,
        scenarioRevisionIds: legacy.scenarioRevisionIds ?? legacy.scenarioIds.flatMap((id) => scenarioByLogicalId.get(id)?.id ?? []),
        variantRevisionIds: legacy.variantRevisionIds ?? legacy.variantIds.flatMap((id) => variantByLogicalId.get(id)?.id ?? []),
        createdBy: legacy.createdBy ?? "local-development",
      };
    });
    const experimentRevisionById = new Map(experiments.map((experiment) => [experiment.id, experiment.id]));
    const runs: RunArtifact[] = (input.runs ?? []).map((run) => {
      const legacy = run as RunArtifact & { projectId?: string; experimentRevisionId?: string; callId?: string; sessionId?: string };
      return {
        ...legacy,
        projectId: this.localProjectId,
        experimentRevisionId: legacy.experimentRevisionId ?? experimentRevisionById.get(legacy.experimentId) ?? legacy.experimentId,
        latencyScope: legacy.latencyScope ?? "executor_wall_clock_including_setup_excluding_persistence",
      };
    });
    const regressionSet: RegressionEntry[] = (input.regressionSet ?? []).map((entry) => {
      const legacy = entry as RegressionEntry & { projectId?: string; promotedBy?: string };
      return { ...legacy, projectId: this.localProjectId, promotedBy: legacy.promotedBy ?? "local-development" };
    });
    return {
      scenarios,
      variants,
      evaluators: input.evaluators ?? defaultEvaluators(),
      experiments,
      runs,
      providerAttemptUsage: input.providerAttemptUsage ?? runs
        .filter((run) => run.mode === "tvic" || run.mode === "audio")
        .map((run) => ({
          projectId: this.localProjectId,
          runId: run.id,
          queuedAt: run.queuedAt ?? run.startedAt ?? now,
        })),
      runStartRequests: input.runStartRequests ?? [],
      earshotReferences: mergeEarshotIncidentReferences(
        input.earshotReferences ?? [],
        runs.map(earshotIncidentReferenceFromRun),
      ),
      projectPurge: input.projectPurge ?? null,
      regressionSet,
    };
  }
}
