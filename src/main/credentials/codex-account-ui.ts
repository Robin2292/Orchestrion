import type { SqliteFoundation } from "../../storage/sqlite/foundation";
import { CodexAccountRepository } from "../../storage/sqlite/codex-account";
import { CodexAccountUiRequestSchema, CodexAccountUiValueSchema,
  type CodexAccountUiValue } from "../../shared/codex-account-ui-contracts";
import { localFailure } from "../../shared/local-contracts";
import type { HostDocument } from "../background/service";
import type { CodexAccountConnection } from "./codex-account-connection";
import type { HostCodexOAuthCeremony, HostOAuthBinding } from "./codex-oauth-ceremony";
import type { CodexOAuthDiagnostic } from "./codex-oauth-diagnostics";
import type { CredentialRequest } from "../../shared/credential-contracts";

type Ports = {
  ceremony: Pick<HostCodexOAuthCeremony, "begin" | "cancel" | "isPending" | "hasCompleted" | "takeTokens">;
  connection: Pick<CodexAccountConnection, "connect" | "inspect" | "disconnectStored">
    | ((document: HostDocument) => Pick<CodexAccountConnection, "connect" | "inspect" | "disconnectStored">);
  refresh?: (document: HostDocument, pin: CredentialRequest) => Promise<void>;
  refreshDue?: (document: HostDocument, pin: CredentialRequest) => boolean;
  recover?: (document: HostDocument) => void;
  prepareStart?: (document: HostDocument) => void;
  readBinding: (documentId: string) => HostOAuthBinding | null;
  readVerifiedAccount: () => string | null;
  reportFailure?: (diagnostic: CodexOAuthDiagnostic) => void;
};
const unavailable = (): CodexAccountUiValue => ({ availability: "unavailable", state: "unavailable",
  accountDisplay: null, executionReady: false });
const disconnected = (): CodexAccountUiValue => ({ availability: "available", state: "disconnected",
  accountDisplay: null, executionReady: false });

/** One utility-host owner. All trusted ports are supplied together. */
export class CodexAccountUiService {
  private pendingOwner: string | null = null;
  constructor(private readonly store: SqliteFoundation, private readonly connectorId: string,
    private readonly ports: Ports | null = null) {}

  private connection(document: HostDocument) {
    if (!this.ports) throw new Error("CODEX_OAUTH_UNAVAILABLE");
    return typeof this.ports.connection === "function"
      ? this.ports.connection(document) : this.ports.connection;
  }

  private authorized(document: HostDocument, projectId: string): boolean {
    if (!document.isActive() || !this.ports) return false;
    try {
      const context = this.store.workspace;
      const binding = this.ports.readBinding(document.id);
      if (!binding || projectId !== context.project_id || binding.orgId !== context.org_id || binding.principalId !== context.principal.id
          || context.principal.type !== "user" || binding.projectId !== context.project_id
          || binding.connectorId !== this.connectorId || binding.windowId !== document.id) return false;
      return !!this.store.transaction(tx => tx.get(`SELECT 1 FROM memberships m JOIN projects p
        ON p.org_id=m.org_id AND p.id=? WHERE m.org_id=? AND m.principal_type=? AND m.principal_id=?`,
      context.project_id, context.org_id, context.principal.type, context.principal.id));
    } catch { return false; }
  }

  private accountRows(account: string) {
    const c = this.store.workspace;
    return this.store.transaction(tx => {
      const repo = new CodexAccountRepository(tx,
        { org_id: c.org_id, principal: c.principal }, c.project_id, this.connectorId);
      return { latest: repo.latest(account), live: repo.liveForAccount(account), hasLive: repo.hasLive() };
    });
  }

  private snapshot(document: HostDocument, projectId: string): CodexAccountUiValue {
    if (!this.ports) return unavailable();
    if (!this.authorized(document, projectId)) return unavailable();
    if (this.pendingOwner === document.id && !this.ports.ceremony.isPending()
        && !this.ports.ceremony.hasCompleted()) this.pendingOwner = null;
    if (this.pendingOwner === document.id && this.ports.ceremony.isPending())
      return { ...disconnected(), state: "pending" };
    if (this.pendingOwner === document.id && this.ports.ceremony.hasCompleted()) {
      this.connection(document).connect(this.ports.ceremony);
      this.pendingOwner = null;
    }
    const account = this.ports.readVerifiedAccount();
    try {
      if (!account) return this.anyLive() ? { ...disconnected(), state: "stale" } : disconnected();
      const rows = this.accountRows(account);
      for (const row of rows.live) if (row.state === "active") {
        const inspected = this.connection(document).inspect({ credential_ref: row.ref,
          connector_id: this.connectorId, revision: row.revision });
        if (inspected.ok && inspected.value.state === "ready")
          return { availability: "available", state: "connected", accountDisplay: "••••",
            executionReady: false };
      }
      if (rows.hasLive) return { ...disconnected(), state: "stale" };
      return rows.latest?.state === "revoked" ? { ...disconnected(), state: "revoked" } : disconnected();
    } catch { return unavailable(); }
  }

  private anyLive(): boolean {
    const c = this.store.workspace;
    return this.store.transaction(tx => new CodexAccountRepository(tx,
      { org_id: c.org_id, principal: c.principal }, c.project_id, this.connectorId).hasLive());
  }

  /** Called only by the utility host's loopback callback. It commits without a
   * renderer poll and confirms the same readiness shown by Settings. */
  completeFromCallback(document: HostDocument, ceremony: Pick<HostCodexOAuthCeremony, "takeTokens">): boolean {
    if (this.pendingOwner !== document.id || !this.authorized(document, this.store.workspace.project_id)) return false;
    let published = false;
    const reportReadinessFailure = () => { try { this.ports?.reportFailure?.({ stage: "credential_connection", reason: "readiness" }); }
      catch { /* Diagnostics cannot affect credential authority. */ } };
    try {
      const connection = this.connection(document);
      const connected = connection.connect(ceremony);
      this.pendingOwner = null;
      if (!connected.ok || connected.value.state !== "ready") return false;
      published = true;
      const inspected = connection.inspect({ credential_ref: connected.value.credential_ref,
        connector_id: connected.value.connector_id, revision: connected.value.revision });
      const ready = inspected.ok && inspected.value.state === "ready" &&
        this.snapshot(document, this.store.workspace.project_id).state === "connected";
      if (!ready) reportReadinessFailure();
      return ready;
    } catch { if (published) reportReadinessFailure(); return false; }
    finally { this.pendingOwner = null; }
  }

  private async refreshIfNeeded(document: HostDocument): Promise<void> {
    if (!this.ports?.refresh || !this.ports.refreshDue) return;
    const account = this.ports.readVerifiedAccount();
    if (!account) return;
    const rows = this.accountRows(account);
    const pin = rows.live.find(row => row.state === "active");
    if (!pin) return;
    const request = { credential_ref: pin.ref, connector_id: this.connectorId, revision: pin.revision };
    if (!this.ports.refreshDue(document, request)) return;
    await this.ports.refresh(document, request);
  }

  async invoke(raw: unknown, document: HostDocument): Promise<unknown> {
    const request = CodexAccountUiRequestSchema.safeParse(raw);
    if (!request.success) return localFailure("INVALID_PAYLOAD");
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    if (!this.ports) return { ok: true, value: unavailable() };
    const projectId = request.data.projectId;
    if (!this.authorized(document, projectId)) { this.revoke(document.id); return localFailure("NOT_AUTHENTICATED"); }
    try {
      switch (request.data.operation) {
        case "read":
          if (!this.ports.ceremony.isPending() && !this.ports.ceremony.hasCompleted()) {
            this.ports.recover?.(document);
            await this.refreshIfNeeded(document);
          }
          break;
        case "start":
          // Existing active or pending material must be disconnected/repaired
          // before another sign-in, even if the newest row is stale.
          if (this.pendingOwner) break;
          this.ports.recover?.(document);
          if (this.anyLive()) break;
          this.pendingOwner = document.id;
          try { this.ports.prepareStart?.(document); await this.ports.ceremony.begin(true); }
          catch { this.pendingOwner = null; return { ok: true, value: unavailable() }; }
          if (!this.authorized(document, projectId)) { this.revoke(document.id); return localFailure("NOT_AUTHENTICATED"); }
          break;
        case "cancel":
          if (this.pendingOwner === document.id) { this.ports.ceremony.cancel(); this.pendingOwner = null; }
          break;
        case "disconnect": {
          const current = this.snapshot(document, projectId);
          if (current.state !== "connected" && current.state !== "stale") break;
          if (!this.authorized(document, projectId)) return localFailure("NOT_AUTHENTICATED");
          this.connection(document).disconnectStored();
          break;
        }
      }
      if (!this.authorized(document, projectId)) return localFailure("NOT_AUTHENTICATED");
      return { ok: true, value: CodexAccountUiValueSchema.parse(this.snapshot(document, projectId)) };
    } catch { return { ok: true, value: unavailable() }; }
  }

  revoke(documentId: string): void {
    if (this.pendingOwner === documentId && this.ports) {
      this.ports.ceremony.cancel(); this.pendingOwner = null;
    }
  }
  shutdown(): void { if (this.pendingOwner) this.revoke(this.pendingOwner); }
}
