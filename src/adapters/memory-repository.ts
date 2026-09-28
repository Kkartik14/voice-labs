import { cloneState, type LabRepository } from "./repository.js";
import type { LabState } from "../domain/model.js";

export class MemoryRepository implements LabRepository {
  private state: LabState;

  public constructor(initialState: LabState) {
    this.state = cloneState(initialState);
  }

  public async read(): Promise<LabState> {
    return cloneState(this.state);
  }

  public async write(state: LabState): Promise<void> {
    this.state = cloneState(state);
  }
}
