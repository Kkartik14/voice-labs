import "dotenv/config";
import { resolve } from "node:path";
import { JsonFileRepository } from "./adapters/json-repository.js";
import { createSeedState } from "./adapters/seed.js";
import { DeterministicRunner } from "./adapters/deterministic-runner.js";
import { createLabService } from "./application/service.js";
import { createTvicRunnerFromEnvironment, loadTvicEnvironment } from "./adapters/tvic-runner.js";

loadTvicEnvironment(process.env.TVIC_ROOT);
const dataFile = resolve(process.env.VOICE_LABS_DATA_DIR ?? "./data", "voice-labs.json");
const context = {
  userId: process.env.VOICE_LABS_LOCAL_USER_ID ?? "local-development",
  projectId: process.env.VOICE_LABS_LOCAL_PROJECT_ID ?? "local",
};
const repository = new JsonFileRepository(dataFile, context.projectId);
const state = await repository.read(context.projectId);
if (state.scenarios.length === 0 && state.variants.length === 0 && state.experiments.length === 0) {
  const seed = createSeedState(new Date().toISOString(), context.projectId, context.userId);
  for (const scenario of seed.scenarios) await repository.addScenarioRevision(context.projectId, scenario);
  for (const variant of seed.variants) await repository.addVariantRevision(context.projectId, variant);
  for (const experiment of seed.experiments) await repository.addExperimentRevision(context.projectId, experiment);
}
const tvicRunner = createTvicRunnerFromEnvironment();
const service = createLabService(repository, new DeterministicRunner(), {
  ...(tvicRunner ? { executors: { tvic: tvicRunner, audio: tvicRunner } } : {}),
});
const [command, argument] = process.argv.slice(2);

if (command === "status" || !command) {
  const bootstrap = await service.getBootstrap(context);
  console.log(JSON.stringify({ experiments: bootstrap.experiments, recentRuns: bootstrap.recentRuns.length }, null, 2));
} else if (command === "run") {
  const experiment = argument ?? (await service.listExperiments(context))[0]?.experimentId;
  if (!experiment) throw new Error("No experiment exists.");
  const result = await service.runExperiment(context, experiment);
  console.log(JSON.stringify(result.comparison, null, 2));
} else if (command === "promote") {
  if (!argument) throw new Error("Usage: pnpm lab promote <scenario-id>");
  console.log(JSON.stringify(await service.promoteScenario(context, argument), null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
