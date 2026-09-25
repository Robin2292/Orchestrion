import { ZodError, type ZodTypeAny } from "zod";
import { createLocalCommandAdapter, LOCAL_COMMAND_MAX_BYTES } from "../shared/local-command-adapter";
import { AgentRejectionCodeSchema } from "../shared/agent-contracts";
import { PolicyDraftSchema, PolicyIdSchema, PolicyTransitionSchema, PolicySelectionSchema, PolicyPreviewSchema,
  PolicyRejectionCodeSchema } from "../shared/policy/p1-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalPolicyService } from "./service";
import { LocalCommandHeaderSchema, LocalVersionPinSchema, localFailure } from "../shared/local-contracts";

/** Only typed, allowlisted deterministic rejections may be projected. Matching
 * exception messages or arbitrary objects with a code would misclassify uncertain
 * failures and could expose private data. The envelope requires code/retryable only. */
function rejection(error: unknown) {
  if (error instanceof ZodError) return localFailure("INVALID_PAYLOAD");
  if (error instanceof StorageError) {
    const parsed = PolicyRejectionCodeSchema.or(AgentRejectionCodeSchema).safeParse(error.code);
    if (parsed.success) return { ok: false, error: { code: parsed.data, retryable: false } };
  }
  return null;
}

/** Thin host API seam for P1; not registered with renderer. resolve authenticates
 * a live sender independently of the request. No SQL/path or execution surface. */
export function policyEndpoints(resolve: () => LocalPolicyService | null) {
  function endpoint<S extends ZodTypeAny>(
    name: string, schema: S, invoke: (s: LocalPolicyService, header: ReturnType<typeof LocalCommandHeaderSchema.parse>, payload: unknown) => unknown,
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
  function readEndpoint<S extends ZodTypeAny>(
    name: string, schema: S, invoke: (s: LocalPolicyService, payload: unknown) => unknown,
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
    get: readEndpoint("policy.get", PolicyIdSchema, (s,p) => s.get(p)),
    selection: readEndpoint("policy.selection", PolicyIdSchema, (s,p) => s.selection(p)),
    preview: readEndpoint("policy.preview", PolicyPreviewSchema, (s,p) => s.preview(p)),
    simulate: readEndpoint("policy.simulate", PolicyPreviewSchema, (s,p) => s.simulate(p)),
    createDraft: endpoint("policy.draft", PolicyDraftSchema, (s,h,p) => s.createDraft(h,p)),
    transition: endpoint("policy.transition", PolicyTransitionSchema, (s,h,p) => s.transition(h,p)),
    select: endpoint("policy.select", PolicySelectionSchema, (s,h,p) => s.select(h,p)),
  };
}
