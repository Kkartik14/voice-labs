import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("dist/feature");
const destination = resolve("packages/feature/dist");

await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
