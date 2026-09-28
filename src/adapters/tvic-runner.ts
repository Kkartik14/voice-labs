import { readFile } from "node:fs/promises";
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
import type {
  ProviderInputMode,
  ProviderTrace,
  RunArtifact,
  RunError,
  ToolCall,
} from "../domain/model.js";
import type { RunExecutor, RunRequest } from "../domain/ports.js";

const TVIC_ENABLED = "1";
const AUDIO_SAMPLE_BYTES = 2;
const AUDIO_FRAME_MS = 20;
const AUDIO_FRAME_BYTES = (PCM16_16K_MONO.sampleRateHz / 1_000) * AUDIO_FRAME_MS * AUDIO_SAMPLE_BYTES;
const TURN_TRAILING_SILENCE_MS = 400;
const TURN_TIMEOUT_MS = 30_000;

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
      description: `A deterministic Voice Labs fixture for ${name}. It records the call and returns the scenario's expected facts.`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute(input) {
        return { ok: true, facts: request.scenario.expectedOutcomeFacts, input };
      },
    }),
  );
}

function buildProviderTrace(agent: VoiceAgent, inputMode: ProviderInputMode): ProviderTrace {
  return {
    runtime: "tvic",
    inputMode,
    telephony: agent.providers.telephony,
    stt: agent.providers.stt,
    llm: agent.providers.llm,
    tts: agent.providers.tts,
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
    experimentId: request.experimentId,
    scenarioId: request.scenario.id,
    variantId: request.variant.id,
    repetition: request.repetition,
    seed: request.seed,
    mode: request.mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
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
    experimentId: request.experimentId,
    scenarioId: request.scenario.id,
    variantId: request.variant.id,
    repetition: request.repetition,
    seed: request.seed,
    mode: request.mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
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

function readPcmFixture(bytes: Uint8Array, fixturePath: string): Uint8Array {
  const isWave = bytes.byteLength >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
  if (!isWave) {
    if (bytes.byteLength % AUDIO_SAMPLE_BYTES !== 0) throw new Error(`Audio fixture is not aligned to 16-bit PCM: ${fixturePath}`);
    return bytes;
  }
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = readUint32(bytes, offset + 4);
    const contentStart = offset + 8;
    if (contentStart + chunkSize > bytes.byteLength) throw new Error(`Audio fixture has an invalid WAV chunk: ${fixturePath}`);
    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = readInt16(bytes, contentStart);
      channels = readInt16(bytes, contentStart + 2);
      sampleRate = readUint32(bytes, contentStart + 4);
      bitsPerSample = readInt16(bytes, contentStart + 14);
      if (audioFormat !== 1) throw new Error(`Audio fixture must be uncompressed PCM: ${fixturePath}`);
    }
    if (chunkId === "data") data = bytes.slice(contentStart, contentStart + chunkSize);
    offset = contentStart + chunkSize + (chunkSize % 2);
  }
  if (channels !== 1 || sampleRate !== PCM16_16K_MONO.sampleRateHz || bitsPerSample !== 16 || !data) {
    throw new Error(`Audio fixture must be mono 16-bit 16kHz PCM WAV: ${fixturePath}`);
  }
  return data;
}

async function readAudioFixture(root: string, fixture: string): Promise<Uint8Array> {
  if (isAbsolute(fixture)) throw new Error(`Audio fixture must be relative to VOICE_LABS_AUDIO_ROOT: ${fixture}`);
  const path = resolve(root, fixture);
  const rootRelative = relative(root, path);
  if (rootRelative.startsWith("..") || isAbsolute(rootRelative)) throw new Error(`Audio fixture escapes VOICE_LABS_AUDIO_ROOT: ${fixture}`);
  return readPcmFixture(new Uint8Array(await readFile(path)), fixture);
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
    this.#audioRoot = resolve(options.audioRoot ?? process.env.VOICE_LABS_AUDIO_ROOT ?? process.cwd());
    this.#sttModel = options.sttModel ?? optionalEnvironment("VOICE_LABS_TVIC_STT_MODEL");
    this.#llmModel = options.llmModel ?? optionalEnvironment("VOICE_LABS_TVIC_LLM_MODEL") ?? optionalEnvironment("GROQ_MODEL") ?? "openai/gpt-oss-20b";
    this.#ttsModel = options.ttsModel ?? optionalEnvironment("VOICE_LABS_TVIC_TTS_MODEL");
    this.#ttsVoiceId = options.ttsVoiceId ?? optionalEnvironment("VOICE_LABS_TVIC_TTS_VOICE_ID") ?? optionalEnvironment("CARTESIA_VOICE_ID");
  }

  async execute(request: RunRequest): Promise<RunArtifact> {
    const startedAt = new Date();
    if (request.mode === "audio" && (request.scenario.audioFixtures?.length ?? 0) < request.scenario.userTurns.length) {
      return errorArtifact(request, startedAt, new Error("Audio mode requires one audioFixtures path for every scenario user turn."));
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
      trace = buildProviderTrace(agent, inputMode);
      captured = createCapturedRun();
      const callId = `voice_labs_call_${newId("call")}` as CallId;
      handle = new SimulationCallHandle(callId);
      const session = await agent.start({
        call: buildCall(callId),
        callHandle: handle,
        channel: "simulated",
        textDelivery: "always",
        metadata: { voiceLabsExperimentId: request.experimentId, voiceLabsVariantId: request.variant.id },
      });
      observation = this.observe(session.run, captured, handle);
      if (scriptedStt) await withTimeout(scriptedStt.waitUntilOpen(), TURN_TIMEOUT_MS, "TVIC scripted STT startup");
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
          const completion = await withTimeout(completed.promise, TURN_TIMEOUT_MS, `TVIC turn ${sequence}`);
          if (completion.status !== "completed") {
            const detail = captured.errors[0]?.message ? ` ${captured.errors[0].message}` : "";
            throw new Error(`TVIC turn ${sequence} ended with status ${completion.status}.${detail}`);
          }
        } else {
          const fixture = request.scenario.audioFixtures?.[index];
          if (!fixture) throw new Error(`Missing audio fixture for user turn ${sequence}.`);
          const bytes = await readAudioFixture(this.#audioRoot, fixture);
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
      await session.run;
      await observation;
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
      await agent?.stop().catch(() => undefined);
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
              captured.toolCalls.set(event.toolCallId, {
                ...existing,
                status: "succeeded",
                elapsedMs: event.latencyMs,
              });
            }
            for (const fact of stringFacts(event.output)) captured.finalFacts.add(fact);
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
  return new TvicVoiceRuntimeRunner();
}

export function loadTvicEnvironment(tvicRoot: string | undefined): void {
  if (process.env.VOICE_LABS_LOAD_TVIC_ENV !== TVIC_ENABLED) return;
  const root = resolve(tvicRoot ?? process.env.TVIC_ROOT ?? "../TVIC");
  // dotenv is deliberately loaded here, after Voice Labs' own .env. Existing
  // Voice Labs variables win; TVIC is only a local source for missing values.
  loadDotenv({ path: resolve(root, ".env"), override: false });
}
