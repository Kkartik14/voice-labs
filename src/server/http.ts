import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { LabService } from "../application/service.js";
import { createExperimentSchema, createScenarioSchema, createVariantSchema } from "./schemas.js";

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
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : "Unexpected error";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes(" not found:");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
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
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(candidate).pipe(response);
  }
  return true;
}

export function createHttpServer(service: LabService, options: { staticDir?: string } = {}): Server {
  return createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      if (options.staticDir && await serveStatic(request, response, options.staticDir)) return;
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, product: "voice-labs", mode: "local-first" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(response, 200, await service.getBootstrap());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/scenarios") {
        sendJson(response, 200, await service.listScenarios());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/variants") {
        sendJson(response, 200, await service.listVariants());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/experiments") {
        sendJson(response, 200, await service.listExperiments());
        return;
      }
      const experimentMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)$/);
      if (request.method === "GET" && experimentMatch) {
        sendJson(response, 200, await service.getExperimentDetail(experimentMatch[1]));
        return;
      }
      const experimentExportMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/export$/);
      if (request.method === "GET" && experimentExportMatch) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("content-disposition", `attachment; filename="voice-labs-${experimentExportMatch[1]}.json"`);
        response.end(JSON.stringify(await service.exportExperiment(experimentExportMatch[1]), null, 2));
        return;
      }
      const experimentRunMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/run$/);
      if (request.method === "POST" && experimentRunMatch) {
        await readJson(request);
        sendJson(response, 200, await service.runExperiment(experimentRunMatch[1]));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        sendJson(response, 200, await service.getRun(runMatch[1]));
        return;
      }
      const promoteMatch = url.pathname.match(/^\/api\/scenarios\/([^/]+)\/promote$/);
      if (request.method === "POST" && promoteMatch) {
        sendJson(response, 200, await service.promoteScenario(promoteMatch[1]));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/scenarios") {
        const input = createScenarioSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createScenario(input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/variants") {
        const input = createVariantSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createVariant(input));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/experiments") {
        const input = createExperimentSchema.parse(await readJson(request));
        sendJson(response, 201, await service.createExperiment(input));
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof ZodError || !isNotFound(error) ? 400 : 404;
      sendJson(response, status, { error: errorMessage(error) });
    }
  });
}
