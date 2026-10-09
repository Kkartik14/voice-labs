import type {
  EarshotIncidentReference,
  EvidenceReference,
  ExecutionMode,
  ProjectContext,
  RunArtifact,
  ScenarioRevision,
  VariantRevision,
} from "./model.js";

export interface Clock {
  now(): Date;
}

export interface RunRequest {
  context: ProjectContext;
  experimentId: string;
  experimentRevisionId: string;
  scenario: ScenarioRevision;
  variant: VariantRevision;
  repetition: number;
  seed: number;
  mode: ExecutionMode;
}

export interface RunExecutor {
  preflight?(mode: ExecutionMode, scenarios?: readonly ScenarioRevision[], signal?: AbortSignal): Promise<unknown> | unknown;
  execute(request: RunRequest, preparation?: unknown, signal?: AbortSignal): Promise<RunArtifact>;
}

export interface EvidenceSink {
  readonly endpoint: string;
  referenceFor?(context: Pick<ProjectContext, "projectId">, run: RunArtifact): EarshotIncidentReference;
  attach(context: Pick<ProjectContext, "projectId">, run: RunArtifact, signal?: AbortSignal): Promise<EvidenceReference>;
}
