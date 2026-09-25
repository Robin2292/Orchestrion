import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { LocalAgentService } from "../agents/service";
import type { KeychainAdapter } from "../main/credentials/keychain";
import { LOCAL_CONTRACT_VERSION, type LocalVersionPinSchema } from "../shared/local-contracts";
import type { SqliteFoundation } from "../storage/sqlite/foundation";
import { StorageError } from "../storage/sqlite/foundation";
import { CODEX_TEXT_MAX_OUTPUT_TOKENS, codexTextModelReady, type CodexTextResult } from "../providers/codex-responses-text";
import { DirectContextService } from "./context";
import { FixtureLedgerCompactionPort } from "./fixture-compaction";
import { FixtureLedgerTextPort } from "./fixture-text";
import { DirectHarnessCoordinator } from "./harness";
import { DirectProviderCallLedger, type ProviderPricing } from "./provider-call-ledger";
import { DirectSessionService, type DirectExecutionBinding } from "./service";

type LocalVersionPin = z.infer<typeof LocalVersionPinSchema>;

export interface CodexTurnProvider {
  bindingHash(): string | null;
  complete(messages: readonly {role:"system"|"user"|"assistant";content:string}[],
    signal:AbortSignal):Promise<CodexTextResult>;
}
export interface CodexBindingLease {binding:DirectExecutionBinding;release():void}
export type BindCodexTurn=(sessionId:string,agentVersionId:string,idempotencyKey:string)=>CodexBindingLease;
const pricing:ProviderPricing={kind:"codex_subscription",modelId:"gpt-6-luna",
  billing:"subscription_zero_actual",maxOutputTokens:CODEX_TEXT_MAX_OUTPUT_TOKENS,
  inputUsdPerMillion:0,outputUsdPerMillion:0};
const limits={modelId:"gpt-6-luna",windowTokens:136_192,
  outputReserveTokens:CODEX_TEXT_MAX_OUTPUT_TOKENS,
  toolReserveTokens:128,pressureRatio:0.75,toolPreviewBytes:96};
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");

/** Text-only Direct orchestration. The harness chooses context and compaction;
 * the existing ledger is the sole physical-call and result authority. */
export class DirectCodexTurnService {
  constructor(private readonly store:SqliteFoundation,private readonly direct:DirectSessionService,
    private readonly agents:LocalAgentService,private readonly keychain:KeychainAdapter,
    private readonly provider:CodexTurnProvider,private readonly bind:BindCodexTurn) {}

  history(sessionId:string):{seq:number;role:"user"|"assistant";text:string}[] {
    const pin=this.direct.contextAdmission(sessionId),session=this.direct.get(sessionId);
    if(!session||session.project_id!==this.store.workspace.project_id||pin.modelId!==pricing.modelId)
      throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
    return new DirectContextService(this.store,this.direct,this.keychain,limits).history(sessionId);
  }

  async run(input:{sessionId:string;prompt:string;expected:LocalVersionPin;
    requestId:string;idempotencyKey:string},signal:AbortSignal):Promise<{
      attemptId:string;text:string;costMicrousd:number;wouldHaveMicrousd:number;replayed:boolean}> {
    if(signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
    if(typeof input.prompt!=="string"||!input.prompt.trim()||Buffer.byteLength(input.prompt)>8192)
      throw new StorageError("INVALID_PAYLOAD");
    const pin=this.direct.contextAdmission(input.sessionId),session=this.direct.get(input.sessionId);
    if(!session||session.project_id!==this.store.workspace.project_id||!session.agent_id
      ||session.agent_version_id!==pin.agentVersionId)throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
    const version=this.agents.reference({agentId:session.agent_id,versionId:pin.agentVersionId});
    if(version.definition.nodeType!=="agent"||version.definition.providerType!=="openai_codex"
      ||!codexTextModelReady(version.definition.modelId)||pin.modelId!==pricing.modelId
      ||(version.definition.toolGrants?.grants.length??0)!==0
      ||version.definition.outputType!=="text"||version.definition.modelParams!==null
      ||version.definition.maxTokens!==null||version.definition.maxRetries!==0
      ||version.definition.planMode!=="execute_only"||version.definition.carryConversation!==true
      ||version.definition.inputSchema!==null||version.definition.outputSchema!==null
      ||version.definition.userPromptTemplate!==null||version.definition.timeoutSeconds!==null
      ||version.definition.finalizationPrompt!==null||version.definition.jsonExtractionPrompt!==null
      ||(version.definition.fallbackModels?.length??0)!==0)
      throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
    const authBindingHash=this.provider.bindingHash();
    if(!authBindingHash)throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
    const selectedPricing:ProviderPricing={...pricing,authBindingHash};
    const lease=this.bind(input.sessionId,pin.agentVersionId,input.idempotencyKey);
    try {
      const header={...this.direct.authority(),expected:input.expected,
        schema_version:LOCAL_CONTRACT_VERSION,request_id:input.requestId,
        idempotency_key:input.idempotencyKey};
      const attemptId=this.direct.startAttempt(header,input.sessionId,lease.binding).resultRef;
      const context=new DirectContextService(this.store,this.direct,this.keychain,limits);
      const ledger=new DirectProviderCallLedger(this.store,this.direct,this.keychain);
      const model={complete:async(messages:readonly {role:"system"|"user"|"assistant";content:string}[],
        callSignal:AbortSignal)=>this.provider.complete(messages,callSignal)};
      const text=new FixtureLedgerTextPort(context,ledger,selectedPricing,{
        complete:async(request,callSignal)=>model.complete(request.messages,callSignal),
      });
      const compact=new FixtureLedgerCompactionPort(context,ledger,selectedPricing,{
        summarize:async(messages,callSignal)=>model.complete(messages,callSignal),
      });
      const harness=new DirectHarnessCoordinator(this.direct,context,compact);
      const last=context.build(input.sessionId);
      if(last.lastFactKind==="assistant"&&this.direct.latestAttempt(input.sessionId)?.outcome==="completed") {
        const previous=context.buildBeforeFinal(input.sessionId,attemptId).context;
        if(context.recall(input.sessionId,previous.checkpoint.factCount)!==input.prompt)
          throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
        const replay=harness.replaySettledText({sessionId:input.sessionId,attemptId,
          binding:lease.binding},text);
        return {attemptId,...replay};
      }
      if(last.lastFactKind==="user") {
        if(context.recall(input.sessionId,last.checkpoint.factCount)!==input.prompt
          ||this.direct.latestAttempt(input.sessionId)?.id!==attemptId)
          throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
      } else context.append({sessionId:input.sessionId,attemptId,binding:lease.binding,
        kind:"user",content:input.prompt});
      // A settled call from a prior host incarnation may be applied without
      // claiming dispatch ownership again. This recovery path cannot start I/O.
      try {this.direct.assertDispatch(input.sessionId,attemptId,lease.binding);}
      catch(error) {
        if(!(error instanceof StorageError)||error.code!=="DIRECT_BINDING_UNAVAILABLE")throw error;
        if(signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
        this.direct.assertStaleReplayOwner(input.sessionId,attemptId,lease.binding);
        const compactionId=context.recoverSettledCompaction(input.sessionId,attemptId,
          lease.binding,selectedPricing,ledger);
        try {
          const replay=harness.replaySettledText({sessionId:input.sessionId,attemptId,
            binding:lease.binding},text);
          return {attemptId,...replay};
        } catch(replayError) {
          if(!compactionId||!(replayError instanceof StorageError)
            ||!["PROVIDER_CALL_UNAVAILABLE","DIRECT_CONTEXT_PRESSURE_UNRESOLVED"]
              .includes(replayError.code))throw replayError;
          // Only the applied summary exists. Close this old attempt using its
          // complete settled-call inventory, then require a new user command.
          this.direct.recoverAppliedTextCompaction({...this.direct.authority(),
            schema_version:LOCAL_CONTRACT_VERSION,request_id:randomUUID(),
            idempotency_key:randomUUID()},input.sessionId,attemptId,lease.binding,compactionId);
          throw new StorageError("DIRECT_CONTEXT_RETRY_REQUIRED");
        }
      }
      const result=await harness.runText({sessionId:input.sessionId,attemptId,
        binding:lease.binding,signal},text);
      return {attemptId,...result};
    } finally {lease.release();}
  }
}

/** A stable, non-secret text-only binding ID for an idempotent command. */
export function codexTextBinding(sessionId:string,agentVersionId:string,idempotencyKey:string):DirectExecutionBinding {
  const seed=digest(JSON.stringify(["direct-codex-text-v1",sessionId,agentVersionId,idempotencyKey]));
  return {placementBindingId:"local_trusted",workspaceBindingId:`text-${seed.slice(0,32)}`,
    sourceRevision:agentVersionId,fencingToken:digest(`fence:${seed}`),providerExecutionRef:null};
}
