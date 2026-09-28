export type ExecutionMode = "deterministic" | "tvic" | "audio";

export type ProviderInputMode = "scripted_transcript" | "audio_fixture";

export type RunStatus = "passed" | "failed" | "unknown" | "cancelled" | "error";

export type EvaluationStatus = "passed" | "failed" | "unknown";

export type EvaluatorKind = "outcome" | "guardrail" | "phrase" | "tool_call" | "latency";

export type VariantStrategy = "reliable" | "concise" | "fragile";

export interface ScenarioRevision {
  id: string;
  scenarioId: string;
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
}

export interface VariantRevision {
  id: string;
  variantId: string;
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
}

export interface EvaluatorDefinition {
  id: string;
  kind: EvaluatorKind;
  name: string;
  weight: number;
}

export interface Experiment {
  id: string;
  name: string;
  description: string;
  scenarioIds: string[];
  variantIds: string[];
  repetitions: number;
  mode: ExecutionMode;
  evaluatorIds: string[];
  createdAt: string;
}

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

export interface ProviderTrace {
  runtime: "tvic";
  inputMode: ProviderInputMode;
  telephony: string;
  stt: string;
  llm: string;
  tts: string;
}

export interface RunError {
  code?: string;
  message: string;
}

export interface RunArtifact {
  id: string;
  experimentId: string;
  scenarioId: string;
  variantId: string;
  repetition: number;
  seed: number;
  mode: ExecutionMode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
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
  bundleDigest?: string;
  endpoint: string;
  status: "attached" | "unavailable" | "not_requested";
}

export interface RegressionEntry {
  scenarioId: string;
  revision: number;
  promotedAt: string;
}

export interface LabState {
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  evaluators: EvaluatorDefinition[];
  experiments: Experiment[];
  runs: RunArtifact[];
  regressionSet: RegressionEntry[];
}

export interface VariantComparisonRow {
  variantId: string;
  variantName: string;
  providerLabel: string;
  runCount: number;
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
  totalPassed: number;
  totalFailed: number;
  totalUnknown: number;
}

export interface ExperimentDetail {
  experiment: Experiment;
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  runs: RunArtifact[];
  comparison: Comparison;
}

export interface BootstrapPayload {
  product: "voice-labs";
  scenarios: ScenarioRevision[];
  variants: VariantRevision[];
  evaluators: EvaluatorDefinition[];
  experiments: Experiment[];
  recentRuns: RunArtifact[];
  regressionScenarioIds: string[];
}
