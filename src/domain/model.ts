export type ExecutionMode = "deterministic" | "tvic" | "audio";

export type ProviderInputMode = "scripted_transcript" | "audio_fixture";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "unknown" | "cancelled" | "error";

/** Minimal row state for refreshing experiment history without run artifacts. */
export interface ExperimentRunStatusSnapshot {
  id: string;
  status: RunStatus;
}

/** Status reconciliation for the recent page plus the caller's previously active run IDs. */
export interface ExperimentRunProgressSnapshot {
  runs: ExperimentRunStatusSnapshot[];
  missingRunIds: string[];
}

export type EvaluationStatus = "passed" | "failed" | "unknown";

export type EvaluatorKind = "outcome" | "guardrail" | "phrase" | "tool_call" | "latency";

export type VariantStrategy = "reliable" | "concise" | "fragile";

/** Identity and project authorization established by the Platform API boundary. */
export interface ProjectContext {
  readonly userId: string;
  readonly projectId: string;
}

export interface ScenarioRevision {
  id: string;
  scenarioId: string;
  projectId: string;
  revision: number;
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
  /** Optional per-turn WAV/PCM fixture paths used by the TVIC audio tier. */
  audioFixtures?: string[];
  createdAt: string;
  createdBy: string;
}

export interface VariantRevision {
  id: string;
  variantId: string;
  projectId: string;
  revision: number;
  name: string;
  description: string;
  instructions: string;
  strategy: VariantStrategy;
  reliability: number;
  toolSuccessRate: number;
  latencyMs: number;
  providerLabel: string;
  createdAt: string;
  createdBy: string;
}

export interface EvaluatorDefinition {
  id: string;
  kind: EvaluatorKind;
  name: string;
  weight: number;
}

export interface Experiment {
  /** Immutable revision identifier. */
  id: string;
  /** Stable identifier shared by all revisions of this experiment. */
  experimentId: string;
  projectId: string;
  revision: number;
  name: string;
  description: string;
  /** Logical IDs selected by the author. */
  scenarioIds: string[];
  variantIds: string[];
  /** Exact immutable inputs pinned when this experiment revision was saved. */
  scenarioRevisionIds: string[];
  variantRevisionIds: string[];
  repetitions: number;
  mode: ExecutionMode;
  /** Whether this immutable experiment revision requests metadata-only Earshot capture. */
  captureEvidence: boolean;
  evaluatorIds: string[];
  createdAt: string;
  createdBy: string;
}

/** Small revision history projection used by the detail selector. */
export type ExperimentRevisionSummary = Pick<Experiment, "id" | "experimentId" | "revision" | "name" | "createdAt">;

export interface TranscriptTurn {
  index: number;
  speaker: "user" | "assistant" | "system";
  text: string;
  offsetMs: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
  status: "succeeded" | "failed";
  elapsedMs: number;
  error?: string;
}

export interface RunMetrics {
  turnCount: number;
  toolCallCount: number;
  audioExercised: boolean;
  totalLatencyMs?: number;
  firstResponseMs?: number;
}

export type LatencyScope = "executor_wall_clock_including_setup_excluding_persistence";

export interface ProviderTrace {
  runtime: "tvic";
  inputMode: ProviderInputMode;
  telephony: string;
  stt: string;
  llm: string;
  tts: string;
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
  ttsVoiceId?: string;
}

export interface RunError {
  code?: string;
  message: string;
}

export interface RunArtifact {
  id: string;
  projectId: string;
  /** Stable logical experiment identifier. */
  experimentId: string;
  /** Exact immutable experiment revision used for this run. */
  experimentRevisionId: string;
  /** Exact immutable scenario and variant revision IDs. */
  scenarioId: string;
  variantId: string;
  /** TVIC identifiers are retained for downstream correlation. */
  callId?: string;
  sessionId?: string;
  repetition: number;
  seed: number;
  mode: ExecutionMode;
  /** Timestamp at which this attempt entered the worker run. */
  queuedAt?: string;
  /** Set when the executor begins; absent while queued. */
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  latencyScope: LatencyScope;
  transcript: TranscriptTurn[];
  toolCalls: ToolCall[];
  finalFacts: string[];
  metrics: RunMetrics;
  providerTrace?: ProviderTrace;
  /** Bounded public TVIC event-kind trace; payloads remain out of the artifact. */
  runtimeEvents?: string[];
  error?: RunError;
  status?: RunStatus;
  evaluations?: EvaluationResult[];
  evidence?: EvidenceReference;
}

/** Fields needed by the run screen to refresh evidence delivery status. */
export type RunEvidenceProgress = Pick<EvidenceReference, "status">
  & Partial<Pick<EvidenceReference, "sessionId" | "message">>;

/** Fields needed to refresh run progress without retransmitting the full artifact. */
export type RunProgressSnapshot = Pick<RunArtifact, "id" | "status">
  & { evidence?: RunEvidenceProgress };

/** Run metadata used by list screens; it deliberately excludes transcripts and tool payloads. */
export type RunSummary = Pick<RunArtifact,
  "id" | "experimentId" | "experimentRevisionId" | "scenarioId" | "variantId" |
  "repetition" | "startedAt" | "durationMs" | "status"
> & {
  experimentName?: string;
  scenarioName?: string;
  variantName?: string;
};

export interface RunPageCursor {
  startedAt: string;
  id: string;
}

export interface ExperimentRunPage {
  runs: RunArtifact[];
  hasMore: boolean;
  nextCursor: RunPageCursor | null;
}

export interface EvaluationResult {
  id: string;
  kind: EvaluatorKind;
  name: string;
  status: EvaluationStatus;
  score: number;
  weight: number;
  reason: string;
  evidence: string[];
}

export interface EvidenceReference {
  source: "earshot";
  incidentId?: string;
  upstreamProjectId?: string;
  sessionId?: string;
  bundleDigest?: string;
  endpoint: string;
  status: "pending" | "attached" | "unavailable" | "not_requested";
  message?: string;
  /** Durable delivery attempts; network attempts are reserved before dispatch so crashes cannot reset the budget. */
  attemptCount?: number;
  /** Earliest UTC time when the persisted metadata-only incident may be retried. */
  retryAt?: string;
}

export interface RegressionEntry {
  projectId: string;
  scenarioId: string;
  revision: number;
  promotedAt: string;
  promotedBy: string;
}

export type RegressionMembership = Pick<RegressionEntry, "scenarioId" | "revision">;

/** Minimal durable accounting record; intentionally survives deletion of the run artifact. */
export interface ProviderAttemptUsage {
  projectId: string;
  runId: string;
  queuedAt: string;
}

export interface AcceptedRunStart {
  experimentId: string;
  runIds: string[];
  status: "queued";
}

/** Durable idempotency receipt for an accepted run-start request. */
export interface RunStartRequestRecord {
  requestKeyHash: string;
  requestFingerprint: string;
  status: "preparing" | "accepted";
  ownerId: string;
  leaseExpiresAt: string;
  createdAt: string;
  acceptance?: AcceptedRunStart;
}

export interface EarshotIncidentReference {
  incidentId: string;
  endpoint: string;
  deliveryStatus: "attempted" | "attached";
  /** Earshot project ID only; API keys and other credentials are never persisted here. */
  upstreamProjectId?: string;
}

export interface ProjectPurgeReceipt {
  projectId: string;
  status: "local_data_deleted";
  linkedEarshotIncidents: EarshotIncidentReference[];
  completedAt: string;
}

export interface LabState {
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  evaluators: EvaluatorDefinition[];
  experiments: Experiment[];
  runs: RunArtifact[];
  providerAttemptUsage: ProviderAttemptUsage[];
  runStartRequests: RunStartRequestRecord[];
  earshotReferences: EarshotIncidentReference[];
  projectPurge: ProjectPurgeReceipt | null;
  regressionSet: RegressionEntry[];
}

export interface VariantComparisonRow {
  variantId: string;
  variantName: string;
  providerLabel: string;
  runCount: number;
  runningRuns: number;
  passedRuns: number;
  failedRuns: number;
  unknownRuns: number;
  passRate: number;
  unknownRate: number;
  qualityScore: number | null;
  averageLatencyMs: number | null;
  deltaFromBaseline: number | null;
}

export interface Comparison {
  baselineVariantId: string | null;
  rows: VariantComparisonRow[];
  totalRuns: number;
  totalRunning: number;
  totalPassed: number;
  totalFailed: number;
  totalUnknown: number;
}

export interface ExperimentDetail {
  experiment: Experiment;
  revisions: ExperimentRevisionSummary[];
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  runs: RunArtifact[];
  comparison: Comparison;
  /** Present for detail requests; exports can also report when the run cap was reached. */
  runsHasMore?: boolean;
  runsCursor?: RunPageCursor | null;
  runsTruncated?: boolean;
}

export interface BootstrapPayload {
  product: "voice-labs";
  projectId: string;
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  evaluators: EvaluatorDefinition[];
  experiments: Experiment[];
  recentRuns: RunSummary[];
  regressionScenarioIds: string[];
  regressionScenarioRevisions: RegressionMembership[];
}
