import {
  CredentialCreateSchema, CredentialIdentitySchema, CredentialPinSchema, CredentialRotateSchema,
  CredentialMetadataRepository, credentialFail, credentialParse,
  type CredentialCreate, type CredentialIdentity, type CredentialMetadata, type CredentialPin,
  type CredentialRotate, type CredentialScope,
} from "../storage/sqlite/credential-metadata";
import type { SqliteUnit } from "../storage/sqlite/foundation";

/** Host-only, synchronous metadata lifecycle within the caller's F4 transaction
 * or fenced commit. No keychain I/O, secret parameters, effects, logging or IPC.
 * F5 must authenticate context independently, authorize effects, and coordinate
 * actual keychain writes; this service does not claim atomicity with external I/O.
 */
export class CredentialMetadataService {
  private readonly repo: CredentialMetadataRepository;
  constructor(tx: SqliteUnit, trustedScope: CredentialScope, private readonly clock: () => number = Date.now) {
    this.repo = new CredentialMetadataRepository(tx, trustedScope);
  }
  private now(previous = 0): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) credentialFail("INVALID");
    return Math.max(previous, now);
  }
  create(input: CredentialCreate): CredentialMetadata {
    return this.repo.insert(credentialParse(CredentialCreateSchema, input), this.now());
  }
  /** Includes terminal state for host cleanup/recovery, never for secret resolution. */
  inspect(identity: CredentialIdentity): CredentialMetadata {
    return this.repo.get(credentialParse(CredentialIdentitySchema, identity));
  }
  private pinned(input: CredentialPin): CredentialMetadata {
    const pin = credentialParse(CredentialPinSchema, input);
    const row = this.repo.get({ credential_ref: pin.credential_ref, connector_id: pin.connector_id });
    if (row.revision !== pin.revision || row.revision === Number.MAX_SAFE_INTEGER) credentialFail("CONFLICT");
    return row;
  }
  requireActive(pin: CredentialPin): CredentialMetadata {
    const row = this.pinned(pin);
    if (row.state !== "active") credentialFail("UNAVAILABLE");
    return row;
  }
  rotate(input: CredentialRotate): CredentialMetadata {
    const value = credentialParse(CredentialRotateSchema, input);
    const row = this.requireActive({ credential_ref: value.credential_ref, connector_id: value.connector_id, revision: value.revision });
    if (row.locator_ref === value.locator_ref) credentialFail("CONFLICT");
    return this.repo.replace(row, { ...row, locator_ref: value.locator_ref, updated_at: this.now(row.updated_at) });
  }
  revoke(pin: CredentialPin): CredentialMetadata {
    const row = this.requireActive(pin), now = this.now(row.updated_at);
    return this.repo.replace(row, { ...row, state: "revoked", updated_at: now, revoked_at: now });
  }
  tombstone(pin: CredentialPin): CredentialMetadata {
    const row = this.pinned(pin), now = this.now(row.updated_at);
    if (row.state === "tombstoned") credentialFail("UNAVAILABLE");
    return this.repo.replace(row, { ...row, state: "tombstoned", locator_ref: null, updated_at: now, tombstoned_at: now });
  }
}
