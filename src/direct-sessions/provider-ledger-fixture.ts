import type { LocalAgentService } from "../agents/service";
import { LocalProviderCallPort, type LocalProviderAdapter, type ProviderAdapterRequest } from "../providers/call-port";
import { localFixtureReadiness } from "../providers/web-local-fixture";
import { PROVIDER_CALL_VERSION, ProviderChunkSchema, type ProviderChunk } from "../shared/provider-call-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { z } from "zod";
import { DirectSessionService, type DirectExecutionBinding } from "./service";
import { DirectProviderCallLedger, type FixturePricing, type FixtureRequest, type FixtureUsage } from "./provider-call-ledger";

/** Host-injected acceptance fixture. Usage is separate from A3's public stream
 * projection and is never accepted from renderer/Tool/model text. */
export interface LedgerFixture {
  chunks:readonly ProviderChunk[];
  usage?:FixtureUsage;
  beforePull?:(index:number,request:ProviderAdapterRequest)=>void|Promise<void>;
}

export class DirectLedgerFixtureTurn {
  private readonly port:LocalProviderCallPort;
  constructor(private readonly direct:DirectSessionService,private readonly agents:LocalAgentService,
    private readonly ledger:DirectProviderCallLedger,private readonly fixture:LedgerFixture) {
    const chunks=fixture.chunks.map(c=>ProviderChunkSchema.parse(structuredClone(c)));
    const adapter:LocalProviderAdapter={source:"web_provider_adapter",readiness:localFixtureReadiness,
      stream:async function*(request,signal){for(const [i,chunk] of chunks.entries()){
        if(signal.aborted)return;
        await fixture.beforePull?.(i,request);
        if(signal.aborted)return;
        yield chunk;
      }}};
    this.port=new LocalProviderCallPort(agents,adapter,()=>direct.authority().runtime_owner,()=>true);
  }
  async run(input:{sessionId:string;attemptId:string;binding:DirectExecutionBinding;text:string;
    pricing:FixturePricing;signal:AbortSignal;outputSchema:z.ZodType<unknown>}):Promise<
      {kind:"final";text:string;parsed:unknown;costMicrousd:number;wouldHaveMicrousd:number;replayed:boolean}
      |{kind:"unknown"|"invalid";code:string}> {
    let claimedId:string|null=null,token:string|null=null;
    try {
      const session=this.direct.get(input.sessionId);
      if(!session?.agent_id||!session.agent_version_id)throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
      const version=this.agents.reference({agentId:session.agent_id,versionId:session.agent_version_id});
      const instructions=this.direct.contextAdmission(input.sessionId,input.attemptId);
      const maxTokens=version.definition.maxTokens??256;
      if(input.pricing.maxOutputTokens!==maxTokens||localFixtureReadiness(version)!==null
        ||instructions.agentVersionId!==session.agent_version_id
        ||instructions.modelId!==input.pricing.modelId)
        throw new StorageError("PROVIDER_NOT_READY");
      const messages:{role:"system"|"user";content:string}[]=[
        ...(instructions.systemPrompt?[{role:"system" as const,content:instructions.systemPrompt}]:[]),
        {role:"user",content:input.text}];
      const request:FixtureRequest={sessionId:input.sessionId,attemptId:input.attemptId,
        binding:input.binding,logicalSlot:"direct:0",physicalIndex:1,messages,pricing:input.pricing};
      const reserved=this.ledger.reserve(request);
      if(reserved.kind==="replayable"||reserved.kind==="applied") {
        const replay=this.ledger.replay(request),parsed=input.outputSchema.safeParse(replay.text);
        if(!parsed.success)return {kind:"invalid",code:"OUTPUT_SCHEMA_INVALID"};
        const applied=this.ledger.apply(request,replay.id,"fixture-final");
        return {kind:"final",text:applied.text,parsed:parsed.data,costMicrousd:applied.cost,
          wouldHaveMicrousd:applied.wouldHave,replayed:true};
      }
      token=this.ledger.claim(request,reserved.id);claimedId=reserved.id;
      const wire={schemaVersion:PROVIDER_CALL_VERSION,context:this.direct.authority().context,
        runtimeOwner:this.direct.authority().runtime_owner,source:"web_provider_adapter" as const,
        agent:{agentId:session.agent_id,versionId:session.agent_version_id},text:input.text,mode:"text" as const};
      let text="",coverage=false,complete=false;
      this.direct.assertDispatch(input.sessionId,input.attemptId,input.binding);
      for await(const event of this.port.call(wire,input.signal,messages)) {
        this.direct.assertDispatch(input.sessionId,input.attemptId,input.binding);
        if(event.type==="coverage") {if(coverage)throw new StorageError("PROVIDER_PROTOCOL_ERROR");coverage=true;}
        else if(event.type==="text") {if(!coverage)throw new StorageError("PROVIDER_PROTOCOL_ERROR");text+=event.text;}
        else if(event.type==="completed") {complete=true;break;}
        else throw new StorageError(event.code);
      }
      if(!complete||!text.trim())throw new StorageError("PROVIDER_INCOMPLETE");
      if(!this.fixture.usage)throw new StorageError("PROVIDER_USAGE_UNKNOWN");
      this.ledger.settle(claimedId,token,this.fixture.usage,text);
      claimedId=null;token=null;
      const parsed=input.outputSchema.safeParse(text);
      if(!parsed.success)return {kind:"invalid",code:"OUTPUT_SCHEMA_INVALID"};
      const applied=this.ledger.apply(request,reserved.id,"fixture-final");
      return {kind:"final",text:applied.text,parsed:parsed.data,costMicrousd:applied.cost,
        wouldHaveMicrousd:applied.wouldHave,replayed:false};
    } catch(error) {
      if(claimedId&&token) {
        try {this.ledger.unknown(claimedId,token);} catch { /* STARTED retains full hold */ }
      }
      return {kind:"unknown",code:error instanceof StorageError?error.code:"PROVIDER_EXECUTION_DISPATCH_AMBIGUOUS"};
    }
  }
}
