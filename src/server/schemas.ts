import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const stringList = z.array(nonEmpty).max(100).default([]);

export const createScenarioSchema = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(1_000).default(""),
  persona: z.string().trim().max(1_000).default("A caller with a clear goal."),
  goal: nonEmpty.max(500),
  userTurns: z.array(nonEmpty.max(2_000)).min(1).max(100),
  expectedOutcomeFacts: stringList,
  forbiddenPhrases: stringList,
  requiredPhrases: stringList,
  expectedToolCalls: stringList,
  latencyBudgetMs: z.number().int().min(1).max(120_000).default(2_000),
  tags: stringList,
  audioFixtures: z.array(nonEmpty.max(1_000)).max(100).optional(),
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

export const createExperimentSchema = z.object({
  name: nonEmpty.max(120),
  description: z.string().trim().max(1_000).default(""),
  scenarioIds: z.array(nonEmpty).min(1).max(100),
  variantIds: z.array(nonEmpty).min(1).max(100),
  repetitions: z.number().int().min(1).max(100).default(1),
  mode: z.enum(["deterministic", "tvic", "audio"]).default("deterministic"),
  evaluatorIds: z.array(nonEmpty).max(20).optional(),
});

export type CreateScenarioBody = z.infer<typeof createScenarioSchema>;
export type CreateVariantBody = z.infer<typeof createVariantSchema>;
export type CreateExperimentBody = z.infer<typeof createExperimentSchema>;
