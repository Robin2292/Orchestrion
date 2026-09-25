import { abortable } from "../providers/call-port";
import { StorageError } from "../storage/sqlite/foundation";
import { DirectContextService, type DirectPackedContext } from "./context";
import type { DirectHarnessRequest, DirectHarnessTextPort, DirectHarnessTextResult } from "./harness";
import { DirectProviderCallLedger, type FixturePricing, type FixtureRequest, type FixtureUsage } from "./provider-call-ledger";

export interface FixtureTextModel {
  complete(input:{modelId:string;messages:FixtureRequest["messages"];
    cacheBoundaries:DirectPackedContext["cacheBoundaries"];checkpoint:DirectPackedContext["checkpoint"]},
    signal:AbortSignal):Promise<{text:string;usage:FixtureUsage}>;
}

/** Concrete deterministic fixture behind the provider-neutral harness. It
 * owns no Session or transcript; A5D owns the physical call and settlement. */
export class FixtureLedgerTextPort implements DirectHarnessTextPort {
  constructor(private readonly context:DirectContextService,
    private readonly ledger:DirectProviderCallLedger,
    private readonly pricing:FixturePricing,
    private readonly model:FixtureTextModel) {}

  private request(input:Omit<DirectHarnessRequest,"signal">,context:DirectPackedContext):FixtureRequest {
    if(context.status!=="ready"||context.lastFactKind!=="user"||context.containsToolFacts
      ||context.modelId!==this.pricing.modelId)throw new StorageError("DIRECT_HARNESS_TEXT_NOT_READY");
    const messages=context.messages.map(m=>{
      if(m.role==="tool"||m.toolCallId||m.recallRef)throw new StorageError("DIRECT_HARNESS_TOOL_NOT_READY");
      return {role:m.role,content:m.content};
    });
    return {sessionId:input.sessionId,attemptId:input.attemptId,binding:input.binding,
      logicalSlot:`direct:${context.epoch}:${context.checkpoint.factCount}`,physicalIndex:1,
      messages,pricing:this.pricing};
  }

  async execute(input:DirectHarnessRequest,context:DirectPackedContext,
    assertCurrent:()=>DirectPackedContext):Promise<DirectHarnessTextResult> {
    if(input.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
    const canonical=assertCurrent();
    if(JSON.stringify(canonical)!==JSON.stringify(context))throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
    const request=this.request(input,canonical),reserved=this.ledger.reserve(request);
    if(reserved.kind==="applied")throw new StorageError("DIRECT_HARNESS_ALREADY_APPLIED");
    if(reserved.kind==="replayable")return this.apply(request,canonical,reserved.id,true);
    if(input.signal.aborted) {
      this.ledger.release(reserved.id);
      throw new StorageError("DIRECT_HARNESS_CANCELLED");
    }
    let token:string;
    try {assertCurrent();token=this.ledger.claim(request,reserved.id);}
    catch(error) {try {this.ledger.release(reserved.id);} catch { /* Preserve the original fence failure. */ }
      throw error;}
    let settled=false;
    try {
      assertCurrent();
      const result=await abortable(this.model.complete({modelId:canonical.modelId,
        messages:request.messages,cacheBoundaries:canonical.cacheBoundaries,
        checkpoint:canonical.checkpoint},input.signal),input.signal,
        ()=>new StorageError("DIRECT_HARNESS_CANCELLED"));
      if(input.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
      this.ledger.settle(reserved.id,token,result.usage,result.text);
      settled=true;
      return this.apply(request,canonical,reserved.id,false);
    } catch(error) {
      if(!settled) {
        try {this.ledger.unknown(reserved.id,token);} catch { /* STARTED remains held. */ }
        throw new StorageError(input.signal.aborted?"DIRECT_HARNESS_CANCELLED":"DIRECT_HARNESS_TEXT_UNKNOWN");
      }
      throw error;
    }
  }

  replaySettled(input:Omit<DirectHarnessRequest,"signal">,context:DirectPackedContext,
    appliedAnswer?:string):DirectHarnessTextResult {
    const request=this.request(input,context),replay=this.ledger.replay(request);
    if(replay.state==="applied") {
      if(appliedAnswer!==replay.text)throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
      return {text:replay.text,costMicrousd:replay.cost,wouldHaveMicrousd:replay.wouldHave,replayed:true};
    }
    if(appliedAnswer!==undefined)throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
    return this.apply(request,context,replay.id,true);
  }

  private apply(request:FixtureRequest,context:DirectPackedContext,id:string,replayed:boolean):DirectHarnessTextResult {
    const result=this.ledger.replay(request);
    if(result.id!==id)throw new StorageError("PROVIDER_REQUEST_REPLAY_MISMATCH");
    const checkpoint=this.context.assistantCheckpoint(request.sessionId,request.attemptId,context,result.text);
    const applied=this.ledger.applyFinal(request,id,"harness-text-final",checkpoint);
    return {text:applied.text,costMicrousd:applied.cost,wouldHaveMicrousd:applied.wouldHave,replayed};
  }
}
