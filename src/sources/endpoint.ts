import { ZodError, type ZodTypeAny } from "zod";
import { createLocalCommandAdapter, LOCAL_COMMAND_MAX_BYTES } from "../shared/local-command-adapter";
import { LocalCommandHeaderSchema, LocalVersionPinSchema, LocalErrorCodeSchema, localFailure } from "../shared/local-contracts";
import { SourceConnectorPinSchema, SourceDraftInputSchema, SourceIdentitySchema, SourceReleaseInputSchema,
  SourceActivateInputSchema, SourceRejectionCodeSchema } from "../shared/source-publication-contracts";
import { SourceContractPinSchema } from "../shared/source-publication-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalSourcePublicationService } from "./service";

function rejection(error:unknown) {
  if (error instanceof ZodError) return localFailure("INVALID_PAYLOAD");
  if (error instanceof StorageError) {
    const code=SourceRejectionCodeSchema.or(LocalErrorCodeSchema).safeParse(error.code);
    if (code.success) return { ok:false as const,error:{ code:code.data,retryable:false } };
  }
  return null;
}
/** Host-authenticated command seam. This does not install an adapter or grant. */
export function sourcePublicationEndpoints(resolve:()=>LocalSourcePublicationService|null) {
  function command<S extends ZodTypeAny>(name:string,schema:S,invoke:(s:LocalSourcePublicationService,h:ReturnType<typeof LocalCommandHeaderSchema.parse>,p:unknown)=>unknown) {
    const adapter=createLocalCommandAdapter(name,schema);
    return (raw:unknown) => {
      let invoked=false;
      try {
        const s=resolve(); if (!s) return localFailure("NOT_AUTHENTICATED");
        if (typeof raw!=="string" || Buffer.byteLength(raw)>LOCAL_COMMAND_MAX_BYTES) return localFailure("INVALID_PAYLOAD");
        let decoded:unknown; try { decoded=JSON.parse(raw); } catch { return localFailure("INVALID_PAYLOAD"); }
        const pin=LocalVersionPinSchema.safeParse(decoded && typeof decoded==="object" && "expected" in decoded ? decoded.expected:null);
        if (!pin.success) return localFailure("INVALID_PAYLOAD");
        const validated=adapter.validate(raw,{...s.authority(),expected:pin.data});
        if (!validated.ok) return validated;
        const { payload,command:_command,...h }=validated.command; void _command;
        invoked=true; return { ok:true as const,value:invoke(s,LocalCommandHeaderSchema.parse(h),payload) };
      } catch (error) { return rejection(error) ?? localFailure(invoked ? "OUTCOME_UNKNOWN":"SERVICE_UNAVAILABLE"); }
    };
  }
  function query<S extends ZodTypeAny>(name:string,schema:S,invoke:(s:LocalSourcePublicationService,p:unknown)=>unknown) {
    const adapter=createLocalCommandAdapter(name,schema);
    return (raw:unknown) => {
      try { const s=resolve(); if (!s) return localFailure("NOT_AUTHENTICATED");
        const validated=adapter.validate(raw,s.authority());
        return validated.ok ? { ok:true as const,value:invoke(s,validated.command.payload) } : validated;
      } catch (error) { return rejection(error) ?? localFailure("SERVICE_UNAVAILABLE"); }
    };
  }
  return {
    accept:command("source.accept",SourceConnectorPinSchema,(s,h,p)=>s.accept(h,p)),
    draft:command("source.draft",SourceDraftInputSchema,(s,h,p)=>s.createDraft(h,p)),
    review:command("source.review",SourceIdentitySchema,(s,h,p)=>s.review(h,p)),
    publish:command("source.publish",SourceReleaseInputSchema,(s,h,p)=>s.publish(h,p)),
    activate:command("source.activate",SourceActivateInputSchema,(s,h,p)=>s.activate(h,p)),
    rollback:command("source.rollback",SourceActivateInputSchema,(s,h,p)=>s.rollback(h,p)),
    snapshot:query("source.snapshot",SourceIdentitySchema,(s,p)=>s.snapshot(p)),
    publication:query("source.publication",SourceIdentitySchema,(s,p)=>s.publication(p)),
    readiness:query("source.readiness",SourceConnectorPinSchema,(s,p)=>s.readiness(p)),
    activeContract:query("source.active-contract",SourceContractPinSchema,(s,p)=>s.assertActiveContract(p)),
  };
}
