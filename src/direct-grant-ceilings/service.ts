import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantDigest } from "../grants/repository";
import { LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { ToolGrantSchema, grantCanonicalJson, normalizeToolGrants, type ToolGrant } from "../shared/tool-grant-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { LocalDirectGrantCeilingRepository, type CeilingSubject, type DirectGrantCeilings } from "./repository";

const keySchema=z.string().uuid();
function expectedRevision(value:number|null):number|null {
  if (value===null) return null;
  if (!Number.isSafeInteger(value) || value<1) throw new StorageError("DIRECT_GRANT_REVISION_INVALID");
  return value;
}
function tuple(raw:unknown):ToolGrant {
  return normalizeToolGrants({schema_version:"tool_grants@1",grants:[ToolGrantSchema.parse(raw)]}).grants[0];
}

/** Trusted utility-host entry only. No renderer route or execution admission. */
export class LocalDirectGrantCeilingService {
  readonly context:LocalContext;
  constructor(private readonly store:SqliteFoundation,private readonly clock:()=>Date=()=>new Date()) {
    this.context=store.workspace;
  }
  private now():string {return this.clock().toISOString().slice(0,19)+"Z";}
  private write(subjectKind:CeilingSubject,subjectId:string,action:"grant"|"revoke",
    expected:number|null,grant:ToolGrant|null,targetVersionId:string|null,key:string):{versionId:string;revision:number} {
    expected=expectedRevision(expected);
    key=keySchema.parse(key);
    const requestHash=grantDigest({subjectKind,subjectId,action,expected,
      grant:grant===null?null:grantCanonicalJson(grant),targetVersionId});
    return this.store.transaction(tx=>{
      const r=new LocalDirectGrantCeilingRepository(tx,this.context);
      r.assertHumanGrantor();
      if (subjectKind==="agent") r.assertLiveAgent(subjectId);
      const replay=r.replay(subjectKind,subjectId,key);
      if (replay) {
        if (replay.request_hash!==requestHash) throw new StorageError("DIRECT_GRANT_REPLAY_CONFLICT");
        return {versionId:replay.event_id,revision:replay.revision};
      }
      const current=r.latest(subjectKind,subjectId);
      if ((current?.revision??null)!==expected) throw new StorageError("DIRECT_GRANT_REVISION_CONFLICT");
      if (action==="revoke" && !targetVersionId) throw new StorageError("DIRECT_GRANT_VERSION_INACTIVE");
      const active=r.active(subjectKind,subjectId);
      if (action==="revoke" && !active.some(g=>g.versionId===targetVersionId))
        throw new StorageError("DIRECT_GRANT_VERSION_INACTIVE");
      if (action==="grant" && active.some(g=>grantCanonicalJson(g.grant)===grantCanonicalJson(grant)))
        throw new StorageError("DIRECT_GRANT_DUPLICATE_TUPLE");
      if (action==="grant" && active.length>=512) throw new StorageError("DIRECT_GRANT_LIMIT");
      let parent:string|null=null;
      if (action==="grant" && subjectKind==="agent") {
        const matching=r.active("organization",this.context.org_id).filter(g=>
          grantCanonicalJson(g.grant)===grantCanonicalJson(grant));
        if (matching.length!==1) throw new StorageError("DIRECT_GRANT_ORGANIZATION_CEILING_REQUIRED");
        parent=matching[0].versionId;
      }
      const revision=(expected??0)+1;
      if (!Number.isSafeInteger(revision)) throw new StorageError("DIRECT_GRANT_REVISION_CONFLICT");
      const versionId=randomUUID();
      r.append(subjectKind,subjectId,versionId,revision,action,grant,parent,targetVersionId,key,requestHash,this.now());
      return {versionId,revision};
    });
  }
  grantOrganization(expected:number|null,rawGrant:unknown,idempotencyKey:string) {
    return this.write("organization",this.context.org_id,"grant",expected,tuple(rawGrant),null,idempotencyKey);
  }
  revokeOrganization(expected:number,versionId:string,idempotencyKey:string) {
    return this.write("organization",this.context.org_id,"revoke",expected,null,LocalIdSchema.parse(versionId),idempotencyKey);
  }
  grantAgent(agentPrincipalId:string,expected:number|null,rawGrant:unknown,idempotencyKey:string) {
    return this.write("agent",LocalIdSchema.parse(agentPrincipalId),"grant",expected,tuple(rawGrant),null,idempotencyKey);
  }
  revokeAgent(agentPrincipalId:string,expected:number,versionId:string,idempotencyKey:string) {
    return this.write("agent",LocalIdSchema.parse(agentPrincipalId),"revoke",expected,null,LocalIdSchema.parse(versionId),idempotencyKey);
  }
  static resolveForAssignment(tx:SqliteUnit,context:LocalContext,assignmentId:string,projectId:string):DirectGrantCeilings {
    return new LocalDirectGrantCeilingRepository(tx,context).resolveForAssignment(assignmentId,projectId);
  }
}
