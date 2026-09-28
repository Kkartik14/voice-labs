import { compareRuns } from "../domain/compare.js";
import { defaultEvaluators, evaluateRun } from "../domain/evaluate.js";
import { newId, stableSeed } from "../domain/ids.js";
import type { Clock, EvidenceSink, RunExecutor } from "../domain/ports.js";
import type {
  BootstrapPayload,
  Comparison,
  EvaluatorDefinition,
  Experiment,
  ExperimentDetail,
  ExecutionMode,
  LabState,
  RunArtifact,
  RunStatus,
  ScenarioRevision,
  VariantRevision,
} from "../domain/model.js";
import {
  cloneState,
  findExperiment,
  findRun,
  latestScenario,
  latestVariant,
  type LabRepository,
} from "../adapters/repository.js";

const systemClock: Clock = { now: () => new Date() };

function latestScenarios(state: LabState): ScenarioRevision[] {
  return [...new Map(state.scenarios.map((scenario) => [scenario.scenarioId, scenario])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

function latestVariants(state: LabState): VariantRevision[] {
  return [...new Map(state.variants.map((variant) => [variant.variantId, variant])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

function statusFor(artifact: RunArtifact, evaluations: RunArtifact["evaluations"]): RunStatus {
  if (artifact.status === "error") return "error";
  if (artifact.status === "cancelled") return "cancelled";
  if (!evaluations || evaluations.length === 0) return "unknown";
  if (evaluations.some((evaluation) => evaluation.status === "failed")) return "failed";
  if (evaluations.some((evaluation) => evaluation.status === "unknown")) return "unknown";
  return "passed";
}

export interface LabService {
  getBootstrap(): Promise<BootstrapPayload>;
  listScenarios(): Promise<ScenarioRevision[]>;
  listVariants(): Promise<VariantRevision[]>;
  listExperiments(): Promise<Experiment[]>;
  getExperimentDetail(id: string): Promise<ExperimentDetail>;
  exportExperiment(id: string): Promise<ExperimentDetail>;
  getRun(id: string): Promise<RunArtifact>;
  createScenario(input: CreateScenarioInput): Promise<ScenarioRevision>;
  createVariant(input: CreateVariantInput): Promise<VariantRevision>;
  createExperiment(input: CreateExperimentInput): Promise<Experiment>;
  runExperiment(id: string): Promise<ExperimentDetail>;
  promoteScenario(scenarioId: string): Promise<ScenarioRevision>;
}

export interface CreateScenarioInput {
  name: string;
  description: string;
  persona: string;
  goal: string;
  userTurns: string[];
  expectedOutcomeFacts: string[];
  forbiddenPhrases: string[];
  requiredPhrases: string[];
  expectedToolCalls: string[];
  latencyBudgetMs: number;
  tags: string[];
}

export interface CreateVariantInput {
  name: string;
  description: string;
  instructions: string;
  strategy: VariantRevision["strategy"];
  reliability: number;
  toolSuccessRate: number;
  latencyMs: number;
  providerLabel: string;
}

export interface CreateExperimentInput {
  name: string;
  description: string;
  scenarioIds: string[];
  variantIds: string[];
  repetitions: number;
  mode: Experiment["mode"];
  evaluatorIds?: string[];
}

export function createLabService(
  repository: LabRepository,
  executor: RunExecutor,
  options: { clock?: Clock; evidenceSink?: EvidenceSink; executors?: Partial<Record<ExecutionMode, RunExecutor>> } = {},
): LabService {
  const clock = options.clock ?? systemClock;

  async function read(): Promise<LabState> {
    return repository.read();
  }

  async function detailFor(state: LabState, experiment: Experiment, runs?: RunArtifact[]): Promise<ExperimentDetail> {
    const selectedScenarios = experiment.scenarioIds.map((scenarioId) => latestScenario(state, scenarioId)).filter((scenario): scenario is ScenarioRevision => Boolean(scenario));
    const selectedVariants = experiment.variantIds.map((variantId) => latestVariant(state, variantId)).filter((variant): variant is VariantRevision => Boolean(variant));
    const experimentRuns = (runs ?? state.runs).filter((run) => run.experimentId === experiment.id);
    return {
      experiment,
      scenarios: selectedScenarios,
      variants: selectedVariants,
      runs: experimentRuns,
      comparison: compareRuns(experimentRuns, selectedVariants),
    };
  }

  return {
    async getBootstrap() {
      const state = await read();
      return {
        product: "voice-labs",
        scenarios: latestScenarios(state),
        variants: latestVariants(state),
        evaluators: state.evaluators,
        experiments: [...state.experiments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        recentRuns: [...state.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 24),
        regressionScenarioIds: state.regressionSet.map((entry) => entry.scenarioId),
      };
    },

    async listScenarios() {
      return latestScenarios(await read());
    },

    async listVariants() {
      return latestVariants(await read());
    },

    async listExperiments() {
      return (await read()).experiments;
    },

    async getExperimentDetail(id) {
      const state = await read();
      const experiment = findExperiment(state, id);
      if (!experiment) throw new Error(`Experiment not found: ${id}`);
      return detailFor(state, experiment);
    },

    async exportExperiment(id) {
      const state = await read();
      const experiment = findExperiment(state, id);
      if (!experiment) throw new Error(`Experiment not found: ${id}`);
      return detailFor(state, experiment);
    },

    async getRun(id) {
      const run = findRun(await read(), id);
      if (!run) throw new Error(`Run not found: ${id}`);
      return run;
    },

    async createScenario(input) {
      const state = await read();
      const scenarioId = newId("scenario");
      const scenario: ScenarioRevision = {
        id: newId("scenario_revision"),
        scenarioId,
        revision: 1,
        ...input,
        createdAt: clock.now().toISOString(),
      };
      state.scenarios.push(scenario);
      await repository.write(state);
      return scenario;
    },

    async createVariant(input) {
      const state = await read();
      const variantId = newId("variant");
      const variant: VariantRevision = {
        id: newId("variant_revision"),
        variantId,
        revision: 1,
        ...input,
        createdAt: clock.now().toISOString(),
      };
      state.variants.push(variant);
      await repository.write(state);
      return variant;
    },

    async createExperiment(input) {
      const state = await read();
      for (const scenarioId of input.scenarioIds) {
        if (!latestScenario(state, scenarioId)) throw new Error(`Scenario not found: ${scenarioId}`);
      }
      for (const variantId of input.variantIds) {
        if (!latestVariant(state, variantId)) throw new Error(`Variant not found: ${variantId}`);
      }
      const experiment: Experiment = {
        id: newId("experiment"),
        ...input,
        evaluatorIds: input.evaluatorIds ?? state.evaluators.map((evaluator) => evaluator.id),
        createdAt: clock.now().toISOString(),
      };
      state.experiments.push(experiment);
      await repository.write(state);
      return experiment;
    },

    async runExperiment(id) {
      const initialState = await read();
      const experiment = findExperiment(initialState, id);
      if (!experiment) throw new Error(`Experiment not found: ${id}`);
      const evaluators: EvaluatorDefinition[] = experiment.evaluatorIds.length > 0
        ? initialState.evaluators.filter((evaluator) => experiment.evaluatorIds.includes(evaluator.id))
        : defaultEvaluators();
      const selectedExecutor = experiment.mode === "deterministic" ? executor : options.executors?.[experiment.mode];
      if (!selectedExecutor) throw new Error(`Execution mode is not configured locally: ${experiment.mode}`);
      const executedRuns: RunArtifact[] = [];

      for (const scenarioId of experiment.scenarioIds) {
        const scenario = latestScenario(initialState, scenarioId);
        if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`);
        for (const variantId of experiment.variantIds) {
          const variant = latestVariant(initialState, variantId);
          if (!variant) throw new Error(`Variant not found: ${variantId}`);
          for (let repetition = 1; repetition <= experiment.repetitions; repetition += 1) {
            const seed = stableSeed(experiment.id, scenario.id, variant.id, repetition);
            const artifact = await selectedExecutor.execute({
              experimentId: experiment.id,
              scenario,
              variant,
              repetition,
              seed,
              mode: experiment.mode,
            });
            const evaluations = evaluateRun(artifact, scenario, evaluators);
            const evidence = options.evidenceSink ? await options.evidenceSink.attach({ ...artifact, evaluations }) : undefined;
            const completed: RunArtifact = {
              ...artifact,
              status: statusFor(artifact, evaluations),
              evaluations,
              ...(evidence ? { evidence } : {}),
            };
            const nextState = await read();
            nextState.runs.push(completed);
            await repository.write(nextState);
            executedRuns.push(completed);
          }
        }
      }

      const finalState = await read();
      return detailFor(finalState, experiment, executedRuns);
    },

    async promoteScenario(scenarioId) {
      const state = await read();
      const scenario = latestScenario(state, scenarioId);
      if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`);
      state.regressionSet = state.regressionSet.filter((entry) => entry.scenarioId !== scenarioId);
      state.regressionSet.push({ scenarioId, revision: scenario.revision, promotedAt: clock.now().toISOString() });
      await repository.write(state);
      return scenario;
    },
  };
}
