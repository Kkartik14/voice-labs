import { createReadStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { LabService } from "../application/service.js";
import { createAuthenticator, AuthenticationError, type Authenticator } from "./auth.js";
import { createExperimentSchema, createScenarioSchema, createVariantSchema, runStartSchema, updateExperimentSchema, updateScenarioSchema, updateVariantSchema } from "./schemas.js";

const maxBodyBytes = 1_000_000;

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : "Unexpected error";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && / not found:/i.test(error.message);
}

function matchesServiceToken(header: string | undefined, configuredToken: string): boolean {
  const [scheme, token, extra] = (header ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || extra) return false;
  const suppliedDigest = createHash("sha256").update(token).digest();
  const configuredDigest = createHash("sha256").update(configuredToken).digest();
  return timingSafeEqual(suppliedDigest, configuredDigest);
}

function requiredScope(method: string | undefined, pathname: string): string {
  if (method === "DELETE" && /^\/api\/projects\/[^/]+\/purge$/.test(pathname)) return "voice-labs:project:delete";
  return method === "GET" ? "voice-labs:read" : "voice-labs:write";
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, staticDir: string): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(staticDir, requested));
  const root = normalize(staticDir);
  if (relative(root, filePath).startsWith("..")) return false;
  let candidate = filePath;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
  } catch {
    candidate = join(staticDir, "index.html");
    try {
      await stat(candidate);
    } catch {
      return false;
    }
  }
  response.statusCode = 200;
  response.setHeader("content-type", mimeTypes[extname(candidate)] ?? "application/octet-stream");
  if (request.method === "HEAD") response.end();
  else createReadStream(candidate).pipe(response);
  return true;
}

export function createHttpServer(service: LabService, options: { auth?: Authenticator; staticDir?: string; serviceToken?: string } = {}): Server {
  const auth = options.auth ?? createAuthenticator({ mode: "local" });
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin) {
      if (!auth.allowedOrigins.has(origin)) {
        sendJson(response, 403, { error: "Origin is not allowed." });
        return;
      }
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-platform-project-id, idempotency-key");
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const platformSummaryMatch = url.pathname.match(/^\/v1\/platform\/projects\/([^/]+)\/lab\/summary$/);
    if (!url.pathname.startsWith("/api/") && !platformSummaryMatch) {
      if (options.staticDir && await serveStatic(request, response, options.staticDir)) return;
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, product: "voice-labs" });
      return;
    }

    try {
      if (request.method === "GET" && platformSummaryMatch) {
        const configuredToken = options.serviceToken?.trim();
        if (auth.mode === "local" && !configuredToken) {
          sendJson(response, 503, { error: "Voice Labs local summary authentication is not configured." });
          return;
        }
        if (auth.mode === "local" && !matchesServiceToken(request.headers.authorization, configuredToken!)) {
          sendJson(response, 401, { error: "A valid local service token is required." });
          return;
        }
        const identity = await auth.authenticate(request);
        if (!identity.scopes.has("voice-labs:read")) {
          sendJson(response, 403, { error: "The Platform token does not allow Voice Labs reads." });
          return;
        }
        const context = identity.context;
        let projectId: string;
        try {
          projectId = decodeURIComponent(platformSummaryMatch[1]);
        } catch {
          sendJson(response, 400, { error: "The project identifier is malformed." });
          return;
        }
        const assertedProject = request.headers["x-platform-project-id"];
        if (!projectId || projectId.length > 200 || projectId.includes("/") || projectId.includes("\\") ||
          typeof assertedProject !== "string" || assertedProject !== projectId || context.projectId !== projectId) {
          sendJson(response, 403, { error: "The requested project does not match the Platform project header." });
          return;
        }
        const recordId = url.searchParams.get("record_id") ?? undefined;
        if (recordId !== undefined && (!recordId.trim() || recordId.length > 200 || /[\u0000-\u001f]/.test(recordId))) {
          sendJson(response, 400, { error: "record_id must be a non-empty identifier of at most 200 characters." });
          return;
        }
        sendJson(response, 200, await service.getPlatformSummary(context, recordId));
        return;
      }
      const identity = await auth.authenticate(request);
      const scope = requiredScope(request.method, url.pathname);
      if (!identity.scopes.has(scope)) {
        sendJson(response, 403, { error: "The Platform token does not allow this Voice Labs operation." });
        return;
      }
      const context = identity.context;
      const projectPurgeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/purge$/);
      if (request.method === "DELETE" && projectPurgeMatch) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(projectPurgeMatch[1]);
        } catch {
          sendJson(response, 400, { error: "The project identifier is malformed." });
          return;
        }
        if (projectId !== context.projectId) {
          sendJson(response, 403, { error: "The requested project does not match the Platform token." });
          return;
        }
        sendJson(response, 200, await service.purgeProject(context));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(response, 200, await service.getBootstrap(context));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/scenarios") {
        sendJson(response, 200, await service.listScenarios(context));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/variants") {
        sendJson(response, 200, await service.listVariants(context));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/experiments") {
        sendJson(response, 200, await service.listExperiments(context));
        return;
      }
      const experimentRunsMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/runs$/);
      if (request.method === "GET" && experimentRunsMatch) {
        const beforeStartedAt = url.searchParams.get("before_started_at");
        const beforeId = url.searchParams.get("before_id");
        const revisionId = url.searchParams.get("revision_id");
        if ((beforeStartedAt === null) !== (beforeId === null) || (beforeStartedAt !== null && !revisionId?.trim())) {
          sendJson(response, 400, { error: "Run pagination requires both cursor fields and the pinned revision_id." });
          return;
        }
        if (beforeStartedAt !== null && (!Number.isFinite(Date.parse(beforeStartedAt)) || beforeStartedAt.length > 40 || !beforeId?.trim() || beforeId.length > 200 || !revisionId || revisionId.length > 200)) {
          sendJson(response, 400, { error: "The run page cursor is invalid." });
          return;
        }
        sendJson(response, 200, await service.getExperimentRuns(
          context,
          decodeURIComponent(experimentRunsMatch[1]),
          beforeStartedAt !== null && beforeId !== null ? { startedAt: beforeStartedAt, id: beforeId } : undefined,
          revisionId ?? undefined,
        ));
        return;
      }
      const experimentRunStatusMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/run-status$/);
      if (request.method === "GET" && experimentRunStatusMatch) {
        const revisionId = url.searchParams.get("revision_id");
        if (!revisionId?.trim() || revisionId.length > 200) {
          sendJson(response, 400, { error: "Experiment run status requires a valid revision_id." });
          return;
        }
        sendJson(response, 200, await service.getExperimentRunProgress(
          context,
          decodeURIComponent(experimentRunStatusMatch[1]),
          revisionId,
          url.searchParams.getAll("run_id"),
        ));
        return;
      }
      const experimentExportMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/export$/);
      if (request.method === "GET" && experimentExportMatch) {
        const detail = await service.exportExperiment(
          context,
          decodeURIComponent(experimentExportMatch[1]),
          url.searchParams.get("revision_id") ?? undefined,
        );
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-disposition", `attachment; filename="voice-labs-${detail.experiment.experimentId}.json"`);
        response.end(JSON.stringify(detail, null, 2));
        return;
      }
      const experimentRunMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/run$/);
      if (request.method === "POST" && experimentRunMatch) {
        const input = runStartSchema.parse(await readJson(request));
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !/^[!#-~]{1,200}$/.test(idempotencyKey)) {
          throw Object.assign(new Error("Idempotency-Key must contain 1 to 200 visible ASCII characters."), { statusCode: 400 });
        }
        sendJson(response, 202, await service.startExperiment(context, decodeURIComponent(experimentRunMatch[1]), {
          idempotencyKey,
          revisionId: input.revision_id,
        }));
        return;
      }
      const experimentMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)$/);
      if (request.method === "GET" && experimentMatch) {
        sendJson(response, 200, await service.getExperimentDetail(
          context,
          decodeURIComponent(experimentMatch[1]),
          url.searchParams.get("revision_id") ?? undefined,
        ));
        return;
      }
      if (request.method === "PUT" && experimentMatch) {
        const input = updateExperimentSchema.parse(await readJson(request));
        sendJson(response, 201, await service.updateExperiment(context, decodeURIComponent(experimentMatch[1]), input));
        return;
      }
      const runStatusMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/status$/);
      if (request.method === "GET" && runStatusMatch) {
        sendJson(response, 200, await service.getRunStatus(context, decodeURIComponent(runStatusMatch[1])));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        sendJson(response, 200, await service.getRun(context, decodeURIComponent(runMatch[1])));
        return;
      }
      if (request.method === "DELETE" && runMatch) {
        await service.deleteRun(context, decodeURIComponent(runMatch[1]));
        response.statusCode = 204;
        response.end();
        return;
      }
      const scenarioPromoteMatch = url.pathname.match(/^\/api\/scenarios\/([^/]+)\/promote$/);
      if (request.method === "POST" && scenarioPromoteMatch) {
        const body = await readJson(request);
        const revisionId = body && typeof body === "object" && "revision_id" in body
          ? (body as { revision_id?: unknown }).revision_id
          : undefined;
        if (revisionId !== undefined && (typeof revisionId !== "string" || !revisionId.trim() || revisionId.length > 200)) {
          sendJson(response, 400, { error: "revision_id must be a non-empty scenario revision identifier." });
          return;
        }
        sendJson(response, 200, await service.promoteScenario(context, decodeURIComponent(scenarioPromoteMatch[1]), revisionId as string | undefined));
        return;
      }
      if (request.method === "DELETE" && scenarioPromoteMatch) {
        await service.removePromotedScenario(context, decodeURIComponent(scenarioPromoteMatch[1]));
        response.statusCode = 204;
        response.end();
        return;
      }
      const scenarioMatch = url.pathname.match(/^\/api\/scenarios\/([^/]+)$/);
      if (request.method === "PUT" && scenarioMatch) {
        const input = updateScenarioSchema.parse(await readJson(request));
        sendJson(response, 201, await service.updateScenario(context, decodeURIComponent(scenarioMatch[1]), input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/scenarios") {
        const input = createScenarioSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createScenario(context, input));
        return;
      }
      const variantMatch = url.pathname.match(/^\/api\/variants\/([^/]+)$/);
      if (request.method === "PUT" && variantMatch) {
        const input = updateVariantSchema.parse(await readJson(request));
        sendJson(response, 201, await service.updateVariant(context, decodeURIComponent(variantMatch[1]), input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/variants") {
        const input = createVariantSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createVariant(context, input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/experiments") {
        const input = createExperimentSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createExperiment(context, input));
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | null)?.statusCode;
      const status = error instanceof AuthenticationError ? 401 : statusCode ?? (error instanceof ZodError ? 400 : isNotFound(error) ? 404 : 500);
      sendJson(response, status, { error: status >= 500 && status !== 503 ? "Internal server error" : errorMessage(error) });
    }
  });
}
