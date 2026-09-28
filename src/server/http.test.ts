import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHttpServer } from "./http.js";
import { createLabService } from "../application/service.js";
import { MemoryRepository } from "../adapters/memory-repository.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createSeedState } from "../adapters/seed.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Voice Labs HTTP API", () => {
  it("creates scenario and variant resources through validated JSON endpoints", async () => {
    const service = createLabService(new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z")), new DeterministicRunner());
    const server = createHttpServer(service);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const scenario = await fetch(`${baseUrl}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New case", goal: "Resolve the caller request", userTurns: ["Please help me."], expectedOutcomeFacts: ["request.resolved"] }),
    });
    expect(scenario.status).toBe(201);
    const variant = await fetch(`${baseUrl}/api/variants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New candidate" }),
    });
    expect(variant.status).toBe(201);
  });

  it("returns the bootstrap projection and runs an experiment end to end", async () => {
    const service = createLabService(
      new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z")),
      new DeterministicRunner({ now: () => new Date("2026-01-01T00:00:00.000Z") }),
    );
    const server = createHttpServer(service);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
    expect(bootstrap.status).toBe(200);
    const payload = (await bootstrap.json()) as { experiments: Array<{ id: string }> };
    expect(payload.experiments).toHaveLength(1);

    const runResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(200);
    const runPayload = (await runResponse.json()) as { runs: unknown[]; comparison: { rows: unknown[] } };
    expect(runPayload.runs).toHaveLength(4);
    expect(runPayload.comparison.rows).toHaveLength(2);

    const exportResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].id}/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-disposition")).toContain("attachment");
  });
});
