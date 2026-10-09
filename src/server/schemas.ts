import { z } from "zod";
import { MAX_RUN_CELLS } from "../domain/limits.js";

const nonEmpty = z.string().trim().min(1);
const stringList = z.array(nonEmpty.max(500)).max(100).default([]);
const audioFixturePath = z.string().trim().min(1).max(255).refine((path) =>
  !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path)
  && !path.split(/[\\/]/).includes("..")
  && !path.includes("\0"),
"Audio fixture paths must be safe relative paths inside VOICE_LABS_AUDIO_ROOT.");

export const createScenarioSchema = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(1_000).default(""),
  persona: z.string().trim().max(1_000).default("A caller with a clear goal."),
  goal: nonEmpty.max(500),
  userTurns: z.array(nonEmpty.max(2_000)).min(1).max(20),
  expectedOutcomeFacts: stringList,
  forbiddenPhrases: stringList,
  requiredPhrases: stringList,
  expectedToolCalls: stringList,
  latencyBudgetMs: z.number().int().min(1).max(120_000).default(2_000),
  tags: stringList,
  audioFixtures: z.array(audioFixturePath).max(20).optional(),
});

export const createVariantSchema = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(1_000).default(""),
  instructions: z.string().trim().max(4_000).default("Be helpful and complete the request."),
  strategy: z.enum(["reliable", "concise", "fragile"]).default("reliable"),
  reliability: z.number().min(0).max(1).default(1),
  toolSuccessRate: z.number().min(0).max(1).default(1),
  latencyMs: z.number().int().min(1).max(60_000).default(200),
  providerLabel: z.string().trim().max(120).default("deterministic"),
});

const experimentFields = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(1_000).default(""),
  scenarioIds: z.array(nonEmpty).min(1).max(MAX_RUN_CELLS),
  variantIds: z.array(nonEmpty).min(1).max(MAX_RUN_CELLS),
  repetitions: z.number().int().min(1).max(MAX_RUN_CELLS).default(1),
  mode: z.enum(["deterministic", "tvic", "audio"]).default("deterministic"),
  captureEvidence: z.boolean().default(false),
  evaluatorIds: z.array(nonEmpty.max(120)).max(20).optional(),
});

export const createExperimentSchema = experimentFields.superRefine((experiment, context) => {
  const cells = experiment.scenarioIds.length * experiment.variantIds.length * experiment.repetitions;
  if (cells > MAX_RUN_CELLS) {
    context.addIssue({ code: "custom", message: `An experiment may contain at most ${MAX_RUN_CELLS} run cells.` });
  }
});

export const updateScenarioSchema = createScenarioSchema.partial();
export const updateVariantSchema = createVariantSchema.partial();
export const updateExperimentSchema = experimentFields.partial();
export const runStartSchema = z.object({
  revision_id: nonEmpty.max(200),
});

export type CreateScenarioBody = z.infer<typeof createScenarioSchema>;
export type CreateVariantBody = z.infer<typeof createVariantSchema>;
export type CreateExperimentBody = z.infer<typeof createExperimentSchema>;
export type UpdateScenarioBody = z.infer<typeof updateScenarioSchema>;
export type UpdateVariantBody = z.infer<typeof updateVariantSchema>;
export type UpdateExperimentBody = z.infer<typeof updateExperimentSchema>;
