import type { EvidenceReference, RunArtifact } from "../domain/model.js";
import type { EvidenceSink } from "../domain/ports.js";

const deniedCaptureClasses = ["extension_payload", "transcript", "audio", "tool_payload", "model_payload", "diagnostic_payload", "identity", "raw_otlp"] as const;

export interface EarshotProjectCredentials {
  readonly earshotProjectId: string;
  readonly apiKey?: string;
}

interface EarshotIngestResponse {
  bundle_id?: unknown;
  session_id?: unknown;
  digest?: unknown;
}

const MAX_EARSHOT_RESPONSE_BYTES = 16 * 1024;
const MAX_EARSHOT_REFERENCE_LENGTH = 256;

function abortedRequestError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Earshot request was aborted.");
}

async function waitForCancellation(cancellation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  const settledCancellation = cancellation.then(() => undefined, () => undefined);
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void settledCancellation.then(finish);
    if (signal.aborted) finish();
  });
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<void> {
  if (!body) return;
  try {
    await waitForCancellation(body.cancel(), signal);
  } catch {
    // A locked or already-closed body has nothing more to cancel.
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    await cancelResponseBody(response.body, signal);
    throw abortedRequestError(signal);
  }
  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_EARSHOT_RESPONSE_BYTES) {
    await cancelResponseBody(response.body, signal);
    throw new Error("Earshot response exceeded the size limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Earshot returned an incomplete incident reference.");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let abortPromiseCleanup: () => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortedRequestError(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    abortPromiseCleanup = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    while (true) {
      pendingRead = reader.read();
      const { done, value } = await Promise.race([pendingRead, abortPromise]);
      pendingRead = undefined;
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_EARSHOT_RESPONSE_BYTES) {
        try {
          await waitForCancellation(reader.cancel(), signal);
        } catch {
          // A closed or canceled response body cannot be read further.
        }
        throw new Error("Earshot response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    abortPromiseCleanup();
    if (signal.aborted && pendingRead) {
      void pendingRead.finally(() => reader.releaseLock()).catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Earshot returned an incomplete incident reference.");
  }
}

function isBoundedReferenceText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EARSHOT_REFERENCE_LENGTH;
}

function toUnixNanos(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis < 0) throw new Error("Run timestamps must be valid UTC timestamps.");
  return (BigInt(millis) * 1_000_000n).toString();
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("EARSHOT_ENDPOINT must use HTTP or HTTPS.");
  const basePath = url.pathname.replace(/\/+$/, "");
  const incidentPath = basePath.endsWith("/v1/incidents") ? basePath : `${basePath}/v1/incidents`;
  return new URL(incidentPath, url.origin).toString().replace(/\/$/, "");
}

function bundleFor(run: RunArtifact) {
  const sessionId = run.sessionId ?? `voice-labs-${run.id}`;
  const bundleId = `voice-labs-${run.id.replaceAll("_", "-")}`;
  const startedAt = run.startedAt;
  if (!startedAt) throw new Error("Earshot evidence requires a run that has started.");
  const startNano = toUnixNanos(startedAt);
  const endNano = toUnixNanos(run.completedAt ?? startedAt);
  const timePoint = (nanoseconds: string) => ({ source_time_unix_nano: nanoseconds });
  return {
    profile: {
      manifest: {
        bundle_id: bundleId,
        session_id: sessionId,
        created_at_unix_nano: endNano,
        producer: { name: "voice-labs", version: "0.1.0", language: "typescript" },
        adapters: [{ name: "tvic", version: "1.2.0", framework: "voice-runtime" }],
      },
      session: {
        session_id: sessionId,
        status: run.status === "error" ? "failed" : "completed",
        started_at: timePoint(startNano),
        ended_at: timePoint(endNano),
      },
      privacy: {
        policy_id: "voice-labs-metadata-only",
        policy_version: "1",
        default_capture_class: "metadata",
        capture_classes: [
          { capture_class: "metadata", decision: "allow", captured: true },
          ...deniedCaptureClasses.map((captureClass) => ({ capture_class: captureClass, decision: "deny", captured: false })),
        ],
      },
      coverage: [{ signal: "voice_labs.run_result", availability: "available" }],
    },
    raw_otlp_chunks: [],
  };
}

/** Sends an immutable metadata-only incident; personal conversation content is never copied. */
export class EarshotEvidenceSink implements EvidenceSink {
  public readonly endpoint: string;
  readonly #projectCredentials: ReadonlyMap<string, EarshotProjectCredentials>;

  public constructor(options: { endpoint: string; projectMappings: Readonly<Record<string, EarshotProjectCredentials>> }) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    const target = new URL(this.endpoint);
    const isLoopback = target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]";
    if (target.protocol === "http:" && !isLoopback) {
      throw new Error("Remote Earshot endpoints must use HTTPS so project API keys are not sent in cleartext.");
    }
    const seenPlatformProjectIds = new Set<string>();
    const mappings = Object.entries(options.projectMappings).map(([platformProjectIdValue, credential]) => {
      const platformProjectId = platformProjectIdValue.trim();
      if (!platformProjectId.trim() || !credential || typeof credential.earshotProjectId !== "string" || !credential.earshotProjectId.trim()) {
        throw new Error("Earshot project mappings require Platform and Earshot project IDs.");
      }
      if (seenPlatformProjectIds.has(platformProjectId)) {
        throw new Error("Each Platform project must have exactly one Earshot mapping.");
      }
      seenPlatformProjectIds.add(platformProjectId);
      const earshotProjectId = credential.earshotProjectId.trim();
      const apiKey = credential.apiKey?.trim() || undefined;
      if (!apiKey && (!isLoopback || target.protocol !== "http:")) {
        throw new Error("Each remote Earshot project mapping requires its project-scoped API key.");
      }
      return [platformProjectId, { earshotProjectId, ...(apiKey ? { apiKey } : {}) }] as const;
    });
    if (mappings.length === 0) throw new Error("At least one Voice Labs to Earshot project mapping is required.");
    const remoteProjectIds = new Set<string>();
    for (const [, credential] of mappings) {
      if (remoteProjectIds.has(credential.earshotProjectId)) {
        throw new Error("Each Platform project must map to a distinct Earshot project.");
      }
      remoteProjectIds.add(credential.earshotProjectId);
    }
    this.#projectCredentials = new Map(mappings);
  }

  public referenceFor(context: { readonly projectId: string }, run: RunArtifact): { incidentId: string; endpoint: string; upstreamProjectId: string; deliveryStatus: "attempted" } {
    const project = this.#projectCredentials.get(context.projectId);
    if (!project) throw new Error("No Earshot project is configured for this Voice Labs project.");
    return {
      incidentId: `voice-labs-${run.id.replaceAll("_", "-")}`,
      endpoint: this.endpoint,
      upstreamProjectId: project.earshotProjectId,
      deliveryStatus: "attempted",
    };
  }

  public async attach(context: { readonly projectId: string }, run: RunArtifact, signal?: AbortSignal): Promise<EvidenceReference> {
    const project = this.#projectCredentials.get(context.projectId);
    if (!project) throw new Error("No Earshot project is configured for this Voice Labs project.");
    const reference = this.referenceFor(context, run);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": `voice-labs-${run.id.replaceAll("_", "-")}`,
      "x-earshot-project-id": project.earshotProjectId,
    };
    if (project.apiKey) headers.authorization = `Bearer ${project.apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Earshot request timed out.")), 10_000);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(bundleFor(run)),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await cancelResponseBody(response.body, controller.signal);
        throw new Error(`Earshot returned HTTP ${response.status}.`);
      }
      const result = await readBoundedJson(response, controller.signal) as EarshotIngestResponse | null;
      if (!result || typeof result !== "object"
        || result.bundle_id !== reference.incidentId
        || !isBoundedReferenceText(result.session_id)
        || !isBoundedReferenceText(result.digest)) {
        throw new Error("Earshot returned an incomplete incident reference.");
      }
      return {
        source: "earshot",
        incidentId: result.bundle_id,
        upstreamProjectId: reference.upstreamProjectId,
        sessionId: result.session_id,
        bundleDigest: result.digest,
        endpoint: this.endpoint,
        status: "attached",
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function createEarshotSinkFromEnvironment(): EarshotEvidenceSink | undefined {
  const endpoint = process.env.EARSHOT_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  const mappingsJson = process.env.EARSHOT_PROJECT_MAPPINGS?.trim();
  if (mappingsJson) {
    let projectMappings: Record<string, EarshotProjectCredentials>;
    try {
      projectMappings = JSON.parse(mappingsJson) as Record<string, EarshotProjectCredentials>;
    } catch {
      throw new Error("EARSHOT_PROJECT_MAPPINGS must contain a valid JSON project map.");
    }
    return new EarshotEvidenceSink({ endpoint, projectMappings });
  }
  const localMode = (process.env.VOICE_LABS_AUTH_MODE ?? "jwt") === "local";
  const platformProjectId = process.env.EARSHOT_PLATFORM_PROJECT_ID?.trim()
    ?? (localMode ? process.env.VOICE_LABS_LOCAL_PROJECT_ID?.trim() ?? "local" : undefined);
  const earshotProjectId = process.env.EARSHOT_PROJECT_ID?.trim();
  if (!platformProjectId || !earshotProjectId) {
    throw new Error("Configure EARSHOT_PROJECT_MAPPINGS or both EARSHOT_PLATFORM_PROJECT_ID and EARSHOT_PROJECT_ID.");
  }
  return new EarshotEvidenceSink({
    endpoint,
    projectMappings: { [platformProjectId]: { earshotProjectId, apiKey: process.env.EARSHOT_API_KEY } },
  });
}
