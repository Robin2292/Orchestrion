import { z } from "zod";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  AgentIdentitySchema,
  AgentSessionAttemptSchema,
  AgentSessionContractSchemas,
  AgentSessionSchema,
  ProjectAgentAssignmentSchema,
  ProjectAgentAssignmentVersionSchema,
  WorkflowRoleBindingSchema,
  compileAssignmentVersionHashes,
  parseAgentSessionContract,
  type AgentSessionContractKind,
} from "../web-compat/lib/schemas/agent-session";

export {
  AGENT_SESSION_CONTRACT_VERSION,
  AgentIdentitySchema,
  AgentSessionAttemptSchema,
  AgentSessionContractSchemas,
  AgentSessionSchema,
  ProjectAgentAssignmentSchema,
  ProjectAgentAssignmentVersionSchema,
  WorkflowRoleBindingSchema,
  compileAssignmentVersionHashes,
  parseAgentSessionContract,
};
export type { AgentSessionContractKind };

export const AgentSessionIpcEnvelopeSchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
  contract: z.enum(["agentIdentity", "assignment", "assignmentVersion", "workflowRoleBinding", "agentSession", "sessionAttempt"]),
  payload: z.unknown(),
}).strict().transform((envelope, context) => {
  const schema = AgentSessionContractSchemas[envelope.contract];
  const parsed = schema.safeParse(envelope.payload);
  if (!parsed.success) {
    context.addIssue({ code: "custom", path: ["payload"], message: "INVALID_AGENT_SESSION_CONTRACT" });
    return z.NEVER;
  }
  return { ...envelope, payload: parsed.data };
});

export type AgentSessionIpcEnvelope = z.infer<typeof AgentSessionIpcEnvelopeSchema>;

export function serializeAgentSessionIpcEnvelope(value: unknown): string {
  return JSON.stringify(AgentSessionIpcEnvelopeSchema.parse(value));
}

export function loadAgentSessionIpcEnvelope(value: string): AgentSessionIpcEnvelope {
  return AgentSessionIpcEnvelopeSchema.parse(JSON.parse(value));
}
