import type {
  EvaluatorDefinition,
  Experiment,
  ExperimentDetail,
  LabState,
  RegressionEntry,
  RunArtifact,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";

export interface LabRepository {
  read(): Promise<LabState>;
  write(state: LabState): Promise<void>;
}

export function cloneState(state: LabState): LabState {
  return structuredClone(state);
}

export function emptyState(): LabState {
  return { scenarios: [], variants: [], evaluators: [], experiments: [], runs: [], regressionSet: [] };
}

export function latestScenario(state: LabState, scenarioId: string): ScenarioRevision | undefined {
  return state.scenarios.filter((scenario) => scenario.scenarioId === scenarioId).sort((a, b) => b.revision - a.revision)[0];
}

export function latestVariant(state: LabState, variantId: string): VariantRevision | undefined {
  return state.variants.filter((variant) => variant.variantId === variantId).sort((a, b) => b.revision - a.revision)[0];
}

export function findExperiment(state: LabState, id: string): Experiment | undefined {
  return state.experiments.find((experiment) => experiment.id === id);
}

export function findRun(state: LabState, id: string): RunArtifact | undefined {
  return state.runs.find((run) => run.id === id);
}

export function currentEvaluators(state: LabState): EvaluatorDefinition[] {
  return state.evaluators;
}

export type { ExperimentDetail, RegressionEntry };
