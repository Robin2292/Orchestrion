import { abortable } from "../providers/call-port";
import { StorageError } from "../storage/sqlite/foundation";
import { DirectContextService, type DirectCompactionSource } from "./context";
import type { DirectHarnessCompactionPort, DirectHarnessRequest } from "./harness";
import { DirectProviderCallLedger, type FixturePricing, type FixtureUsage } from "./provider-call-ledger";

export interface FixtureCompactionModel {
  summarize(messages:readonly {role:"system"|"user";content:string}[],signal:AbortSignal):
    Promise<{text:string;usage:FixtureUsage}>;
}

/** Synthetic model bridge for the current A5D ledger. A live provider adapter
 * must supply its own reviewed pricing, entitlement and physical I/O gate. */
export class FixtureLedgerCompactionPort implements DirectHarnessCompactionPort {
  constructor(private readonly context:DirectContextService,
    private readonly ledger:DirectProviderCallLedger,
    private readonly pricing:FixturePricing,
    private readonly model:FixtureCompactionModel) {}

  async compact(request:DirectHarnessRequest,source:DirectCompactionSource):Promise<void> {
    if(request.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
    const {sessionId,attemptId,binding}=request;
    const prepared=this.context.prepareCompaction(sessionId,attemptId,binding,this.pricing);
    if(prepared.epoch!==source.epoch||prepared.sourceStartSeq!==source.sourceStartSeq
      ||prepared.sourceEndSeq!==source.sourceEndSeq||prepared.sourceHash!==source.sourceHash
      ||prepared.request.logicalSlot!==source.logicalSlot
      ||JSON.stringify(prepared.request.messages)!==JSON.stringify(source.messages))
      throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
    const reserved=this.ledger.reserve(prepared.request);
    if(reserved.kind==="replayable"||reserved.kind==="applied") {
      this.context.applyCompaction(sessionId,attemptId,binding,this.pricing,this.ledger,reserved.id);
      return;
    }
    if(request.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
    const token=this.ledger.claim(prepared.request,reserved.id);
    let settled=false;
    try {
      const result=await abortable(this.model.summarize(source.messages,request.signal),
        request.signal,()=>new StorageError("DIRECT_HARNESS_CANCELLED"));
      if(request.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
      this.ledger.settle(reserved.id,token,result.usage,result.text);
      settled=true;
      this.context.applyCompaction(sessionId,attemptId,binding,this.pricing,this.ledger,reserved.id);
    } catch(error) {
      if(!settled) {
        try {this.ledger.unknown(reserved.id,token);} catch { /* STARTED remains held. */ }
        throw new StorageError(request.signal.aborted?"DIRECT_HARNESS_CANCELLED":"DIRECT_CONTEXT_COMPACTION_UNKNOWN");
      }
      throw error;
    }
  }
}
