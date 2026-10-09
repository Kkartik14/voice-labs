import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createSeedState } from "../adapters/seed.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { MemoryRepository } from "../adapters/memory-repository.js";
import { createLabService } from "../application/service.js";
import { createAuthenticator, createAuthenticatorFromEnvironment } from "./auth.js";
import { createHttpServer } from "./http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function token(
  privateKey: CryptoKey,
  userId: string,
  projectId: string,
  options: { expires?: boolean; scope?: string | null; jti?: string | null; lifetimeSeconds?: number; audience?: string | string[]; issuer?: string } = {},
): Promise<string> {
  const scope = options.scope === undefined ? "voice-labs:read voice-labs:write voice-labs:project:delete" : options.scope;
  const builder = new SignJWT({ project_id: projectId, ...(scope === null ? {} : { scope }) })
    .setProtectedHeader({ alg: "RS256", kid: "platform-test-key" })
    .setSubject(userId)
    .setIssuer(options.issuer ?? "https://platform.test")
    .setAudience(options.audience ?? "voice-labs")
    .setIssuedAt();
  if (options.jti !== null) builder.setJti(options.jti ?? "platform-token-test-id");
  if (options.expires !== false) builder.setExpirationTime(Math.floor(Date.now() / 1_000) + (options.lifetimeSeconds ?? 300));
  return builder.sign(privateKey);
}

describe("Platform project authentication", () => {
  it("requires a signed user/project token and isolates every API read and write", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, { kid: "platform-test-key", alg: "RS256", use: "sig" });
    const jwksServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    servers.push(jwksServer);
    const jwksUrl = `${await listen(jwksServer)}/.well-known/jwks.json`;
    const auth = createAuthenticator({
      mode: "jwt",
      jwksUrl,
      issuer: "https://platform.test",
      audience: "voice-labs",
      allowedOrigins: "https://platform.test",
    });
    expect(() => createAuthenticator({
      mode: "jwt",
      jwksUrl: "http://platform.test/.well-known/jwks.json",
      issuer: "https://platform.test",
      audience: "voice-labs",
    })).toThrow("must use HTTPS");
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z", "project-a", "user-a"), "project-a");
    const service = createLabService(repository, new DeterministicRunner());
    const apiServer = createHttpServer(service, { auth });
    servers.push(apiServer);
    const baseUrl = await listen(apiServer);
    const userAToken = await token(privateKey, "user-a", "project-a");
    const userBToken = await token(privateKey, "user-b", "project-b");
    const noExpiryToken = await token(privateKey, "user-a", "project-a", { expires: false });
    const noScopeToken = await token(privateKey, "user-a", "project-a", { scope: null });
    const noJtiToken = await token(privateKey, "user-a", "project-a", { jti: null });
    const overlongToken = await token(privateKey, "user-a", "project-a", { lifetimeSeconds: 301 });
    const wrongAudienceToken = await token(privateKey, "user-a", "project-a", { audience: "earshot" });
    const multiAudienceToken = await token(privateKey, "user-a", "project-a", { audience: ["voice-labs", "earshot"] });
    const readOnlyToken = await token(privateKey, "user-a", "project-a", { scope: "voice-labs:read" });
    const writeOnlyToken = await token(privateKey, "user-a", "project-a", { scope: "voice-labs:write" });

    expect((await fetch(`${baseUrl}/api/bootstrap`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${noExpiryToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${noScopeToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${noJtiToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${overlongToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${wrongAudienceToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${multiAudienceToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${writeOnlyToken}` } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/scenarios`, {
      method: "POST",
      headers: { authorization: `Bearer ${readOnlyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Forbidden write", goal: "No access", userTurns: ["Help me."], expectedOutcomeFacts: [] }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/projects/project-a/purge`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${writeOnlyToken}` },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${userAToken}`, "x-platform-project-id": "project-b" } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { origin: "https://attacker.test", authorization: `Bearer ${userAToken}` } })).status).toBe(403);

    const bootstrapA = await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${userAToken}` } });
    const bootstrapB = await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${userBToken}` } });
    expect(bootstrapA.status).toBe(200);
    expect(bootstrapB.status).toBe(200);
    expect((await bootstrapA.json() as { scenarios: unknown[] }).scenarios).toHaveLength(1);
    expect((await bootstrapB.json() as { scenarios: unknown[] }).scenarios).toHaveLength(0);

    const summaryA = await fetch(`${baseUrl}/v1/platform/projects/project-a/lab/summary`, {
      headers: { authorization: `Bearer ${userAToken}`, "x-platform-project-id": "project-a" },
    });
    expect(summaryA.status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/platform/projects/project-b/lab/summary`, {
      headers: { authorization: `Bearer ${userAToken}`, "x-platform-project-id": "project-a" },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/v1/platform/projects/project-a/lab/summary`, {
      headers: { authorization: `Bearer ${userAToken}` },
    })).status).toBe(403);

    const createB = await fetch(`${baseUrl}/api/scenarios`, {
      method: "POST",
      headers: { authorization: `Bearer ${userBToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Project B case", goal: "Resolve request", userTurns: ["Please help."], expectedOutcomeFacts: [] }),
    });
    expect(createB.status).toBe(201);
    expect((await createB.json() as { projectId: string; createdBy: string }).projectId).toBe("project-b");
    expect((await fetch(`${baseUrl}/api/experiments/experiment_reschedule_baseline`, { headers: { authorization: `Bearer ${userBToken}` } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { authorization: `Bearer ${userAToken}` } }).then((response) => response.json()) as { scenarios: unknown[] }).scenarios).toHaveLength(1);
  });

  it("refuses local authentication in production even when the bind address is loopback", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorAuthMode = process.env.VOICE_LABS_AUTH_MODE;
    process.env.NODE_ENV = "production";
    process.env.VOICE_LABS_AUTH_MODE = "local";
    try {
      expect(() => createAuthenticatorFromEnvironment("127.0.0.1")).toThrow("disabled in production");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorAuthMode === undefined) delete process.env.VOICE_LABS_AUTH_MODE;
      else process.env.VOICE_LABS_AUTH_MODE = priorAuthMode;
    }
  });

  it("defaults to JWT on loopback unless local development auth is explicitly selected", () => {
    const names = ["NODE_ENV", "VOICE_LABS_AUTH_MODE", "VOICE_LABS_AUTH_JWKS_URL", "VOICE_LABS_AUTH_ISSUER", "VOICE_LABS_AUTH_AUDIENCE"];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    delete process.env.NODE_ENV;
    delete process.env.VOICE_LABS_AUTH_MODE;
    process.env.VOICE_LABS_AUTH_JWKS_URL = "http://127.0.0.1:9999/jwks.json";
    process.env.VOICE_LABS_AUTH_ISSUER = "https://platform.test";
    process.env.VOICE_LABS_AUTH_AUDIENCE = "voice-labs";
    try {
      expect(createAuthenticatorFromEnvironment("127.0.0.1").mode).toBe("jwt");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
