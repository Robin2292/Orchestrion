import { z } from "zod";
import {
  LOCAL_CONTRACT_VERSION, LocalContextSchema, RuntimeOwnerSchema,
  LocalVersionPinSchema, LocalRunIdentitySchema, localCommandSchema, localFailure,
  type LocalCommandHeader, type LocalFailure,
} from "./local-contracts";

export const LOCAL_COMMAND_MAX_BYTES = 1024 * 1024;

function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => boundedJson(item, depth + 1));
  return typeof value === "object" && Object.entries(value).every(([key, item]) =>
    boundedJson(key, depth + 1) && boundedJson(item, depth + 1));
}

/** Supplied by authenticated host/session and org-scoped service reads, NEVER IPC.
 * An exact Run/owner/version is looked up by the service, not selected by a caller.
 */
export const LocalAuthoritySnapshotSchema = z.object({
  context: LocalContextSchema,
  runtime_owner: RuntimeOwnerSchema,
  expected: LocalVersionPinSchema,
  run: LocalRunIdentitySchema.nullable(),
}).strict();
export type LocalAuthoritySnapshot = z.infer<typeof LocalAuthoritySnapshotSchema>;

function mismatch(command: LocalCommandHeader, trusted: LocalAuthoritySnapshot): LocalFailure | null {
  const a = command.context;
  const b = trusted.context;
  if (a.org_id !== b.org_id || a.project_id !== b.project_id
      || a.principal.type !== b.principal.type || a.principal.id !== b.principal.id
      || command.run?.project_id !== trusted.run?.project_id
      || command.run?.workflow_id !== trusted.run?.workflow_id
      || command.run?.workflow_version_id !== trusted.run?.workflow_version_id
      || command.run?.run_id !== trusted.run?.run_id) return localFailure("CONTEXT_MISMATCH");
  if (command.runtime_owner.engine !== trusted.runtime_owner.engine
      || command.runtime_owner.instance_id !== trusted.runtime_owner.instance_id
      || command.runtime_owner.epoch !== trusted.runtime_owner.epoch) return localFailure("RUNTIME_OWNER_MISMATCH");
  if (command.expected.revision !== trusted.expected.revision
      || command.expected.hash !== trusted.expected.hash) return localFailure("REVISION_CONFLICT");
  return null;
}

/** Pure transport adapter, deliberately unregistered with Electron in F2.
 * One adapter per service command, using its existing schema. No generic dispatcher.
 * readAuthority must authenticate the sender independently; null is fail-closed.
 */
export function createLocalCommandAdapter<S extends z.ZodTypeAny>(name: string, payload: S) {
  const schema = localCommandSchema(name, payload);
  type Command = z.infer<typeof schema>;

  function validate(raw: unknown, authority: unknown): { ok: true; command: Command } | LocalFailure {
    // Text is intentional: a bounded JSON wire excludes Electron objects/prototypes,
    // functions, getters and undefined instead of silently dropping their fields.
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > LOCAL_COMMAND_MAX_BYTES)
      return localFailure("INVALID_PAYLOAD");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return localFailure("INVALID_PAYLOAD"); }
    if (!boundedJson(value)) return localFailure("INVALID_PAYLOAD");
    if (value && typeof value === "object" && !Array.isArray(value)
        && "schema_version" in value && value.schema_version !== LOCAL_CONTRACT_VERSION)
      return localFailure("UNSUPPORTED_VERSION");
    const parsed = schema.safeParse(value);
    if (!parsed.success) return localFailure("INVALID_PAYLOAD");
    const trusted = LocalAuthoritySnapshotSchema.safeParse(authority);
    if (!trusted.success) return localFailure("NOT_AUTHENTICATED");
    const error = mismatch(parsed.data, trusted.data);
    return error ?? { ok: true, command: parsed.data };
  }

  return {
    schema,
    validate,
    /** Preparation may only read/validate. Re-read authority after async preparation.
     * Service commit MUST enforce atomic revision/owner fencing + durable scoped
     * idempotency (org/principal/project/command/key + exact request content).
     * This transport check is not a transaction, replay ledger, or Tool permission.
     * Tool services MUST use ToolInvocation/Registry/Policy; events MUST use EventBus.
     * No automatic retry: a service error can mean an unknown committed outcome.
     */
    async handle<T>(raw: unknown, service: {
      readAuthority(): LocalAuthoritySnapshot | null;
      prepare(command: Command): Promise<void>;
      commit(command: Command): Promise<T>;
    }): Promise<{ ok: true; value: T } | LocalFailure> {
      try {
        const initial = validate(raw, service.readAuthority());
        if (!initial.ok) return initial;
        await service.prepare(initial.command);
        // Reparse the original immutable wire, not a possibly mutated preparation DTO.
        const final = validate(raw, service.readAuthority());
        if (!final.ok) return final;
        try {
          return { ok: true, value: await service.commit(final.command) };
        } catch {
          // The effect may have committed before the response was lost.
          return localFailure("OUTCOME_UNKNOWN");
        }
      } catch {
        return localFailure("SERVICE_UNAVAILABLE");
      }
    },
  };
}
