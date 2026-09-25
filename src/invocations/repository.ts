import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import type { LocalContext } from "../shared/local-contracts";
import { ConnectorRepository } from "../connectors/repository";

/** Reuse F4's fence and scoped command receipt tables. Only an opaque plan hash
 * is retained; there is no grant, dispatch, action, run or argument persistence. */
export const INVOCATION_FENCE = "local-tool-preparations";
export class InvocationRepository {
  constructor(private readonly tx: SqliteUnit, private readonly context: LocalContext) {
    const member = tx.get("SELECT 1 FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      context.org_id, context.principal.type, context.principal.id);
    if (!member) throw new StorageError("NOT_AUTHENTICATED");
  }
  ensureFence() {
    const c = this.context;
    if (!this.tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?", c.org_id, c.project_id, INVOCATION_FENCE))
      SqliteFoundation.createFence(this.tx, c, INVOCATION_FENCE, `sha256:${"0".repeat(64)}`);
  }
  requireConnectionReady(id: string): void {
    // Registered host-only fixtures need no Connector configuration row. An
    // existing C0 row, however, is authoritatively inactive: neither a trusted
    // resolver's stale active claim nor registry registration can activate it.
    // Future transport owners must replace this gate with reviewed readiness;
    // missing config alone grants nothing (T1/P1/host proof are still required).
    try { new ConnectorRepository(this.tx, this.context).get(id); }
    catch (error) {
      if (error instanceof StorageError && error.code === "CONNECTOR_NOT_FOUND") return;
      throw error;
    }
    throw new StorageError("TOOL_CONNECTION_NOT_READY");
  }
  pin() {
    const c = this.context;
    const row = this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?", c.org_id, c.project_id, INVOCATION_FENCE);
    if (!row) throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    return { revision: Number(row.revision), hash: String(row.hash) };
  }
}
