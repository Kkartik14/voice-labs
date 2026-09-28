import "dotenv/config";
import { resolve } from "node:path";
import { JsonFileRepository } from "./adapters/json-repository.js";
import { createSeedState } from "./adapters/seed.js";
import { DeterministicRunner } from "./adapters/deterministic-runner.js";
import { createLabService } from "./application/service.js";
import { createTvicRunnerFromEnvironment, loadTvicEnvironment } from "./adapters/tvic-runner.js";

loadTvicEnvironment(process.env.TVIC_ROOT);
const dataFile = resolve(process.env.VOICE_LABS_DATA_DIR ?? "./data", "voice-labs.json");
const repository = new JsonFileRepository(dataFile);
const state = await repository.read();
if (state.scenarios.length === 0 && state.variants.length === 0 && state.experiments.length === 0) {
  await repository.write(createSeedState());
}
const tvicRunner = createTvicRunnerFromEnvironment();
const service = createLabService(repository, new DeterministicRunner(), {
  ...(tvicRunner ? { executors: { tvic: tvicRunner, audio: tvicRunner } } : {}),
});
const [command, argument] = process.argv.slice(2);

if (command === "status" || !command) {
  const bootstrap = await service.getBootstrap();
  console.log(JSON.stringify({ experiments: bootstrap.experiments, recentRuns: bootstrap.recentRuns.length }, null, 2));
} else if (command === "run") {
  const experiment = argument ?? (await service.listExperiments())[0]?.id;
  if (!experiment) throw new Error("No experiment exists.");
  const result = await service.runExperiment(experiment);
  console.log(JSON.stringify(result.comparison, null, 2));
} else if (command === "promote") {
  if (!argument) throw new Error("Usage: pnpm lab promote <scenario-id>");
  console.log(JSON.stringify(await service.promoteScenario(argument), null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
