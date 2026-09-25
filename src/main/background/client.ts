import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { localFailure, type LocalFailure } from "../../shared/local-contracts";
import { LOCAL_AGENT_SOUL_CHANNEL, LocalAgentSoulRequestSchema } from "../../shared/agent-soul-ui-contracts";
import { CODEX_ACCOUNT_UI_CHANNEL, CodexAccountUiRequestSchema } from "../../shared/codex-account-ui-contracts";
import { CODEX_AUTHORIZE_URL, CODEX_CLIENT_ID, CODEX_REDIRECT_URI } from "../credentials/codex-oauth-provider";
import { parseCodexOAuthDiagnostic } from "../credentials/codex-oauth-diagnostics";
import { parseCodexTextDiagnostic } from "../../providers/codex-text-diagnostics";
import type { RendererDocumentIdentity } from "../renderer-document-lifecycle";

export interface HostProcess {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
}
interface Pending {
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  document: RendererDocumentIdentity;
  channel: string;
  input: unknown;
}
export interface HostBudgets { start: number; request: number; stop: number; maxPending: number }
const budgets: HostBudgets = { start: 5000, request: 60000, stop: 2000, maxPending: 128 };

/** One consumer per process incarnation. No request replay after uncertain effects.
 * A crash gets at most one automatic replacement, never a restart storm. */
export class BackgroundHost extends EventEmitter {
  private child: HostProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private ready = false;
  private quitting = false;
  private replacementUsed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly children = new Set<number>();
  private stopped: Promise<void> | null = null;
  constructor(private readonly spawn: () => HostProcess,
    private readonly openSystem: (path: string) => Promise<string>,
    private readonly limits = budgets,
    private readonly killChild: (pid: number) => void = () => {},
    private readonly soulUserData?: string,
    private readonly openOAuthBrowser?: (url: string) => Promise<void>) { super(); }

  private authorizedOAuth(pending: Pending, raw: string): boolean {
    if (!pending.document.isActive() || pending.channel !== CODEX_ACCOUNT_UI_CHANNEL || !this.openOAuthBrowser) return false;
    const request = CodexAccountUiRequestSchema.safeParse(pending.input);
    if (!request.success || request.data.operation !== "start") return false;
    try {
      const url = new URL(raw), expected = new URL(CODEX_AUTHORIZE_URL);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash
          || url.username || url.password) return false;
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 10 || new Set(keys).size !== 10) return false;
      const get = (key: string) => url.searchParams.get(key);
      return get("response_type") === "code" && get("client_id") === CODEX_CLIENT_ID
        && get("redirect_uri") === CODEX_REDIRECT_URI
        && get("scope") === "openid profile email offline_access"
        && get("code_challenge_method") === "S256"
        && /^[A-Za-z0-9_-]{43}$/.test(get("code_challenge") ?? "")
        && /^[A-Za-z0-9_-]{43}$/.test(get("state") ?? "")
        && get("id_token_add_organizations") === "true"
        && get("codex_cli_simplified_flow") === "true"
        && get("originator") === "orchestrion";
    } catch { return false; }
  }

  private authorizedOpen(pending: Pending, path: string): boolean {
    if (!pending.document.isActive()) return false;
    if (pending.channel === "orchestrion:open-workspace-file") return true;
    if (pending.channel !== LOCAL_AGENT_SOUL_CHANNEL || !this.soulUserData) return false;
    const parsed = LocalAgentSoulRequestSchema.safeParse(pending.input);
    if (!parsed.success || parsed.data.operation !== "open") return false;
    const agentId = parsed.data.agentId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) return false;
    return path === join(this.soulUserData, "agents", agentId, "SOUL.md");
  }

  start(): Promise<boolean> {
    if (this.quitting) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(false); // timed-out child must EXIT before replacement
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    this.starting = promise;
    let child: HostProcess;
    try { child = this.spawn(); } catch { this.starting = null; resolve(false); return promise; }
    this.child = child;
    const finish = (success: boolean) => {
      clearTimeout(timer);
      if (this.starting === promise) this.starting = null;
      resolve(success);
    };
    const timer = setTimeout(() => { finish(false); child.kill(); }, this.limits.start);
    child.on("message", (raw) => {
      if (this.child !== child || this.quitting || !raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.type === "ready") { this.ready = true; finish(true); return; }
      if (message.type === "codex-oauth-diagnostic") {
        const keys = Reflect.ownKeys(message);
        const diagnostic = keys.length === 2 && keys.includes("type") && keys.includes("diagnostic")
          ? parseCodexOAuthDiagnostic(message.diagnostic) : null;
        if (diagnostic) this.emit("codex-oauth-diagnostic", diagnostic);
        return;
      }
      if (message.type === "codex-text-diagnostic") {
        const keys = Reflect.ownKeys(message);
        const diagnostic = keys.length === 2 && keys.includes("type") && keys.includes("diagnostic")
          ? parseCodexTextDiagnostic(message.diagnostic) : null;
        if (diagnostic) this.emit("codex-text-diagnostic", diagnostic);
        return;
      }
      if (message.type === "child" && typeof message.pid === "number" && Number.isSafeInteger(message.pid) && message.pid > 1) {
        if (message.active === true) this.children.add(message.pid); else this.children.delete(message.pid);
        return;
      }
      if (message.type === "event") { this.emit("event", message.channel, message.value, message.documentId); return; }
      if (typeof message.id !== "string") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "open-oauth-url") {
        if (typeof message.url !== "string" || !this.authorizedOAuth(pending, message.url)) {
          child.postMessage({ type: "opened", id: message.id, ok: false }); return;
        }
        void this.openOAuthBrowser!(message.url).then(() => {
          if (this.child === child) child.postMessage({ type: "opened", id: message.id,
            ok: pending.document.isActive() });
        }, () => { if (this.child === child) child.postMessage({ type: "opened", id: message.id, ok: false }); });
        return;
      }
      if (message.type === "open-system") {
        // Only the exact originating request/document can consume this OS adapter.
        if (typeof message.path !== "string" || !this.authorizedOpen(pending, message.path)) {
          child.postMessage({ type: "opened", id: message.id, ok: false }); return;
        }
        void this.openSystem(message.path).then((error) => {
          if (this.child === child) child.postMessage({ type: "opened", id: message.id, ok: !error && pending.document.isActive() });
        }, () => { if (this.child === child) child.postMessage({ type: "opened", id: message.id, ok: false }); });
        return;
      }
      if (message.type !== "result") return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      pending.resolve(pending.document.isActive() ? message.value : localFailure("NOT_AUTHENTICATED"));
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null; this.ready = false; finish(false);
      this.killChildren();
      this.failPending("OUTCOME_UNKNOWN");
      this.emit("unavailable", localFailure("SERVICE_UNAVAILABLE"));
      if (!this.quitting && !this.replacementUsed) { this.replacementUsed = true; void this.start(); }
    });
    return promise;
  }

  async invoke(channel: string, input: unknown, document: RendererDocumentIdentity): Promise<unknown> {
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    if (this.pending.size >= this.limits.maxPending || !await this.start()) return localFailure("SERVICE_UNAVAILABLE");
    if (!document.isActive() || this.quitting || !this.child || this.pending.size >= this.limits.maxPending) return localFailure("SERVICE_UNAVAILABLE");
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); resolve(localFailure("OUTCOME_UNKNOWN"));
      }, this.limits.request);
      this.pending.set(id, { resolve, timer, document, channel, input });
      try { this.child!.postMessage({ type: "invoke", id, channel, input, documentId: document.id }); }
      catch { this.pending.delete(id); clearTimeout(timer); resolve(localFailure("OUTCOME_UNKNOWN")); }
    });
  }
  revoke(id: string): void {
    if (this.child && !this.quitting) {
      try { this.child.postMessage({ type: "revoke", documentId: id }); } catch { /* exiting host */ }
    }
    for (const [key, pending] of this.pending) if (pending.document.id === id) {
      clearTimeout(pending.timer); this.pending.delete(key); pending.resolve(localFailure("NOT_AUTHENTICATED"));
    }
  }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.quitting = true;
    this.failPending("OUTCOME_UNKNOWN");
    const child = this.child;
    this.stopped = new Promise((resolve) => {
      if (!child) { this.killChildren(); resolve(); return; }
      const timer = setTimeout(() => { this.killChildren(); child.kill(); resolve(); }, this.limits.stop);
      child.once("exit", () => { clearTimeout(timer); this.killChildren(); resolve(); });
      try { child.postMessage({ type: "shutdown" }); } catch { child.kill(); }
    });
    return this.stopped;
  }
  private killChildren(): void { for (const pid of this.children) this.killChild(pid); this.children.clear(); }
  private failPending(code: LocalFailure["error"]["code"]): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(localFailure(code)); }
    this.pending.clear();
  }
}
