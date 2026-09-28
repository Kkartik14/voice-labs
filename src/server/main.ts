import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLabService } from "../application/service.js";
import { JsonFileRepository } from "../adapters/json-repository.js";
import { createSeedState } from "../adapters/seed.js";
import { DeterministicRunner } from "../adapters/deterministic-runner.js";
import { createTvicRunnerFromEnvironment, loadTvicEnvironment } from "../adapters/tvic-runner.js";
import { createHttpServer } from "./http.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataDir = resolve(process.env.VOICE_LABS_DATA_DIR ?? resolve(projectRoot, "data"));
const dataFile = resolve(dataDir, "voice-labs.json");
const port = Number(process.env.VOICE_LABS_PORT ?? 4320);
const host = process.env.VOICE_LABS_HOST ?? "127.0.0.1";
loadTvicEnvironment(process.env.TVIC_ROOT);
const repository = new JsonFileRepository(dataFile);

const existing = await repository.read();
if (existing.scenarios.length === 0 && existing.variants.length === 0 && existing.experiments.length === 0) {
  await repository.write(createSeedState());
}

const tvicRunner = createTvicRunnerFromEnvironment();
if (tvicRunner) {
  console.log("TVIC provider executor enabled (credentials remain process-local).");
} else {
  console.log("TVIC provider executor disabled; deterministic mode remains available.");
}
const service = createLabService(repository, new DeterministicRunner(), {
  ...(tvicRunner ? { executors: { tvic: tvicRunner, audio: tvicRunner } } : {}),
});
const server = createHttpServer(service, { staticDir: resolve(projectRoot, "dist/web") });
server.listen(port, host, () => {
  console.log(`Voice Labs listening at http://${host}:${port}`);
  console.log(`Data file: ${dataFile}`);
});

function shutdown(signal: string): void {
  server.close((error) => {
    if (error) {
      console.error(`${signal}: failed to close server`, error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
