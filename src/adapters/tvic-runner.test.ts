import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "./seed.js";
import { TvicVoiceRuntimeRunner, createTvicRunnerFromEnvironment } from "./tvic-runner.js";
import type { RunRequest } from "../domain/ports.js";
import { UNCONFIRMED_RUNTIME_CLEANUP_CODE } from "../domain/run-lifecycle.js";

const { createVoiceAgentMock } = vi.hoisted(() => ({ createVoiceAgentMock: vi.fn() }));
vi.mock("voice-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("voice-runtime")>();
  return { ...actual, createVoiceAgent: createVoiceAgentMock };
});

const providerEnvironment = [
  "DEEPGRAM_API_KEY",
  "GROQ_API_KEY",
  "CARTESIA_API_KEY",
  "CARTESIA_VOICE_ID",
  "VOICE_LABS_TVIC_ENABLED",
  "VOICE_LABS_LOAD_TVIC_ENV",
] as const;

const originalEnvironment = new Map(providerEnvironment.map((name) => [name, process.env[name]]));

afterEach(() => {
  createVoiceAgentMock.mockReset();
  vi.unstubAllEnvs();
  for (const name of providerEnvironment) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(mode: RunRequest["mode"]): RunRequest {
  const state = createSeedState();
  return {
    context: { userId: "test-user", projectId: "local" },
    experimentId: state.experiments[0].experimentId,
    experimentRevisionId: state.experiments[0].id,
    scenario: state.scenarios[0],
    variant: state.variants[0],
    repetition: 1,
    seed: 42,
    mode,
  };
}

describe("TVIC runner boundary", () => {
  it("does not enable provider execution implicitly", () => {
    delete process.env.VOICE_LABS_TVIC_ENABLED;
    expect(createTvicRunnerFromEnvironment()).toBeUndefined();
  });

  it("fails audio runs before provider startup when fixtures are incomplete", async () => {
    const artifact = await new TvicVoiceRuntimeRunner().execute(request("audio"));

    expect(artifact.status).toBe("error");
    expect(artifact.error?.message).toContain("one audioFixtures path for every scenario user turn");
    expect(artifact.providerTrace).toBeUndefined();
  });

  it("fails closed without leaking provider credentials", async () => {
    for (const name of ["DEEPGRAM_API_KEY", "GROQ_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID"]) {
      delete process.env[name];
    }
    const artifact = await new TvicVoiceRuntimeRunner().execute(request("tvic"));

    expect(artifact.status).toBe("error");
    expect(artifact.error?.message).toContain("CARTESIA_VOICE_ID");
    expect(artifact.error?.message).not.toContain("sk-");
  });

  it.each([false, true])("marks runtime shutdown unconfirmed when cancelled=%s", async (cancelled) => {
    vi.stubEnv("GROQ_API_KEY", "mocked-provider-boundary");
    vi.stubEnv("CARTESIA_API_KEY", "mocked-provider-boundary");
    vi.stubEnv("CARTESIA_VOICE_ID", "mocked-voice");
    let resolveStartCalled!: () => void;
    const startCalled = new Promise<void>((resolve) => { resolveStartCalled = resolve; });
    createVoiceAgentMock.mockReturnValue({
      providers: { telephony: "mock", stt: "mock", llm: "mock", tts: "mock" },
      start: async ({ signal }: { signal?: AbortSignal }) => {
        resolveStartCalled();
        if (cancelled) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        throw new Error("The simulated session ended unexpectedly.");
      },
      stop: async () => { throw new Error("TVIC runtime shutdown timed out."); },
    } as never);

    const controller = new AbortController();
    const execution = new TvicVoiceRuntimeRunner().execute(request("tvic"), undefined, cancelled ? controller.signal : undefined);
    if (cancelled) {
      await startCalled;
      controller.abort(new Error("Simulated caller cancellation."));
    }
    await expect(execution)
      .rejects.toMatchObject({ code: UNCONFIRMED_RUNTIME_CLEANUP_CODE });
  });
});
