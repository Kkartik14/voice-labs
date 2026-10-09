import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  AsyncQueue,
  createMediaEvent,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  type Call,
  type CallHandle,
  type CallId,
  type CreateVoiceAgentOptions,
  type InboundMediaEvent,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type SpeechToTextProvider,
  type SttStream,
  type TranscriptEvent,
  type TurnId,
  type VoiceAgent,
  type VoiceEvent,
} from "voice-runtime";
import { newId } from "../domain/ids.js";
import { UNCONFIRMED_RUNTIME_CLEANUP_CODE, UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE } from "../domain/run-lifecycle.js";
import type {
  ProviderInputMode,
  ProviderTrace,
  RunArtifact,
  RunError,
  ScenarioRevision,
  ToolCall,
} from "../domain/model.js";
import type { RunExecutor, RunRequest } from "../domain/ports.js";

const TVIC_ENABLED = "1";
const AUDIO_SAMPLE_BYTES = 2;
const AUDIO_FRAME_MS = 20;
const AUDIO_FRAME_BYTES = (PCM16_16K_MONO.sampleRateHz / 1_000) * AUDIO_FRAME_MS * AUDIO_SAMPLE_BYTES;
const TURN_TRAILING_SILENCE_MS = 400;
const TURN_TIMEOUT_MS = 30_000;
const AGENT_START_TIMEOUT_MS = 30_000;
const RUNTIME_STOP_TIMEOUT_MS = 5_000;
const MAX_AUDIO_FIXTURE_BYTES = 1 * 1024 * 1024;

const SCRIPTED_STT_CAPABILITIES = {
  streaming: { input: true, output: true, native: false },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO] },
  models: ["voice-labs-scripted"],
  turnDetection: ["manual"],
} satisfies ProviderCapabilities;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Run execution was cancelled."));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? new Error("Run execution was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; enable TVIC provider credentials before running this tier.`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function safeError(error: unknown): RunError {
  const value = error as { readonly code?: unknown; readonly message?: unknown } | null;
  const code = typeof value?.code === "string" && value.code.length > 0 ? value.code : undefined;
  let message = value?.message instanceof String ? value.message.toString() : typeof value?.message === "string" ? value.message : String(error);
  for (const secretName of [
    "DEEPGRAM_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "CARTESIA_API_KEY",
    "ELEVENLABS_API_KEY",
  ]) {
    const secret = process.env[secretName];
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return { ...(code ? { code } : {}), message: message.slice(0, 2_000) };
}

function jsonArguments(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        typeof item === "string" ? item : JSON.stringify(item),
      ]),
    );
  }
  return { value: typeof value === "string" ? value : JSON.stringify(value) };
}

function stringFacts(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const facts = (value as { readonly facts?: unknown }).facts;
  return Array.isArray(facts) ? facts.filter((fact): fact is string => typeof fact === "string") : [];
}

function inputEventId(prefix: string, sequence: number): ProviderEventId {
  return `${prefix}_${sequence}` as ProviderEventId;
}

function createScriptedStt(): {
  readonly provider: SpeechToTextProvider;
  readonly waitUntilOpen: () => Promise<void>;
  readonly pushTurn: (sessionId: string, text: string, sequence: number) => void;
} {
  let events: AsyncQueue<TranscriptEvent> | undefined;
  let opened = deferred<void>();
  const provider: SpeechToTextProvider = {
    name: "voice-labs-scripted-stt",
    kind: "stt",
    version: "1.0.0",
    capabilities: SCRIPTED_STT_CAPABILITIES,
    async open(request): Promise<SttStream> {
      events = new AsyncQueue<TranscriptEvent>();
      opened.resolve();
      return {
        events,
        commit: async () => undefined,
        sendAudio: async () => undefined,
        close: async () => events?.close(),
      };
    },
  };
  return {
    provider,
    waitUntilOpen: () => opened.promise,
    pushTurn(sessionId, text, sequence) {
      if (!events) throw new Error("TVIC scripted STT stream is not open yet.");
      const timestamp = nowTimestamp();
      events.push({
        id: inputEventId("voice_labs_final", sequence),
        type: "stt.final",
        direction: "input",
        sessionId: sessionId as never,
        sequence: sequence * 2 - 1,
        provider: "voice-labs-scripted-stt",
        text,
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      events.push({
        id: inputEventId("voice_labs_endpoint", sequence),
        type: "stt.endpoint",
        direction: "input",
        sessionId: sessionId as never,
        sequence: sequence * 2,
        provider: "voice-labs-scripted-stt",
        reason: "manual",
        timestamp,
      });
    },
  };
}

class SimulationCallHandle implements CallHandle {
  readonly events = new AsyncQueue<InboundMediaEvent>();
  readonly callId: CallId;
  readonly outputTexts: Array<{ readonly text: string; readonly at: number }> = [];
  readonly outputBytes: number[] = [];
  readonly closeReasons: string[] = [];
  #closed = false;

  constructor(callId: CallId) {
    this.callId = callId;
  }

  async send(event: OutputMediaEvent): Promise<boolean> {
    if (this.#closed) return false;
    if (event.type === "media.audio.chunk") this.outputBytes.push(event.audio.bytes.byteLength);
    return true;
  }

  async deliverText(_turnId: TurnId, _sequence: number, text: string): Promise<boolean> {
    if (this.#closed) return false;
    this.outputTexts.push({ text, at: Date.now() });
    return true;
  }

  async clear(): Promise<void> {
    // The harness has no remote playback buffer. TVIC still calls this method
    // during interruption, which is the behavior this seam is meant to expose.
  }

  async close(reason: Parameters<CallHandle["close"]>[0]): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.closeReasons.push(reason);
    this.events.close();
  }

  async confirmPlayout(): Promise<boolean> {
    return !this.#closed;
  }

  push(event: InboundMediaEvent): void {
    if (!this.events.push(event)) throw new Error("TVIC simulation transport input queue is closed.");
  }
}

interface CapturedRun {
  readonly startedAtMs: number;
  callId?: string;
  sessionId?: string;
  readonly userTurns: Array<{ readonly text: string; readonly at: number }>;
  readonly assistantTurns: Array<{ readonly text: string; readonly at: number }>;
  readonly toolCalls: Map<string, ToolCall>;
  readonly finalFacts: Set<string>;
  readonly errors: RunError[];
  readonly turnCompletions: Array<VoiceEvent & { readonly kind: "turn_completed" }>;
  readonly completedWaiters: Deferred<VoiceEvent & { readonly kind: "turn_completed" }>[];
  readonly eventKinds: string[];
  audioInputBytes: number;
  audioOutputBytes: number;
}

function createCapturedRun(): CapturedRun {
  return {
    startedAtMs: Date.now(),
    userTurns: [],
    assistantTurns: [],
    toolCalls: new Map(),
    finalFacts: new Set(),
    errors: [],
    turnCompletions: [],
    completedWaiters: [],
    eventKinds: [],
    audioInputBytes: 0,
    audioOutputBytes: 0,
  };
}

function buildCall(callId: CallId): Call {
  const now = nowTimestamp();
  return {
    id: callId,
    provider: "web-client-audio",
    direction: "inbound",
    from: "voice-labs-scenario",
    to: "voice-labs-agent",
    status: "connected",
    mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
    createdAt: now,
    startedAt: now,
  };
}

function buildPrompt(request: RunRequest): string {
  const tools = request.scenario.expectedToolCalls.length > 0
    ? `Available test tools: ${request.scenario.expectedToolCalls.join(", ")}. Use them when they are necessary to complete the caller's goal.`
    : "There are no test tools available for this scenario.";
  return [
    request.variant.instructions,
    `Caller persona: ${request.scenario.persona}`,
    `Caller goal: ${request.scenario.goal}`,
    tools,
    "You are running inside a Voice Labs experiment. Do not invent a successful final state when the available test tools did not confirm it.",
  ].join("\n\n");
}

function createSandboxTools(request: RunRequest): readonly ReturnType<typeof defineTool>[] {
  const uniqueNames = [...new Set(request.scenario.expectedToolCalls)];
  return uniqueNames.map((name) =>
    defineTool({
      id: `voice_labs_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      name,
      description: `A Voice Labs harness tool for ${name}. No business system is connected, so it cannot confirm a side effect.`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { ok: false, error: "No business tool is connected to this Voice Labs scenario." };
      },
    }),
  );
}

function buildProviderTrace(
  agent: VoiceAgent,
  inputMode: ProviderInputMode,
  models: Pick<ProviderTrace, "sttModel" | "llmModel" | "ttsModel" | "ttsVoiceId">,
): ProviderTrace {
  return {
    runtime: "tvic",
    inputMode,
    telephony: agent.providers.telephony,
    stt: agent.providers.stt,
    llm: agent.providers.llm,
    tts: agent.providers.tts,
    ...models,
  };
}

function buildTranscript(captured: CapturedRun): RunArtifact["transcript"] {
  const turns = [
    ...captured.userTurns.map((turn) => ({ speaker: "user" as const, ...turn })),
    ...captured.assistantTurns.map((turn) => ({ speaker: "assistant" as const, ...turn })),
  ].sort((left, right) => left.at - right.at);
  return turns.map((turn, index) => ({
    index,
    speaker: turn.speaker,
    text: turn.text,
    offsetMs: Math.max(0, turn.at - captured.startedAtMs),
  }));
}

function errorArtifact(request: RunRequest, startedAt: Date, error: unknown, trace?: ProviderTrace): RunArtifact {
  const completedAt = new Date();
  return {
    id: newId("run"),
    projectId: request.context.projectId,
    experimentId: request.experimentId,
    experimentRevisionId: request.experimentRevisionId,
    scenarioId: request.scenario.id,
    variantId: request.variant.id,
    repetition: request.repetition,
    seed: request.seed,
    mode: request.mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
    latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
    transcript: [],
    toolCalls: [],
    finalFacts: [],
    metrics: { turnCount: 0, toolCallCount: 0, audioExercised: false },
    ...(trace ? { providerTrace: trace } : {}),
    runtimeEvents: [],
    error: safeError(error),
    status: "error",
  };
}

function capturedArtifact(
  request: RunRequest,
  startedAt: Date,
  captured: CapturedRun,
  trace: ProviderTrace,
  error?: RunError,
): RunArtifact {
  const completedAt = new Date();
  return {
    id: newId("run"),
    projectId: request.context.projectId,
    experimentId: request.experimentId,
    experimentRevisionId: request.experimentRevisionId,
    scenarioId: request.scenario.id,
    variantId: request.variant.id,
    ...(captured.callId ? { callId: captured.callId } : {}),
    ...(captured.sessionId ? { sessionId: captured.sessionId } : {}),
    repetition: request.repetition,
    seed: request.seed,
    mode: request.mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
    latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
    transcript: buildTranscript(captured),
    toolCalls: [...captured.toolCalls.values()],
    finalFacts: [...captured.finalFacts],
    metrics: {
      turnCount: captured.turnCompletions.length,
      toolCallCount: captured.toolCalls.size,
      audioExercised: captured.audioInputBytes > 0 || captured.audioOutputBytes > 0,
      totalLatencyMs: completedAt.getTime() - startedAt.getTime(),
      ...(captured.assistantTurns[0] ? { firstResponseMs: captured.assistantTurns[0].at - captured.startedAtMs } : {}),
    },
    providerTrace: trace,
    runtimeEvents: captured.eventKinds.slice(0, 200),
    ...(error ? { error, status: "error" as const } : {}),
  };
}

function readInt16(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function readUint32(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}

function readPcmFixture(bytes: Uint8Array): Uint8Array {
  const isWave = bytes.byteLength >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
  if (!isWave) throw new Error("Audio fixtures must be WAV files.");
  if (readUint32(bytes, 4) + 8 !== bytes.byteLength) throw new Error("Audio fixture has an invalid WAV length.");
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = readUint32(bytes, offset + 4);
    const contentStart = offset + 8;
      if (contentStart + chunkSize > bytes.byteLength) throw new Error("Audio fixture has an invalid WAV chunk.");
    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = readInt16(bytes, contentStart);
      channels = readInt16(bytes, contentStart + 2);
      sampleRate = readUint32(bytes, contentStart + 4);
      bitsPerSample = readInt16(bytes, contentStart + 14);
      if (audioFormat !== 1) throw new Error("Audio fixture must be uncompressed PCM.");
    }
    if (chunkId === "data") data = bytes.slice(contentStart, contentStart + chunkSize);
    offset = contentStart + chunkSize + (chunkSize % 2);
  }
  if (channels !== 1 || sampleRate !== PCM16_16K_MONO.sampleRateHz || bitsPerSample !== 16 || !data) {
    throw new Error("Audio fixture must be mono 16-bit 16kHz PCM WAV.");
  }
  if (data.byteLength === 0 || data.byteLength % AUDIO_SAMPLE_BYTES !== 0) throw new Error("Audio fixture PCM data is empty or misaligned.");
  return data;
}

export async function readAudioFixture(root: string, projectId: string, fixture: string): Promise<Uint8Array> {
  if (isAbsolute(fixture) || fixture.split(/[\\/]/).includes("..") || fixture.includes("\0")) {
    throw new Error("Audio fixture paths must be safe relative paths inside VOICE_LABS_AUDIO_ROOT.");
  }
  const canonicalRoot = await realpath(root);
  const projectDirectory = createHash("sha256").update(projectId).digest("hex");
  const projectPath = resolve(canonicalRoot, projectDirectory);
  const canonicalProjectPath = await realpath(projectPath);
  const projectRelative = relative(canonicalRoot, canonicalProjectPath);
  if (projectRelative.startsWith("..") || isAbsolute(projectRelative)) {
    throw new Error("Project audio fixtures must stay inside VOICE_LABS_AUDIO_ROOT.");
  }
  const requestedPath = resolve(canonicalProjectPath, fixture);
  const requestedRelative = relative(canonicalProjectPath, requestedPath);
  if (!requestedRelative || requestedRelative.startsWith("..") || isAbsolute(requestedRelative)) {
    throw new Error("Audio fixture paths must be safe relative paths inside VOICE_LABS_AUDIO_ROOT.");
  }
  const canonicalPath = await realpath(requestedPath);
  const canonicalRelative = relative(canonicalProjectPath, canonicalPath);
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
    throw new Error("Audio fixture resolves outside VOICE_LABS_AUDIO_ROOT.");
  }
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new Error("Audio fixtures must be regular files.");
  if (info.size > MAX_AUDIO_FIXTURE_BYTES) throw new Error(`Audio fixtures must not exceed ${MAX_AUDIO_FIXTURE_BYTES} bytes.`);
  return readPcmFixture(new Uint8Array(await readFile(canonicalPath)));
}

interface AudioFixturePreparation {
  readonly kind: "voice-labs-audio-fixtures";
  readonly projectId: string;
  readonly fixturesByScenario: ReadonlyMap<string, readonly Uint8Array[]>;
}

function isAudioFixturePreparation(value: unknown): value is AudioFixturePreparation {
  if (typeof value !== "object" || value === null) return false;
  const preparation = value as Partial<AudioFixturePreparation>;
  return preparation.kind === "voice-labs-audio-fixtures" && preparation.fixturesByScenario instanceof Map;
}

async function loadAudioFixtures(
  root: string,
  projectId: string,
  scenarios: readonly ScenarioRevision[],
): Promise<AudioFixturePreparation> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("Audio fixture root is not a directory.");
  } catch {
    throw Object.assign(new Error("Voice Labs audio fixture storage is unavailable on this host."), { statusCode: 503 });
  }
  const fixturesByScenario = new Map<string, readonly Uint8Array[]>();
  for (const scenario of scenarios) {
    if ((scenario.audioFixtures?.length ?? 0) !== scenario.userTurns.length) {
      throw Object.assign(new Error(`Audio mode needs one fixture per caller turn in scenario “${scenario.name}”.`), { statusCode: 422 });
    }
    if (fixturesByScenario.has(scenario.id)) continue;
    const scenarioFixtures: Uint8Array[] = [];
    for (const fixture of scenario.audioFixtures ?? []) {
      try {
        scenarioFixtures.push(await readAudioFixture(root, projectId, fixture));
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw Object.assign(new Error(`Audio fixture “${fixture}” for scenario “${scenario.name}” was not found in this project's audio directory.`), { statusCode: 422 });
        }
        if (code) throw Object.assign(new Error("Voice Labs could not read this project's audio fixture storage."), { statusCode: 503 });
        throw Object.assign(new Error(error instanceof Error ? error.message : "The audio fixture is invalid."), { statusCode: 422 });
      }
    }
    fixturesByScenario.set(scenario.id, scenarioFixtures);
  }
  return { kind: "voice-labs-audio-fixtures", projectId, fixturesByScenario };
}

export async function validateAudioFixtures(root: string, projectId: string, scenarios: readonly ScenarioRevision[]): Promise<void> {
  await loadAudioFixtures(root, projectId, scenarios);
}

export interface TvicRunnerOptions {
  readonly audioRoot?: string;
  readonly sttModel?: string;
  readonly llmModel?: string;
  readonly ttsModel?: string;
  readonly ttsVoiceId?: string;
}

export class TvicVoiceRuntimeRunner implements RunExecutor {
  readonly #audioRoot: string;
  readonly #sttModel: string | undefined;
  readonly #llmModel: string;
  readonly #ttsModel: string | undefined;
  readonly #ttsVoiceId: string | undefined;

  constructor(options: TvicRunnerOptions = {}) {
    this.#audioRoot = resolve(options.audioRoot ?? process.env.VOICE_LABS_AUDIO_ROOT ?? resolve(process.cwd(), "audio-fixtures"));
    this.#sttModel = options.sttModel ?? optionalEnvironment("VOICE_LABS_TVIC_STT_MODEL");
    this.#llmModel = options.llmModel ?? optionalEnvironment("VOICE_LABS_TVIC_LLM_MODEL") ?? optionalEnvironment("GROQ_MODEL") ?? "openai/gpt-oss-20b";
    this.#ttsModel = options.ttsModel ?? optionalEnvironment("VOICE_LABS_TVIC_TTS_MODEL");
    this.#ttsVoiceId = options.ttsVoiceId ?? optionalEnvironment("VOICE_LABS_TVIC_TTS_VOICE_ID") ?? optionalEnvironment("CARTESIA_VOICE_ID");
  }

  preflight(mode: "deterministic" | "tvic" | "audio", scenarios: readonly ScenarioRevision[] = []): Promise<unknown> | unknown {
    if (mode === "deterministic") return;
    this.#assertProviderConfiguration(mode);
    if (mode === "audio") return loadAudioFixtures(this.#audioRoot, scenarios[0]?.projectId ?? "", scenarios);
  }

  #assertProviderConfiguration(mode: "deterministic" | "tvic" | "audio"): void {
    if (mode === "deterministic") return;
    const missing = [
      ...(!optionalEnvironment("GROQ_API_KEY") ? ["GROQ_API_KEY"] : []),
      ...(!optionalEnvironment("CARTESIA_API_KEY") ? ["CARTESIA_API_KEY"] : []),
      ...(!this.#ttsVoiceId ? ["CARTESIA_VOICE_ID or VOICE_LABS_TVIC_TTS_VOICE_ID"] : []),
      ...(mode === "audio" && !optionalEnvironment("DEEPGRAM_API_KEY") ? ["DEEPGRAM_API_KEY"] : []),
    ];
    if (missing.length > 0) {
      throw Object.assign(new Error(`Missing provider configuration: ${missing.join(", ")}.`), { statusCode: 503 });
    }
  }

  async execute(request: RunRequest, preparation?: unknown, signal?: AbortSignal): Promise<RunArtifact> {
    const startedAt = new Date();
    if (request.mode === "audio" && (request.scenario.audioFixtures?.length ?? 0) !== request.scenario.userTurns.length) {
      return errorArtifact(request, startedAt, Object.assign(
        new Error("Audio mode requires one audioFixtures path for every scenario user turn."),
        { statusCode: 422 },
      ));
    }
    const audioFixtures: Uint8Array[] = [];
    try {
      this.#assertProviderConfiguration(request.mode);
      if (request.mode === "audio") {
        const audioPreparation = isAudioFixturePreparation(preparation) && preparation.projectId === request.context.projectId
          ? preparation
          : await loadAudioFixtures(this.#audioRoot, request.context.projectId, [request.scenario]);
        const preparedFixtures = audioPreparation.fixturesByScenario.get(request.scenario.id);
        if (!preparedFixtures) throw Object.assign(new Error("The audio fixture preflight did not include this scenario revision."), { statusCode: 422 });
        audioFixtures.push(...preparedFixtures);
      }
    } catch (error) {
      return errorArtifact(request, startedAt, error);
    }

    const inputMode: ProviderInputMode = request.mode === "audio" ? "audio_fixture" : "scripted_transcript";
    const scriptedStt = inputMode === "scripted_transcript" ? createScriptedStt() : undefined;
    let agent: VoiceAgent | undefined;
    let trace: ProviderTrace | undefined;
    let captured: CapturedRun | undefined;
    let observation: Promise<void> | undefined;
    let handle: SimulationCallHandle | undefined;
    try {
      agent = createVoiceAgent(this.agentOptions(request, scriptedStt?.provider));
      trace = buildProviderTrace(agent, inputMode, {
        sttModel: scriptedStt ? "voice-labs-scripted" : this.#sttModel,
        llmModel: this.#llmModel,
        ttsModel: this.#ttsModel,
        ttsVoiceId: this.#ttsVoiceId,
      });
      captured = createCapturedRun();
      const callId = `voice_labs_call_${newId("call")}` as CallId;
      captured.callId = callId;
      handle = new SimulationCallHandle(callId);
      const session = await withAbort(withTimeout(agent.start({
        call: buildCall(callId),
        callHandle: handle,
        channel: "simulated",
        textDelivery: "always",
        metadata: { voiceLabsExperimentId: request.experimentId, voiceLabsVariantId: request.variant.id },
        ...(signal ? { signal } : {}),
      }), AGENT_START_TIMEOUT_MS, "TVIC agent startup"), signal);
      captured.sessionId = session.sessionId;
      observation = this.observe(session.run, captured, handle);
      if (scriptedStt) await withAbort(withTimeout(scriptedStt.waitUntilOpen(), TURN_TIMEOUT_MS, "TVIC scripted STT startup"), signal);
      handle.push(createMediaEvent({
        id: inputEventId("voice_labs_stream_started", 1) as never,
        type: "media.stream.started",
        sessionId: session.sessionId,
        sequence: 1,
        direction: "input",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        format: PCM16_16K_MONO,
      }));

      for (let index = 0; index < request.scenario.userTurns.length; index += 1) {
        const sequence = index + 1;
        if (scriptedStt) {
          const completed = deferred<VoiceEvent & { readonly kind: "turn_completed" }>();
          captured.completedWaiters.push(completed);
          scriptedStt.pushTurn(session.sessionId, request.scenario.userTurns[index], sequence);
          const completion = await withAbort(withTimeout(completed.promise, TURN_TIMEOUT_MS, `TVIC turn ${sequence}`), signal);
          if (completion.status !== "completed") {
            const detail = captured.errors[0]?.message ? ` ${captured.errors[0].message}` : "";
            throw new Error(`TVIC turn ${sequence} ended with status ${completion.status}.${detail}`);
          }
        } else {
          const completed = deferred<VoiceEvent & { readonly kind: "turn_completed" }>();
          captured.completedWaiters.push(completed);
          const bytes = audioFixtures[index];
          if (!bytes) throw new Error(`Missing audio fixture for user turn ${sequence}.`);
          const nextAudioSequence = await this.pushAudio(handle, session.sessionId, bytes, captured, sequence);
          await this.pushAudio(
            handle,
            session.sessionId,
            new Uint8Array(Math.ceil(TURN_TRAILING_SILENCE_MS / AUDIO_FRAME_MS) * AUDIO_FRAME_BYTES),
            captured,
            sequence,
            nextAudioSequence,
          );
          // A fixture boundary is an explicit push-to-talk boundary. Keep the
          // commit on by default; callers can opt into provider endpointing with
          // VOICE_LABS_AUDIO_MANUAL_COMMIT=0.
          if (process.env.VOICE_LABS_AUDIO_MANUAL_COMMIT !== "0") {
            handle.push(createMediaEvent({
              id: inputEventId("voice_labs_commit", sequence) as never,
              type: "media.turn.commit_requested",
              sessionId: session.sessionId,
              sequence: 10_000 + sequence,
              direction: "input",
              timestamp: nowTimestamp(),
              monotonicOffsetMs: 0,
            }));
          }
          const completion = await withAbort(withTimeout(completed.promise, TURN_TIMEOUT_MS, `TVIC audio turn ${sequence}`), signal);
          if (completion.status !== "completed") {
            const detail = captured.errors[0]?.message ? ` ${captured.errors[0].message}` : "";
            throw new Error(`TVIC audio turn ${sequence} ended with status ${completion.status}.${detail}`);
          }
        }
      }

      handle.push(createMediaEvent({
        id: inputEventId("voice_labs_stream_ended", 1) as never,
        type: "media.stream.ended",
        sessionId: session.sessionId,
        sequence: 20_000,
        direction: "input",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        reason: "completed",
        durationMs: Math.max(0, Date.now() - captured.startedAtMs),
      }));
      await withAbort(withTimeout(Promise.resolve(session.run), TURN_TIMEOUT_MS, "TVIC session shutdown"), signal);
      await withAbort(withTimeout(observation, TURN_TIMEOUT_MS, "TVIC event stream shutdown"), signal);
      for (const reason of handle.closeReasons) {
        if (captured.eventKinds.length < 200) captured.eventKinds.push(`transport_close:${reason}`);
      }

      const completedAt = new Date();
      return capturedArtifact(request, startedAt, captured, trace, captured.errors[0]);
    } catch (error) {
      await handle?.close("error").catch(() => undefined);
      if (observation) await Promise.race([observation.catch(() => undefined), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000))]);
      if (captured && trace) {
        for (const reason of handle?.closeReasons ?? []) {
          if (captured.eventKinds.length < 200) captured.eventKinds.push(`transport_close:${reason}`);
        }
        const runError = captured.errors[0] ?? safeError(error);
        return capturedArtifact(request, startedAt, captured, trace, runError);
      }
      return errorArtifact(request, startedAt, error, trace);
    } finally {
      if (agent) {
        try {
          await withTimeout(agent.stop(), RUNTIME_STOP_TIMEOUT_MS, "TVIC runtime shutdown");
        } catch (error) {
          throw Object.assign(new Error(UNCONFIRMED_RUNTIME_CLEANUP_MESSAGE), { code: UNCONFIRMED_RUNTIME_CLEANUP_CODE, cause: error });
        }
      }
    }
  }

  private agentOptions(request: RunRequest, scriptedStt: SpeechToTextProvider | undefined): CreateVoiceAgentOptions {
    const llmProvider = optionalEnvironment("VOICE_LABS_TVIC_LLM_PROVIDER") ?? "groq";
    const sttProvider = optionalEnvironment("VOICE_LABS_TVIC_STT_PROVIDER") ?? "deepgram";
    const ttsProvider = optionalEnvironment("VOICE_LABS_TVIC_TTS_PROVIDER") ?? "cartesia";
    if (llmProvider !== "groq") throw new Error(`Unsupported Voice Labs TVIC LLM provider: ${llmProvider}`);
    if (ttsProvider !== "cartesia") throw new Error(`Unsupported Voice Labs TVIC TTS provider: ${ttsProvider}`);
    if (!scriptedStt && sttProvider !== "deepgram") throw new Error(`Unsupported Voice Labs TVIC STT provider: ${sttProvider}`);
    if (!this.#ttsVoiceId) throw new Error("Missing CARTESIA_VOICE_ID or VOICE_LABS_TVIC_TTS_VOICE_ID for TVIC runs.");

    const stt = scriptedStt
      ? scriptedStt
      : {
          provider: "deepgram" as const,
          apiKey: requiredEnvironment("DEEPGRAM_API_KEY"),
          ...(this.#sttModel ? { model: this.#sttModel } : {}),
        };
    const llm = {
      provider: "groq" as const,
      apiKey: requiredEnvironment("GROQ_API_KEY"),
      model: this.#llmModel,
      ...(optionalEnvironment("GROQ_API_URL") ? { url: optionalEnvironment("GROQ_API_URL") } : {}),
    };
    const tts = {
      provider: "cartesia" as const,
      apiKey: requiredEnvironment("CARTESIA_API_KEY"),
      voiceId: this.#ttsVoiceId,
      ...(this.#ttsModel ? { model: this.#ttsModel } : {}),
    };
    return {
      id: `voice-labs-${request.variant.id}`,
      name: "Voice Labs TVIC candidate",
      prompt: buildPrompt(request),
      providers: {
        telephony: { provider: "web-client-audio" },
        stt,
        llm,
        tts,
      },
      tools: createSandboxTools(request),
      audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    };
  }

  private async pushAudio(
    handle: SimulationCallHandle,
    sessionId: string,
    bytes: Uint8Array,
    captured: CapturedRun,
    turn: number,
    sequenceStart = turn * 1_000,
  ): Promise<number> {
    let offset = 0;
    let sequence = sequenceStart;
    while (offset < bytes.byteLength) {
      const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + AUDIO_FRAME_BYTES));
      const frameCount = Math.floor(chunk.byteLength / AUDIO_SAMPLE_BYTES);
      handle.push(createMediaEvent({
        id: inputEventId(`voice_labs_audio_${turn}`, sequence) as never,
        type: "media.audio.chunk",
        sessionId: sessionId as never,
        sequence,
        direction: "input",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: offset / AUDIO_SAMPLE_BYTES / PCM16_16K_MONO.sampleRateHz * 1_000,
        audio: {
          format: PCM16_16K_MONO,
          durationMs: frameCount / PCM16_16K_MONO.sampleRateHz * 1_000,
          frameCount,
          bytes: chunk,
        },
      }));
      captured.audioInputBytes += chunk.byteLength;
      offset += chunk.byteLength;
      sequence += 1;
      if (process.env.VOICE_LABS_AUDIO_FAST !== "1") {
        // Provider websocket sessions are realtime contracts. Sending a
        // three-second recording in a tight loop can make endpointing and
        // provider backpressure behave unlike a caller microphone.
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, AUDIO_FRAME_MS));
      } else {
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
    }
    return sequence;
  }

  private async observe(run: AsyncIterable<VoiceEvent>, captured: CapturedRun, handle: SimulationCallHandle): Promise<void> {
    try {
      for await (const event of run) {
        const at = Date.now();
        if (captured.eventKinds.length < 200) captured.eventKinds.push(event.kind);
        switch (event.kind) {
          case "transcript_delta":
            if (event.isFinal) captured.userTurns.push({ text: event.text, at });
            break;
          case "audio_output":
            captured.audioOutputBytes += event.bytes.byteLength;
            break;
          case "tool_call":
            captured.toolCalls.set(event.toolCallId, {
              id: event.toolCallId,
              name: event.toolName,
              arguments: jsonArguments(event.input),
              status: "failed",
              elapsedMs: 0,
            });
            break;
          case "tool_result": {
            const existing = captured.toolCalls.get(event.toolCallId);
            if (existing) {
              const output = event.output && typeof event.output === "object" ? event.output as { ok?: unknown; error?: unknown } : {};
              const succeeded = output.ok === true;
              captured.toolCalls.set(event.toolCallId, {
                ...existing,
                status: succeeded ? "succeeded" : "failed",
                elapsedMs: event.latencyMs,
                ...(!succeeded ? { error: typeof output.error === "string" ? output.error.slice(0, 500) : "The tool did not confirm completion." } : {}),
              });
            }
            if (captured.toolCalls.get(event.toolCallId)?.status === "succeeded") {
              for (const fact of stringFacts(event.output)) captured.finalFacts.add(fact);
            }
            break;
          }
          case "turn_completed":
            captured.turnCompletions.push(event);
            if (captured.eventKinds.length < 200) captured.eventKinds.push(`turn_completed:${event.status}`);
            captured.completedWaiters.shift()?.resolve(event);
            break;
          case "error":
            captured.errors.push(safeError(event.error));
            break;
          case "call_ended":
            if (captured.eventKinds.length < 200) captured.eventKinds.push(`call_ended:${event.reason}`);
            break;
          case "turn_started":
            break;
        }
      }
    } catch (error) {
      captured.errors.push(safeError(error));
      while (captured.completedWaiters.length > 0) captured.completedWaiters.shift()?.reject(error);
    }
    // Output bytes are also available on the transport, which catches adapters
    // that accepted audio without emitting a public VoiceEvent.
    if (captured.audioOutputBytes === 0) captured.audioOutputBytes = handle.outputBytes.reduce((sum, value) => sum + value, 0);
    for (const output of handle.outputTexts) {
      if (!captured.assistantTurns.some((turn) => turn.at === output.at && turn.text === output.text)) {
        captured.assistantTurns.push(output);
      }
    }
  }
}

export function createTvicRunnerFromEnvironment(): TvicVoiceRuntimeRunner | undefined {
  if (process.env.VOICE_LABS_TVIC_ENABLED !== TVIC_ENABLED) return undefined;
  const runner = new TvicVoiceRuntimeRunner();
  runner.preflight("tvic");
  return runner;
}

export function loadTvicEnvironment(tvicRoot: string | undefined): void {
  if (process.env.VOICE_LABS_LOAD_TVIC_ENV !== TVIC_ENABLED) return;
  const root = resolve(tvicRoot ?? process.env.TVIC_ROOT ?? "../TVIC");
  // dotenv is deliberately loaded here, after Voice Labs' own .env. Existing
  // Voice Labs variables win; TVIC is only a local source for missing values.
  loadDotenv({ path: resolve(root, ".env"), override: false });
}
