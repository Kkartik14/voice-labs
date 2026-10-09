import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLabService } from "../application/service.js";
import { DeterministicRunner } from "./deterministic-runner.js";
import { JsonFileRepository } from "./json-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { createSeedState } from "./seed.js";

describe("JsonFileRepository Earshot references", () => {
  it("upgrades references from legacy runs and retains multiple destinations after deletion", async () => {
    const projectId = "local";
    const incidentId = "legacy-earshot-incident";
    const endpoints = [
      "https://earshot-old.example/v1/incidents",
      "https://earshot-current.example/v1/incidents",
    ];
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId);
    const memoryRepository = new MemoryRepository(seed, projectId);
    const service = createLabService(memoryRepository, new DeterministicRunner());
    const experiment = (await service.listExperiments({ userId: "local-development", projectId }))[0];
    const run = (await service.runExperiment({ userId: "local-development", projectId }, experiment.experimentId)).runs[0];
    const legacyState = {
      ...seed,
      runs: [{
        ...run,
        evidence: {
          source: "earshot" as const,
          incidentId,
          endpoint: endpoints[0],
          status: "attached" as const,
        },
      }],
      earshotReferences: [],
    };
    const directory = await mkdtemp(join(tmpdir(), "voice-labs-json-earshot-"));

    try {
      const filePath = join(directory, "lab-state.json");
      await writeFile(filePath, `${JSON.stringify(legacyState)}\n`, { mode: 0o600 });
      const repository = new JsonFileRepository(filePath, projectId);

      expect(await repository.deleteRun(projectId, run.id)).toBe(true);
      await repository.recordEarshotReference(projectId, {
        incidentId,
        endpoint: endpoints[1],
        deliveryStatus: "attempted",
      });

      const receipt = await repository.purgeProject(projectId, "2026-01-02T00:00:00.000Z");
      expect(receipt.linkedEarshotIncidents).toHaveLength(2);
      expect(receipt.linkedEarshotIncidents.map((reference) => reference.endpoint).sort()).toEqual([...endpoints].sort());
      await expect(repository.isProjectPurged(projectId)).resolves.toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses cached project state for run and purge status without cloning a full read", async () => {
    const projectId = "local";
    const seed = createSeedState("2026-01-01T00:00:00.000Z", projectId);
    const memoryRepository = new MemoryRepository(seed, projectId);
    const service = createLabService(memoryRepository, new DeterministicRunner());
    const experiment = (await service.listExperiments({ userId: "local-development", projectId }))[0];
    await service.runExperiment({ userId: "local-development", projectId }, experiment.experimentId);
    const directory = await mkdtemp(join(tmpdir(), "voice-labs-json-run-lookup-"));

    try {
      const filePath = join(directory, "lab-state.json");
      await writeFile(filePath, `${JSON.stringify(await memoryRepository.read(projectId))}\n`, { mode: 0o600 });
      const repository = new JsonFileRepository(filePath, projectId);
      await repository.read(projectId);
      const fullRead = vi.spyOn(repository, "read");
      const runId = (await memoryRepository.listRuns(projectId))[0].id;

      const lookup = await repository.getRunWithProjectStatus(projectId, runId);
      expect(lookup.run?.id).toBe(runId);
      expect(lookup.projectPurged).toBe(false);
      await expect(repository.isProjectPurged(projectId)).resolves.toBe(false);
      await expect(repository.getProjectPurgeReceipt(projectId)).resolves.toBeNull();
      await expect(repository.getExperimentRunProgressWithProjectStatus(
        projectId,
        seed.experiments[0].experimentId,
        seed.experiments[0].id,
        1,
      )).resolves.toMatchObject({
        experimentFound: true,
        runs: [{ id: runId }],
        projectPurged: false,
      });
      expect(fullRead).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
