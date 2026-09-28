import type { ExecutionMode, RunArtifact, ScenarioRevision, VariantRevision } from "./model.js";

export interface Clock {
  now(): Date;
}

export interface RunRequest {
  experimentId: string;
  scenario: ScenarioRevision;
  variant: VariantRevision;
  repetition: number;
  seed: number;
  mode: ExecutionMode;
}

export interface RunExecutor {
  execute(request: RunRequest): Promise<RunArtifact>;
}

export interface EvidenceSink {
  attach(run: RunArtifact): Promise<RunArtifact["evidence"]>;
}
