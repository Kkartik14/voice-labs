import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/feature", { recursive: true });
await copyFile("src/web/styles.feature.css", "dist/feature/styles.css");
