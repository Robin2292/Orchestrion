import { ZodError, type ZodTypeAny } from "zod";
import { createLocalCommandAdapter, LOCAL_COMMAND_MAX_BYTES } from "../shared/local-command-adapter";
import { ConnectorCreateSchema, ConnectorUpdateSchema, ConnectorRotateSchema, ConnectorPinSchema, ConnectorIdSchema,
  ConnectorPageSchema, ConnectorRejectionCodeSchema } from "../shared/connector-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalConnectorService } from "./service";
import { LocalCommandHeaderSchema, LocalVersionPinSchema, LocalErrorCodeSchema, localFailure } from "../shared/local-contracts";

/** Only typed, allowlisted deterministic rejections may be projected. Matching
 * exception messages or arbitrary objects with a code would misclassify uncertain
 * failures and could expose private data. The envelope requires code/retryable only. */
function rejection(error: unknown) {
  if (error instanceof ZodError) return localFailure("INVALID_PAYLOAD");
  if (error instanceof StorageError) {
    const parsed = ConnectorRejectionCodeSchema.or(LocalErrorCodeSchema).safeParse(error.code);
    if (parsed.success) return { ok: false, error: { code: parsed.data, retryable: false } };
  }
  return null;
}

/** Thin host API seam for C0; not registered with renderer. resolve authenticates
 * a live sender independently of the request. No SQL/path or execution surface. */
export function connectorEndpoints(resolve: () => LocalConnectorService | null) {
  function endpoint<S extends ZodTypeAny>(
    name: string, schema: S, invoke: (s: LocalConnectorService, header: ReturnType<typeof LocalCommandHeaderSchema.parse>, payload: unknown) => unknown,
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
    name: string, schema: S, invoke: (s: LocalConnectorService, payload: unknown) => unknown,
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
    get: readEndpoint("connector.get", ConnectorIdSchema, (s,p) => s.get(p)),
    list: readEndpoint("connector.list", ConnectorPageSchema, (s,p) => s.list(p)),
    projection: readEndpoint("connector.projection", ConnectorIdSchema, (s,p) => s.projection(p)),
    create: endpoint("connector.create", ConnectorCreateSchema, (s,h,p) => s.create(h,p)),
    update: endpoint("connector.update", ConnectorUpdateSchema, (s,h,p) => s.update(h,p)),
    disable: endpoint("connector.disable", ConnectorPinSchema, (s,h,p) => s.disable(h,p)),
    delete: endpoint("connector.delete", ConnectorPinSchema, (s,h,p) => s.delete(h,p)),
    rotate: endpoint("connector.rotate", ConnectorRotateSchema, (s,h,p) => s.rotate(h,p)),
  };
}
