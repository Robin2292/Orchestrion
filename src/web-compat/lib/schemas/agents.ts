import { z } from "zod";
import { ToolGrantSetSchema } from "./tool-grants";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const AgentVersionFieldsSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  versionNumber: z.number().int().positive(),
  nodeType: z.enum(["agent", "terminal", "code", "coding_agent", "sub_workflow"]),
  config: JsonObjectSchema.nullable(),
  role: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  userPromptTemplate: z.string().nullable(),
  providerType: z.string(),
  modelId: z.string(),
  modelParams: JsonObjectSchema.nullable(),
  inputSchema: JsonObjectSchema.nullable(),
  outputSchema: JsonObjectSchema.nullable(),
  outputType: z.string(),
  toolGrants: ToolGrantSetSchema.nullable().optional(),
  maxTokens: z.number().int().nullable(),
  maxRetries: z.number().int().nonnegative(),
  maxToolTurns: z.number().int().positive().nullable(),
  timeoutSeconds: z.number().int().positive().nullable().optional(),
  toolTurnLimitMode: z.enum(["soft", "hard"]),
  maxToolBudget: z.number().int().nullable(),
  planMode: z.enum(["execute_only", "plan_then_execute", "plan_await_approval", "plan_only"]).nullable(),
  interactionMode: z.enum(["autonomous", "conversational", "approval_gated"]).nullable(),
  carryConversation: z.boolean().nullable(),
  finalizationPrompt: z.string().nullable(),
  jsonExtractionPrompt: z.string().nullable(),
  fallbackModels: z.array(z.object({
    providerType: z.string().min(1),
    modelId: z.string().min(1),
  }).strict()).nullable(),
  createdAt: z.string().min(1),
}).strict();

export const AgentVersionSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const legacy = { ...value } as Record<string, unknown>;
  delete legacy.cacheEnabled;
  delete legacy.cache_enabled;
  return legacy;
}, AgentVersionFieldsSchema);

const AgentSummaryFields = {
  id: z.string().min(1),
  nodeType: z.enum(["agent", "terminal", "code", "coding_agent", "sub_workflow"]),
  name: z.string().min(1),
  description: z.string().nullable(),
  userGuide: z.string().nullable(),
  latestVersionId: z.string().nullable(),
  sourceTemplateId: z.string().nullable(),
  sourceTemplateVersion: z.number().int().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  latestVersion: AgentVersionSchema.nullable(),
};

export const AgentDetailSchema = z.object(AgentSummaryFields).strict();

export const AgentListSchema = z.object({
  agents: z.array(AgentDetailSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
}).strict();

export const AgentVersionListSchema = z.object({
  versions: z.array(AgentVersionSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
}).strict();
