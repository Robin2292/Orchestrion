import { LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { LocalBudgetCeilingRepository, type LocalBudgetBounds, type LocalBudgetCeilings } from "./repository";

function validBounds(value: unknown): value is LocalBudgetBounds {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const b=value as Record<string,unknown>;
  return Object.keys(b).sort().join(",")==="costUsd,modelTokens,toolCalls"
    && typeof b.modelTokens==="number" && Number.isSafeInteger(b.modelTokens) && b.modelTokens>0
    && typeof b.toolCalls==="number" && Number.isSafeInteger(b.toolCalls) && b.toolCalls>0
    && typeof b.costUsd==="number" && Number.isFinite(b.costUsd)
    && b.costUsd>=0 && b.costUsd<=1_000_000_000_000_000;
}

function revision(value: number | null): number | null {
  if (value===null) return null;
  if (!Number.isSafeInteger(value) || value<1) throw new StorageError("BUDGET_REVISION_INVALID");
  return value;
}

/** Trusted utility-host API only. No IPC, renderer, or Assignment release route. */
export class LocalBudgetCeilingService {
  readonly context: LocalContext;
  constructor(private readonly store: SqliteFoundation, private readonly clock: () => Date = () => new Date()) {
    this.context=store.workspace;
  }
  private now(): string { return this.clock().toISOString().slice(0,19)+"Z"; }
  private inTransaction<T>(work:(r:LocalBudgetCeilingRepository,tx:SqliteUnit)=>T):T {
    return this.store.transaction(tx => {
      const r=new LocalBudgetCeilingRepository(tx,this.context);
      r.assertHumanGrantor();
      return work(r,tx);
    });
  }
  private next(current:{revision:number}|null, expected:number|null):number {
    if ((current ? Number(current.revision) : null)!==expected)
      throw new StorageError("BUDGET_REVISION_CONFLICT");
    const next=(expected??0)+1;
    if (!Number.isSafeInteger(next)) throw new StorageError("BUDGET_REVISION_CONFLICT");
    return next;
  }
  grantOrganization(expectedRevision:number|null, bounds:unknown):number {
    expectedRevision=revision(expectedRevision);
    if (!validBounds(bounds)) throw new StorageError("BUDGET_CEILING_INVALID");
    return this.inTransaction(r => {
      const next=this.next(r.latestOrganization(),expectedRevision);
      r.appendOrganization("grant",next,bounds,this.now()); return next;
    });
  }
  revokeOrganization(expectedRevision:number):number {
    revision(expectedRevision);
    return this.inTransaction(r => {
      const current=r.latestOrganization();
      if (!current || current.action!=="grant") throw new StorageError("BUDGET_CEILING_REQUIRED");
      const next=this.next(current,expectedRevision);
      r.appendOrganization("revoke",next,{modelTokens:Number(current.model_tokens),
        toolCalls:Number(current.tool_calls),costUsd:Number(current.cost_usd)},this.now()); return next;
    });
  }
  grantAgent(agentPrincipalId:string, expectedRevision:number|null, bounds:unknown):number {
    agentPrincipalId=LocalIdSchema.parse(agentPrincipalId); expectedRevision=revision(expectedRevision);
    if (!validBounds(bounds)) throw new StorageError("BUDGET_CEILING_INVALID");
    return this.inTransaction(r => {
      r.assertLiveAgent(agentPrincipalId);
      const organization=r.latestOrganization();
      if (!organization || organization.action!=="grant") throw new StorageError("BUDGET_CEILING_REQUIRED");
      if (bounds.modelTokens>Number(organization.model_tokens)
          || bounds.toolCalls>Number(organization.tool_calls)
          || bounds.costUsd>Number(organization.cost_usd)) throw new StorageError("BUDGET_CEILING_EXCEEDED");
      const next=this.next(r.latestAgent(agentPrincipalId),expectedRevision);
      r.appendAgent(agentPrincipalId,"grant",next,bounds,this.now()); return next;
    });
  }
  revokeAgent(agentPrincipalId:string, expectedRevision:number):number {
    agentPrincipalId=LocalIdSchema.parse(agentPrincipalId); revision(expectedRevision);
    return this.inTransaction(r => {
      const current=r.latestAgent(agentPrincipalId);
      if (!current || current.action!=="grant") throw new StorageError("BUDGET_CEILING_REQUIRED");
      const next=this.next(current,expectedRevision);
      r.appendAgent(agentPrincipalId,"revoke",next,{modelTokens:Number(current.model_tokens),
        toolCalls:Number(current.tool_calls),costUsd:Number(current.cost_usd)},this.now()); return next;
    });
  }
  /** Call from a caller-owned SQLite transaction, so live reads serialize with writes. */
  static resolveForAssignment(tx:SqliteUnit, context:LocalContext,
                              assignmentId:string, projectId:string):LocalBudgetCeilings {
    return new LocalBudgetCeilingRepository(tx,context).resolveForAssignment(assignmentId,projectId);
  }
}
