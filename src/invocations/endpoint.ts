import { ToolInvocationRequestSchema, ToolInvocationRejectionCodeSchema } from "../shared/tool-invocation-contracts";
import { AgentRejectionCodeSchema } from "../shared/agent-contracts";
import { PolicyRejectionCodeSchema } from "../shared/policy/p1-contracts";
import { LocalCommandHeaderSchema, LocalErrorCodeSchema, localFailure } from "../shared/local-contracts";
import { createLocalCommandAdapter } from "../shared/local-command-adapter";
import { parseCanonical } from "../shared/policy/p0-canonical";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalToolInvocationService } from "./service";

const codes = ToolInvocationRejectionCodeSchema.or(PolicyRejectionCodeSchema)
  .or(AgentRejectionCodeSchema).or(LocalErrorCodeSchema);
/** Host-only canonical wire endpoint. Not registered in Electron/preload or
 * native Codex/PTTY. Every future caller must use this same admission service.
 * No generic dispatch or execute endpoint is supplied. */
export function toolInvocationEndpoints(resolve: () => LocalToolInvocationService | null) {
  const schema = createLocalCommandAdapter("tool.prepare", ToolInvocationRequestSchema).schema;
  return { prepare(raw: unknown) {
    try {
      const service = resolve();
      if (!service) return localFailure("NOT_AUTHENTICATED");
      let request;
      try { request = schema.parse(parseCanonical(raw)); }
      catch { return localFailure("INVALID_PAYLOAD"); }
      const { command: _command, payload, ...header } = request; void _command;
      return { ok: true as const, value: service.prepareDirect(LocalCommandHeaderSchema.parse(header), payload) };
    } catch (e) {
      if (e instanceof StorageError) {
        const code = codes.safeParse(e.code);
        if (code.success) return { ok: false as const, error: { code: code.data, retryable: false as const } };
      }
      return localFailure("SERVICE_UNAVAILABLE");
    }
  } };
}
