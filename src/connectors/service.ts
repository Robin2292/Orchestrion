import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalContextSchema, LocalCommandHeaderSchema, type LocalContext, type LocalCommandHeader } from "../shared/local-contracts";
import { CredentialRequestSchema } from "../shared/credential-contracts";
import { ConnectorCreateSchema, ConnectorUpdateSchema, ConnectorRotateSchema, ConnectorPinSchema, ConnectorIdSchema,
  ConnectorPageSchema, ConnectorImportSchema, RunnerConnectorConfigSchema, ConnectorProjectionSchema, type LocalConnector } from "../shared/connector-contracts";
import { canonical, parseCanonical, type Json } from "../shared/policy/p0-canonical";
import { toolJson } from "../tools/registry";
import type { ToolPolicySource } from "../shared/tool-policy-source";
import { ToolDefinitionSchema } from "../shared/tool-registry-contracts";
import type { CredentialAuthority } from "../main/credentials/service";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { ConnectorRepository, CONNECTOR_FENCE } from "./repository";

const stateSchema = CredentialRequestSchema.extend({ state:z.enum(["active","revoked","tombstoned"]) }).strict();
const cleanupMaterialSchema = z.object({ context:LocalContextSchema,id:z.string().uuid(),revision:z.number().int().nonnegative().safe(),
  origin:z.enum(["local","runner"]),bindings:z.array(CredentialRequestSchema),credentials:z.array(stateSchema) }).strict();
export const ConnectorCleanupProofSchema = cleanupMaterialSchema.extend({ proofRef:z.string().uuid(),released:z.literal(true) }).strict();
const runnerProofSchema = z.object({ context:LocalContextSchema, config:RunnerConnectorConfigSchema }).strict();
/** Trusted host integration only. These synchronous readers must obtain owned
 * historical rows / completed cleanup evidence, never echo request claims or do
 * Keychain/network I/O inside a SQLite transaction. No renderer registration.
 * released attests ALL known F5 versions (including staged bytes) and historical
 * Runner resources are gone. F5 retirement is independently rechecked below.
 */
export interface ConnectorHostAuthority {
  runnerImport?(tx: SqliteUnit, context: LocalContext, sourceId: string): unknown;
  cleanupProof?(tx: SqliteUnit, context: LocalContext, id: string): unknown;
}
export class LocalConnectorService {
  readonly #context: LocalContext;
  constructor(private readonly store: SqliteFoundation, context: LocalContext,
    private readonly host: ConnectorHostAuthority = {}, private readonly clock = () => new Date()) {
    this.#context = LocalContextSchema.parse(context);
    this.read((r) => r.ensureFence());
  }
  get context() { return structuredClone(this.#context); }
  private read<T>(work: (r: ConnectorRepository,tx: SqliteUnit) => T): T {
    return this.store.transaction((tx) => { const r = new ConnectorRepository(tx,this.context); r.authorize(); return work(r,tx); });
  }
  authority() { return { context:this.context,runtime_owner:this.store.owner,expected:this.read((r) => r.pin()),run:null }; }
  private parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
    try {
      const bytes = toolJson(raw), parsed = schema.parse(parseCanonical(bytes));
      if (canonical(parsed) !== bytes) throw new Error();
      return parsed;
    } catch { throw new StorageError("INVALID_PAYLOAD"); }
  }
  private mutate(header: LocalCommandHeader, command: string, payload: unknown, work: (r: ConnectorRepository,tx: SqliteUnit) => string) {
    const h = this.parse(LocalCommandHeaderSchema,header);
    if (h.run !== null) throw new StorageError("INVALID_PAYLOAD");
    // F4 replay skips the mutation callback. Re-authorize before replay too.
    this.read((r) => r.authorize(true));
    const bytes = canonical(payload as Json);
    const result = this.store.commit({ trustedContext:this.context,header:h,command,resourceKey:CONNECTOR_FENCE,
      canonicalContent:bytes,nextHash:`sha256:${createHash("sha256").update(bytes).digest("hex")}` },(tx) => {
      const r = new ConnectorRepository(tx,this.context); r.authorize(true); return work(r,tx);
    });
    return { resultRef:result.resultRef };
  }
  private pinned(r: ConnectorRepository, p: { id:string; revision:number }) {
    const row = r.get(p.id);
    if (row.revision !== p.revision || row.revision === Number.MAX_SAFE_INTEGER) throw new StorageError("CONNECTOR_REVISION_CONFLICT");
    if (row.deletedAt) throw new StorageError("CONNECTOR_DELETED");
    return row;
  }
  private activeCredential(r: ConnectorRepository, id: string, p: z.infer<typeof CredentialRequestSchema>) {
    if (p.connector_id !== id) throw new StorageError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
    try {
      const row = r.credentials.get({ connector_id:id,credential_ref:p.credential_ref });
      if (row.revision !== p.revision || row.state !== "active") throw new Error();
    } catch { throw new StorageError("CONNECTOR_CREDENTIAL_UNAVAILABLE"); }
  }
  create(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorCreateSchema,raw);
    return this.mutate(header,"connector.create",p,(r) => {
      r.requireName(p.config.name,p.id);
      if (p.auth.mode === "static") this.activeCredential(r,p.id,p.auth.credential);
      const now = this.clock().toISOString();
      const row: LocalConnector = { ...p,schemaVersion:"orchestrion.local.connector.v1",context:this.context,revision:0,
        origin:"local",status:"inactive",cleanupRequired:p.auth.mode === "static" || r.credentialStates(p.id).length > 0,createdAt:now,updatedAt:now,deletedAt:null };
      r.insert(row); r.bind(row); return row.id;
    });
  }
  /** Identity-only Web migration. The payload selects a source; the host owns
   * its org/project/principal mapping and deliberately sanitized Web metadata. */
  importRunner(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorImportSchema,raw);
    return this.mutate(header,"connector.import-runner",p,(r,tx) => {
      let proof;
      try { proof = runnerProofSchema.parse(this.host.runnerImport?.(tx,this.context,p.sourceId)); }
      catch { throw new StorageError("CONNECTOR_IMPORT_UNAVAILABLE"); }
      if (canonical(proof.context) !== canonical(this.context) || proof.config.sourceId !== p.sourceId)
        throw new StorageError("CONNECTOR_IMPORT_UNAVAILABLE");
      r.requireName(proof.config.name,p.id);
      const now = this.clock().toISOString();
      r.insert({ schemaVersion:"orchestrion.local.connector.v1",context:this.context,id:p.id,revision:0,config:proof.config,
        auth:{ mode:"none" },origin:"runner",status:"inactive",cleanupRequired:true,createdAt:now,updatedAt:now,deletedAt:null });
      return p.id;
    });
  }
  update(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorUpdateSchema,raw);
    return this.mutate(header,"connector.update",p,(r) => {
      const row = this.pinned(r,p);
      if (row.origin === "runner") throw new StorageError("CONNECTOR_CLEANUP_REQUIRED");
      r.requireName(p.config.name,p.id);
      r.replace({ ...row,config:p.config,revision:row.revision+1,updatedAt:this.clock().toISOString() }); return row.id;
    });
  }
  disable(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorPinSchema,raw);
    return this.mutate(header,"connector.disable",p,(r) => {
      const row = this.pinned(r,p);
      r.replace({ ...row,revision:row.revision+1,updatedAt:this.clock().toISOString() }); return row.id;
    });
  }
  /** Reference rotation only. Secret staging/rotation and retired-byte cleanup
   * remain in F5 outside this transaction. Neither source nor bytes are API input. */
  rotate(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorRotateSchema,raw);
    return this.mutate(header,"connector.rotate",p,(r) => {
      const row = this.pinned(r,p);
      if (row.origin === "runner") throw new StorageError("CONNECTOR_CLEANUP_REQUIRED");
      this.activeCredential(r,p.id,p.credential);
      if (row.auth.mode === "static") {
        const old = row.auth.credential;
        if (old.credential_ref === p.credential.credential_ref) {
          if (p.credential.revision <= old.revision) throw new StorageError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
        } else {
          const state = r.credentialStates(row.id).find((v) => v.credential_ref === old.credential_ref);
          if (!state || state.state === "active") throw new StorageError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
        }
      }
      const next: LocalConnector = { ...row,auth:{ mode:"static",credential:p.credential },cleanupRequired:true,
        revision:row.revision+1,updatedAt:this.clock().toISOString() };
      r.replace(next); r.bind(next); return row.id;
    });
  }
  delete(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(ConnectorPinSchema,raw);
    return this.mutate(header,"connector.delete",p,(r,tx) => {
      const row = this.pinned(r,p), credentials = r.credentialStates(row.id);
      const staging = r.staging(row.id);
      // No external proof can override an unresolved F5 write-ahead obligation.
      if (staging.some((s) => s.state === "pending" || (s.state === "published"
        && !credentials.some((c) => c.credential_ref === s.credential_ref && c.revision >= Number(s.revision)))))
        throw new StorageError("CONNECTOR_CLEANUP_REQUIRED");
      let proofRef = staging.length ? "f5-staging-cleared" : "no-external-resources";
      if (row.cleanupRequired || credentials.length) {
        const material = { context:this.context,id:row.id,revision:row.revision,origin:row.origin,bindings:r.bindings(row.id),credentials };
        let proof;
        try { proof = ConnectorCleanupProofSchema.parse(this.host.cleanupProof?.(tx,this.context,row.id)); }
        catch { throw new StorageError("CONNECTOR_CLEANUP_REQUIRED"); }
        const { proofRef:ref,released:_released,...observed } = proof; void _released;
        if (credentials.some((c) => c.state !== "tombstoned") || canonical(observed) !== canonical(material))
          throw new StorageError("CONNECTOR_CLEANUP_REQUIRED");
        proofRef = ref;
      }
      const now = this.clock().toISOString(), next = { ...row,revision:row.revision+1,cleanupRequired:false,updatedAt:now,deletedAt:now };
      r.replace(next); r.tombstone(next,proofRef); return row.id;
    });
  }
  get(raw: unknown) { const p = this.parse(ConnectorIdSchema,raw); return this.read((r) => r.get(p.id)); }
  /** Host lifecycle admission, never Tool execution authority. Rechecks live
   * membership and the durable Connector revision after asynchronous I/O. */
  hostLifecycle(raw: unknown) {
    const p = this.parse(ConnectorPinSchema,raw);
    return this.read((r) => { r.authorize(true); return this.pinned(r,p); });
  }
  list(raw: unknown) { const p = this.parse(ConnectorPageSchema,raw); return this.read((r) => r.list(p.limit,p.offset)); }
  projection(raw: unknown) {
    const row = this.get(raw);
    return ConnectorProjectionSchema.parse({ connector:row,authority:"none",availability:"unavailable",execution:"not_ready",
      reason:row.deletedAt ? "CONNECTOR_DELETED" : row.cleanupRequired ? "CONNECTOR_CLEANUP_REQUIRED" : "CONNECTOR_TRANSPORT_UNAVAILABLE",
      stdioReadiness:row.config.transport === "stdio" ? {
        state:"not_ready",code:"CONNECTOR_STDIO_CONTAINMENT_UNAVAILABLE",retryable:false,
      } : null,
      tools:[],toolCount:0,executableCount:0 });
  }
  /** C0 composition with the existing T1 inventory. No Connector has transport
   * or accepted discovery proof yet, so none can supply policy-ready metadata.
   * Later transport/release owners must compose readiness AND P1 policy here. */
  inventorySource(): ToolPolicySource {
    return { metadata:(raw) => {
      const definition = this.parse(ToolDefinitionSchema,raw);
      if (canonical(definition.context) !== canonical(this.context)) throw new StorageError("CONTEXT_MISMATCH");
      this.projection({ id:definition.connectorId });
      return null;
    } };
  }
  /** F5 host composition: C0 may manage references but cannot resolve secrets
   * for execution. Create an unauthenticated Connector first, save through F5,
   * then rotate its reference. Deleted identities retain host retirement only.
   * This authority is host-only and rechecks live membership on every operation. */
  credentialAuthority(): CredentialAuthority {
    const owner = canonical(this.store.owner);
    return {
      isActive:() => { try { return canonical(this.store.owner) === owner; } catch { return false; } },
      allow:(operation,id) => {
        if (operation === "resolve") return false;
        try { return this.read((r) => {
          r.authorize(operation !== "inspect");
          const row = r.get(id);
          if (row.deletedAt) return operation === "cleanup" || operation === "repair" || operation === "revoke" || operation === "tombstone";
          if (row.origin === "runner" && (operation === "create" || operation === "rotate")) return false;
          return true;
        }); } catch { return false; }
      },
    };
  }
}
