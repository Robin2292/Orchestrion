import { ZodError } from "zod";
import { createLocalCommandAdapter, LOCAL_COMMAND_MAX_BYTES } from "../shared/local-command-adapter";
import { AgentVersionCloneSchema, AgentCreateSchema, AgentUpdateSchema, AgentVersionCreateSchema, AgentIdSchema, AgentPageSchema, AgentReferenceSchema, AgentRejectionCodeSchema, type AgentFailure } from "../shared/agent-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalAgentService } from "./service";
import { LocalCommandHeaderSchema, LocalVersionPinSchema, localFailure } from "../shared/local-contracts";

/** Only typed, allowlisted deterministic rejections may be projected. Matching
 * exception messages or arbitrary objects with a code would misclassify uncertain
 * failures and could expose private data. The envelope requires code/retryable only. */
function rejection(error: unknown): AgentFailure | null {
  if (error instanceof ZodError) return localFailure("INVALID_PAYLOAD");
  if (error instanceof StorageError) {
    const parsed = AgentRejectionCodeSchema.safeParse(error.code);
    if (parsed.success) return { ok: false, error: { code: parsed.data, retryable: false } };
  }
  return null;
}

/** Thin host API seam for A1; not registered with renderer. resolve authenticates
 * a live sender independently of the request. No SQL/path or execution surface. */
export function agentEndpoints(resolve: () => LocalAgentService | null) {
  function endpoint<S extends typeof AgentCreateSchema | typeof AgentUpdateSchema | typeof AgentVersionCreateSchema | typeof AgentVersionCloneSchema | typeof AgentIdSchema>(
    name: string, schema: S, invoke: (s: LocalAgentService, header: ReturnType<typeof LocalCommandHeaderSchema.parse>, payload: unknown) => unknown,
  ) {
    const adapter = createLocalCommandAdapter(name, schema);
    return (raw: unknown) => {
      let invoked = false;
      try {
        const service = resolve();
        if (!service) return localFailure("NOT_AUTHENTICATED");
        if (typeof raw !== "string" || Buffer.byteLength(raw) > LOCAL_COMMAND_MAX_BYTES) return localFailure("INVALID_PAYLOAD");
        let decoded: unknown;
        try { decoded = JSON.parse(raw); } catch { return localFailure("INVALID_PAYLOAD"); }
        const pin = LocalVersionPinSchema.safeParse(decoded && typeof decoded === "object" && "expected" in decoded ? decoded.expected : null);
        if (!pin.success) return localFailure("INVALID_PAYLOAD");
        // Revision CAS AND exact replay are decided in foundation.commit's one
        // transaction. A current-pin-only transport check would reject lost-response
        // retries before reaching durable replay. Context/owner remain host-owned.
        const validated = adapter.validate(raw, { ...service.authority(), expected: pin.data });
        if (!validated.ok) return validated;
        const { payload, command: _command, ...header } = validated.command;
        void _command;
        const parsedHeader = LocalCommandHeaderSchema.parse(header);
        invoked = true;
        return { ok: true as const, value: invoke(service, parsedHeader, payload) };
      } catch (error) {
        return rejection(error) ?? localFailure(invoked ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE");
      }
    };
  }
  function readEndpoint<S extends typeof AgentIdSchema | typeof AgentPageSchema | typeof AgentReferenceSchema | ReturnType<typeof AgentIdSchema.merge>>(
    name: string, schema: S, invoke: (s: LocalAgentService, payload: unknown) => unknown,
  ) {
    const adapter = createLocalCommandAdapter(name, schema);
    return (raw: unknown) => {
      try {
        const service = resolve();
        if (!service) return localFailure("NOT_AUTHENTICATED");
        const validated = adapter.validate(raw, service.authority());
        if (!validated.ok) return validated;
        return { ok: true as const, value: invoke(service, validated.command.payload) };
      } catch (error) { return rejection(error) ?? localFailure("SERVICE_UNAVAILABLE"); }
    };
  }
  return {
    get: readEndpoint("agent.get", AgentIdSchema, (s, p) => s.get(p)),
    list: readEndpoint("agent.list", AgentPageSchema, (s, p) => s.list(p)),
    versions: readEndpoint("agent.versions", AgentIdSchema.merge(AgentPageSchema), (s, p) => s.versions(p)),
    reference: readEndpoint("agent.reference", AgentReferenceSchema, (s, p) => s.reference(p)),
    create: endpoint("agent.create", AgentCreateSchema, (s, h, p) => s.create(h, p)),
    update: endpoint("agent.update", AgentUpdateSchema, (s, h, p) => s.update(h, p)),
    createVersion: endpoint("agent.version.create", AgentVersionCreateSchema, (s, h, p) => s.createVersion(h, p)),
    cloneVersion: endpoint("agent.version.clone", AgentVersionCloneSchema, (s, h, p) => s.cloneVersion(h, p)),
    delete: endpoint("agent.delete", AgentIdSchema, (s, h, p) => s.delete(h, p)),
  };
}
