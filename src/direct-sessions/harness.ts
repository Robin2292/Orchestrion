import { StorageError } from "../storage/sqlite/foundation";
import { DirectContextService, type DirectCompactionSource, type DirectPackedContext } from "./context";
import { DirectSessionService, type DirectExecutionBinding } from "./service";

export interface DirectHarnessRequest {
  sessionId:string;attemptId:string;binding:DirectExecutionBinding;signal:AbortSignal;
}

/** The harness owns scheduling; an injected host port owns one durable model
 * call and its accounting. Adapters never choose the Session or context span. */
export interface DirectHarnessCompactionPort {
  compact(request:DirectHarnessRequest,source:DirectCompactionSource):Promise<void>;
}
export interface DirectHarnessTextResult {text:string;costMicrousd:number;wouldHaveMicrousd:number;replayed:boolean}
export interface DirectHarnessTextPort {
  execute(request:DirectHarnessRequest,context:DirectPackedContext,
    assertCurrent:()=>DirectPackedContext):Promise<DirectHarnessTextResult>;
  replaySettled(request:Omit<DirectHarnessRequest,"signal">,context:DirectPackedContext,
    appliedAnswer?:string):DirectHarnessTextResult;
}

/** One text-only Direct turn plan. Cache boundaries are optional adapter hints,
 * while checkpoint and pins are the exact context facts to bind to a call. */
export class DirectHarnessCoordinator {
  constructor(private readonly direct:DirectSessionService,
    private readonly context:DirectContextService,
    private readonly compaction:DirectHarnessCompactionPort) {}

  async prepare(request:DirectHarnessRequest):Promise<DirectPackedContext> {
    this.check(request);
    const initial=this.context.build(request.sessionId);
    this.textOnly(initial);
    if(initial.status==="ready")return initial;

    const source=this.context.prepareCompactionSource(request.sessionId);
    await this.compaction.compact(request,source);
    this.check(request);
    const ready=this.context.build(request.sessionId);
    this.textOnly(ready);
    if(ready.status!=="ready")throw new StorageError("DIRECT_CONTEXT_PRESSURE_UNRESOLVED");
    if(ready.epoch!==initial.epoch+1||ready.sourceEndSeq<=initial.sourceEndSeq
      ||ready.checkpoint.digest===initial.checkpoint.digest
      ||JSON.stringify(ready.pins)!==JSON.stringify(initial.pins))
      throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
    return ready;
  }

  /** Call immediately before physical provider I/O. Return the fresh canonical
   * plan so a caller cannot mutate messages or cache hints after preparation. */
  assertCurrent(request:DirectHarnessRequest,prepared:DirectPackedContext):DirectPackedContext {
    this.check(request);
    const current=this.context.build(request.sessionId);
    this.textOnly(current);
    if(current.status!=="ready"||JSON.stringify(current)!==JSON.stringify(prepared))
      throw new StorageError("DIRECT_CONTEXT_CHECKPOINT_MISMATCH");
    return current;
  }

  /** One canonical text turn. The port owns the durable physical call, while
   * the harness owns context and the final pre-I/O checkpoint gate. */
  async runText(request:DirectHarnessRequest,port:DirectHarnessTextPort):Promise<DirectHarnessTextResult> {
    const prepared=await this.prepare(request);
    return port.execute(request,prepared,()=>this.assertCurrent(request,prepared));
  }

  /** Recovery consumes only a previously settled result. It never authorizes
   * another physical call under an old runtime owner. */
  replaySettledText(request:Omit<DirectHarnessRequest,"signal">,port:DirectHarnessTextPort):DirectHarnessTextResult {
    const context=this.context.build(request.sessionId);
    if(context.lastFactKind==="assistant") {
      const final=this.context.buildBeforeFinal(request.sessionId,request.attemptId);
      return port.replaySettled(request,final.context,final.answer);
    }
    this.textOnly(context);
    if(context.status!=="ready")throw new StorageError("DIRECT_CONTEXT_PRESSURE_UNRESOLVED");
    return port.replaySettled(request,context);
  }

  private check(request:DirectHarnessRequest):void {
    if(request.signal.aborted)throw new StorageError("DIRECT_HARNESS_CANCELLED");
    this.direct.assertDispatch(request.sessionId,request.attemptId,request.binding);
  }

  private textOnly(context:DirectPackedContext):void {
    if(context.containsToolFacts)throw new StorageError("DIRECT_HARNESS_TOOL_NOT_READY");
    if(context.lastFactKind!=="user")throw new StorageError("DIRECT_HARNESS_USER_TURN_REQUIRED");
  }
}
