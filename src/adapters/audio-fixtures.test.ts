import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readAudioFixture, validateAudioFixtures } from "./tvic-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "voice-labs-audio-"));
  temporaryDirectories.push(root);
  return root;
}

function validWave(): Buffer {
  const pcm = Buffer.from([0, 0]);
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + pcm.length, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16_000, 24);
  wave.writeUInt32LE(32_000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(pcm.length, 40);
  pcm.copy(wave, 44);
  return wave;
}

async function projectFolder(root: string, projectId: string): Promise<string> {
  const folder = join(root, createHash("sha256").update(projectId).digest("hex"));
  await mkdir(folder, { recursive: true });
  return folder;
}

describe("TVIC audio fixture boundary", () => {
  it("reads only WAV fixtures from the authorized project's directory", async () => {
    const root = await makeRoot();
    const projectFolderA = await projectFolder(root, "project-a");
    await projectFolder(root, "project-b");
    await writeFile(join(projectFolderA, "caller.wav"), validWave());

    expect(Array.from(await readAudioFixture(root, "project-a", "caller.wav"))).toEqual([0, 0]);
    await expect(readAudioFixture(root, "project-b", "caller.wav")).rejects.toThrow();
    await expect(readAudioFixture(root, "project-a", "../caller.wav")).rejects.toThrow("safe relative");
  });

  it("preflights every scenario fixture before accepting an audio run", async () => {
    const root = await makeRoot();
    const projectId = "project-a";
    const folder = await projectFolder(root, projectId);
    await writeFile(join(folder, "caller.wav"), validWave());
    const scenarios = [{
      id: "scenario-revision-1",
      scenarioId: "scenario-1",
      projectId,
      revision: 1,
      name: "Test scenario",
      description: "",
      persona: "Caller",
      goal: "Finish task",
      userTurns: ["Please do this."],
      expectedOutcomeFacts: [],
      forbiddenPhrases: [],
      requiredPhrases: [],
      expectedToolCalls: [],
      latencyBudgetMs: 1_000,
      tags: [],
      audioFixtures: ["caller.wav"],
      createdAt: new Date().toISOString(),
      createdBy: "test",
    }];

    await expect(validateAudioFixtures(root, projectId, scenarios)).resolves.toBeUndefined();
    await expect(validateAudioFixtures(root, projectId, scenarios.map((scenario) => ({ ...scenario, audioFixtures: ["missing.wav"] }))))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects symlink escapes, raw PCM, and oversized fixtures", async () => {
    const root = await makeRoot();
    const projectFolderA = await projectFolder(root, "project-a");
    const outside = join(root, "outside.wav");
    await writeFile(outside, validWave());
    await symlink(outside, join(projectFolderA, "outside.wav"));
    await writeFile(join(projectFolderA, "raw.pcm"), Buffer.from([0, 0]));
    await writeFile(join(projectFolderA, "oversized.wav"), Buffer.alloc(1_048_577));

    await expect(readAudioFixture(root, "project-a", "outside.wav")).rejects.toThrow("resolves outside");
    await expect(readAudioFixture(root, "project-a", "raw.pcm")).rejects.toThrow("WAV files");
    await expect(readAudioFixture(root, "project-a", "oversized.wav")).rejects.toThrow("must not exceed");
  });
});
