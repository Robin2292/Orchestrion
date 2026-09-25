import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LocalConnectorService } from "./service";
import { HostCredentialService } from "../main/credentials/service";
import type { KeychainAdapter } from "../main/credentials/keychain";
import { SqliteFoundation } from "../storage/sqlite/foundation";
import { LOCAL_CONTRACT_VERSION, type LocalContext } from "../shared/local-contracts";
import { ConnectorPinSchema, type LocalConnector } from "../shared/connector-contracts";
import { ConnectorCandidateSchema, ConnectorDisconnectSchema, ConnectorHttpProjectionSchema, type ConnectorHttpProjection, type ConnectorHttpCode } from "../shared/connector-http-contracts";
import type { CredentialRequest } from "../shared/credential-contracts";
import { canonical } from "../shared/policy/p0-canonical";
import { JobEventBus } from "../jobs/event-bus";
import { ConnectorHttpError, HostHttpTransport, endpointUrl, requireJson, type HttpResponse } from "./http-transport";

import { RedactionSchema, RedactionMatcher, extendRedaction, validateRedaction, coversCredential, type Redaction } from "./http-redaction";

const secret = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const bearer = secret.regex(/^[a-zA-Z0-9._~+/-]+=*$/);
const oauthSchema = z.object({ clientId:z.string().min(1).max(256), authorizeUrl:z.string(),tokenUrl:z.string(),
  revokeUrl:z.string().nullable(),redirectUri:z.string(),scopes:z.array(z.string().regex(/^[a-zA-Z0-9:._/-]{1,128}$/)).max(32) }).strict();
const profileSchema = z.object({ endpoint:z.string(),allowedEndpoints:z.array(z.string()).min(1).max(32),
  oauth:oauthSchema.nullable() }).strict();
export type ConnectorHttpProfile = z.infer<typeof profileSchema>;
const tokenSchema = z.object({ kind:z.literal("oauth-pkce.v2"),profile:z.string(),access:secret,refresh:secret.nullable(),
  expires:z.number().finite(),scopes:z.array(z.string()),redaction:RedactionSchema }).strict();
type Token = z.infer<typeof tokenSchema>;
// A failed first grant still remembers attempted material through the same F5
// lifecycle. This payload carries no tokens and cannot authorize discovery.
const attemptSchema = z.object({ kind:z.literal("oauth-pkce.attempt.v1"),profile:z.string(),redaction:RedactionSchema }).strict();
const payloadSchema = z.union([tokenSchema,attemptSchema]);
type Payload = z.infer<typeof payloadSchema>;
type Pin = z.infer<typeof ConnectorPinSchema>;
type Pending = { state:Buffer; verifier:Buffer; expires:number; fingerprint:string; redaction:Redaction };
type Slot = { generation:number; busy:boolean; abort:AbortController | null; pending:Pending | null; projection:ConnectorHttpProjection | null; fingerprint:string | null; verified:number; credentialExpires:number };
// One coordinator per exclusive F4 writer/context. A second host composition
// fences old in-flight work and never adopts its cached discovery/state.
const coordinators = new WeakMap<SqliteFoundation,Map<string,Map<string,Slot>>>();
const failure = (code: ConnectorHttpCode) => ({ ok:false as const,error:{ code,retryable:false } });
const hash = (v: unknown) => createHash("sha256").update(canonical(v as never)).digest("hex");
const authError = () => new ConnectorHttpError("CONNECTOR_AUTH_FAILED");
const stateError = () => new ConnectorHttpError("CONNECTOR_AUTH_STATE_INVALID");
/** Headers and intermediate redirect/error bodies are untrusted too. Successful
 * bodies require JSON media before parsing. Nothing from this scanner is logged. */
function inspectResponse(response: HttpResponse,matcher: RedactionMatcher) {
  matcher.inspect(response.headers);
  if (!response.body) return;
  if (response.status >= 200 && response.status < 300) requireJson(response);
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); }
  catch { matcher.inspect(response.body); return; }
  matcher.inspect(parsed);
}

/** Host-only lifecycle. No IPC/preload registration, ToolRegistry registration,
 * model projection, arbitrary HTTP command or execution dispatch. All durable
 * facts are read/written through C0/F5; memory is advisory and lost on restart. */
export class HostConnectorHttpService {
  readonly connectors: LocalConnectorService;
  readonly events = new JobEventBus();
  private readonly credentials: HostCredentialService;
  private readonly slots = new Map<string,Slot>();
  private readonly owner: string;
  private stopped = false;
  private resolving: string | null = null;
  constructor(private readonly store: SqliteFoundation, context: LocalContext,keychain: KeychainAdapter,
    private readonly profiles: (template: string | null) => unknown,
    private readonly http = new HostHttpTransport(),private readonly now = () => Date.now(),
    private readonly timeoutMs = 10000,private readonly freshMs = 60000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isFinite(freshMs) || freshMs < 1 || freshMs > 300000) throw authError();
    this.connectors = new LocalConnectorService(store,context);
    this.owner = canonical(store.owner);
    let scopes = coordinators.get(store);
    if (!scopes) { scopes = new Map(); coordinators.set(store,scopes); }
    const key = canonical(this.connectors.context), previous = scopes.get(key);
    if (previous) for (const slot of previous.values()) this.clear(slot);
    scopes.set(key,this.slots);
    const authority = this.connectors.credentialAuthority();
    this.credentials = new HostCredentialService(store,keychain,{ org_id:context.org_id,principal:context.principal },{
      isActive:() => this.active() && authority.isActive(),
      allow:(op,id) => op === "resolve" ? this.resolving === id && authority.allow("rotate",id) : authority.allow(op,id),
    });
  }
  private active() {
    try { return !this.stopped && canonical(this.store.owner) === this.owner
      && coordinators.get(this.store)?.get(canonical(this.connectors.context)) === this.slots; } catch { return false; }
  }
  private slot(id: string) {
    let slot = this.slots.get(id);
    if (!slot) { slot = { generation:0,busy:false,abort:null,pending:null,projection:null,fingerprint:null,verified:0,credentialExpires:Infinity }; this.slots.set(id,slot); }
    return slot;
  }
  private clear(slot: Slot) {
    slot.generation++; slot.abort?.abort(); slot.abort = null; slot.busy = false;
    slot.pending?.state.fill(0); slot.pending?.verifier.fill(0); slot.pending = null;
    slot.projection = null; slot.fingerprint = null; slot.verified = 0; slot.credentialExpires = Infinity;
  }
  private admissionForRow(pin: Pin,row: LocalConnector) {
    if (!this.active() || row.id !== pin.id || row.revision !== pin.revision
      || canonical(row.context) !== canonical(this.connectors.context) || row.deletedAt)
      throw new ConnectorHttpError("CONNECTOR_STALE");
    if (row.origin !== "local" || row.config.transport !== "http") throw new ConnectorHttpError("CONNECTOR_HTTP_DENIED");
    const profile = profileSchema.parse(this.profiles(row.config.templateId));
    if (profile.endpoint !== row.config.url) throw new ConnectorHttpError("CONNECTOR_HTTP_DENIED");
    for (const url of [profile.endpoint,...profile.allowedEndpoints]) endpointUrl(url);
    if (!profile.allowedEndpoints.includes(profile.endpoint)) throw new ConnectorHttpError("CONNECTOR_HTTP_DENIED");
    if (profile.oauth) {
      for (const url of [profile.oauth.authorizeUrl,profile.oauth.tokenUrl,...(profile.oauth.revokeUrl ? [profile.oauth.revokeUrl] : [])]) {
        endpointUrl(url); if (!profile.allowedEndpoints.includes(url)) throw new ConnectorHttpError("CONNECTOR_HTTP_DENIED");
      }
      // Exact host-installed loopback callback; this is never an outbound target.
      const callback = new URL(profile.oauth.redirectUri);
      if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || !callback.port || callback.username || callback.password
        || callback.search || callback.hash || callback.href !== profile.oauth.redirectUri) throw authError();
    }
    return { pin,row,profile,fingerprint:hash([row,profile,this.owner]) };
  }
  private admission(raw: unknown) {
    const pin = ConnectorPinSchema.parse(raw), row = this.connectors.hostLifecycle(pin);
    return this.admissionForRow(pin,row);
  }
  private checked(raw: Pin,fingerprint: string) {
    const a = this.admission(raw);
    if (a.fingerprint !== fingerprint) throw new ConnectorHttpError("CONNECTOR_STALE");
    return a;
  }
  private result(pin: Pin,status: ConnectorHttpProjection["status"],reason: ConnectorHttpCode | null,tools: ConnectorHttpProjection["tools"] = []) {
    return ConnectorHttpProjectionSchema.parse({ ...pin,status,reason,readiness:"not_ready",authority:"none",executableCount:0,tools });
  }
  projection(raw: unknown) {
    try {
      const a = this.admission(raw), slot = this.slot(a.pin.id);
      if (!slot.projection || slot.fingerprint !== a.fingerprint || (slot.projection.status === "candidate" && (this.now()-slot.verified >= this.freshMs || this.now() >= slot.credentialExpires))) {
        this.clear(slot); return { ok:true as const,value:this.result(a.pin,"stale","CONNECTOR_STALE") };
      }
      if (a.row.auth.mode === "static" && slot.projection.status === "candidate") {
        try { this.validateCredential(a.row,a.profile); }
        catch { this.clear(slot); this.events.publish(); return failure("CONNECTOR_AUTH_FAILED"); }
      }
      return { ok:true as const,value:structuredClone(slot.projection) };
    } catch { return failure("CONNECTOR_STALE"); }
  }
  /** Read C1's reviewed candidate against the Connector row already pinned by
   * the caller's SQLite transaction. This path must not open another SQLite
   * transaction or mutate the slot while a release check is in progress. */
  reviewedProfileForConnector(row: LocalConnector): boolean {
    try {
      const a=this.admissionForRow({id:row.id,revision:row.revision},row);
      const slot=this.slots.get(row.id);
      return !!slot && slot.projection?.status==="candidate" && slot.fingerprint===a.fingerprint
        && this.now()-slot.verified < this.freshMs && this.now() < slot.credentialExpires;
    } catch { return false; }
  }
  private async operation(raw: unknown,work: (a: ReturnType<HostConnectorHttpService["admission"]>, signal: AbortSignal,check: () => void) => Promise<ConnectorHttpProjection>) {
    let slot: Slot | undefined, generation = -1;
    try {
      const requested = ConnectorPinSchema.parse(raw); slot = this.slot(requested.id);
      const a = this.admission(requested);
      if (slot.busy) return failure("CONNECTOR_BUSY");
      slot.projection = this.result(a.pin,"discovering",null); slot.fingerprint = a.fingerprint; slot.verified = 0; slot.busy = true; generation = ++slot.generation;
      const controller = new AbortController(); slot.abort = controller;
      const check = () => { if (slot!.generation !== generation || controller.signal.aborted) throw new ConnectorHttpError("CONNECTOR_STALE"); this.checked(a.pin,a.fingerprint); };
      const timer = setTimeout(() => controller.abort(),this.timeoutMs);
      try {
        const value = await work(a,controller.signal,check);
        if (slot.generation !== generation || !this.active()) throw new ConnectorHttpError("CONNECTOR_STALE");
        slot.projection = value; slot.fingerprint = this.admission({ id:value.id,revision:value.revision }).fingerprint; slot.verified = this.now();
        this.events.publish(); return { ok:true as const,value };
      } finally { clearTimeout(timer); }
    } catch (error) {
      const code = error instanceof ConnectorHttpError ? error.code : "CONNECTOR_HTTP_FAILED";
      if (slot && (generation === -1 || slot.generation === generation)) { this.clear(slot); this.events.publish(); }
      return failure(code);
    } finally { if (slot && slot.generation === generation) { slot.busy = false; slot.abort = null; } }
  }
  /** Browser launch is a trusted host callback; state/URL never enter a DTO. */
  async authorize(raw: unknown,open: (url: string) => void) {
    return this.operation(raw,async (a,signal,check) => {
      const oauth = a.profile.oauth; if (!oauth) throw authError();
      const slot = this.slot(a.pin.id);
      let redaction = slot.pending?.redaction ?? null;
      if (!redaction && a.row.auth.mode === "static") {
        let previous: Buffer | null = null;
        try { previous = this.consume(a.row); if (previous) redaction = this.decodePayload(previous,a.profile).redaction; }
        catch { /* Explicit reauthorization replaces a legacy/corrupt payload. */ }
        finally { previous?.fill(0); }
      }
      slot.pending?.state.fill(0); slot.pending?.verifier.fill(0); slot.pending = null;
      await this.http.validate(oauth.authorizeUrl,a.profile.allowedEndpoints,signal); check();
      const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      slot.pending = { state:Buffer.from(state),verifier:Buffer.from(verifier),expires:this.now()+300000,fingerprint:a.fingerprint,
        redaction:extendRedaction(redaction,"transient",[state,verifier,challenge]) };
      const url = new URL(oauth.authorizeUrl);
      url.search = new URLSearchParams({ response_type:"code",client_id:oauth.clientId,redirect_uri:oauth.redirectUri,
        state,code_challenge:challenge,code_challenge_method:"S256",scope:oauth.scopes.join(" ") }).toString();
      open(url.href); check();
      return this.result(a.pin,"stale","CONNECTOR_STALE");
    });
  }
  async callback(raw: unknown,callbackUrl: string) {
    // Consume before validation, including duplicate/wrong-identity callbacks.
    let pending: Pending | null = null;
    try { const pin = ConnectorPinSchema.parse(raw); const slot = this.slot(pin.id); pending = slot.pending; slot.pending = null; } catch { return failure("CONNECTOR_AUTH_STATE_INVALID"); }
    if (!pending) {
      const pin = ConnectorPinSchema.parse(raw); this.clear(this.slot(pin.id)); this.events.publish();
      return failure("CONNECTOR_AUTH_STATE_INVALID");
    }
    const owned = pending;
    try {
      return await this.operation(raw,async (a,signal,check) => {
        const oauth = a.profile.oauth;
        if (!oauth || owned.expires <= this.now() || owned.fingerprint !== a.fingerprint || callbackUrl.length > 16384) throw stateError();
        const url = new URL(callbackUrl), target = new URL(oauth.redirectUri), state = Buffer.from(url.searchParams.get("state") ?? "");
        if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash
          || [...url.searchParams.keys()].some((k) => !["state","code"].includes(k)) || url.searchParams.getAll("state").length !== 1
          || url.searchParams.getAll("code").length !== 1 || state.length !== owned.state.length || !timingSafeEqual(state,owned.state)) throw stateError();
        const code = secret.parse(url.searchParams.get("code"));
        const redaction = extendRedaction(owned.redaction,"transient",[code]);
        let previous: Payload | null = null, bytes: Buffer | null = null;
        try { bytes = this.consume(a.row); if (bytes) previous = this.decodePayload(bytes,a.profile); }
        catch { /* Explicit reauthorization can replace invalid/retired data. */ }
        finally { bytes?.fill(0); }
        check();
        // Commit proof BEFORE the first token request, including failed grants.
        // F5 CAS/staging and C0 revision fencing own this write, just like refresh.
        const attempted = this.save(a.row,previous ? { ...previous,redaction }
          : { kind:"oauth-pkce.attempt.v1",profile:hash(a.profile),redaction },true);
        const current = this.admission(attempted);
        const token = await this.token(a.profile,{ grant_type:"authorization_code",code,code_verifier:owned.verifier.toString(),redirect_uri:oauth.redirectUri },signal,redaction);
        if (signal.aborted) throw new ConnectorHttpError("CONNECTOR_STALE");
        this.checked(attempted,current.fingerprint);
        // Reauthorization was admitted before the request. A later revocation
        // must win; the response cannot start another credential lifecycle.
        const next = this.save(current.row,token); return this.result(next,"stale","CONNECTOR_STALE");
      });
    } finally { owned.state.fill(0); owned.verifier.fill(0); }
  }
  private async token(profile: ConnectorHttpProfile,fields: Record<string,string>,signal: AbortSignal,redaction: Redaction,previous?: Token): Promise<Token> {
    const oauth = profile.oauth; if (!oauth) throw authError();
    const matcher = new RedactionMatcher(redaction,"transient","CONNECTOR_AUTH_FAILED");
    const fullMatcher = new RedactionMatcher(redaction,undefined,"CONNECTOR_AUTH_FAILED");
    const response = await this.http.post(oauth.tokenUrl,[oauth.tokenUrl],new URLSearchParams({ ...fields,client_id:oauth.clientId }).toString(),
      { "content-type":"application/x-www-form-urlencoded" },signal,[],r => {
        fullMatcher.inspect(r.headers); inspectResponse(r,r.status >= 200 && r.status < 300 ? matcher : fullMatcher);
      });
    try {
      requireJson(response);
      const p = z.object({ access_token:bearer,refresh_token:secret.optional(),token_type:z.literal("Bearer"),
        expires_in:z.number().int().min(1).max(31536000),scope:z.string().max(4096).optional() }).strict().parse(JSON.parse(response.body));
      const scopes = p.scope === undefined ? previous?.scopes ?? oauth.scopes : p.scope.split(/ +/).filter(Boolean);
      if (oauth.scopes.some((s) => !scopes.includes(s))) throw authError();
      const refresh = p.refresh_token ?? previous?.refresh ?? null;
      const nextRedaction = extendRedaction(redaction,"credential",[p.access_token,...(refresh ? [refresh] : [])]);
      new RedactionMatcher(nextRedaction,undefined,"CONNECTOR_AUTH_FAILED").inspect({ scope:p.scope,token_type:p.token_type });
      return { kind:"oauth-pkce.v2",profile:hash(profile),access:p.access_token,refresh,
        expires:this.now()+p.expires_in*1000,scopes,redaction:nextRedaction };
    } catch { throw authError(); }
  }
  private consume(row: LocalConnector): Buffer | null {
    if (row.auth.mode === "none") return null;
    let value: Buffer | null = null;
    this.resolving = row.id;
    try {
      const result = this.credentials.consume(row.auth.credential,(bytes) => { value = Buffer.from(bytes); });
      if (!result.ok || !value) throw authError(); return value;
    } finally { this.resolving = null; }
  }
  private save(row: LocalConnector,token: Payload,reauthorize = false): Pin {
    let old = row.auth.mode === "static" ? row.auth.credential : null;
    if (old) {
      const version = this.credentials.version(old);
      const current = version ? this.credentials.inspect({ ...old,revision:version.revision }) : null;
      if (!current?.ok) throw authError();
      if (current.value.state === "tombstoned" || current.value.state === "revoked") {
        if (!reauthorize) throw authError();
        old = null;
      }
    }
    const p: CredentialRequest = old ?? { connector_id:row.id,credential_ref:randomUUID(),revision:0 };
    const saved = this.credentials.save(p,() => Buffer.from(JSON.stringify(token)),!!old);
    if (!saved.ok) throw authError();
    const credential = { connector_id:row.id,credential_ref:p.credential_ref,revision:saved.value.revision };
    this.connectors.rotate({ schema_version:LOCAL_CONTRACT_VERSION,request_id:randomUUID(),idempotency_key:randomUUID(),...this.connectors.authority() },
      { id:row.id,revision:row.revision,credential });
    return { id:row.id,revision:row.revision+1 };
  }
  private decodePayload(bytes: Buffer,profile: ConnectorHttpProfile): Payload {
    try {
      const token = payloadSchema.parse(JSON.parse(bytes.toString()));
      validateRedaction(token.redaction);
      if (token.profile !== hash(profile) || !token.redaction.fingerprints.some(f => f.kind === "transient")) throw authError();
      if (token.kind === "oauth-pkce.v2" && (!coversCredential(token.redaction,token.access)
        || (token.refresh && !coversCredential(token.redaction,token.refresh)))) throw authError();
      return token;
    } catch { throw authError(); }
  }
  private decode(bytes: Buffer,profile: ConnectorHttpProfile): Token {
    const payload = this.decodePayload(bytes,profile);
    if (payload.kind !== "oauth-pkce.v2") throw authError();
    return payload;
  }
  private validateCredential(row: LocalConnector,profile: ConnectorHttpProfile) {
    const bytes = this.consume(row);
    try {
      if (!bytes) throw authError();
      if (profile.oauth) this.decode(bytes,profile); else bearer.parse(bytes.toString());
    } finally { bytes?.fill(0); }
  }
  /** Explicit refresh invalidates discovery even when the token has not expired. */
  async refresh(raw: unknown) {
    return this.operation(raw,async (a,signal,check) => {
      const bytes = this.consume(a.row); if (!bytes) throw authError();
      try {
        const old = this.decode(bytes,a.profile); if (!old.refresh) throw authError();
        const token = await this.token(a.profile,{ grant_type:"refresh_token",refresh_token:old.refresh },signal,old.redaction,old);
        check(); const next = this.save(a.row,token); return this.result(next,"stale","CONNECTOR_STALE");
      } finally { bytes.fill(0); }
    });
  }
  test(raw: unknown) { return this.discover(raw); }
  reconnect(raw: unknown) { return this.discover(raw); }
  async discover(raw: unknown) {
    return this.operation(raw,async (a,signal,check) => {
      let bytes = this.consume(a.row), access: string | null = null;
      let redaction: Redaction | null = null;
      let pin = a.pin, row = a.row, credentialExpires = Infinity;
      try {
        if (a.profile.oauth) {
          if (!bytes) throw authError();
          let token = this.decode(bytes,a.profile);
          if (token.expires <= this.now()+30000) {
            if (!token.refresh) throw authError();
            token = await this.token(a.profile,{ grant_type:"refresh_token",refresh_token:token.refresh },signal,token.redaction,token); check();
            pin = this.save(row,token); row = this.connectors.hostLifecycle(pin);
          }
          credentialExpires = token.expires; access = token.access; redaction = token.redaction;
        } else if (bytes) { access = bearer.parse(bytes.toString()); redaction = extendRedaction(null,"credential",[access]); }
        bytes?.fill(0); bytes = null;
        const fingerprint = this.admission(pin).fingerprint;
        const live = () => {
          if (signal.aborted) throw new ConnectorHttpError("CONNECTOR_HTTP_TIMEOUT");
          if (this.now() >= credentialExpires) throw authError();
          this.checked(pin,fingerprint);
          if (row.auth.mode === "static") {
            this.validateCredential(row,a.profile);
          }
        };
        const matcher = redaction ? new RedactionMatcher(redaction) : null;
        let session: string | undefined;
        const post = async (method: string,params: unknown,notification = false): Promise<Record<string,unknown>> => {
          live(); const id = randomUUID();
          const response = await this.http.post(a.profile.endpoint,a.profile.allowedEndpoints,
            JSON.stringify({ jsonrpc:"2.0",...(notification ? {} : { id }),method,params }),
            { "content-type":"application/json",accept:"application/json",...(access ? { authorization:`Bearer ${access}` } : {}),
              ...(session ? { "mcp-session-id":session,"mcp-protocol-version":"2025-03-26" } : {}) },signal,
            row.config.transport === "http" ? row.config.trustedRedirectHosts : [],r => { if (matcher) inspectResponse(r,matcher); });
          live();
          const sid = response.headers["mcp-session-id"];
          if (sid !== undefined) { if (typeof sid !== "string" || !/^[\x21-\x7e]{1,256}$/.test(sid)) throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID"); session = sid; }
          // Every successful response needs one unambiguous JSON media field,
          // including empty notification acknowledgements without credentials.
          requireJson(response);
          if (notification) return {};
          let p;
          try { p = z.object({ jsonrpc:z.literal("2.0"),id:z.literal(id),result:z.record(z.unknown()) }).strict().parse(JSON.parse(response.body)); }
          catch { throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID"); }
          matcher?.inspect(p);
          return p.result;
        };
        const init = await post("initialize",{ protocolVersion:"2025-03-26",capabilities:{},clientInfo:{ name:"orchestrion-local",version:"1" } });
        if (init.protocolVersion !== "2025-03-26" || !init.capabilities || typeof init.capabilities !== "object" || !("tools" in init.capabilities)) throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID");
        await post("notifications/initialized",{},true);
        const tools: ConnectorHttpProjection["tools"] = [], names = new Set<string>(), cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 8; page++) {
          const result = await post("tools/list",cursor ? { cursor } : {});
          if (!Array.isArray(result.tools) || result.tools.length > 256) throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID");
          for (const rawTool of result.tools) {
            let tool;
            try {
              const p = z.object({ name:z.string(),inputSchema:z.record(z.unknown()),outputSchema:z.record(z.unknown()).optional() }).parse(rawTool);
              tool = ConnectorCandidateSchema.parse({ name:p.name,inputSchema:p.inputSchema,outputSchema:p.outputSchema ?? null });
              if (tool.inputSchema.type !== "object") throw authError();
            } catch { throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID"); }
            if (names.has(tool.name) || tools.length >= 256) throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID");
            names.add(tool.name); tools.push(tool);
          }
          if (result.nextCursor === undefined) { live(); this.slot(pin.id).credentialExpires = credentialExpires; return this.result(pin,"candidate",null,tools); }
          if (typeof result.nextCursor !== "string" || !result.nextCursor.length || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID");
          cursor = result.nextCursor; cursors.add(cursor);
        }
        throw new ConnectorHttpError("CONNECTOR_DISCOVERY_INVALID");
      } finally { bytes?.fill(0); access = null; redaction = null; }
    });
  }
  async disconnect(raw: unknown) {
    let bytes: Buffer | null = null;
    try {
      const a = this.admission(raw), slot = this.slot(a.pin.id);
      this.clear(slot); // Abort callbacks/refresh/discovery before retiring bytes.
      try { bytes = this.consume(a.row); } catch { /* local retirement still required */ }
      if (a.row.auth.mode === "static") {
        const p = a.row.auth.credential, version = this.credentials.version(p);
        if (!version) { bytes?.fill(0); throw authError(); }
        const current = { ...p,revision:version.revision }, inspected = this.credentials.inspect(current);
        if (!inspected.ok || (inspected.value.state !== "tombstoned" && !this.credentials.retire(current,true).ok)) { bytes?.fill(0); throw authError(); }
        if (!this.credentials.cleanup(p)) { bytes?.fill(0); throw authError(); }
      }
      // Durable revision fences other instances and disconnect without credentials.
      this.connectors.disable({ schema_version:LOCAL_CONTRACT_VERSION,request_id:randomUUID(),idempotency_key:randomUUID(),...this.connectors.authority() },a.pin);
      const pin = { id:a.pin.id,revision:a.pin.revision+1 };
      slot.projection = this.result(pin,"disconnected","CONNECTOR_DISCONNECTED"); slot.fingerprint = this.admission(pin).fingerprint;
      const disconnected = structuredClone(slot.projection);
      this.events.publish();
      let remoteRevocation: "confirmed" | "unconfirmed" | "not_applicable" = a.profile.oauth ? "unconfirmed" : "not_applicable";
      if (bytes) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(),this.timeoutMs);
        try {
          const oauth = a.profile.oauth;
          if (oauth?.revokeUrl) {
            const token = this.decode(bytes,a.profile);
            for (const value of new Set([token.access,...(token.refresh ? [token.refresh] : [])])) {
              this.checked(pin,slot.fingerprint!);
              await this.http.post(oauth.revokeUrl,[oauth.revokeUrl],new URLSearchParams({ token:value,client_id:oauth.clientId }).toString(),
                { "content-type":"application/x-www-form-urlencoded" },controller.signal);
            }
            remoteRevocation = "confirmed";
          }
        } catch { remoteRevocation = "unconfirmed"; }
        finally { clearTimeout(timer); bytes.fill(0); }
      }
      return { ok:true as const,value:ConnectorDisconnectSchema.parse({ ...disconnected,remoteRevocation }) };
    } catch { return failure("CONNECTOR_AUTH_FAILED"); }
    finally { bytes?.fill(0); }
  }
  close() { this.stopped = true; for (const slot of this.slots.values()) this.clear(slot); }
}
