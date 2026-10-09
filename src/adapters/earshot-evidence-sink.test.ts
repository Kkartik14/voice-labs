import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunArtifact } from "../domain/model.js";
import { createEarshotSinkFromEnvironment, EarshotEvidenceSink } from "./earshot-evidence-sink.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const run: RunArtifact = {
  id: "run_test_123",
  projectId: "project-test",
  experimentId: "experiment-test",
  experimentRevisionId: "experiment-revision-1",
  scenarioId: "scenario-revision-1",
  variantId: "variant-revision-1",
  callId: "call-test",
  sessionId: "session-test",
  repetition: 1,
  seed: 42,
  mode: "tvic",
  startedAt: "2026-09-28T12:00:00.000Z",
  completedAt: "2026-09-28T12:00:02.000Z",
  durationMs: 2_000,
  latencyScope: "executor_wall_clock_including_setup_excluding_persistence",
  transcript: [{ index: 0, speaker: "user", text: "private caller words", offsetMs: 0 }],
  toolCalls: [{ id: "tool-test", name: "private_tool", arguments: { customer: "private tool data" }, status: "succeeded", elapsedMs: 1 }],
  finalFacts: [],
  metrics: { turnCount: 1, toolCallCount: 1, audioExercised: false },
  status: "passed",
};

describe("Earshot evidence sink", () => {
  it("joins root and prefixed endpoints without duplicate slashes", () => {
    const localMapping = { "platform-local": { earshotProjectId: "earshot-local" } };
    expect(new EarshotEvidenceSink({ endpoint: "http://localhost:4319/", projectMappings: localMapping }).endpoint)
      .toBe("http://localhost:4319/v1/incidents");
    const remoteMapping = { "platform-local": { earshotProjectId: "earshot-local", apiKey: "test-key" } };
    expect(new EarshotEvidenceSink({ endpoint: "https://earshot.example/api/", projectMappings: remoteMapping }).endpoint)
      .toBe("https://earshot.example/api/v1/incidents");
    expect(new EarshotEvidenceSink({ endpoint: "https://earshot.example/api/v1/incidents/", projectMappings: remoteMapping }).endpoint)
      .toBe("https://earshot.example/api/v1/incidents");
  });

  it("requires project-scoped keys for remote mappings", () => {
    expect(() => new EarshotEvidenceSink({
      endpoint: "https://earshot.example",
      projectMappings: { "platform-local": { earshotProjectId: "earshot-local" } },
    })).toThrow("project-scoped API key");
    expect(() => new EarshotEvidenceSink({
      endpoint: "http://earshot.example",
      projectMappings: { "platform-local": { earshotProjectId: "earshot-local", apiKey: "private-key" } },
    })).toThrow("must use HTTPS");
  });

  it("requires explicit Platform mapping when auth mode is unset, then uses that hosted project mapping", async () => {
    const originalAuthMode = process.env.VOICE_LABS_AUTH_MODE;
    delete process.env.VOICE_LABS_AUTH_MODE;
    vi.stubEnv("EARSHOT_ENDPOINT", "http://localhost:4319");
    vi.stubEnv("EARSHOT_PROJECT_MAPPINGS", "");
    vi.stubEnv("EARSHOT_PROJECT_ID", "earshot-hosted-project");
    vi.stubEnv("EARSHOT_PLATFORM_PROJECT_ID", "");
    vi.stubEnv("EARSHOT_API_KEY", "");

    try {
      expect(() => createEarshotSinkFromEnvironment()).toThrow(
        "Configure EARSHOT_PROJECT_MAPPINGS or both EARSHOT_PLATFORM_PROJECT_ID and EARSHOT_PROJECT_ID.",
      );

      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-earshot-project-id")).toBe("earshot-hosted-project");
        return new Response(JSON.stringify({ bundle_id: "voice-labs-run-test-123", session_id: "session-test", digest: "digest-hosted" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubEnv("EARSHOT_PLATFORM_PROJECT_ID", "platform-hosted-project");

      const sink = createEarshotSinkFromEnvironment();
      expect(sink).toBeDefined();
      await expect(sink!.attach({ projectId: "platform-hosted-project" }, run)).resolves.toMatchObject({
        incidentId: "voice-labs-run-test-123",
        status: "attached",
      });
    } finally {
      if (originalAuthMode === undefined) delete process.env.VOICE_LABS_AUTH_MODE;
      else process.env.VOICE_LABS_AUTH_MODE = originalAuthMode;
    }
  });

  it("rejects mappings that merge Platform projects into one Earshot tenant", () => {
    expect(() => new EarshotEvidenceSink({
      endpoint: "https://earshot.example",
      projectMappings: {
        "platform-one": { earshotProjectId: "earshot-shared", apiKey: "first-key" },
        "platform-two": { earshotProjectId: " earshot-shared ", apiKey: "second-key" },
      },
    })).toThrow("Each Platform project must map to a distinct Earshot project.");
    expect(() => new EarshotEvidenceSink({
      endpoint: "https://earshot.example",
      projectMappings: {
        "platform-one": { earshotProjectId: "earshot-one", apiKey: "first-key" },
        " platform-one ": { earshotProjectId: "earshot-two", apiKey: "second-key" },
      },
    })).toThrow("Each Platform project must have exactly one Earshot mapping.");
  });

  it("uploads only metadata and returns the immutable incident reference", async () => {
    let requestedUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = input;
      requestInit = init;
      return new Response(JSON.stringify({ bundle_id: "voice-labs-run-test-123", session_id: "session-test", digest: "sha256:abc" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test", apiKey: "private-key" },
    } });
    const reference = await sink.attach({ projectId: "project-test" }, run);
    const body = JSON.parse(String(requestInit?.body)) as {
      profile: { privacy: { capture_classes: Array<{ capture_class: string; decision: string; captured: boolean }> } };
      raw_otlp_chunks: unknown[];
    };
    const wireBody = JSON.stringify(body);

    expect(requestedUrl).toBe("http://localhost:4319/v1/incidents");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer private-key");
    expect(new Headers(requestInit?.headers).get("x-earshot-project-id")).toBe("earshot-project-test");
    expect(requestInit?.redirect).toBe("error");
    expect(wireBody).not.toContain("private caller words");
    expect(wireBody).not.toContain("private tool data");
    expect(body.raw_otlp_chunks).toEqual([]);
    expect(body.profile.privacy.capture_classes.filter((item) => ["transcript", "audio", "tool_payload", "model_payload"].includes(item.capture_class)))
      .toEqual([
        { capture_class: "transcript", decision: "deny", captured: false },
        { capture_class: "audio", decision: "deny", captured: false },
        { capture_class: "tool_payload", decision: "deny", captured: false },
        { capture_class: "model_payload", decision: "deny", captured: false },
      ]);
    expect(reference).toMatchObject({
      source: "earshot", incidentId: "voice-labs-run-test-123", upstreamProjectId: "earshot-project-test", sessionId: "session-test",
      bundleDigest: "sha256:abc", endpoint: "http://localhost:4319/v1/incidents", status: "attached",
    });
  });

  it("fails closed when the configured Earshot endpoint redirects", async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      return new Response("redirect target should not receive the request", { status: 200 });
    });
    const sink = new EarshotEvidenceSink({ endpoint: "https://earshot.example", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test", apiKey: "private-key" },
    } });

    await expect(sink.attach({ projectId: run.projectId }, run)).rejects.toThrow("fetch failed");
    expect(requestInit?.redirect).toBe("error");
  });

  it.each([
    { session_id: "", digest: "valid-digest" },
    { session_id: "s".repeat(257), digest: "valid-digest" },
    { session_id: "valid-session", digest: "" },
    { session_id: "valid-session", digest: "d".repeat(257) },
  ])("rejects an incomplete or unbounded Earshot reference", async (reference) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      bundle_id: "voice-labs-run-test-123",
      ...reference,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test" },
    } });

    await expect(sink.attach({ projectId: run.projectId }, run)).rejects.toThrow("incomplete incident reference");
  });

  it("rejects an Earshot response body over its byte limit", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({
      bundle_id: "voice-labs-run-test-123",
      session_id: "session-test",
      digest: "digest-test",
      padding: "x".repeat(20 * 1024),
      }))); },
      cancel() { bodyCancelled = true; },
    });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 201 }));
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test" },
    } });

    await expect(sink.attach({ projectId: run.projectId }, run)).rejects.toThrow("response exceeded the size limit");
    expect(bodyCancelled).toBe(true);
  });

  it("cancels a stalled body when Earshot returns an error status", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("error")); },
      cancel() { bodyCancelled = true; },
    });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 503 }));
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test" },
    } });

    await expect(sink.attach({ projectId: run.projectId }, run)).rejects.toThrow("Earshot returned HTTP 503.");
    expect(bodyCancelled).toBe(true);
  });

  it("keeps the request timeout active while a response body stalls", async () => {
    vi.useFakeTimers();
    let signalFromFetch: AbortSignal | undefined;
    let bodyCancelled = false;
    let resolveFetchReturned!: () => void;
    const fetchReturned = new Promise<void>((resolve) => { resolveFetchReturned = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { bodyCancelled = true; },
    });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      signalFromFetch = init?.signal as AbortSignal;
      resolveFetchReturned();
      return new Response(body, { status: 201 });
    });
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test" },
    } });
    let outcome = "pending";
    const pending = sink.attach({ projectId: run.projectId }, run).then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );

    await fetchReturned;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome).toBe("rejected");
    expect(signalFromFetch?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
    await pending;
  });

  it("propagates caller cancellation through a stalled response body", async () => {
    let bodyCancelled = false;
    let resolveFetchReturned!: () => void;
    const fetchReturned = new Promise<void>((resolve) => { resolveFetchReturned = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { bodyCancelled = true; },
    });
    vi.stubGlobal("fetch", async () => {
      resolveFetchReturned();
      return new Response(body, { status: 201 });
    });
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test" },
    } });
    const abortController = new AbortController();
    let outcome = "pending";
    const pending = sink.attach({ projectId: run.projectId }, run, abortController.signal).then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );

    await fetchReturned;
    await Promise.resolve();
    abortController.abort(new Error("Caller cancelled Earshot delivery."));
    const outcomeAfterAbort = await Promise.race([
      pending.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 50)),
    ]);

    expect(outcomeAfterAbort).toBe("settled");
    expect(outcome).toBe("rejected");
    expect(bodyCancelled).toBe(true);
  });

  it("reuses an identical bundle ID and payload after an ambiguous ingest response", async () => {
    const requests: Array<{ body: string; idempotencyKey: string | null }> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        body: String(init?.body),
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(JSON.stringify({ bundle_id: "voice-labs-run-test-123", session_id: "session-test", digest: "digest-stable" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const sink = new EarshotEvidenceSink({ endpoint: "http://localhost:4319", projectMappings: {
      "project-test": { earshotProjectId: "earshot-project-test", apiKey: "private-key" },
    } });

    await sink.attach({ projectId: run.projectId }, run);
    await sink.attach({ projectId: run.projectId }, run);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].body).toContain("voice-labs-run-test-123");
    expect(requests[0].idempotencyKey).toBe("voice-labs-run-test-123");
  });
});
