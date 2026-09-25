import { ZodError } from "zod";
import { AgentRejectionCodeSchema } from "../shared/agent-contracts";
import { LOCAL_CONTRACT_VERSION, localFailure } from "../shared/local-contracts";
import { LocalAgentSoulRequestSchema, LocalAgentSoulValueSchema,
  type LocalAgentSoulReplySchema } from "../shared/agent-soul-ui-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { z } from "zod";
import type { LocalAgentService } from "./service";
import { AgentSoulFileService } from "./soul-file";

type Reply = z.infer<typeof LocalAgentSoulReplySchema>;

export class AgentSoulUiEndpoint {
  constructor(private readonly resolve: () => LocalAgentService,
    private readonly userData: string) {}

  async invoke(raw: unknown, active: () => boolean, openSystem: (path: string) => Promise<void>): Promise<Reply> {
    const request = LocalAgentSoulRequestSchema.safeParse(raw);
    if (!request.success) return localFailure("INVALID_PAYLOAD");
    if (!active()) return localFailure("NOT_AUTHENTICATED");
    let invoked = false;
    try {
      const agent = this.resolve();
      const files = new AgentSoulFileService(this.userData, agent);
      const p = request.data;
      if (p.operation === "read") return { ok: true, value: LocalAgentSoulValueSchema.parse({
        kind: "draft", draft: files.read(p.agentId),
      }) };
      if (p.operation === "save") {
        invoked = true;
        const draft = files.save(p.agentId, p.content, p.expectedHash, p.publishedVersionId);
        return { ok: true, value: LocalAgentSoulValueSchema.parse({ kind: "draft", draft }) };
      }
      if (p.operation === "open") {
        invoked = true;
        const path = files.open(p.agentId, p.expectedHash);
        if (!active()) return localFailure("NOT_AUTHENTICATED");
        await openSystem(path);
        if (!active()) return localFailure("NOT_AUTHENTICATED");
        return { ok: true, value: LocalAgentSoulValueSchema.parse({ kind: "opened", draft: files.read(p.agentId) }) };
      }
      invoked = true;
      const authority = agent.authority();
      const result = agent.publishSoul({ ...authority, expected: p.expected,
        schema_version: LOCAL_CONTRACT_VERSION, request_id: p.requestId,
        idempotency_key: p.idempotencyKey }, { agentId:p.agentId,
        publishedVersionId:p.publishedVersionId,expectedHash:p.expectedHash },
      () => files.publishedDraft(p.agentId));
      return { ok: true, value: LocalAgentSoulValueSchema.parse({ kind: "published",
        versionId: result.resultRef, draft: files.read(p.agentId),
      }) };
    } catch (error) {
      if (error instanceof ZodError) return localFailure("INVALID_PAYLOAD");
      if (error instanceof StorageError) {
        const code = AgentRejectionCodeSchema.safeParse(error.code);
        if (code.success) return { ok: false, error: { code: code.data, retryable: false } };
      }
      return localFailure(invoked ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE");
    }
  }
}
