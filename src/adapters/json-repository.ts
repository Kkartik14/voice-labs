import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cloneState, emptyState, type LabRepository } from "./repository.js";
import type { LabState } from "../domain/model.js";

export class JsonFileRepository implements LabRepository {
  private state: LabState | undefined;

  public constructor(private readonly filePath: string) {}

  public async read(): Promise<LabState> {
    if (this.state) return cloneState(this.state);
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as LabState;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") throw error;
      this.state = emptyState();
    }
    return cloneState(this.state);
  }

  public async write(state: LabState): Promise<void> {
    this.state = cloneState(state);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
