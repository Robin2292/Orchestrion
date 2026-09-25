import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  AgentSessionContractSchemas,
  compileAssignmentVersionHashes,
  loadAgentSessionIpcEnvelope,
  serializeAgentSessionIpcEnvelope,
  type AgentSessionContractKind,
} from "./agent-session-contracts";

const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/agent-session/contract-fixtures.json", import.meta.url),
  "utf8",
));
const validKinds: Record<string, AgentSessionContractKind> = {
  agentIdentity: "agentIdentity",
  assignment: "assignment",
  assignmentVersion: "assignmentVersion",
  workflowRoleBinding: "workflowRoleBinding",
  directSession: "agentSession",
  legacyDirectSession: "agentSession",
  workflowSession: "agentSession",
  sessionAttempt: "sessionAttempt",
};

describe("Agent Session v1 Desktop IPC contract", () => {
  it("round-trips every canonical fixture through the strict IPC envelope", () => {
    expect(fixture.schemaVersion).toBe(AGENT_SESSION_CONTRACT_VERSION);
    for (const [name, payload] of Object.entries(fixture.valid)) {
      const envelope = { schemaVersion: AGENT_SESSION_CONTRACT_VERSION, contract: validKinds[name], payload };
      expect(loadAgentSessionIpcEnvelope(serializeAgentSessionIpcEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("rejects the shared invalid vectors", () => {
    for (const testCase of fixture.invalid) {
      const schema = AgentSessionContractSchemas[testCase.contract as AgentSessionContractKind];
      expect(schema.safeParse(testCase.value).success, testCase.name).toBe(false);
    }
  });

  it("shares the canonical hash compiler with Web", async () => {
    const document = fixture.valid.assignmentVersion;
    await expect(compileAssignmentVersionHashes(document)).resolves.toEqual({
      resolvedConfigHash: document.resolvedConfigHash,
      authorityCeilingHash: document.authorityCeilingHash,
      memoryScopeHash: document.memoryScopeHash,
    });
  });

  it("rejects shared unsafe numeric hash material", async () => {
    for (const value of fixture.invalidHashNumbers) {
      const document = structuredClone(fixture.valid.assignmentVersion);
      document.parameterValues.unsafeNumber = value;
      await expect(compileAssignmentVersionHashes(document)).rejects.toThrow("JavaScript-safe");
    }
  });

  it("rejects shared noncanonical wire timestamps", () => {
    for (const createdAt of fixture.invalidWireTimestamps) {
      expect(AgentSessionContractSchemas.sessionAttempt.safeParse({
        ...fixture.valid.sessionAttempt, createdAt,
      }).success, createdAt).toBe(false);
    }
  });
});
