import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { compareRuns } from "../domain/compare.js";
import type {
  BootstrapPayload,
  Experiment,
  ExperimentDetail,
  ExperimentRunProgressSnapshot,
  ExperimentRunPage,
  RunArtifact,
  RunPageCursor,
  RunProgressSnapshot,
  RegressionMembership,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";
import { MAX_PROVIDER_TURNS, MAX_RUN_CELLS } from "../domain/limits.js";
import { ApiRequestError, createApiRequester, createScopedApiRequester, StaleApiRequestError, type ApiRequester } from "./api-request.js";
import { shouldRetryStatusPoll, statusPollDelay, type StatusPollMode } from "./polling.js";
import { mergeRunProgress } from "./run-progress.js";
import { buildExperimentRunStatusUrl, isActiveRunStatus } from "./run-status-polling.js";

const useCommittedEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type View = "overview" | "setup" | "experiment" | "run" | "scenarios";
type RunReturnTarget = { experimentId: string; revisionId: string };
type PendingRunStart = { projectId: string; experimentId: string; revisionId: string; idempotencyKey: string };

export interface VoiceLabsFeatureProps {
  /** Voice Labs API origin or path prefix. Leave unset to use same-origin API routes. */
  apiBaseUrl?: string;
  /** Short-lived Platform access token containing sub and project_id claims. */
  accessToken?: string;
  /** Optional run selected by a Platform-owned deep link. */
  initialRunId?: string;
}

function newestFirst(runs: RunArtifact[]): RunArtifact[] {
  return runs.sort((a, b) => (b.startedAt ?? b.queuedAt ?? "").localeCompare(a.startedAt ?? a.queuedAt ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function mergeExperimentDetail(current: ExperimentDetail, fresh: ExperimentDetail): ExperimentDetail {
  if (current.experiment.id !== fresh.experiment.id) return fresh;
  const runsById = new Map(current.runs.map((run) => [run.id, run]));
  for (const run of fresh.runs) runsById.set(run.id, run);
  const runs = newestFirst([...runsById.values()]);
  const freshPageBoundaryIsLoaded = !fresh.runsHasMore
    || Boolean(fresh.runsCursor && current.runs.some((run) => run.id === fresh.runsCursor?.id));
  const discoveredGap = Boolean(fresh.runsHasMore && !freshPageBoundaryIsLoaded);
  const runsHasMore = Boolean(current.runsHasMore || discoveredGap);
  return {
    ...fresh,
    runs,
    comparison: compareRuns(runs, fresh.variants),
    runsHasMore,
    runsCursor: discoveredGap ? fresh.runsCursor : runsHasMore ? current.runsCursor : null,
  };
}

function withoutRun(detail: ExperimentDetail, runId: string): ExperimentDetail {
  const runs = detail.runs.filter((run) => run.id !== runId);
  return runs.length === detail.runs.length
    ? detail
    : { ...detail, runs, comparison: compareRuns(runs, detail.variants) };
}

function pendingRunStartStorageKey(projectId: string): string {
  return `voice-labs:pending-run-start:${projectId}`;
}

function readPendingRunStart(projectId: string): PendingRunStart | undefined {
  try {
    const encoded = window.localStorage.getItem(pendingRunStartStorageKey(projectId));
    if (!encoded) return undefined;
    const pending = JSON.parse(encoded) as Partial<PendingRunStart>;
    if (pending.projectId !== projectId || typeof pending.experimentId !== "string" || typeof pending.revisionId !== "string" || typeof pending.idempotencyKey !== "string") return undefined;
    return pending as PendingRunStart;
  } catch {
    return undefined;
  }
}

function savePendingRunStart(pending: PendingRunStart): void {
  try {
    window.localStorage.setItem(pendingRunStartStorageKey(pending.projectId), JSON.stringify(pending));
  } catch {
    // The in-memory copy still lets this page safely reconcile a lost response.
  }
}

function clearPendingRunStart(pending: PendingRunStart): void {
  try {
    const current = readPendingRunStart(pending.projectId);
    if (current?.idempotencyKey === pending.idempotencyKey) window.localStorage.removeItem(pendingRunStartStorageKey(pending.projectId));
  } catch {
    // A stale local receipt is safe: replaying it returns the original acceptance.
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTime(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value));
}

function statusLabel(status: RunArtifact["status"] | undefined): string {
  return status === "queued" ? "Queued" : status === "passed" ? "Passed" : status === "failed" ? "Failed" : status === "unknown" ? "Needs review" : status === "error" ? "Error" : status === "cancelled" ? "Cancelled" : status === "running" ? "Running" : "Pending";
}

function isStaleApiRequest(error: unknown): error is StaleApiRequestError {
  return error instanceof StaleApiRequestError;
}

function formatRunDuration(run: Pick<RunArtifact, "durationMs" | "status">): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "In progress";
  return run.durationMs === undefined ? "—" : `${run.durationMs}ms`;
}

function StatusPill({ status }: { status: RunArtifact["status"] | undefined }) {
  return <span className={`status-pill status-${status ?? "unknown"}`}><span className="status-dot" />{statusLabel(status)}</span>;
}

function MetricCard({ label, value, note, tone = "neutral" }: { label: string; value: string; note: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <div className={`metric-card metric-${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">◎</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function App({ apiBaseUrl, accessToken, initialRunId, standalone = true }: VoiceLabsFeatureProps & { standalone?: boolean } = {}) {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [view, setView] = useState<View>("overview");
  const [selectedExperiment, setSelectedExperiment] = useState<ExperimentDetail | null>(null);
  const [runReturnTarget, setRunReturnTarget] = useState<RunReturnTarget | null>(null);
  const [editingExperiment, setEditingExperiment] = useState<Experiment | null>(null);
  const [scenarioLibraryReturnTarget, setScenarioLibraryReturnTarget] = useState<"overview" | "setup">("overview");
  const [selectedRun, setSelectedRun] = useState<RunArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusPollError = useRef<string | null>(null);
  const initialRunHandled = useRef<string | null>(null);
  const initialRunAttempt = useRef<{ runId: string; request: ApiRequester } | null>(null);
  const activeRequest = useRef<ApiRequester | null>(null);
  const previousRequest = useRef<ApiRequester | null>(null);
  const pendingRunStartMemory = useRef<PendingRunStart | null>(null);
  const reconciledRunStartKeys = useRef(new Set<string>());
  const experimentSelectionSequence = useRef(0);
  const runSelectionSequence = useRef(0);

  const reportStatusPollError = (message: string) => {
    statusPollError.current = message;
    setError(message);
  };
  const clearStatusPollError = () => {
    const previousMessage = statusPollError.current;
    if (previousMessage === null) return;
    statusPollError.current = null;
    setError((currentMessage) => currentMessage === previousMessage ? null : currentMessage);
  };

  const clearPurgedProjectView = useCallback((message: string) => {
    statusPollError.current = null;
    setData(null);
    setSelectedExperiment(null);
    setSelectedRun(null);
    setRunReturnTarget(null);
    setEditingExperiment(null);
    setScenarioLibraryReturnTarget("overview");
    setRunning(false);
    setLoadingOlderRuns(false);
    setView("overview");
    setLoading(false);
    setError(message);
  }, []);
  const baseRequest = useMemo(() => createApiRequester(apiBaseUrl, accessToken), [apiBaseUrl, accessToken]);
  const request = useMemo<ApiRequester>(() => {
    let currentRequest: ApiRequester;
    currentRequest = createScopedApiRequester(
      baseRequest,
      () => activeRequest.current === currentRequest,
      (message) => clearPurgedProjectView(message),
    );
    return currentRequest;
  }, [baseRequest, clearPurgedProjectView]);
  const [renderedRequest, setRenderedRequest] = useState<ApiRequester>(() => request);

  const openScenarioLibrary = () => {
    setScenarioLibraryReturnTarget(view === "setup" ? "setup" : "overview");
    setView("scenarios");
  };
  const closeScenarioLibrary = () => {
    setView(scenarioLibraryReturnTarget);
    setScenarioLibraryReturnTarget("overview");
  };

  const refresh = async () => {
    if (request.isCurrent?.() === false) return;
    setError(null);
    try {
      const next = await request<BootstrapPayload>("/api/bootstrap");
      if (request.isCurrent?.() !== false) setData(next);
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Could not load Voice Labs.");
      }
    } finally {
      if (request.isCurrent?.() !== false) setLoading(false);
    }
  };

  const showOverview = () => {
    setSelectedExperiment(null);
    setSelectedRun(null);
    setRunReturnTarget(null);
    setView("overview");
    void refresh();
  };

  useCommittedEffect(() => {
    activeRequest.current = request;
    return () => {
      if (activeRequest.current === request) activeRequest.current = null;
    };
  }, [request]);

  useEffect(() => {
    const contextChanged = previousRequest.current !== null && previousRequest.current !== request;
    previousRequest.current = request;
    setRenderedRequest(request);
    if (contextChanged) {
      setData(null);
      setSelectedExperiment(null);
      setSelectedRun(null);
      setRunReturnTarget(null);
      setEditingExperiment(null);
      setScenarioLibraryReturnTarget("overview");
      setRunning(false);
      setLoadingOlderRuns(false);
      statusPollError.current = null;
      setError(null);
      setLoading(true);
      setView("overview");
    }
  }, [request]);
  useEffect(() => { void refresh(); }, [request]);

  const experimentRunStatusSignature = useMemo(
    () => JSON.stringify(selectedExperiment?.runs.map(({ id, status }) => [id, status])),
    [selectedExperiment?.runs],
  );
  useEffect(() => {
    if (renderedRequest !== request) return;
    const currentExperiment = selectedExperiment;
    const experimentId = currentExperiment?.experiment.experimentId;
    const revisionId = currentExperiment?.experiment.id;
    const statusRequestUrl = buildExperimentRunStatusUrl(experimentId, revisionId, currentExperiment?.runs ?? []);
    if (view !== "experiment" || !currentExperiment || !statusRequestUrl) return;
    let cancelled = false;
    let timer: number | undefined;
    let retryPolling = false;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const progress = await request<ExperimentRunProgressSnapshot>(
          statusRequestUrl,
        );
        if (cancelled) return;
        const hasActiveRuns = progress.runs.some((run) => isActiveRunStatus(run.status));
        const knownRunIds = new Set(currentExperiment.runs.map((run) => run.id));
        let refreshedDetail: ExperimentDetail | undefined;
        let discoveredRuns: RunArtifact[] = [];
        let missingDiscoveredRunIds: string[] = [];
        if (progress.runs.some((run) => !knownRunIds.has(run.id))) {
          refreshedDetail = await request<ExperimentDetail>(`/api/experiments/${experimentId}?revision_id=${encodeURIComponent(revisionId ?? "")}`);
          if (cancelled) return;
          const detailedRunIds = new Set(refreshedDetail.runs.map((run) => run.id));
          // Status polling also returns active rows that fall outside this recent detail page.
          const runsOutsideRecentPage = progress.runs.filter((run) =>
            !knownRunIds.has(run.id) && !detailedRunIds.has(run.id) && isActiveRunStatus(run.status));
          const discoveredResults = await Promise.all(runsOutsideRecentPage.map(async ({ id }) => {
            try {
              return { id, run: await request<RunArtifact>(`/api/runs/${id}`) };
            } catch (error) {
              return { id, error };
            }
          }));
          if (cancelled) return;
          const unavailableProject = discoveredResults.find((result) =>
            "error" in result && result.error instanceof ApiRequestError && result.error.status === 410);
          if (unavailableProject && "error" in unavailableProject) throw unavailableProject.error;
          const discoveryError = discoveredResults.find((result) =>
            "error" in result && !(result.error instanceof ApiRequestError && result.error.status === 404));
          if (discoveryError && "error" in discoveryError) throw discoveryError.error;
          missingDiscoveredRunIds = discoveredResults.flatMap((result) =>
            "error" in result && result.error instanceof ApiRequestError && result.error.status === 404 ? [result.id] : []);
          discoveredRuns = discoveredResults.flatMap((result) =>
            "run" in result && result.run ? [result.run] : []);
        }

        const previousById = new Map([
          ...currentExperiment.runs,
          ...(refreshedDetail?.runs ?? []),
          ...discoveredRuns,
        ].map((run) => [run.id, run]));
        const statusById = new Map(progress.runs.map((run) => [run.id, run.status]));
        const terminalChanges = progress.runs.filter((run) => {
          const previousStatus = previousById.get(run.id)?.status;
          return previousStatus !== run.status && !isActiveRunStatus(run.status);
        });
        const terminalResults = await Promise.all(terminalChanges.map(async ({ id }) => {
          try {
            return { id, run: await request<RunArtifact>(`/api/runs/${id}`) };
          } catch (error) {
            return { id, error };
          }
        }));
        if (cancelled) return;
        const projectUnavailable = terminalResults.find((result) =>
          "error" in result && result.error instanceof ApiRequestError && result.error.status === 410);
        if (projectUnavailable && "error" in projectUnavailable) throw projectUnavailable.error;
        const terminalError = terminalResults.find((result) =>
          "error" in result && !(result.error instanceof ApiRequestError && result.error.status === 404));

        const missingRunIds = new Set([
          ...progress.missingRunIds,
          ...missingDiscoveredRunIds,
          ...terminalResults.flatMap((result) =>
            "error" in result && result.error instanceof ApiRequestError && result.error.status === 404 ? [result.id] : []),
        ]);
        const retryableRunIds = new Set(terminalResults.flatMap((result) =>
          "error" in result && shouldRetryStatusPoll(result.error) ? [result.id] : []));
        const completedById = new Map(terminalResults.flatMap((result) => "run" in result ? [[result.id, result.run] as const] : []));
        if (refreshedDetail || discoveredRuns.length || completedById.size || missingRunIds.size
          || progress.runs.some((run) => previousById.get(run.id)?.status !== run.status)) {
          setSelectedExperiment((current) => {
            if (!current || current.experiment.id !== revisionId) return current;
            const mergedDetail = refreshedDetail ? mergeExperimentDetail(current, refreshedDetail) : current;
            const discoveredById = new Map([...mergedDetail.runs, ...discoveredRuns].map((run) => [run.id, run]));
            const freshlyHydratedRunIds = new Set([
              ...(refreshedDetail?.runs.map((run) => run.id) ?? []),
              ...discoveredRuns.map((run) => run.id),
            ]);
            const runs = newestFirst([...discoveredById.values()])
              .filter((run) => !missingRunIds.has(run.id))
              .map((run) => {
                const completed = completedById.get(run.id);
                if (completed) return completed;
                if (freshlyHydratedRunIds.has(run.id)) return run;
                const status = statusById.get(run.id);
                return status !== undefined && status !== run.status && !retryableRunIds.has(run.id)
                  ? { ...run, status }
                  : run;
              });
            return { ...mergedDetail, runs, comparison: compareRuns(runs, mergedDetail.variants) };
          });
        }
        if (terminalError && "error" in terminalError) throw terminalError.error;
        retryPolling = hasActiveRuns;
        consecutiveFailures = 0;
        clearStatusPollError();
      } catch (requestError) {
        retryPolling = shouldRetryStatusPoll(requestError);
        if (retryPolling) consecutiveFailures += 1;
        if (!cancelled && !isStaleApiRequest(requestError)) {
          if (requestError instanceof ApiRequestError && requestError.status === 404) {
            showOverview();
          } else if (!(requestError instanceof ApiRequestError && requestError.status === 410)) {
            reportStatusPollError(requestError instanceof Error ? requestError.message : "Could not refresh run status.");
          }
        }
      } finally {
        if (!cancelled && retryPolling) timer = window.setTimeout(() => void poll(), statusPollDelay(consecutiveFailures));
      }
    };
    timer = window.setTimeout(() => void poll(), statusPollDelay(0));
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [view, request, renderedRequest, selectedExperiment?.experiment.experimentId, selectedExperiment?.experiment.id, experimentRunStatusSignature]);

  const openExperiment = async (id: string, revisionId?: string): Promise<boolean> => {
    if (request.isCurrent?.() === false) return false;
    const sequence = ++experimentSelectionSequence.current;
    runSelectionSequence.current += 1;
    if (initialRunAttempt.current) {
      initialRunHandled.current = initialRunAttempt.current.runId;
      initialRunAttempt.current = null;
    }
    setError(null);
    try {
      const revisionQuery = revisionId ? `?revision_id=${encodeURIComponent(revisionId)}` : "";
      const detail = await request<ExperimentDetail>(`/api/experiments/${id}${revisionQuery}`);
      if (request.isCurrent?.() === false || sequence !== experimentSelectionSequence.current) return false;
      setSelectedExperiment(detail);
      setSelectedRun(null);
      setRunReturnTarget(null);
      setView("experiment");
      return true;
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false
        && sequence === experimentSelectionSequence.current) {
        setError(requestError instanceof Error ? requestError.message : "Could not load the experiment.");
      }
      return false;
    }
  };

  const runExperiment = async (id: string, requestedRevisionId?: string, reconcile = false) => {
    if (request.isCurrent?.() === false) return;
    const projectId = data?.projectId;
    const currentExperiment = data?.experiments.find((experiment) => experiment.experimentId === id);
    const revisionId = requestedRevisionId ?? currentExperiment?.id;
    if (!projectId || !revisionId) {
      setError("The selected experiment revision could not be found. Refresh the project and try again.");
      return;
    }
    const stored = readPendingRunStart(projectId) ?? pendingRunStartMemory.current ?? undefined;
    const pending = stored?.projectId === projectId
      ? stored
      : { projectId, experimentId: id, revisionId, idempotencyKey: newIdempotencyKey() };
    const reconcilingDifferentRequest = Boolean(stored && (stored.experimentId !== id || stored.revisionId !== revisionId));
    if (!stored || stored.projectId !== projectId) {
      savePendingRunStart(pending);
      pendingRunStartMemory.current = pending;
    }
    setRunning(true);
    setError(null);
    if (!reconcile && reconcilingDifferentRequest) {
      setError("A previous run start is still being reconciled. Voice Labs is retrying that same request before starting another run.");
    }
    const pendingKey = `${pending.projectId}:${pending.idempotencyKey}`;
    reconciledRunStartKeys.current.add(pendingKey);
    let startConfirmed = false;
    try {
      await request<{ experimentId: string; runIds: string[]; status: "queued" }>(`/api/experiments/${pending.experimentId}/run`, {
        method: "POST",
        headers: { "idempotency-key": pending.idempotencyKey },
        body: JSON.stringify({ revision_id: pending.revisionId }),
      });
      if (request.isCurrent?.() === false) return;
      startConfirmed = true;
      clearPendingRunStart(pending);
      pendingRunStartMemory.current = null;
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        if (requestError instanceof ApiRequestError && requestError.status === 410) {
          setError(requestError.message);
        } else {
          setError(`Voice Labs could not confirm whether the run was accepted. Retry safely with the same request; it will reuse the saved idempotency key. ${requestError instanceof Error ? requestError.message : "The experiment could not run."}`);
        }
      }
    } finally {
      if (request.isCurrent?.() !== false) setRunning(false);
    }
    if (request.isCurrent?.() === false) return;
    if (!startConfirmed) return;
    setSelectedRun(null);
    await openExperiment(pending.experimentId, pending.revisionId);
  };

  useEffect(() => {
    if (renderedRequest !== request || !data?.projectId || running) return;
    const pending = readPendingRunStart(data.projectId) ?? pendingRunStartMemory.current ?? undefined;
    if (!pending || pending.projectId !== data.projectId) return;
    const pendingKey = `${pending.projectId}:${pending.idempotencyKey}`;
    if (reconciledRunStartKeys.current.has(pendingKey)) return;
    void runExperiment(pending.experimentId, pending.revisionId, true);
  }, [data?.projectId, renderedRequest, request, running]);

  const loadOlderRuns = async () => {
    if (!selectedExperiment?.runsCursor || loadingOlderRuns) return;
    setLoadingOlderRuns(true);
    setError(null);
    try {
      const cursor: RunPageCursor = selectedExperiment.runsCursor;
      const query = new URLSearchParams({ before_started_at: cursor.startedAt, before_id: cursor.id, revision_id: selectedExperiment.experiment.id });
      const page = await request<ExperimentRunPage>(`/api/experiments/${selectedExperiment.experiment.experimentId}/runs?${query}`);
      if (request.isCurrent?.() === false) return;
      setSelectedExperiment((current) => {
        if (!current || current.experiment.id !== selectedExperiment.experiment.id) return current;
        const runs = newestFirst([...new Map([...current.runs, ...page.runs].map((run) => [run.id, run])).values()]);
        const paginationCursorIsCurrent = current.runsCursor?.startedAt === cursor.startedAt && current.runsCursor.id === cursor.id;
        if (!paginationCursorIsCurrent) {
          return { ...current, runs, comparison: compareRuns(runs, current.variants) };
        }
        return {
          ...current,
          runs,
          comparison: compareRuns(runs, current.variants),
          runsHasMore: page.hasMore,
          runsCursor: page.hasMore ? page.nextCursor : null,
        };
      });
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Could not load older runs.");
      }
    } finally {
      if (request.isCurrent?.() !== false) setLoadingOlderRuns(false);
    }
  };

  const openRun = async (id: string, fromDeepLink = false): Promise<boolean> => {
    const sequence = ++runSelectionSequence.current;
    experimentSelectionSequence.current += 1;
    const returnTarget = !fromDeepLink && view === "experiment" && selectedExperiment
      ? { experimentId: selectedExperiment.experiment.experimentId, revisionId: selectedExperiment.experiment.id }
      : null;
    if (!fromDeepLink && initialRunAttempt.current) {
      initialRunHandled.current = initialRunAttempt.current.runId;
      initialRunAttempt.current = null;
    }
    setError(null);
    try {
      const run = await request<RunArtifact>(`/api/runs/${id}`);
      if (request.isCurrent?.() === false) return false;
      if (sequence !== runSelectionSequence.current) return false;
      setSelectedRun(run);
      setRunReturnTarget(returnTarget);
      setView("run");
      return true;
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false
        && sequence === runSelectionSequence.current) {
        setError(requestError instanceof Error ? requestError.message : "Could not load the run.");
      }
      return false;
    }
  };

  const returnFromMissingRun = (missingRunId: string) => {
    const target = runReturnTarget;
    setSelectedRun(null);
    setRunReturnTarget(null);
    if (!target) {
      showOverview();
      return;
    }
    setSelectedExperiment((current) => current ? withoutRun(current, missingRunId) : current);
    setView("experiment");
    void openExperiment(target.experimentId, target.revisionId);
  };

  useEffect(() => {
    if (renderedRequest !== request) return;
    const linkedRunId = initialRunId ?? (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("runId"));
    if (!linkedRunId || initialRunHandled.current === linkedRunId) return;
    if (initialRunAttempt.current?.runId === linkedRunId && initialRunAttempt.current.request === request) return;
    initialRunAttempt.current = { runId: linkedRunId, request };
    void openRun(linkedRunId, true).then((opened) => {
      if (initialRunAttempt.current?.runId !== linkedRunId || initialRunAttempt.current.request !== request) return;
      initialRunAttempt.current = null;
      if (opened) initialRunHandled.current = linkedRunId;
    });
  }, [initialRunId, renderedRequest, request]);

  useEffect(() => {
    if (renderedRequest !== request) return;
    if (view !== "run" || !selectedRun || (!isActiveRunStatus(selectedRun.status) && selectedRun.evidence?.status !== "pending")) return;
    const runId = selectedRun.id;
    let cancelled = false;
    let timer: number | undefined;
    let retryPolling = true;
    let consecutiveFailures = 0;
    let pollMode: StatusPollMode = !isActiveRunStatus(selectedRun.status) && selectedRun.evidence?.status === "pending"
      ? "pending-evidence"
      : "active-run";
    const poll = async () => {
      try {
        const progress = await request<RunProgressSnapshot>(`/api/runs/${runId}/status`);
        if (cancelled) return;
        if ((isActiveRunStatus(selectedRun.status) && !isActiveRunStatus(progress.status))
          || (progress.evidence && !selectedRun.evidence)) {
          const run = await request<RunArtifact>(`/api/runs/${runId}`);
          if (!cancelled) {
            pollMode = !isActiveRunStatus(run.status) && run.evidence?.status === "pending" ? "pending-evidence" : "active-run";
            setSelectedRun((current) => current?.id === runId ? run : current);
          }
        } else {
          const evidenceStatus = progress.evidence?.status ?? selectedRun.evidence?.status;
          pollMode = !isActiveRunStatus(progress.status) && evidenceStatus === "pending" ? "pending-evidence" : "active-run";
          setSelectedRun((current) => current ? mergeRunProgress(current, progress) : current);
        }
        consecutiveFailures = 0;
        clearStatusPollError();
      } catch (requestError) {
        retryPolling = shouldRetryStatusPoll(requestError);
        if (retryPolling) consecutiveFailures += 1;
        if (!cancelled && !isStaleApiRequest(requestError)) {
          if (requestError instanceof ApiRequestError && requestError.status === 404) {
            returnFromMissingRun(runId);
          } else if (!(requestError instanceof ApiRequestError && requestError.status === 410)) {
            reportStatusPollError(requestError instanceof Error ? requestError.message : "Could not refresh run status.");
          }
        }
      } finally {
        if (!cancelled && retryPolling) timer = window.setTimeout(() => void poll(), statusPollDelay(consecutiveFailures, pollMode));
      }
    };
    timer = window.setTimeout(() => void poll(), statusPollDelay(0, pollMode));
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [view, selectedRun?.id, selectedRun?.status, selectedRun?.evidence?.status, request, renderedRequest, runReturnTarget?.experimentId, runReturnTarget?.revisionId]);

  const deleteRun = async (id: string) => {
    if (!window.confirm("Delete this run and its Voice Labs transcript and tool arguments? Any Earshot incident is managed separately.")) return;
    const returnTarget = runReturnTarget;
    setError(null);
    try {
      await request<void>(`/api/runs/${id}`, { method: "DELETE" });
      if (request.isCurrent?.() === false) return;
      setSelectedRun(null);
      if (returnTarget) {
        setRunReturnTarget(null);
        setSelectedExperiment((current) => current ? withoutRun(current, id) : current);
        setView("experiment");
        await openExperiment(returnTarget.experimentId, returnTarget.revisionId);
      } else {
        setRunReturnTarget(null);
        showOverview();
      }
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Could not delete the run.");
      }
    }
  };

  const promoteScenarioRevision = async (scenarioId: string, revisionId: string) => {
    try {
      await request(`/api/scenarios/${scenarioId}/promote`, { method: "POST", body: JSON.stringify({ revision_id: revisionId }) });
      if (request.isCurrent?.() === false) return;
      await refresh();
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Scenario promotion failed.");
      }
    }
  };

  const removePromotedScenario = async (scenarioId: string) => {
    try {
      await request<void>(`/api/scenarios/${scenarioId}/promote`, { method: "DELETE" });
      if (request.isCurrent?.() === false) return;
      await refresh();
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Could not remove the scenario pin.");
      }
    }
  };

  const exportExperiment = async (experimentId: string, revisionId: string) => {
    setError(null);
    try {
      const exported = await request<ExperimentDetail>(`/api/experiments/${experimentId}/export?revision_id=${encodeURIComponent(revisionId)}`);
      if (request.isCurrent?.() === false) return;
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `voice-labs-${exported.experiment.experimentId}-revision-${exported.experiment.revision}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
      if (exported.runsTruncated) setError("This export contains the newest 500 runs for the selected revision.");
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        setError(requestError instanceof Error ? requestError.message : "Could not export the experiment.");
      }
    }
  };

  if (loading || renderedRequest !== request) return <div className="loading-screen"><div className="loader" /><span>Loading your lab…</span></div>;
  if (request.isCurrent?.() === false) {
    const UnavailableContent = standalone ? "main" : "div";
    return <div className={standalone ? "app-shell" : "voice-labs-feature"}>
      <UnavailableContent className={standalone ? "main-content" : "voice-labs-content"}>
        <div className="page-wrap"><div role="alert"><EmptyState title="Project unavailable" body={error ?? "The Voice Labs project is unavailable."} /></div></div>
      </UnavailableContent>
    </div>;
  }

  const currentData = data ?? { product: "voice-labs" as const, projectId: "", scenarios: [], variants: [], evaluators: [], experiments: [], recentRuns: [], regressionScenarioIds: [], regressionScenarioRevisions: [] };
  const ContentElement = standalone ? "main" : "div";

  return (
    <div className={standalone ? "app-shell" : "voice-labs-feature"}>
      {standalone && <aside className="sidebar">
        <div className="brand-lockup" onClick={showOverview} role="button" tabIndex={0}>
          <div className="brand-orbit"><span /><span /><span /></div>
          <div><div className="brand-name">voice<span>·</span>labs</div><div className="brand-caption">agent evaluation studio</div></div>
        </div>
        <div className="workspace-switcher"><div className="workspace-avatar">VL</div><div><div className="workspace-name">{currentData.projectId === "local" ? "Local workspace" : `Project ${currentData.projectId || "…"}`}</div><div className="workspace-path">Voice Labs</div></div><span className="chevron">⌄</span></div>
        <nav className="main-nav" aria-label="Main navigation">
          <NavButton active={view === "overview"} icon="⌂" label="Overview" onClick={showOverview} />
          <NavButton active={view === "setup"} icon="＋" label="New experiment" onClick={() => { setEditingExperiment(null); setView("setup"); }} accent />
          <NavButton active={view === "scenarios"} icon="◇" label="Scenario library" onClick={openScenarioLibrary} />
        </nav>
        <div className="nav-section-label">Workspace</div>
        <nav className="secondary-nav">
          <NavButton active={false} icon="▦" label="Experiments" onClick={showOverview} count={currentData.experiments.length} />
          <NavButton active={false} icon="✓" label="Pinned scenarios" onClick={openScenarioLibrary} count={currentData.regressionScenarioIds.length} />
        </nav>
        <div className="sidebar-spacer" />
        <div className="boundary-card"><div className="boundary-heading"><span className="pulse" />Local-first</div><p>Deterministic by default. TVIC execution and Earshot evidence stay behind explicit adapters.</p><div className="boundary-links"><span>TVIC <i>↗</i></span><span>Earshot <i>↗</i></span></div></div>
        <div className="sidebar-footer"><span className="version-badge">v0.1.0</span><span className="footer-item">⌘ K</span><span className="footer-item">?</span></div>
      </aside>}
      <ContentElement className={standalone ? "main-content" : "voice-labs-content"}>
        {standalone && <header className="topbar"><div className="breadcrumb"><span>Voice Labs</span><span className="crumb-separator">/</span><span className="crumb-current">{view === "overview" ? "Overview" : view === "setup" ? editingExperiment ? "Edit experiment" : "New experiment" : view === "scenarios" ? "Scenario library" : view === "run" ? "Run detail" : selectedExperiment?.experiment.name ?? "Experiment"}</span></div><div className="topbar-actions"><span className="connection-state"><span className="status-dot" /> Project {currentData.projectId || "…"}</span><button className="icon-button" title="Refresh" onClick={() => void refresh()}>↻</button></div></header>}
        {error && <div className="error-banner" role="alert"><span aria-hidden="true">!</span>{error}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
        {(view === "setup" || (view === "scenarios" && scenarioLibraryReturnTarget === "setup")) && <div hidden={view !== "setup"}><ExperimentSetup key={editingExperiment?.id ?? "new-experiment"} data={currentData} request={request} initialExperiment={editingExperiment ?? undefined} onCancel={() => { setEditingExperiment(null); setView(selectedExperiment ? "experiment" : "overview"); }} onCreateScenario={openScenarioLibrary} onChanged={refresh} onError={(message) => setError(message)} onCreated={async (experiment) => { setEditingExperiment(null); if (await openExperiment(experiment.experimentId)) await runExperiment(experiment.experimentId, experiment.id); }} onUpdated={async (experimentId) => { setEditingExperiment(null); await refresh(); await openExperiment(experimentId); }} /></div>}
        {view === "overview" && <Overview data={currentData} onNew={() => { setEditingExperiment(null); setView("setup"); }} onScenarios={openScenarioLibrary} onOpen={openExperiment} onRun={runExperiment} onOpenRun={openRun} running={running || currentData.recentRuns.some((run) => isActiveRunStatus(run.status))} />}
        {view === "scenarios" && <ScenarioLibrary data={currentData} request={request} onBack={closeScenarioLibrary} standalone={standalone} onPromote={promoteScenarioRevision} onRemove={removePromotedScenario} onChanged={refresh} onError={(message) => setError(message)} />}
        {view === "experiment" && selectedExperiment && <ExperimentView detail={selectedExperiment} onBack={showOverview} onSelectRevision={(revisionId) => void openExperiment(selectedExperiment.experiment.experimentId, revisionId)} onEdit={() => { setEditingExperiment(selectedExperiment.experiment); setView("setup"); }} onRun={() => void runExperiment(selectedExperiment.experiment.experimentId, selectedExperiment.experiment.id)} onExport={() => void exportExperiment(selectedExperiment.experiment.experimentId, selectedExperiment.experiment.id)} onOpenRun={openRun} onLoadOlder={() => void loadOlderRuns()} loadingOlderRuns={loadingOlderRuns} running={running || currentData.recentRuns.some((run) => isActiveRunStatus(run.status)) || selectedExperiment.comparison.totalRunning > 0} onPromote={promoteScenarioRevision} onRemove={removePromotedScenario} regressionRevisions={currentData.regressionScenarioRevisions} />}
        {view === "run" && selectedRun && <RunView run={selectedRun} backLabel={runReturnTarget ? "Back to experiment" : "Back to overview"} onBack={() => {
          const target = runReturnTarget;
          setSelectedRun(null);
          if (target) void openExperiment(target.experimentId, target.revisionId);
          else {
            setRunReturnTarget(null);
            showOverview();
          }
        }} onDelete={() => void deleteRun(selectedRun.id)} />}
      </ContentElement>
    </div>
  );
}

/** Feature entry point for Platform's Next.js shell; renders no product sidebar or account chrome. */
export function VoiceLabsFeature(props: VoiceLabsFeatureProps) {
  return <App {...props} standalone={false} />;
}

function NavButton({ active, icon, label, onClick, count, accent = false }: { active: boolean; icon: string; label: string; onClick: () => void; count?: number; accent?: boolean }) {
  return <button className={`nav-button ${active ? "active" : ""} ${accent ? "nav-accent" : ""}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</button>;
}

function Overview({ data, onNew, onScenarios, onOpen, onRun, onOpenRun, running }: { data: BootstrapPayload; onNew: () => void; onScenarios: () => void; onOpen: (id: string) => void; onRun: (id: string, revisionId: string) => void; onOpenRun: (id: string) => void; running: boolean }) {
  const completedRuns = data.recentRuns.filter((run) => !isActiveRunStatus(run.status));
  const runningCount = data.recentRuns.length - completedRuns.length;
  const passed = completedRuns.filter((run) => run.status === "passed").length;
  const failed = completedRuns.filter((run) => run.status === "failed" || run.status === "error").length;
  const unknown = completedRuns.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length;
  const passRate = completedRuns.length ? passed / completedRuns.length : 0;
  return <div className="page-wrap overview-page">
    <section className="hero-row"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE OVERVIEW</div><h1>Find the version<br /><em>worth shipping.</em></h1><p className="hero-copy">Simulate real conversations. Compare what changed. Build confidence before callers find the edge case.</p><div className="hero-actions"><button className="primary-button" onClick={onNew}><span>＋</span> New experiment</button><button className="quiet-button" onClick={onScenarios}>Scenario library <span>↗</span></button><button className="quiet-button" onClick={() => document.getElementById("recent-experiments")?.scrollIntoView({ behavior: "smooth" })}>Explore runs <span>↓</span></button></div></div><div className="hero-visual"><div className="orbit-card"><div className="orbit-core"><span className="core-mark">◌</span><span className="core-label">SIMULATE</span></div><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-node node-one">prompt</div><div className="orbit-node node-two">tools</div><div className="orbit-node node-three">voice</div></div></div></section>
    <section className="metric-grid"><MetricCard label="Recent run health" value={completedRuns.length ? formatPercent(passRate) : "—"} note={completedRuns.length ? `${passed} passed · ${failed} failed${runningCount ? ` · ${runningCount} running` : ""} · recent history` : runningCount ? `${runningCount} run${runningCount === 1 ? "" : "s"} in progress · recent history` : "Run your first experiment · recent history"} tone={failed > 0 ? "warn" : "good"} /><MetricCard label="Experiments" value={String(data.experiments.length).padStart(2, "0")} note={`${data.scenarios.length} scenarios · ${data.variants.length} variants`} /><MetricCard label="Pinned scenarios" value={String(data.regressionScenarioIds.length).padStart(2, "0")} note="project-level revision pins" tone="neutral" /><MetricCard label="Recent needs review" value={String(unknown).padStart(2, "0")} note="unknown or incomplete evidence · recent history" tone={unknown ? "warn" : "good"} /></section>
    <section className="content-section" id="recent-experiments"><div className="section-heading"><div><div className="eyebrow">YOUR LAB</div><h2>Experiments</h2></div><button className="text-button" onClick={onNew}>Create one <span>↗</span></button></div>
      {data.experiments.length ? <div className="experiment-list">{data.experiments.map((experiment) => <ExperimentCard key={experiment.experimentId} experiment={experiment} data={data} onOpen={onOpen} onRun={onRun} running={running} />)}<div className="experiment-list-footer"><span>Showing {data.experiments.length} experiment{data.experiments.length === 1 ? "" : "s"}</span><span className="muted">Run data is stored in this project's Voice Labs workspace.</span></div></div> : <EmptyState title="Your lab is ready." body="Create a scenario matrix, run it locally, and see which candidate holds up." action={<button className="primary-button" onClick={onNew}>Start first experiment</button>} />}
    </section>
    <section className="content-section recent-runs"><div className="section-heading"><div><div className="eyebrow">TRACE INBOX</div><h2>Recent runs</h2></div><span className="section-caption">Latest {data.recentRuns.length === 24 ? "24" : data.recentRuns.length} project runs</span></div>{data.recentRuns.length ? <div className="run-table">{data.recentRuns.slice(0, 6).map((run) => <button className="run-row" key={run.id} onClick={() => onOpenRun(run.id)}><div className="run-cell-status"><StatusPill status={run.status} /></div><div className="run-cell-main"><strong>{run.scenarioName ?? "Scenario run"}</strong><span>{run.variantName ?? "Variant"} · repetition {run.repetition}</span></div><div className="run-cell-time">{formatRunDuration(run)}</div><div className="run-cell-date">{formatTime(run.startedAt)}</div><span className="row-arrow">›</span></button>)}</div> : <div className="mini-empty">No runs yet — your first result will appear here.</div>}</section>
  </div>;
}

function ExperimentCard({ experiment, data, onOpen, onRun, running }: { experiment: Experiment; data: BootstrapPayload; onOpen: (id: string) => void; onRun: (id: string, revisionId: string) => void; running: boolean }) {
  const runs = data.recentRuns.filter((run) => run.experimentRevisionId === experiment.id);
  const passed = runs.filter((run) => run.status === "passed").length;
  const failed = runs.filter((run) => run.status === "failed" || run.status === "error").length;
  const active = runs.filter((run) => isActiveRunStatus(run.status)).length;
  const needsReview = runs.filter((run) => run.status === "unknown" || run.status === "cancelled" || !run.status).length;

  return <div className="experiment-card">
    <div className="experiment-card-top"><div className="experiment-icon">✦</div><div className="experiment-card-title"><h3>{experiment.name}</h3><p>{experiment.description}</p></div><span className="mode-badge">{experiment.mode} mode</span></div>
    <div className="experiment-card-meta"><span><b>{experiment.scenarioIds.length}</b> scenarios</span><span><b>{experiment.variantIds.length}</b> variants</span><span><b>{experiment.repetitions}</b> repetitions</span><span className="meta-spacer" /><span className="experiment-date">Created {formatTime(experiment.createdAt)}</span></div>
    <div className="experiment-card-bottom">
      <div className="mini-statuses" title="Counts cover this revision within the 24 most recent project runs" aria-label="Recent run counts for this experiment revision">
        <span className="experiment-run-scope">Recent</span>
        {runs.length ? <>
          {passed > 0 && <span className="mini-status good"><i />{passed} passed</span>}
          {failed > 0 && <span className="mini-status bad"><i />{failed} failed</span>}
          {active > 0 && <span className="mini-status neutral"><i />{active} active</span>}
          {needsReview > 0 && <span className="mini-status neutral"><i />{needsReview} needs review</span>}
        </> : <span className="mini-status neutral"><i />No recent runs</span>}
      </div>
      <div className="card-actions"><button className="quiet-button small" onClick={() => onOpen(experiment.experimentId)}>View results <span>→</span></button><button className="primary-button small" onClick={() => onRun(experiment.experimentId, experiment.id)} disabled={running}>{running ? "Starting…" : runs.length ? "Run again" : "Run experiment"}</button></div>
    </div>
  </div>;
}

function ExperimentSetup({ data, request, initialExperiment, onCancel, onCreateScenario, onChanged, onError, onCreated, onUpdated }: { data: BootstrapPayload; request: ApiRequester; initialExperiment?: Experiment; onCancel: () => void; onCreateScenario: () => void; onChanged: () => Promise<void>; onError: (message: string) => void; onCreated: (experiment: Experiment) => Promise<void>; onUpdated: (experimentId: string) => Promise<void> }) {
  const [name, setName] = useState(initialExperiment?.name ?? "New voice experiment");
  const [description, setDescription] = useState(initialExperiment?.description ?? "Compare candidates against a focused scenario set.");
  const [scenarioIds, setScenarioIds] = useState<string[]>(initialExperiment?.scenarioIds ?? (data.scenarios[0] ? [data.scenarios[0].scenarioId] : []));
  const [variantIds, setVariantIds] = useState<string[]>(initialExperiment?.variantIds ?? data.variants.slice(0, 2).map((variant) => variant.variantId));
  const [repetitions, setRepetitions] = useState(initialExperiment?.repetitions ?? 2);
  const [mode, setMode] = useState<Experiment["mode"]>(initialExperiment?.mode ?? "deterministic");
  const [captureEvidence, setCaptureEvidence] = useState(initialExperiment?.captureEvidence ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [showVariantForm, setShowVariantForm] = useState(false);
  const [variantName, setVariantName] = useState("New candidate");
  const [variantInstructions, setVariantInstructions] = useState("Be clear, complete the caller's request, and confirm the final state.");
  const [variantStrategy, setVariantStrategy] = useState<VariantRevision["strategy"]>("reliable");
  const [variantLatency, setVariantLatency] = useState(160);
  const [variantReliability, setVariantReliability] = useState(0.9);
  const [variantToolRate, setVariantToolRate] = useState(0.9);
  const [variantSubmitting, setVariantSubmitting] = useState(false);
  const cells = scenarioIds.length * variantIds.length * repetitions;
  const providerTurns = data.scenarios
    .filter((scenario) => scenarioIds.includes(scenario.scenarioId))
    .reduce((total, scenario) => total + scenario.userTurns.length, 0) * variantIds.length * repetitions;
  const invalidAudioScenario = mode === "audio"
    ? data.scenarios.find((scenario) => scenarioIds.includes(scenario.scenarioId) && (scenario.audioFixtures?.length ?? 0) !== scenario.userTurns.length)
    : undefined;
  const runLimitMessage = cells > MAX_RUN_CELLS
    ? `Split this experiment into runs of ${MAX_RUN_CELLS} cells or fewer.`
    : mode !== "deterministic" && providerTurns > MAX_PROVIDER_TURNS
      ? `This provider run has ${providerTurns} caller turns; the limit is ${MAX_PROVIDER_TURNS}.`
      : invalidAudioScenario
        ? `Audio mode needs one fixture per caller turn in “${invalidAudioScenario.name}”.`
      : null;
  const toggle = (value: string, values: string[], setValues: (next: string[]) => void) => setValues(values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const input = JSON.stringify({ name, description, scenarioIds, variantIds, repetitions, mode, captureEvidence });
      if (initialExperiment) {
        await request<Experiment>(`/api/experiments/${initialExperiment.experimentId}`, { method: "PUT", body: input });
        if (request.isCurrent?.() === false) return;
        await onUpdated(initialExperiment.experimentId);
      } else {
        const experiment = await request<Experiment>("/api/experiments", { method: "POST", body: input });
        if (request.isCurrent?.() === false) return;
        await onCreated(experiment);
      }
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        onError(requestError instanceof Error ? requestError.message : "Could not save the experiment.");
      }
    } finally {
      if (request.isCurrent?.() !== false) setSubmitting(false);
    }
  };
  const createVariant = async () => {
    setVariantSubmitting(true);
    try {
      await request<VariantRevision>("/api/variants", { method: "POST", body: JSON.stringify({ name: variantName, description: "A candidate created in the experiment builder.", instructions: variantInstructions, strategy: variantStrategy, latencyMs: variantLatency, reliability: variantReliability, toolSuccessRate: variantToolRate, providerLabel: "configured" }) });
      if (request.isCurrent?.() === false) return;
      await onChanged();
      if (request.isCurrent?.() === false) return;
      setShowVariantForm(false);
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        onError(requestError instanceof Error ? requestError.message : "Could not save the candidate.");
      }
    } finally {
      if (request.isCurrent?.() !== false) setVariantSubmitting(false);
    }
  };
  return <div className="page-wrap setup-page"><div className="setup-header"><div><div className="eyebrow"><span className="eyebrow-line" /> {initialExperiment ? "EDIT EXPERIMENT" : "EXPERIMENT BUILDER"}</div><h1>{initialExperiment ? <>Revise the setup<br /><em>pin the next run.</em></> : <>Set the question<br /><em>before the run.</em></>}</h1><p>Choose the behavior you want to learn about, then make the comparison explicit.</p></div><div className="setup-summary"><div className="summary-kicker">RUN MATRIX</div><strong>{cells || 0}</strong><span>scenario × variant cells</span></div></div><form className="setup-grid" onSubmit={submit}><div className="setup-form-column"><section className="form-panel"><div className="panel-heading"><span className="panel-number">01</span><div><h2>Name the experiment</h2><p>Make the hypothesis recognizable six weeks from now.</p></div></div><label>Experiment name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label></section><section className="form-panel"><div className="panel-heading"><span className="panel-number">02</span><div><h2>Choose scenarios</h2><p>Start with outcomes, not a brittle conversation script.</p></div></div><div className="selection-list">{data.scenarios.map((scenario) => <SelectionCard key={scenario.scenarioId} selected={scenarioIds.includes(scenario.scenarioId)} onClick={() => toggle(scenario.scenarioId, scenarioIds, setScenarioIds)} title={scenario.name} description={scenario.goal} meta={`${scenario.tags.join(" · ")} · ${scenario.expectedOutcomeFacts.length} outcome facts${scenario.audioFixtures?.length ? ` · ${scenario.audioFixtures.length} audio fixtures` : ""}`} />)}</div>{!data.scenarios.length && <div className="inline-note">Create a scenario before setting up a run. <button type="button" className="text-button" onClick={onCreateScenario}>Open scenario library <span>↗</span></button></div>}</section><section className="form-panel"><div className="panel-heading panel-heading-with-action"><div className="panel-heading-title"><span className="panel-number">03</span><div><h2>Choose candidates</h2><p>Every candidate is resolved to a versioned configuration at run time.</p></div></div><button type="button" className="text-button" onClick={() => setShowVariantForm((visible) => !visible)}>{showVariantForm ? "Close" : "＋ New candidate"}</button></div>{showVariantForm && <div className="quick-create"><label>Candidate name<input value={variantName} onChange={(event) => setVariantName(event.target.value)} required /></label><label>Agent instructions<textarea value={variantInstructions} onChange={(event) => setVariantInstructions(event.target.value)} rows={3} required /></label><div className="inline-note">Instructions shape TVIC calls. The following behavior and rate fields control deterministic simulation only.</div><div className="quick-create-row"><label>Simulation strategy<select value={variantStrategy} onChange={(event) => setVariantStrategy(event.target.value as VariantRevision["strategy"])}><option value="reliable">Reliable</option><option value="concise">Concise</option><option value="fragile">Fragile</option></select></label><label>Simulation latency (ms)<input type="number" min="1" max="60000" value={variantLatency} onChange={(event) => setVariantLatency(Number(event.target.value))} /></label><label>Simulated completion rate<input type="number" min="0" max="1" step="0.05" value={variantReliability} onChange={(event) => setVariantReliability(Number(event.target.value))} /></label><label>Simulated tool success rate<input type="number" min="0" max="1" step="0.05" value={variantToolRate} onChange={(event) => setVariantToolRate(Number(event.target.value))} /></label></div><button type="button" className="primary-button small" onClick={() => void createVariant()} disabled={variantSubmitting}>{variantSubmitting ? "Saving…" : "Save candidate"}<span>→</span></button></div>}<div className="selection-list">{data.variants.map((variant) => <SelectionCard key={variant.variantId} selected={variantIds.includes(variant.variantId)} onClick={() => toggle(variant.variantId, variantIds, setVariantIds)} title={variant.name} description={variant.description} meta={mode === "deterministic" ? `${variant.strategy} simulation · ${variant.latencyMs}ms target · ${formatPercent(variant.reliability)} completion` : `Instructions revision ${variant.revision}`} color={variant.strategy === "reliable" ? "green" : "orange"} />)}</div>{!data.variants.length && <div className="inline-note">Create a variant before setting up a run.</div>}</section></div><aside className="setup-sidebar"><div className="form-panel sticky-panel"><div className="panel-heading compact"><span className="panel-number">04</span><div><h2>Run settings</h2><p>Keep the first loop cheap and repeatable.</p></div></div><label>Execution mode<select value={mode} onChange={(event) => setMode(event.target.value as Experiment["mode"])}><option value="deterministic">Deterministic simulation</option><option value="tvic">TVIC runtime · real LLM/TTS</option><option value="audio">TVIC audio · real STT/LLM/TTS</option></select></label><div className="inline-note">TVIC modes call the configured providers. Scripted caller turns use real LLM/TTS but do not exercise real STT; audio mode uses real STT/LLM/TTS.</div><p className="privacy-note">Voice Labs run records can contain transcripts and tool-call arguments. Current run retention defaults to 30 days and is operator-configurable; this is the current implementation, not finalized product policy. Active runs, pending Earshot attachments, and unconfirmed TVIC cleanup can be retained beyond that window. Voice Labs attempts to send only metadata to Earshot when capture is enabled and a destination is configured; delivery can fail or remain unconfirmed.</p><label>Capture in Earshot<input type="checkbox" checked={captureEvidence} onChange={(event) => setCaptureEvidence(event.target.checked)} /> <small>Metadata only. Transcripts, audio, model text, and tool arguments are excluded.</small></label><label>Repetitions<div className="stepper"><button type="button" onClick={() => setRepetitions(Math.max(1, repetitions - 1))}>−</button><span>{repetitions}</span><button type="button" onClick={() => setRepetitions(Math.min(MAX_RUN_CELLS, repetitions + 1))} disabled={repetitions >= MAX_RUN_CELLS}>＋</button></div></label><div className="settings-callout"><span>✧</span><p><strong>Evaluation runs after the runtime returns.</strong> Deterministic mode is labeled as a simulation; TVIC modes report provider results directly.</p></div><div className="preflight"><div><span>Scenarios</span><strong>{scenarioIds.length}</strong></div><div><span>Variants</span><strong>{variantIds.length}</strong></div><div><span>Cells</span><strong>{cells}</strong></div></div>{runLimitMessage && <div className="inline-note" role="alert">{runLimitMessage}</div>}<div className="form-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={submitting || !scenarioIds.length || !variantIds.length || Boolean(runLimitMessage)}>{submitting ? "Saving…" : initialExperiment ? "Save revision" : "Create & run"}<span>→</span></button></div></div></aside></form></div>;
}

function SelectionCard({ selected, onClick, title, description, meta, color = "purple" }: { selected: boolean; onClick: () => void; title: string; description: string; meta: string; color?: string }) {
  return <button type="button" className={`selection-card ${selected ? "selected" : ""}`} onClick={onClick}><span className={`selection-indicator ${color}`}>{selected ? "✓" : ""}</span><span className="selection-copy"><strong>{title}</strong><span>{description}</span><small>{meta}</small></span><span className="selection-chevron">›</span></button>;
}

function ExperimentView({ detail, onBack, onSelectRevision, onEdit, onRun, onExport, onOpenRun, onLoadOlder, loadingOlderRuns, running, onPromote, onRemove, regressionRevisions }: {
  detail: ExperimentDetail;
  onBack: () => void;
  onSelectRevision: (revisionId: string) => void;
  onEdit: () => void;
  onRun: () => void;
  onExport: () => void;
  onOpenRun: (id: string) => void;
  onLoadOlder: () => void;
  loadingOlderRuns: boolean;
  running: boolean;
  onPromote: (scenarioId: string, revisionId: string) => void;
  onRemove: (scenarioId: string) => void;
  regressionRevisions: RegressionMembership[];
}) {
  const [filter, setFilter] = useState<"all" | "failed" | "passed">("all");
  const [promotionScenarioRevisionId, setPromotionScenarioRevisionId] = useState(detail.scenarios[0]?.id ?? "");
  const filteredRuns = detail.runs.filter((run) => filter === "all" || (filter === "failed" ? run.status === "failed" || run.status === "error" : run.status === "passed"));
  const completedRunCount = detail.comparison.totalRuns - detail.comparison.totalRunning;
  const latestRevision = detail.revisions[detail.revisions.length - 1];
  const isLatestRevision = detail.experiment.id === latestRevision?.id;
  const loadedRunsLabel = `${detail.runs.length}${detail.runsHasMore ? "+" : ""}`;
  const selectedPromotionScenario = detail.scenarios.find((scenario) => scenario.id === promotionScenarioRevisionId) ?? detail.scenarios[0];
  const selectedCoverage = selectedPromotionScenario
    ? regressionRevisions.find((membership) => membership.scenarioId === selectedPromotionScenario.scenarioId)
    : undefined;

  return <div className="page-wrap experiment-page">
    <div className="detail-header">
      <button className="back-button" onClick={onBack}>← <span>All experiments</span></button>
      <div className="detail-title-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> EXPERIMENT RESULT</div>
          <h1>{detail.experiment.name}</h1>
          <p>{detail.experiment.description}</p>
        </div>
        <div className="detail-actions">
          <label className="revision-select-label">Revision
            <select className="revision-select" value={detail.experiment.id} onChange={(event) => onSelectRevision(event.currentTarget.value)}>
              {detail.revisions.map((revision) => <option key={revision.id} value={revision.id}>Revision {revision.revision} · {formatTime(revision.createdAt)}</option>)}
            </select>
          </label>
          <button className="quiet-button" onClick={onExport}>Export JSON</button>
          {isLatestRevision ? <>
            <button className="quiet-button" onClick={onEdit}>Edit experiment</button>
            <button className="quiet-button" onClick={onRun} disabled={running}>{running ? "Running…" : "↻ Run again"}</button>
            {selectedPromotionScenario && <div className="regression-controls">
              <label className="revision-select-label">Scenario revision to pin
                <select className="revision-select" value={selectedPromotionScenario.id} onChange={(event) => setPromotionScenarioRevisionId(event.currentTarget.value)}>
                  {detail.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name} · rev {scenario.revision}</option>)}
                </select>
              </label>
              {selectedCoverage?.revision === selectedPromotionScenario.revision
                ? <button className="quiet-button" onClick={() => onRemove(selectedPromotionScenario.scenarioId)}>Remove pin</button>
                : <button className="primary-button" onClick={() => onPromote(selectedPromotionScenario.scenarioId, selectedPromotionScenario.id)}>{selectedCoverage ? `Update pin to rev ${selectedPromotionScenario.revision}` : `＋ Pin rev ${selectedPromotionScenario.revision}`}</button>}
            </div>}
          </> : <span className="historical-revision-note">Historical revision · read only</span>}
        </div>
      </div>
    </div>

    <div className="result-strip">
      <div><span className="strip-label">LOADED RUNS</span><strong>{loadedRunsLabel}</strong>{detail.comparison.totalRunning > 0 && <small>{detail.comparison.totalRunning} in progress</small>}</div>
      <div><span className="strip-label">PASS RATE</span><strong className="text-good">{completedRunCount ? formatPercent(detail.comparison.totalPassed / completedRunCount) : "—"}</strong></div>
      <div><span className="strip-label">REGRESSIONS</span><strong className={detail.comparison.totalFailed ? "text-bad" : "text-good"}>{detail.comparison.totalFailed}</strong></div>
      <div><span className="strip-label">BASELINE</span><strong className="strip-baseline">{detail.comparison.rows.find((row) => row.variantId === detail.comparison.baselineVariantId)?.variantName ?? "—"}</strong></div>
      <div className="strip-spacer" />
      <div className="evidence-chip"><span className="status-dot" />{detail.scenarios.filter((scenario) => regressionRevisions.some((membership) => membership.scenarioId === scenario.scenarioId && membership.revision === scenario.revision)).length}/{detail.scenarios.length} selected revisions pinned</div>
    </div>
    <p className="history-scope-note">{detail.runsHasMore ? `Comparison and filters use the ${detail.runs.length} loaded runs. Load older runs to expand the sample.` : `Showing all ${detail.runs.length} retained runs for this revision.`}</p>

    <section className="comparison-section">
      <div className="section-heading">
        <div><div className="eyebrow">VARIANT COMPARISON</div><h2>What changed?</h2></div>
        <div className="filter-tabs">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All runs</button>
          <button className={filter === "failed" ? "active" : ""} onClick={() => setFilter("failed")}>Regressions <span>{detail.comparison.totalFailed}</span></button>
          <button className={filter === "passed" ? "active" : ""} onClick={() => setFilter("passed")}>Passing</button>
        </div>
      </div>
      <div className="comparison-table">
        <div className="comparison-head"><span>Candidate</span><span>Run health</span><span>Quality score</span><span>Avg latency</span><span>vs baseline</span><span /></div>
        {detail.comparison.rows.map((row, index) => <div className={`comparison-row ${index === 0 ? "baseline-row" : ""}`} key={row.variantId}>
          <div className="candidate-cell"><span className={`candidate-dot candidate-${index}`} /><div><strong>{row.variantName}</strong><small>{row.providerLabel}{index === 0 && <b> BASELINE</b>}</small></div></div>
          <div className="health-cell"><div className="health-bar"><span style={{ width: `${row.passRate * 100}%` }} /></div><strong>{formatPercent(row.passRate)}</strong><small>{row.runCount ? `${row.passedRuns}/${row.runCount} completed` : "No completed runs"}</small>{row.runningRuns > 0 && <small>{row.runningRuns} in progress</small>}</div>
          <div className="score-cell"><strong>{row.qualityScore === null ? "—" : formatPercent(row.qualityScore)}</strong><small>{row.unknownRuns ? `${row.unknownRuns} need review` : "all evidence scored"}</small></div>
          <div className="latency-cell"><strong>{row.averageLatencyMs === null ? "—" : `${row.averageLatencyMs}ms`}</strong><small>per run</small></div>
          <div className={`delta-cell ${row.deltaFromBaseline === null ? "muted" : row.deltaFromBaseline > 0 ? "positive" : row.deltaFromBaseline < 0 ? "negative" : "neutral"}`}>{row.deltaFromBaseline === null ? "—" : row.deltaFromBaseline === 0 ? "same" : `${row.deltaFromBaseline > 0 ? "+" : ""}${formatPercent(row.deltaFromBaseline)}`}</div>
          <span className="row-arrow">›</span>
        </div>)}
      </div>
    </section>

    <section className="case-section">
      <div className="section-heading"><div><div className="eyebrow">CASE MATRIX</div><h2>Trace every result</h2></div><span className="section-caption">{filteredRuns.length} shown from {loadedRunsLabel} loaded runs</span></div>
      <div className="case-table">
        <div className="case-head"><span>Status</span><span>Scenario</span><span>Candidate</span><span>Latency</span><span>Repetition</span><span /></div>
        {filteredRuns.length ? filteredRuns.map((run) => <button className="case-row" key={run.id} onClick={() => onOpenRun(run.id)}>
          <StatusPill status={run.status} />
          <div className="case-primary"><strong>{detail.scenarios.find((scenario) => scenario.id === run.scenarioId)?.name ?? "Scenario"}</strong><small>{detail.scenarios.find((scenario) => scenario.id === run.scenarioId)?.goal ?? ""}</small></div>
          <div className="case-candidate"><span className="tiny-dot" />{detail.variants.find((variant) => variant.id === run.variantId)?.name ?? "Variant"}</div>
          <span>{formatRunDuration(run)}</span><span className="repetition-pill">trial {run.repetition}</span><span className="row-arrow">›</span>
        </button>) : <div className="mini-empty">No runs match this filter.</div>}
      </div>
      {detail.runsHasMore && <div className="load-older-runs"><button className="quiet-button" onClick={onLoadOlder} disabled={loadingOlderRuns}>{loadingOlderRuns ? "Loading older runs…" : "Load older runs"}</button></div>}
    </section>
  </div>;
}

function RunView({ run, backLabel, onBack, onDelete }: { run: RunArtifact; backLabel: string; onBack: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);
  const active = isActiveRunStatus(run.status);
  const runTimestamp = run.startedAt ?? run.queuedAt;

  const copyReplayConfig = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ runId: run.id, mode: run.mode, experimentRevisionId: run.experimentRevisionId, scenarioRevisionId: run.scenarioId, variantRevisionId: run.variantId, repetition: run.repetition, seed: run.seed, providerTrace: run.providerTrace ?? null }, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return <div className="page-wrap run-page">
    <button className="back-button" onClick={onBack}>← <span>{backLabel}</span></button>
    <div className="run-header">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" /> RUN TRACE · {run.id}</div>
        <h1>{run.status === "queued" ? <>Run queued<br /><em>execution will begin shortly.</em></> : run.status === "running" ? <>Run in progress<br /><em>trace is pending.</em></> : <>One conversation,<br /><em>fully explained.</em></>}</h1>
        <p>{run.status === "queued" ? "This attempt is waiting for an execution slot." : run.status === "running" ? "The executor is running. Its transcript appears after execution finishes." : "Every assertion is linked to the evidence that produced it."}</p>
      </div>
      <div className="run-header-status"><StatusPill status={run.status} /><span>Trial {run.repetition} · seed {run.seed}</span></div>
    </div>
    {run.error && <section className="run-error-panel" role="alert"><div className="eyebrow">WHY THIS RUN STOPPED</div>{run.error.code && <code>{run.error.code}</code>}<p>{run.error.message}</p></section>}
    <div className="trace-meta">
      <div><span>MODE</span><strong>{run.mode}</strong></div>
      <div><span>DURATION</span><strong>{formatRunDuration(run)}</strong></div>
      <div><span>TURNS</span><strong>{run.metrics.turnCount}</strong></div>
      <div><span>TOOLS</span><strong>{run.metrics.toolCallCount}</strong></div>
      <div><span>{run.status === "queued" ? "QUEUED AT" : "STARTED"}</span><strong>{formatTime(runTimestamp)}</strong></div>
      <div className="trace-meta-spacer" />
      <div className="evidence-link">◈ Evidence {run.evidence?.status === "pending" ? "Pending" : run.evidence?.status === "attached" ? <a href={`/observe?sessionId=${encodeURIComponent(run.evidence.sessionId ?? "")}`}>Open in Observe · {run.evidence.sessionId}</a> : run.evidence?.status === "unavailable" ? `Unavailable: ${run.evidence.message ?? "Earshot did not accept the metadata."}` : "No evidence requested"}</div>
    </div>
    <p className="latency-definition">Latency is executor wall clock from setup through the final runtime event; it excludes evaluation, database writes, and Earshot upload.</p>
    <div className="trace-layout">
      <section className="trace-panel">
        <div className="trace-panel-header"><div><div className="eyebrow">CONVERSATION TRACE</div><h2>What the agent did</h2></div><span className="trace-count">{run.transcript.length} events</span></div>
        <div className="timeline">
          {active && <div className="mini-empty">{run.status === "queued" ? "The attempt is queued. Trace events appear after execution starts." : "The run is active. Trace events are saved when execution completes."}</div>}
          {run.transcript.map((turn) => <div className={`timeline-event ${turn.speaker}`} key={`${turn.index}-${turn.offsetMs}`}><div className="timeline-rail"><span className="timeline-dot" /><span className="timeline-line" /></div><div className="timeline-content"><div className="timeline-label"><span>{turn.speaker === "assistant" ? "AGENT" : turn.speaker.toUpperCase()}</span><time>+{turn.offsetMs}ms</time></div><div className="bubble">{turn.text}</div></div></div>)}
          {run.toolCalls.map((call) => <div className="timeline-event tool" key={call.id}><div className="timeline-rail"><span className="timeline-dot" /><span className="timeline-line" /></div><div className="timeline-content"><div className="timeline-label"><span>TOOL CALL</span><time>{call.elapsedMs}ms</time></div><div className="tool-card"><div className="tool-card-top"><strong>{call.name}</strong><span className={`tool-status ${call.status}`}>{call.status === "succeeded" ? "Succeeded" : "Failed"}</span></div><code>{JSON.stringify(call.arguments)}</code>{call.error && <p>{call.error}</p>}</div></div></div>)}
        </div>
      </section>
      <aside className="trace-sidebar">
        <section className="assertion-panel"><div className="eyebrow">EVALUATIONS</div><h2>Why it got this result</h2><div className="assertion-list">{(run.evaluations ?? []).map((evaluation) => <div className={`assertion ${evaluation.status}`} key={evaluation.id}><div className="assertion-top"><span className="assertion-icon">{evaluation.status === "passed" ? "✓" : evaluation.status === "failed" ? "×" : "?"}</span><strong>{evaluation.name}</strong><span className="assertion-score">{evaluation.status === "unknown" ? "—" : formatPercent(evaluation.score)}</span></div><p>{evaluation.reason}</p></div>)}</div></section>
        <section className="manifest-panel">
          <div className="eyebrow">RUN CONFIGURATION</div><h2>Pinned configuration</h2>
          <div className="manifest-list"><div><span>Scenario revision</span><strong>{run.scenarioId}</strong></div><div><span>Variant revision</span><strong>{run.variantId}</strong></div><div><span>Seed</span><strong>{run.seed}</strong></div><div><span>Audio</span><strong>{run.metrics.audioExercised ? "Exercised" : "Not exercised"}</strong></div><div><span>Provider models</span><strong>{run.providerTrace ? [run.providerTrace.llmModel, run.providerTrace.ttsModel].filter(Boolean).join(" / ") || "Not reported" : "Not used"}</strong></div></div>
          <button className="quiet-button full-width" onClick={() => void copyReplayConfig()}>{copied ? "Manifest copied" : "Copy run manifest"} <span>↗</span></button>
          <p className="manifest-note">This snapshot records pinned inputs and reported providers; it does not restore provider versions or guarantee an identical replay.</p>
          {active ? <p className="manifest-note">Active runs cannot be deleted. Wait for execution to finish first.</p> : run.error?.code === "cancellation_unconfirmed" ? <p className="manifest-note">This run cannot be deleted while TVIC cleanup is unconfirmed. Voice Labs has no automated cleanup reconciliation; contact the service owner for an owner-approved resolution.</p> : run.evidence?.status === "pending" ? <p className="manifest-note">This run cannot be deleted while its Earshot evidence attachment is pending.</p> : <><button className="quiet-button full-width" onClick={onDelete}>Delete run data</button><p className="manifest-note">Deletes this run's transcript and tool arguments. When Earshot delivery was attempted, Voice Labs keeps a minimal incident, destination, and delivery-status reference to support future project deletion. Earshot controls retention and deletion of any incident it accepted.</p></>}
        </section>
      </aside>
    </div>
  </div>;
}
function ScenarioLibrary({ data, request, onBack, standalone, onPromote, onRemove, onChanged, onError }: {
  data: BootstrapPayload;
  request: ApiRequester;
  onBack: () => void;
  standalone: boolean;
  onPromote: (scenarioId: string, revisionId: string) => void;
  onRemove: (scenarioId: string) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [editingScenario, setEditingScenario] = useState<ScenarioRevision | null | undefined>(undefined);
  const memberships = new Map(data.regressionScenarioRevisions.map((entry) => [entry.scenarioId, entry]));
  return <div className="page-wrap scenarios-page">
    {!standalone && <button className="back-button" onClick={onBack}>← <span>Voice Labs overview</span></button>}
    <div className="detail-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> SCENARIO LIBRARY</div><h1>Cases worth<br /><em>keeping around.</em></h1><p>Pin exact scenario revisions for project-level review. Running scenarios still happens through an experiment.</p></div><button className="primary-button" onClick={() => setEditingScenario((current) => current === undefined ? null : undefined)}>{editingScenario === undefined ? "+ New scenario" : "Close editor"}</button></div>
    {editingScenario !== undefined && <ScenarioEditor key={editingScenario?.id ?? "new-scenario"} initialScenario={editingScenario ?? undefined} request={request} onError={onError} onCancel={() => setEditingScenario(undefined)} onSaved={async () => { await onChanged(); setEditingScenario(undefined); }} />}
    <div className="scenario-grid">{data.scenarios.map((scenario) => {
      const coverage = memberships.get(scenario.scenarioId);
      const currentRevisionCovered = coverage?.revision === scenario.revision;
      return <article className="scenario-card" key={scenario.scenarioId}>
        <div className="scenario-card-top"><span className="scenario-symbol">◇</span><div className="scenario-tags">{scenario.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>{coverage && <span className="promoted-badge">{currentRevisionCovered ? `✓ pinned · rev ${coverage.revision}` : `Pin points to rev ${coverage.revision}`}</span>}</div>
        <h2>{scenario.name}</h2><p>{scenario.description}</p><div className="scenario-goal"><span>OUTCOME · REVISION {scenario.revision}</span><strong>{scenario.goal}</strong></div>
        <div className="scenario-footer"><span>{scenario.userTurns.length} user turns · {scenario.expectedOutcomeFacts.length} facts{scenario.audioFixtures?.length ? ` · ${scenario.audioFixtures.length} audio` : ""}</span><div className="card-actions">
          <button type="button" className="quiet-button small" onClick={() => setEditingScenario(scenario)}>Edit</button>
          {coverage && <button type="button" className="quiet-button small" onClick={() => onRemove(scenario.scenarioId)}>Remove pin</button>}
          {!currentRevisionCovered && <button type="button" className="quiet-button small" onClick={() => onPromote(scenario.scenarioId, scenario.id)}>{coverage ? `Update pin to rev ${scenario.revision}` : `Pin rev ${scenario.revision}`} <span>↗</span></button>}
        </div></div>
      </article>;
    })}</div>
    {!data.scenarios.length && <EmptyState title="No scenarios yet" body="Start with a customer outcome and a few representative caller turns." />}
  </div>;
}

function ScenarioEditor({ initialScenario, request, onCancel, onSaved, onError }: { initialScenario?: ScenarioRevision; request: ApiRequester; onCancel: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(initialScenario?.name ?? "New scenario");
  const [description, setDescription] = useState(initialScenario?.description ?? "A scenario authored in the scenario library.");
  const [persona, setPersona] = useState(initialScenario?.persona ?? "A representative caller with a real customer goal.");
  const [goal, setGoal] = useState(initialScenario?.goal ?? "");
  const [turns, setTurns] = useState(initialScenario?.userTurns.join("\n") ?? "");
  const [facts, setFacts] = useState(initialScenario?.expectedOutcomeFacts.join(", ") ?? "");
  const [phrases, setPhrases] = useState(initialScenario?.requiredPhrases.join(", ") ?? "");
  const [forbiddenPhrases, setForbiddenPhrases] = useState(initialScenario?.forbiddenPhrases.join(", ") ?? "");
  const [tools, setTools] = useState(initialScenario?.expectedToolCalls.join(", ") ?? "");
  const [audioFixtures, setAudioFixtures] = useState(initialScenario?.audioFixtures?.join("\n") ?? "");
  const [tags, setTags] = useState(initialScenario?.tags.join(", ") ?? "new");
  const [latencyBudgetMs, setLatencyBudgetMs] = useState(initialScenario?.latencyBudgetMs ?? 2_000);
  const [submitting, setSubmitting] = useState(false);
  const parseList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const saveScenario = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const input = {
        name, description, persona, goal,
        userTurns: turns.split("\n").map((item) => item.trim()).filter(Boolean),
        expectedOutcomeFacts: parseList(facts), forbiddenPhrases: parseList(forbiddenPhrases),
        requiredPhrases: parseList(phrases), expectedToolCalls: parseList(tools),
        latencyBudgetMs, tags: parseList(tags),
        audioFixtures: audioFixtures.split("\n").map((item) => item.trim()).filter(Boolean),
      };
      const editing = Boolean(initialScenario);
      await request<ScenarioRevision>(editing ? `/api/scenarios/${initialScenario?.scenarioId}` : "/api/scenarios", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(input),
      });
      if (request.isCurrent?.() === false) return;
      await onSaved();
    } catch (requestError) {
      if (!isStaleApiRequest(requestError) && request.isCurrent?.() !== false) {
        onError(requestError instanceof Error ? requestError.message : "Could not save the scenario.");
      }
    } finally {
      if (request.isCurrent?.() !== false) setSubmitting(false);
    }
  };
  return <form className="form-panel scenario-create-panel" onSubmit={saveScenario}><div className="panel-heading"><span className="panel-number">{initialScenario ? `REV ${initialScenario.revision} → ${initialScenario.revision + 1}` : "NEW"}</span><div><h2>{initialScenario ? "Edit scenario" : "Describe the case"}</h2><p>Saving creates a new immutable scenario revision.</p></div></div><div className="scenario-form-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What should be true at the end?" required /></label><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>Caller persona<input value={persona} onChange={(event) => setPersona(event.target.value)} /></label><label className="wide-field">Caller turns<textarea value={turns} onChange={(event) => setTurns(event.target.value)} placeholder="One user message per line" rows={4} required /></label><label>Outcome facts<input value={facts} onChange={(event) => setFacts(event.target.value)} placeholder="booking.created, confirmation.shared" /></label><label>Required phrases<input value={phrases} onChange={(event) => setPhrases(event.target.value)} placeholder="tomorrow, confirmation" /></label><label>Forbidden phrases<input value={forbiddenPhrases} onChange={(event) => setForbiddenPhrases(event.target.value)} /></label><label>Expected tools<input value={tools} onChange={(event) => setTools(event.target.value)} placeholder="appointments.book" /></label><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="critical, billing" /></label><label>Latency budget (ms)<input type="number" min="1" max="120000" value={latencyBudgetMs} onChange={(event) => setLatencyBudgetMs(Number(event.target.value))} /></label><label className="wide-field">Audio fixtures (optional)<textarea value={audioFixtures} onChange={(event) => setAudioFixtures(event.target.value)} placeholder="One safe relative WAV path per caller turn" rows={3} /></label></div><div className="form-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Saving…" : initialScenario ? "Save revision" : "Save scenario"}<span>→</span></button></div></form>;
}
