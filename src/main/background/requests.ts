import { REALTIME_CHANNEL, REALTIME_BOOTSTRAP } from "../../shared/realtime-contracts";
import { z } from "zod";
import { IPC } from "../../shared/contracts";
import { BindSessionAgentSchema } from "../../shared/session-tree-contracts";
import { CREDENTIAL_READINESS_CHANNEL, CredentialReadinessWireSchema } from "../../shared/credential-contracts";
import { CODEX_ACCOUNT_UI_CHANNEL, CodexAccountUiRequestSchema } from "../../shared/codex-account-ui-contracts";
import { LOCAL_AGENT_UI_CHANNEL, LocalAgentUiRequestSchema } from "../../shared/agent-ui-contracts";
import { LOCAL_AGENT_SOUL_CHANNEL, LocalAgentSoulRequestSchema } from "../../shared/agent-soul-ui-contracts";
import { LOCAL_ASSIGNMENT_UI_CHANNEL, LocalAssignmentUiRequestSchema } from "../../shared/assignment-ui-contracts";
import { LOCAL_DIRECT_SESSION_CHANNEL, LocalDirectSessionRequestSchema } from "../../shared/direct-session-ui-contracts";
import { LOCAL_POLICY_UI_CHANNEL, LocalPolicyUiRequestSchema } from "../../shared/policy/p2-ui-contracts";

// Compatibility adapter for the existing native Codex client, NOT governed Local
// commands. Domain command owners use the unchanged F2 adapter separately.
const text = z.string().max(2 * 1024 * 1024);
const id = z.string().min(1).max(255);
const session = z.object({ sessionId: id }).strict();
const file = session.extend({ relativePath: text }).strict();
const settings = { model: text.nullable().optional(), modelProvider: text.nullable().optional(), reasoningEffort: text.nullable().optional(), serviceTier: text.nullable().optional() };
const attachment = z.object({ id, path: text, name: text, kind: z.enum(["image", "audio", "file", "folder"]), mimeType: text.nullable(), size: z.number().nonnegative().nullable(), previewUrl: text.nullable() }).strict();
const message = { text, attachments: z.array(attachment).max(32).optional() };
const createSession = z.object({ agentId: id, title: text.optional(), titleSource: z.enum(["provisional", "codex", "manual"]).optional(), ...settings }).strict();
const terminal = session.extend({ terminalId: id }).strict();
const dimensions = { columns: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
const requestId = z.union([id, z.number().safe()]);
// Nested approval/permission values are validated by the existing request service
// against the exact live pending request; transport never grants authority.
export const requestSchemas: Readonly<Record<string, z.ZodTypeAny>> = {
  [REALTIME_BOOTSTRAP]: z.undefined(),
  [REALTIME_CHANNEL]: z.string().max(32768),
  [CREDENTIAL_READINESS_CHANNEL]: CredentialReadinessWireSchema,
  [CODEX_ACCOUNT_UI_CHANNEL]: CodexAccountUiRequestSchema,
  [LOCAL_AGENT_UI_CHANNEL]: LocalAgentUiRequestSchema,
  [LOCAL_AGENT_SOUL_CHANNEL]: LocalAgentSoulRequestSchema,
  [LOCAL_ASSIGNMENT_UI_CHANNEL]: LocalAssignmentUiRequestSchema,
  [LOCAL_DIRECT_SESSION_CHANNEL]: LocalDirectSessionRequestSchema,
  [LOCAL_POLICY_UI_CHANNEL]: LocalPolicyUiRequestSchema,
  [IPC.describeDroppedAttachments]: z.array(z.string().max(32768)).max(32),
  [IPC.bootstrap]: z.undefined(), [IPC.listModels]: z.undefined(), [IPC.restartCodex]: z.undefined(),
  [IPC.createProject]: z.object({ name: text, path: text }).strict(),
  [IPC.createAgent]: z.object({ projectId: id, name: text, instructions: text }).strict(),
  [IPC.bindSessionAgent]: BindSessionAgentSchema,
  [IPC.createSession]: createSession, [IPC.startSession]: createSession.extend(message).strict(),
  [IPC.renameProject]: z.object({ projectId: id, name: text }).strict(),
  [IPC.renameAgent]: z.object({ agentId: id, name: text }).strict(),
  [IPC.deleteProject]: z.object({ projectId: id }).strict(),
  [IPC.deleteAgent]: z.object({ agentId: id }).strict(),
  [IPC.renameSession]: session.extend({ title: text }).strict(), [IPC.deleteSession]: session,
  [IPC.updateSessionSettings]: session.extend({ model: text, modelProvider: text.nullable().optional(), reasoningEffort: text.nullable(), serviceTier: text.nullable().optional() }).strict(),
  [IPC.sendMessage]: session.extend(message).strict(), [IPC.stopTurn]: session,
  [IPC.loadAttachmentPreviews]: session, [IPC.listWorkspaceDirectory]: file, [IPC.readWorkspaceFile]: file,
  [IPC.saveWorkspaceFile]: file.extend({ content: text, expectedRevision: text }).strict(),
  [IPC.openWorkspaceFile]: file.extend({ destination: z.enum(["system", "vscode", "cursor"]) }).strict(),
  [IPC.createTerminal]: session.extend(dimensions).strict(),
  [IPC.terminalInput]: terminal.extend({ data: z.string().max(32768) }).strict(),
  [IPC.resizeTerminal]: terminal.extend(dimensions).strict(),
  [IPC.acknowledgeTerminalOutput]: terminal.extend({ sequence: z.number().int().positive().safe() }).strict(),
  [IPC.closeTerminal]: terminal, [IPC.closeSessionTerminals]: session,
  [IPC.respondToRequest]: z.discriminatedUnion("kind", [
    z.object({ requestId, kind: z.literal("approval"), decision: z.union([text, z.record(z.unknown())]) }).strict(),
    z.object({ requestId, kind: z.literal("userInput"), answers: z.record(z.object({ answers: z.array(text) }).strict()) }).strict(),
    z.object({ requestId, kind: z.literal("permissions"), permissions: z.record(z.unknown()), scope: z.enum(["turn", "session"]).optional() }).strict(),
    z.object({ requestId, kind: z.literal("elicitation"), action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.unknown()).nullable() }).strict(),
  ]),
};

export function validateRequest(channel: string, input: unknown): boolean {
  try {
    const wire = JSON.stringify(input);
    return (wire === undefined || Buffer.byteLength(wire) <= 16 * 1024 * 1024)
      && !!requestSchemas[channel]?.safeParse(input).success;
  } catch { return false; }
}
