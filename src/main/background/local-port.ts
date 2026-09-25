import { z } from "zod";
import { createLocalCommandAdapter, LocalAuthoritySnapshotSchema, type LocalAuthoritySnapshot } from "../../shared/local-command-adapter";
import { localEventSchema, localFailure } from "../../shared/local-contracts";
import type { RendererDocumentIdentity } from "../renderer-document-lifecycle";

/** Domain-owned port for the F2 root. The host installs an endpoint with its own
 * authority reader; an IPC payload/document ID is never an org or release grant.
 * Native Codex requests do not enter this port or become governed Agent Runs.
 * F4/domain owners still own transaction fences, durable replay, and EventBus. */
export function createHostLocalEndpoint<S extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  command: string, payload: S, eventType: string, eventData: E,
) {
  const adapter = createLocalCommandAdapter(command, payload);
  const eventSchema = localEventSchema(eventType, eventData);
  type Command = z.infer<typeof adapter.schema>;
  return {
    async handle<T>(wire: unknown, document: RendererDocumentIdentity, service: {
      readAuthority(document: RendererDocumentIdentity): LocalAuthoritySnapshot | null;
      prepare(command: Command): Promise<void>;
      commit(command: Command): Promise<T>;
    }) {
      return adapter.handle(wire, {
        readAuthority: () => document.isActive() ? service.readAuthority(document) : null,
        prepare: (value) => service.prepare(value),
        commit: (value) => service.commit(value),
      });
    },
    // Call only from the domain's EventBus consumer. The root schema is reused,
    // including exact owner, scoped context, Run identity and recorded sequence.
    projectEvent(raw: unknown, document: RendererDocumentIdentity,
      readAuthority: (document: RendererDocumentIdentity) => LocalAuthoritySnapshot | null) {
      if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
      const trusted = LocalAuthoritySnapshotSchema.safeParse(readAuthority(document));
      const authority = trusted.success ? trusted.data : null;
      const parsed = eventSchema.safeParse(raw);
      if (!authority || !parsed.success) return localFailure("NOT_AUTHENTICATED");
      const event = parsed.data;
      if (JSON.stringify(event.context) !== JSON.stringify(authority.context)
          || JSON.stringify(event.runtime_owner) !== JSON.stringify(authority.runtime_owner)
          || JSON.stringify(event.run) !== JSON.stringify(authority.run)) return localFailure("CONTEXT_MISMATCH");
      return { ok: true as const, value: event };
    },
  };
}
