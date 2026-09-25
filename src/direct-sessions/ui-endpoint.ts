import { ZodError, type z } from "zod";
import { LOCAL_CONTRACT_VERSION } from "../shared/local-contracts";
import { LocalDirectSessionErrorCodeSchema, LocalDirectSessionReplySchema,
  LocalDirectSessionRequestSchema, LocalDirectSessionValueSchema,
  type LocalDirectSessionReply } from "../shared/direct-session-ui-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import { DirectSessionService } from "./service";

const failure=(code:z.infer<typeof LocalDirectSessionErrorCodeSchema>):LocalDirectSessionReply=>
  ({ok:false,error:{code,retryable:false}});

/** Renderer cannot supply principal, runtime owner or execution binding. */
export class LocalDirectSessionUiEndpoint {
  constructor(private readonly resolve:()=>DirectSessionService|null) {}
  async invoke(raw:unknown,isActive:()=>boolean):Promise<LocalDirectSessionReply> {
    const parsed=LocalDirectSessionRequestSchema.safeParse(raw);
    if (!parsed.success) return failure("INVALID_PAYLOAD");
    if (!isActive()) return failure("NOT_AUTHENTICATED");
    let invoked=false;
    try {
      const s=this.resolve();
      if (!s) return failure("SERVICE_UNAVAILABLE");
      const request=parsed.data;
      const projectSession=(row:NonNullable<ReturnType<DirectSessionService["get"]>>) => {
        const attempt=s.latestAttempt(row.id);
        return {id:row.id,projectId:row.project_id,agentId:row.agent_id,
          agentVersionId:row.agent_version_id,assignmentId:row.assignment_id,
          assignmentVersionId:row.assignment_version_id,lifecycle:row.lifecycle,
          title:row.title,createdAt:row.created_at,provenance:"released" as const,
          latestAttempt:attempt?{number:attempt.attempt_number,outcome:attempt.outcome}:null};
      };
      if (request.operation==="list") {
        return LocalDirectSessionReplySchema.parse({ok:true,value:LocalDirectSessionValueSchema.parse({
          kind:"page",expected:s.authority().expected,
          items:s.list(request.limit,request.offset).map(projectSession),
        })});
      }
      if (request.operation==="get") {
        const row=s.get(request.sessionId);
        return LocalDirectSessionReplySchema.parse({ok:true,value:LocalDirectSessionValueSchema.parse({
          kind:"detail",expected:s.authority().expected,
          session:row?.provenance==="released" ? {...projectSession(row),deleted:row.deleted_at!==null,
            deleting:row.deletion_state==="pending" && row.deleted_at===null} : null,
        })});
      }
      const header={...s.authority(),expected:request.expected,schema_version:LOCAL_CONTRACT_VERSION,
        request_id:request.requestId,idempotency_key:request.idempotencyKey};
      if (!isActive()) return failure("NOT_AUTHENTICATED");
      invoked=true;
      const result=request.operation==="create"
        ? s.create(header,request.payload.assignmentId,request.payload.assignmentVersionId,request.payload.title)
        : request.operation==="rename" ? s.rename(header,request.payload.sessionId,request.payload.title)
        : request.operation==="archive" ? s.archive(header,request.payload.sessionId)
        : request.operation==="restore" ? s.restore(header,request.payload.sessionId)
        : await s.delete(header,request.payload.sessionId,async _pin=>{
          if (!isActive()) throw new StorageError("NOT_AUTHENTICATED");
          // There is no live Direct provider owner in this host yet.
          throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
        });
      return LocalDirectSessionReplySchema.parse({ok:true,value:LocalDirectSessionValueSchema.parse({
        kind:"command",expected:s.authority().expected,resultRef:result.resultRef,replayed:result.replayed})});
    } catch(error) {
      if (error instanceof ZodError) return failure("INVALID_PAYLOAD");
      if (error instanceof StorageError) {
        const code=LocalDirectSessionErrorCodeSchema.safeParse(error.code);
        if (code.success) return failure(code.data);
      }
      return failure(invoked?"OUTCOME_UNKNOWN":"SERVICE_UNAVAILABLE");
    }
  }
}
