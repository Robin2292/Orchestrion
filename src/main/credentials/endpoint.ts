import { createHostLocalEndpoint } from "../background/local-port";
import { createLocalCommandAdapter } from "../../shared/local-command-adapter";
import { CredentialRequestSchema, CredentialReadinessSchema, CredentialResultSchema } from "../../shared/credential-contracts";
import { localFailure } from "../../shared/local-contracts";
import type { HostDocument } from "../background/service";
import type { SqliteFoundation } from "../../storage/sqlite/foundation";
import type { HostCredentialService } from "./service";

const endpoint = createHostLocalEndpoint("credential.readiness", CredentialRequestSchema,
  "credential.readiness", CredentialReadinessSchema);
const requestGate = createLocalCommandAdapter("credential.readiness", CredentialRequestSchema);
const unauthenticated = () => localFailure("NOT_AUTHENTICATED");

function parseRequest(raw: string) {
  try { return requestGate.schema.safeParse(JSON.parse(raw)); }
  catch { return requestGate.schema.safeParse(null); }
}

/** Read-only F2 endpoint. No secret input, lifecycle mutation or Tool invocation
 * is registered. Future secret ingress must remain in-process in the host.
 * Events are not emitted here; future domain events must use the F6 EventBus. */
export function credentialEndpoint(store: SqliteFoundation, create: (document: HostDocument) => HostCredentialService) {
  return async (raw: unknown, document: HostDocument): Promise<unknown> => {
    if (!document.isActive() || typeof raw !== "string") return unauthenticated();
    const parsed = parseRequest(raw);
    if (!parsed.success) return requestGate.validate(raw, null);
    const command = parsed.data;
    // Authenticate the complete host-owned context before a credential reference
    // can influence repository access or the public error classification. The
    // claimed version is used only to make this first pass metadata-independent;
    // the ordinary F2 handler still resolves and rechecks the authoritative pin.
    const authorized = requestGate.validate(raw, {
      context: store.workspace,
      runtime_owner: store.owner,
      expected: command.expected,
      run: null,
    });
    if (!authorized.ok) {
      return authorized.error.code === "INVALID_PAYLOAD" || authorized.error.code === "UNSUPPORTED_VERSION"
        ? authorized : unauthenticated();
    }
    if (!document.isActive()) return unauthenticated();
    const service = create(document);
    return endpoint.handle(raw, document, {
      readAuthority: () => {
        const expected = service.version(command.payload);
        return expected ? { context: store.workspace, runtime_owner: store.owner, expected, run: null } : null;
      },
      prepare: async () => {},
      commit: async command => {
        if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
        return CredentialResultSchema.parse(service.inspect(command.payload));
      },
    });
  };
}
