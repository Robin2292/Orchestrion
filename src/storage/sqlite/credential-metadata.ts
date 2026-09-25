import { z } from "zod";
import { LocalContextSchema } from "../../shared/local-contracts";
import { StorageError, type SqliteUnit } from "./foundation";

/** Internal host-only metadata. Never register these shapes as IPC/model payloads. */
export const CredentialScopeSchema = LocalContextSchema.pick({ org_id: true, principal: true }).strict();
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;
const opaqueId = z.string().uuid();
const locator = z.string().regex(/^keychain-ref:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const CredentialIdentitySchema = z.object({ credential_ref: opaqueId, connector_id: opaqueId }).strict();
export const CredentialPinSchema = CredentialIdentitySchema.extend({ revision }).strict();
export const CredentialCreateSchema = CredentialIdentitySchema.extend({ locator_ref: locator }).strict();
export const CredentialRotateSchema = CredentialPinSchema.extend({ locator_ref: locator }).strict();
export type CredentialIdentity = z.infer<typeof CredentialIdentitySchema>;
export type CredentialPin = z.infer<typeof CredentialPinSchema>;
export type CredentialCreate = z.infer<typeof CredentialCreateSchema>;
export type CredentialRotate = z.infer<typeof CredentialRotateSchema>;
export interface CredentialMetadata extends CredentialScope, CredentialIdentity {
  locator_ref: string | null;
  revision: number;
  state: "active" | "revoked" | "tombstoned";
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  tombstoned_at: number | null;
}
const MetadataSchema = CredentialScopeSchema.merge(CredentialIdentitySchema).extend({
  locator_ref: locator.nullable(), revision, state: z.enum(["active", "revoked", "tombstoned"]),
  created_at: revision, updated_at: revision, revoked_at: revision.nullable(), tombstoned_at: revision.nullable(),
}).strict().refine(row => row.updated_at >= row.created_at && (
  (row.state === "active" && row.locator_ref !== null && row.revoked_at === null && row.tombstoned_at === null)
  || (row.state === "revoked" && row.locator_ref !== null && row.revoked_at === row.updated_at && row.tombstoned_at === null)
  || (row.state === "tombstoned" && row.locator_ref === null && row.tombstoned_at === row.updated_at)
));
export function credentialFail(code: "INVALID" | "UNAVAILABLE" | "CONFLICT"): never {
  throw new StorageError(`CREDENTIAL_METADATA_${code}`);
}
/** Do not expose Zod's input/unknown-key diagnostics to logs or callers. */
export function credentialParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return credentialFail("INVALID");
  return parsed.data;
}

/** SQL-only repository. Caller owns a live SqliteUnit and independently authenticated
 * org/principal context. No unscoped get/list/update or arbitrary JSON fields.
 */
export class CredentialMetadataRepository {
  readonly #scope: CredentialScope;
  constructor(private readonly tx: SqliteUnit, scope: CredentialScope) {
    this.#scope = credentialParse(CredentialScopeSchema, scope);
  }
  private scope() {
    const c = this.#scope;
    const args = [c.org_id, c.principal.type, c.principal.id];
    if (!this.tx.get(`SELECT 1 FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?`, ...args))
      credentialFail("UNAVAILABLE");
    return args;
  }
  get(identity: CredentialIdentity): CredentialMetadata {
    const id = credentialParse(CredentialIdentitySchema, identity);
    const row = this.tx.get(`SELECT * FROM credential_metadata WHERE org_id=? AND principal_type=?
      AND principal_id=? AND credential_ref=? AND connector_id=?`, ...this.scope(), id.credential_ref, id.connector_id);
    if (!row) return credentialFail("UNAVAILABLE");
    return credentialParse(MetadataSchema, { ...structuredClone(this.#scope), ...id, locator_ref: row.locator_ref,
      revision: Number(row.revision), state: row.state as CredentialMetadata["state"],
      created_at: Number(row.created_at), updated_at: Number(row.updated_at),
      revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
      tombstoned_at: row.tombstoned_at === null ? null : Number(row.tombstoned_at) });
  }
  insert(input: CredentialCreate, now: number): CredentialMetadata {
    const value = credentialParse(CredentialCreateSchema, input);
    const scope = this.scope();
    const changed = this.tx.run(`INSERT INTO credential_metadata
      (org_id,principal_type,principal_id,credential_ref,connector_id,locator_ref,revision,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,0,'active',?,?) ON CONFLICT DO NOTHING`,
    ...scope, value.credential_ref, value.connector_id, value.locator_ref, now, now);
    if (changed.changes !== 1) credentialFail("CONFLICT");
    return this.get({ credential_ref: value.credential_ref, connector_id: value.connector_id });
  }
  /** CAS persistence primitive; lifecycle decisions belong to the service. */
  replace(previous: CredentialMetadata, next: CredentialMetadata): CredentialMetadata {
    previous = credentialParse(MetadataSchema, previous);
    next = credentialParse(MetadataSchema, next);
    const c = this.#scope;
    for (const row of [previous, next]) {
      if (row.org_id !== c.org_id || row.principal.type !== c.principal.type || row.principal.id !== c.principal.id
          || row.credential_ref !== previous.credential_ref || row.connector_id !== previous.connector_id)
        credentialFail("UNAVAILABLE");
    }
    const changed = this.tx.run(`UPDATE credential_metadata SET locator_ref=?,revision=revision+1,state=?,
      updated_at=?,revoked_at=?,tombstoned_at=? WHERE org_id=? AND principal_type=? AND principal_id=?
      AND credential_ref=? AND connector_id=? AND revision=? AND state=? AND revision<9007199254740991`,
    next.locator_ref, next.state, next.updated_at, next.revoked_at, next.tombstoned_at,
    ...this.scope(), previous.credential_ref, previous.connector_id, previous.revision, previous.state);
    if (changed.changes !== 1) credentialFail("CONFLICT");
    return this.get({ credential_ref: previous.credential_ref, connector_id: previous.connector_id });
  }
}
