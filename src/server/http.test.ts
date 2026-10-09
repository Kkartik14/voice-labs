import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHttpServer } from "./http.js";
import { createLabService } from "../application/service.js";
import { MemoryRepository } from "../adapters/memory-repository.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createSeedState } from "../adapters/seed.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

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

    const viteOrigin = await fetch(`${baseUrl}/api/bootstrap`, { headers: { origin: "http://127.0.0.1:4321" } });
    expect(viteOrigin.status).toBe(200);
    expect(viteOrigin.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4321");
    expect((await fetch(`${baseUrl}/api/bootstrap`, { headers: { origin: "http://127.0.0.1:5173" } })).status).toBe(403);

    const scenario = await fetch(`${baseUrl}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New case", goal: "Resolve the caller request", userTurns: ["Please help me."], expectedOutcomeFacts: ["request.resolved"] }),
    });
    expect(scenario.status).toBe(201);
    const createdScenario = await scenario.json() as { id: string; scenarioId: string };
    const promoted = await fetch(`${baseUrl}/api/scenarios/${createdScenario.scenarioId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision_id: createdScenario.id }),
    });
    expect(promoted.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json()) as { regressionScenarioRevisions: unknown[] }).regressionScenarioRevisions).toContainEqual({ scenarioId: createdScenario.scenarioId, revision: 1 });
    expect((await fetch(`${baseUrl}/api/scenarios/${createdScenario.scenarioId}/promote`, { method: "DELETE" })).status).toBe(204);
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
    const payload = (await bootstrap.json()) as { experiments: Array<{ id: string; experimentId: string }> };
    expect(payload.experiments).toHaveLength(1);

    const runResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision_id: payload.experiments[0].id }),
    });
    expect(runResponse.status).toBe(400);

    const startHeaders = { "content-type": "application/json", "idempotency-key": "http-run-start-001" };
    const acceptedResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run`, {
      method: "POST",
      headers: startHeaders,
      body: JSON.stringify({ revision_id: payload.experiments[0].id }),
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = (await acceptedResponse.json()) as { runIds: string[]; status: string };
    const retryResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run`, {
      method: "POST",
      headers: startHeaders,
      body: JSON.stringify({ revision_id: payload.experiments[0].id }),
    });
    expect(retryResponse.status).toBe(202);
    expect(await retryResponse.json()).toEqual(accepted);
    expect(accepted.runIds).toHaveLength(4);
    expect(accepted.status).toBe("queued");
    let runPayload: { experiment: { id: string; revision: number }; runs: Array<{ id: string }>; comparison: { rows: unknown[]; totalRunning: number } } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}`);
      runPayload = await detail.json() as typeof runPayload;
      if (runPayload?.comparison.totalRunning === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runPayload?.runs).toHaveLength(4);
    expect(runPayload?.comparison.rows).toHaveLength(2);
    expect(runPayload?.comparison.totalRunning).toBe(0);

    const originalRevisionId = runPayload!.experiment.id;
    const experimentStatuses = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run-status?revision_id=${encodeURIComponent(originalRevisionId)}&run_id=${encodeURIComponent(runPayload!.runs[0].id)}`);
    expect(experimentStatuses.status).toBe(200);
    expect(await experimentStatuses.json()).toEqual({
      runs: runPayload!.runs.map(({ id }) => ({ id, status: expect.any(String) })),
      missingRunIds: [],
    });
    const missingRunResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run-status?revision_id=${encodeURIComponent(originalRevisionId)}&run_id=missing-run`);
    expect(await missingRunResponse.json()).toMatchObject({ missingRunIds: ["missing-run"] });
    expect((await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/run-status`)).status).toBe(400);
    await service.updateExperiment({ userId: "local-development", projectId: "local" }, payload.experiments[0].experimentId, { name: "Edited experiment" });
    const historicalDetail = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}?revision_id=${encodeURIComponent(originalRevisionId)}`);
    expect(historicalDetail.status).toBe(200);
    expect(await historicalDetail.json()).toMatchObject({ experiment: { id: originalRevisionId, revision: 1 }, runs: expect.any(Array) });

    const runId = runPayload!.runs[0].id;
    const fullRunResponse = await fetch(`${baseUrl}/api/runs/${runId}`);
    expect(fullRunResponse.status).toBe(200);
    const fullRun = await fullRunResponse.json() as { id: string; status?: string };
    const runStatusResponse = await fetch(`${baseUrl}/api/runs/${runId}/status`);
    expect(runStatusResponse.status).toBe(200);
    const runStatus = await runStatusResponse.json() as { id: string; status?: string };
    expect(runStatus).toMatchObject({ id: runId, status: fullRun.status });
    expect(runStatus).not.toHaveProperty("transcript");
    expect(runStatus).not.toHaveProperty("toolCalls");
    const deleteResponse = await fetch(`${baseUrl}/api/runs/${runId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/runs/${runId}`)).status).toBe(404);

    const exportResponse = await fetch(`${baseUrl}/api/experiments/${payload.experiments[0].experimentId}/export?revision_id=${encodeURIComponent(originalRevisionId)}`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-disposition")).toContain("attachment");
  });

  it("serves the bounded Platform summary only to the project-scoped service caller", async () => {
    const service = createLabService(new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z")), new DeterministicRunner());
    const server = createHttpServer(service, { serviceToken: "service-secret-for-test" });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: "Bearer service-secret-for-test", "x-platform-project-id": "local" };
    const experiment = (await service.listExperiments({ userId: "local-development", projectId: "local" }))[0];
    await service.runExperiment({ userId: "local-development", projectId: "local" }, experiment.experimentId);

    const response = await fetch(`${baseUrl}/v1/platform/projects/local/lab/summary`, { headers });
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<{ id: string; href: string }>; summary: string };
    expect(payload.items).toHaveLength(4);
    expect(payload.items[0].href).toMatch(/^\/lab\?runId=run_/);
    expect(payload.summary).toContain("Voice Labs runs");
    expect((await fetch(`${baseUrl}/v1/platform/projects/other/lab/summary`, { headers })).status).toBe(403);
    expect((await fetch(`${baseUrl}/v1/platform/projects/local/lab/summary`, { headers: { ...headers, authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/platform/projects/other/lab/summary`, { headers: { ...headers, "x-platform-project-id": "local" } })).status).toBe(403);
  });

  it("returns an idempotent Voice Labs purge receipt without claiming Earshot deletion", async () => {
    const repository = new MemoryRepository(createSeedState("2026-01-01T00:00:00.000Z"));
    await repository.recordEarshotReference("local", {
      incidentId: "voice-labs-run-456",
      endpoint: "http://127.0.0.1:4319/v1/incidents",
      deliveryStatus: "attached",
      upstreamProjectId: "earshot-local",
    });
    const service = createLabService(repository, new DeterministicRunner());
    const server = createHttpServer(service);
    servers.push(server);
    const baseUrl = await listen(server);

    const first = await fetch(`${baseUrl}/api/projects/local/purge`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(receipt).toMatchObject({
      projectId: "local",
      status: "local_data_deleted",
      linkedEarshotIncidents: [{ incidentId: "voice-labs-run-456", deliveryStatus: "attached", upstreamProjectId: "earshot-local" }],
    });
    const retry = await fetch(`${baseUrl}/api/projects/local/purge`, { method: "DELETE" });
    expect(await retry.json()).toEqual(receipt);
    expect((await fetch(`${baseUrl}/api/projects/another-project/purge`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/bootstrap`)).status).toBe(410);
  });
});
