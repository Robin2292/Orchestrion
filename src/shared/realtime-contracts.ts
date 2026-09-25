import { z } from "zod";
import { LocalContextSchema, LocalIdSchema, LocalRevisionSchema, localEventSchema, LocalFailureSchema } from "./local-contracts";
import { LocalAuthoritySnapshotSchema } from "./local-command-adapter";

export const REALTIME_CHANNEL = "orchestrion:local-realtime";
export const REALTIME_BOOTSTRAP = "orchestrion:local-realtime-bootstrap";
export const REALTIME_NOTICE = "orchestrion:local-realtime-notice";
export const JobStatusSchema = z.enum(["queued", "claimed", "effect", "succeeded", "failed", "cancelled", "unknown"]);
export const JobFactSchema = z.object({ subject_id: LocalIdSchema, ordinal: LocalRevisionSchema.positive(), status: JobStatusSchema }).strict();
export const JobEventSchema = localEventSchema("synthetic.job.status", JobFactSchema).refine(e =>
  e.run === null && e.node_id === null && e.channel === "domain" && e.recorded_sequence !== null && e.recorded_sequence > 0);
export const CursorSchema = z.object({
  version: z.literal("synthetic.cursor.v1"), context: LocalContextSchema, subject_id: LocalIdSchema,
  sequence: LocalRevisionSchema.positive(), ordinal: LocalRevisionSchema.positive(), event_id: z.string().uuid(),
}).strict();
export const RealtimeRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("snapshot"), subject_id: LocalIdSchema }).strict(),
  z.object({ operation: z.literal("page"), subject_id: LocalIdSchema, cursor: CursorSchema.nullable(), limit: z.number().int().min(1).max(50) }).strict(),
  z.object({ operation: z.literal("subscribe"), generation: z.string().uuid(), subjects: z.array(LocalIdSchema).min(1).max(2).refine(v => new Set(v).size === v.length) }).strict(),
  z.object({ operation: z.literal("unsubscribe"), generation: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("enqueue") }).strict(),
]);
export const PageSchema = z.object({ events: z.array(JobEventSchema).max(50), cursor: CursorSchema.nullable(), has_more: z.boolean() }).strict();
export const SnapshotSchema = z.object({ event: JobEventSchema, cursor: CursorSchema }).strict();
export const RealtimeValueSchema = z.union([PageSchema, SnapshotSchema, z.object({ subscribed: z.boolean() }).strict(), z.object({ subject_id: LocalIdSchema }).strict()]);
export const RealtimeReplySchema = z.union([LocalFailureSchema, z.object({ ok: z.literal(true), value: RealtimeValueSchema }).strict()]);
export const RealtimeBootstrapSchema = LocalAuthoritySnapshotSchema;
export const NoticeSchema = z.object({ version: z.literal("synthetic.notice.v1"), generation: z.string().uuid() }).strict();
export type JobEvent = z.infer<typeof JobEventSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type EventPage = z.infer<typeof PageSchema>;
export type EventSnapshot = z.infer<typeof SnapshotSchema>;
export type RealtimeRequest = z.infer<typeof RealtimeRequestSchema>;
export interface LocalRealtimeApi {
  bootstrap(): Promise<z.infer<typeof RealtimeBootstrapSchema>>;
  request(wire: string): Promise<z.infer<typeof RealtimeValueSchema>>;
  onNotice(listener: (notice: z.infer<typeof NoticeSchema>) => void): () => void;
}
