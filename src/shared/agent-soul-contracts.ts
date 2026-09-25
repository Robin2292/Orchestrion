import { z } from "zod";

/** Portable logical SOUL document shape. The managed Local path is an edit
 * surface; execution uses the exact AgentVersion snapshot instead. */
export const AGENT_SOUL_MAX_BYTES = 128 * 1024;
export const AgentSoulSnapshotSchema = z.object({
  content: z.string().max(AGENT_SOUL_MAX_BYTES),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type AgentSoulSnapshot = z.infer<typeof AgentSoulSnapshotSchema>;

export const AgentSoulDraftSchema = AgentSoulSnapshotSchema.extend({
  source: z.enum(["managed_file", "version_preview", "legacy_preview"]),
  publishedVersionId: z.string().nullable(),
}).strict();
export type AgentSoulDraft = z.infer<typeof AgentSoulDraftSchema>;

export const DEFAULT_AGENT_SOUL = "You are a helpful Agent. State your goal, explain important decisions, and ask when required authority or context is missing.\n";
