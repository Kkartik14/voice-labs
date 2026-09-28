import { afterEach, describe, expect, it } from "vitest";
import { createSeedState } from "./seed.js";
import { TvicVoiceRuntimeRunner, createTvicRunnerFromEnvironment } from "./tvic-runner.js";
import type { RunRequest } from "../domain/ports.js";

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
  for (const name of providerEnvironment) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(mode: RunRequest["mode"]): RunRequest {
  const state = createSeedState();
  return {
    experimentId: state.experiments[0].id,
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
});
