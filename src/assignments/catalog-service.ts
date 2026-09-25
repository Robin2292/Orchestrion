import { AGENT_FENCE, AGENT_INITIAL_HASH } from "../agents/repository";
import { LocalContextSchema, LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { LocalAssignmentRepository } from "./repository";

/** Host-owned read projection. Constructing or reading it never creates a fence. */
export class LocalAgentCatalogService {
  readonly context: LocalContext;
  constructor(private readonly store: SqliteFoundation, context: LocalContext) {
    this.context=LocalContextSchema.parse(context);
  }
  private read<T>(work:(r:LocalAssignmentRepository,tx:SqliteUnit)=>T):T {
    return this.store.transaction(tx=>{
      const r=new LocalAssignmentRepository(tx,this.context);r.authorize();
      return work(r,tx);
    });
  }
  private expected(tx:SqliteUnit) {
    const c=this.context;
    const row=tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      c.org_id,c.project_id,AGENT_FENCE);
    return row ? {revision:Number(row.revision),hash:String(row.hash)} : {revision:0,hash:AGENT_INITIAL_HASH};
  }
  list(limit:number,offset:number) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0)
      throw new StorageError("INVALID_PAYLOAD");
    return this.read((r,tx)=>({items:r.catalog(limit,offset),total:r.catalogTotal(),canAdd:r.canAdd(),
      expected:this.expected(tx)}));
  }
  detail(agentId:string,limit:number,offset:number) {
    agentId=LocalIdSchema.parse(agentId);
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0)
      throw new StorageError("INVALID_PAYLOAD");
    return this.read((r,tx)=>{
      const row=r.catalogIdentity(agentId);
      if (!row) {
        const identity=r.identity(agentId);
        if (identity && (identity.visibility==="organization" || identity.home_project_id===this.context.project_id))
          throw new StorageError("AGENT_CATALOG_NOT_READY");
        throw new StorageError("AGENT_CATALOG_NOT_FOUND");
      }
      return {item:row,versions:r.catalogVersions(row,limit,offset),totalVersions:r.catalogVersionTotal(row),
        canAdd:r.canAdd(),expected:this.expected(tx)};
    });
  }
}
