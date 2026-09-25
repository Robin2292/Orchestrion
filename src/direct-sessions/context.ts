import { createHash } from "node:crypto";
import type { KeychainAdapter } from "../main/credentials/keychain";
import { LocalIdSchema } from "../shared/local-contracts";
import { StorageError, type SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import { DirectContextCrypto, contextEpochAad, contextFactAad } from "./context-crypto";
import { DirectProviderCallLedger, type FixturePricing, type FixtureRequest } from "./provider-call-ledger";
import { DirectSessionService, type DirectExecutionBinding } from "./service";

const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const fail=(code:string):never=>{throw new StorageError(code);};
const MAX_FACT_BYTES=32768,MAX_SUMMARY_BYTES=8192,MAX_FACTS=4096;
export type DirectContextKind="user"|"assistant"|"tool_call"|"tool_result";
export interface DirectContextFact {seq:number;kind:DirectContextKind;content:string;toolCallId:string|null;preview:string;recallRef:string|null}
interface FactRow {seq:number;attempt_id:string;kind:DirectContextKind;tool_call_id:string|null;
  body_cipher_json:string;body_hash:string;fact_hash:string}
interface EpochRow {epoch:number;source_start_seq:number;source_end_seq:number;source_hash:string;
  summary_cipher_json:string;summary_hash:string;provider_call_id:string;agent_version_id:string;
  assignment_version_id:string;scope_hash:string}
export interface ContextModelLimits {modelId:string;windowTokens:number;outputReserveTokens:number;
  toolReserveTokens:number;pressureRatio:number;toolPreviewBytes:number}
export interface DirectPackedContext {status:"ready"|"compaction_required";modelId:string;
  pins:{agentVersionId:string;assignmentVersionId:string;configHash:string;scopeHash:string;
    repositoryHash:string|null};
  epoch:number;sourceEndSeq:number;usedTokens:number;availableTokens:number;pressureRatio:number;
  messages:readonly {role:"system"|"user"|"assistant"|"tool";content:string;toolCallId?:string;recallRef?:string}[]}
interface Plan {epoch:number;start:number;end:number;sourceHash:string;request:FixtureRequest;decision:string}

/** A4C owns one canonical transcript beneath D3B's Direct Session. Only host
 * callers can append fixture facts; there is no renderer endpoint or live loop. */
export class DirectContextService {
  private readonly crypto:DirectContextCrypto;
  private readonly limits:ContextModelLimits;
  constructor(private readonly store:SqliteFoundation,private readonly direct:DirectSessionService,
    keychain:KeychainAdapter,limits:ContextModelLimits) {
    this.crypto=new DirectContextCrypto(store,keychain);
    if(typeof limits.modelId!=="string"||!limits.modelId
      ||![limits.windowTokens,limits.outputReserveTokens,limits.toolReserveTokens,limits.toolPreviewBytes]
        .every(n=>Number.isSafeInteger(n)&&n>0)
      ||limits.windowTokens>1_000_000||limits.outputReserveTokens+limits.toolReserveTokens>=limits.windowTokens
      ||limits.toolPreviewBytes>4096||!Number.isFinite(limits.pressureRatio)
      ||limits.pressureRatio<0.5||limits.pressureRatio>0.95)fail("DIRECT_CONTEXT_LIMIT_INVALID");
    this.limits={...limits};
  }
  private scope(sessionId:string) {const c=this.store.workspace;return [c.org_id,c.project_id,sessionId] as const;}
  private rows(sessionId:string):{facts:FactRow[];epochs:EpochRow[]} {
    const [org,project,id]=this.scope(sessionId);
    return this.store.transaction(tx=>({
      facts:tx.all(`SELECT seq,attempt_id,kind,tool_call_id,body_cipher_json,body_hash,fact_hash
        FROM direct_context_facts WHERE org_id=? AND project_id=? AND session_id=? ORDER BY seq`,
        org,project,id) as unknown as FactRow[],
      epochs:tx.all(`SELECT * FROM direct_context_epochs WHERE org_id=? AND project_id=? AND session_id=?
        ORDER BY epoch`,org,project,id) as unknown as EpochRow[],
    }));
  }
  private verified(sessionId:string,allowPendingTool=false) {
    const pin=this.direct.contextAdmission(sessionId);
    if(pin.modelId!==this.limits.modelId)fail("DIRECT_CONTEXT_MODEL_CHANGED");
    const [org,project]=this.scope(sessionId),rows=this.rows(sessionId);
    if(rows.facts.length>MAX_FACTS)fail("DIRECT_CONTEXT_FACT_LIMIT");
    let prev="0".repeat(64),pending:string|null=null,previousKind:DirectContextKind|null=null;
    const facts:DirectContextFact[]=[];
    for(const r of rows.facts) {
      if(r.seq!==facts.length+1||!Number.isSafeInteger(r.seq))fail("DIRECT_CONTEXT_CORRUPT");
      const body=this.crypto.decrypt(r.body_cipher_json,
        contextFactAad(org,project,sessionId,r.seq,r.kind,r.tool_call_id),r.body_hash);
      const factHash=sha(JSON.stringify([prev,r.seq,r.attempt_id,r.kind,r.tool_call_id,r.body_hash]));
      if(factHash!==r.fact_hash)fail("DIRECT_CONTEXT_CORRUPT");
      prev=factHash;
      if(r.kind==="user"&&!(previousKind===null||previousKind==="assistant"))fail("DIRECT_CONTEXT_ORDER_INVALID");
      if(r.kind==="assistant"&&!(previousKind==="user"||previousKind==="tool_result"))fail("DIRECT_CONTEXT_ORDER_INVALID");
      if(r.kind==="tool_call") {
        if(previousKind!=="assistant"||pending||!r.tool_call_id)fail("DIRECT_CONTEXT_ORDER_INVALID");
        pending=r.tool_call_id;
      }
      if(r.kind==="tool_result") {
        if(previousKind!=="tool_call"||pending!==r.tool_call_id)fail("DIRECT_CONTEXT_ORDER_INVALID");
        pending=null;
      }
      previousKind=r.kind;
      const preview=r.kind==="tool_result"?this.preview(body,this.limits.toolPreviewBytes):body;
      facts.push({seq:r.seq,kind:r.kind,content:body,toolCallId:r.tool_call_id,preview,
        recallRef:preview===body?null:`direct-context:${sessionId}:${r.seq}:${r.body_hash}`});
    }
    if(pending&&!allowPendingTool)fail("DIRECT_CONTEXT_TOOL_PAIR_INCOMPLETE");
    let summary:string|null=null,previous:EpochRow|null=null;
    for(const epoch of rows.epochs) {
      if(epoch.agent_version_id!==pin.agentVersionId||epoch.assignment_version_id!==pin.assignmentVersionId
        ||epoch.scope_hash!==pin.scopeHash||epoch.source_end_seq>facts.length
        ||epoch.source_start_seq<1||epoch.source_end_seq<epoch.source_start_seq)fail("DIRECT_CONTEXT_EPOCH_INVALID");
      summary=this.crypto.decrypt(epoch.summary_cipher_json,
        contextEpochAad(org,project,sessionId,epoch.epoch,epoch.source_hash),epoch.summary_hash);
      const start=previous?previous.source_end_seq+1:1;
      if(epoch.source_start_seq!==start||epoch.epoch!==(previous?previous.epoch+1:1))
        fail("DIRECT_CONTEXT_EPOCH_INVALID");
      const sourceHash=this.sourceHash(facts.filter(f=>f.seq>=start&&f.seq<=epoch.source_end_seq),
        previous?.summary_hash??null);
      if(sourceHash!==epoch.source_hash)fail("DIRECT_CONTEXT_EPOCH_INVALID");
      const provider=this.store.transaction(tx=>tx.get(`SELECT result_state,continuation_json,
        agent_version_id,assignment_version_id FROM direct_provider_calls
        WHERE org_id=? AND session_id=? AND id=?`,org,sessionId,epoch.provider_call_id));
      const continuation=provider?.continuation_json?JSON.parse(String(provider.continuation_json)) as {kind?:string;providerCallId?:string}:null;
      if(provider?.result_state!=="applied"||provider.agent_version_id!==epoch.agent_version_id
        ||provider.assignment_version_id!==epoch.assignment_version_id
        ||continuation?.kind!=="context_compaction"||continuation.providerCallId!==epoch.provider_call_id)
        fail("DIRECT_CONTEXT_EPOCH_INVALID");
      previous=epoch;
    }
    const fresh=this.direct.contextAdmission(sessionId);
    if(JSON.stringify(fresh)!==JSON.stringify(pin))fail("DIRECT_PIN_REVOKED");
    return {pin,facts,epoch:previous,summary};
  }
  private preview(body:string,limit:number):string {
    const bytes=Buffer.from(body);
    if(bytes.length<=limit)return body;
    const head=Math.floor(limit*0.65),tail=limit-head;
    return `${bytes.subarray(0,head).toString("utf8")}\n[tool result omitted]\n${bytes.subarray(bytes.length-tail).toString("utf8")}`;
  }
  private sourceHash(facts:readonly DirectContextFact[],previousSummaryHash:string|null):string {
    return sha(JSON.stringify(["direct-context-source-v1",previousSummaryHash,
      facts.map(f=>[f.seq,f.kind,f.toolCallId,sha(f.content)])]));
  }
  append(input:{sessionId:string;attemptId:string;binding:DirectExecutionBinding;kind:DirectContextKind;
    content:string;toolCallId?:string|null}):number {
    const sessionId=LocalIdSchema.parse(input.sessionId),attemptId=LocalIdSchema.parse(input.attemptId);
    if(!["user","assistant","tool_call","tool_result"].includes(input.kind)
      ||typeof input.content!=="string"||!input.content.trim()
      ||Buffer.byteLength(input.content)>MAX_FACT_BYTES)fail("DIRECT_CONTEXT_FACT_INVALID");
    const callId=input.toolCallId??null;
    if((input.kind==="tool_call"||input.kind==="tool_result")
      ?typeof callId!=="string"||!callId||callId.length>128:callId!==null)
      fail("DIRECT_CONTEXT_FACT_INVALID");
    const pin=this.direct.contextAdmission(sessionId);
    if(pin.modelId!==this.limits.modelId)fail("DIRECT_CONTEXT_MODEL_CHANGED");
    const [org,project]=this.scope(sessionId);
    const last=this.store.transaction(tx=>tx.get(`SELECT seq,kind,tool_call_id,fact_hash FROM direct_context_facts
      WHERE org_id=? AND project_id=? AND session_id=? ORDER BY seq DESC LIMIT 1`,org,project,sessionId));
    const seq=last?Number(last.seq)+1:1;
    if(seq>MAX_FACTS)fail("DIRECT_CONTEXT_FACT_LIMIT");
    const encrypted=this.crypto.encrypt(input.content,contextFactAad(org,project,sessionId,seq,input.kind,callId));
    return this.direct.withProviderAttempt(sessionId,attemptId,input.binding,"dispatch",(tx,current)=>{
      if(current.agentVersionId!==pin.agentVersionId||current.assignmentVersionId!==pin.assignmentVersionId
        ||current.configHash!==pin.configHash)fail("DIRECT_PIN_REVOKED");
      const actual=tx.get(`SELECT seq,kind,tool_call_id,fact_hash FROM direct_context_facts
        WHERE org_id=? AND project_id=? AND session_id=? ORDER BY seq DESC LIMIT 1`,org,project,sessionId);
      if((actual?Number(actual.seq)+1:1)!==seq||String(actual?.fact_hash??"0".repeat(64))!==String(last?.fact_hash??"0".repeat(64)))
        fail("DIRECT_CONTEXT_CONFLICT");
      const previous=actual?String(actual.kind):null,pending=actual?.kind==="tool_call"?String(actual.tool_call_id):null;
      if(input.kind==="user"&&!(previous===null||previous==="assistant")
        ||input.kind==="assistant"&&!(previous==="user"||previous==="tool_result")
        ||input.kind==="tool_call"&&(previous!=="assistant"||!!pending)
        ||input.kind==="tool_result"&&(previous!=="tool_call"||pending!==callId))
        fail("DIRECT_CONTEXT_ORDER_INVALID");
      if(callId&&input.kind==="tool_call"&&tx.get(`SELECT 1 FROM direct_context_facts
        WHERE org_id=? AND project_id=? AND session_id=? AND tool_call_id=? LIMIT 1`,org,project,sessionId,callId))
        fail("DIRECT_CONTEXT_CALL_REUSED");
      const previousHash=String(actual?.fact_hash??"0".repeat(64));
      const factHash=sha(JSON.stringify([previousHash,seq,attemptId,input.kind,callId,encrypted.hash]));
      tx.run(`INSERT INTO direct_context_facts VALUES (?,?,?,?,?,?,?,?,?,?,?)`,org,project,sessionId,
        seq,attemptId,input.kind,callId,encrypted.cipher,encrypted.hash,factHash,new Date().toISOString());
      return seq;
    });
  }
  recall(sessionId:string,seq:number):string {
    sessionId=LocalIdSchema.parse(sessionId);
    if(!Number.isSafeInteger(seq)||seq<1)fail("DIRECT_CONTEXT_FACT_INVALID");
    const facts=this.verified(sessionId).facts;
    const fact=facts[seq-1];if(!fact||fact.seq!==seq)fail("DIRECT_CONTEXT_FACT_UNAVAILABLE");
    return fact.content;
  }
  build(sessionId:string):DirectPackedContext {
    sessionId=LocalIdSchema.parse(sessionId);
    const {pin,facts,epoch,summary}=this.verified(sessionId),tail=facts.filter(f=>f.seq>(epoch?.source_end_seq??0));
    const messages:DirectPackedContext["messages"]=[
      ...(pin.systemPrompt?[{role:"system" as const,content:pin.systemPrompt}]:[]),
      ...(summary?[{role:"system" as const,content:`[Compacted Direct Session]\n${summary}`}]:[]),
      ...tail.map(f=>({role:f.kind==="tool_result"?"tool" as const:f.kind==="user"?"user" as const:"assistant" as const,
        content:f.preview,...(f.toolCallId?{toolCallId:f.toolCallId}:{}),...(f.recallRef?{recallRef:f.recallRef}:{})})),
    ];
    // UTF-8 byte count is a conservative deterministic upper bound for this
    // fixture model. The reserved output and Tool budget is never spendable input.
    const usedTokens=messages.reduce((n,m)=>n+Buffer.byteLength(m.content)+16,0);
    const availableTokens=this.limits.windowTokens-this.limits.outputReserveTokens-this.limits.toolReserveTokens;
    const ratio=usedTokens/availableTokens,required=ratio>=this.limits.pressureRatio;
    return {status:required?"compaction_required":"ready",modelId:pin.modelId,
      pins:{agentVersionId:pin.agentVersionId,assignmentVersionId:pin.assignmentVersionId,
        configHash:pin.configHash,scopeHash:pin.scopeHash,
        repositoryHash:pin.repository?.aggregateHash??null},epoch:epoch?.epoch??0,
      sourceEndSeq:epoch?.source_end_seq??0,usedTokens,availableTokens,pressureRatio:ratio,
      messages:required?[]:messages};
  }
  private plan(sessionId:string,attemptId:string,binding:DirectExecutionBinding,pricing:FixturePricing,
    pinned?:{baseEpoch:number;end:number}):Plan {
    const state=this.verified(sessionId,!!pinned);
    if(!pinned&&this.build(sessionId).status!=="compaction_required")fail("DIRECT_CONTEXT_PRESSURE_NOT_REACHED");
    const baseEpoch=state.epoch?.epoch??0;
    if(pinned&&pinned.baseEpoch!==baseEpoch)fail("DIRECT_CONTEXT_EPOCH_CONFLICT");
    const start=(state.epoch?.source_end_seq??0)+1;
    // A user fact begins a turn. Preserve the entire latest turn, including
    // every Tool pair, rather than assuming its final two facts are the turn.
    let lastUser=-1;
    for(let i=state.facts.length-1;i>=0;i--) if(state.facts[i].kind==="user") {lastUser=i;break;}
    const end=pinned?.end??(lastUser<0?0:state.facts[lastUser].seq-1);
    if(end<start||state.facts[end-1]?.kind!=="assistant"||state.facts[end]?.kind!=="user"
      ||(!pinned&&state.facts.at(-1)?.kind!=="assistant"))
      fail("DIRECT_CONTEXT_COMPACTION_UNAVAILABLE");
    const source=state.facts.filter(f=>f.seq>=start&&f.seq<=end);
    const sourceHash=this.sourceHash(source,state.epoch?.summary_hash??null);
    const sourceText=JSON.stringify({previousSummary:state.summary,source:source.map(f=>({seq:f.seq,kind:f.kind,
      content:f.preview,toolCallId:f.toolCallId,recallRef:f.recallRef}))});
    const request:FixtureRequest={sessionId,attemptId,binding,
      logicalSlot:`context:${baseEpoch}:${end}`,physicalIndex:1,
      messages:[{role:"system",content:"Summarize the Direct Session facts faithfully. Preserve source order, tool outcomes, and uncertainty."},
        {role:"user",content:sourceText}],pricing};
    if(Buffer.byteLength(JSON.stringify(request.messages))>8192)fail("DIRECT_CONTEXT_COMPACTION_INPUT_LIMIT");
    if(!pinned) {
      // A changed tail cannot mint a second chargeable slot while an earlier
      // reservation for this source epoch is unresolved or already settled.
      const [org,project]=this.scope(sessionId);
      const held=this.store.transaction(tx=>tx.all(`SELECT logical_slot FROM direct_provider_calls p
        JOIN agent_sessions s ON s.org_id=p.org_id AND s.id=p.session_id
        WHERE p.org_id=? AND s.project_id=? AND p.session_id=? AND p.logical_slot LIKE ?
        AND p.lifecycle!='released'`,org,project,sessionId,`context:${baseEpoch}:%`));
      if(held.some(row=>row.logical_slot!==request.logicalSlot))fail("DIRECT_CONTEXT_COMPACTION_IN_FLIGHT");
    }
    const epoch=(state.epoch?.epoch??0)+1;
    return {epoch,start,end,sourceHash,request,
      decision:sha(JSON.stringify(["direct-context-epoch-v1",sessionId,epoch,start,end,sourceHash]))};
  }
  prepareCompaction(sessionId:string,attemptId:string,binding:DirectExecutionBinding,pricing:FixturePricing) {
    const plan=this.plan(LocalIdSchema.parse(sessionId),LocalIdSchema.parse(attemptId),binding,pricing);
    return {request:plan.request,epoch:plan.epoch,sourceStartSeq:plan.start,sourceEndSeq:plan.end,
      sourceHash:plan.sourceHash};
  }
  applyCompaction(sessionId:string,attemptId:string,binding:DirectExecutionBinding,pricing:FixturePricing,
    ledger:DirectProviderCallLedger,providerCallId:string):void {
    sessionId=LocalIdSchema.parse(sessionId);attemptId=LocalIdSchema.parse(attemptId);
    const current=this.verified(sessionId,true).epoch;
    if(current?.provider_call_id===providerCallId) return; // APPLIED epoch is already durable.
    const [org,project]=this.scope(sessionId);
    const reserved=this.store.transaction(tx=>tx.get(`SELECT p.logical_slot,p.physical_index FROM direct_provider_calls p
      JOIN agent_sessions s ON s.org_id=p.org_id AND s.id=p.session_id
      WHERE p.org_id=? AND s.project_id=? AND p.session_id=? AND p.attempt_id=? AND p.id=?`,
      org,project,sessionId,attemptId,providerCallId));
    const slot=String(reserved?.logical_slot??""),match=/^context:(0|[1-9]\d*):([1-9]\d*)$/.exec(slot);
    if(!match||Number(reserved?.physical_index)!==1)
      throw new StorageError("DIRECT_CONTEXT_PREPARATION_UNAVAILABLE");
    const plan=this.plan(sessionId,attemptId,binding,pricing,
      {baseEpoch:Number(match[1]),end:Number(match[2])}),replayed=ledger.replay(plan.request);
    if(replayed.id!==providerCallId||!replayed.text.trim()||Buffer.byteLength(replayed.text)>MAX_SUMMARY_BYTES)
      fail("DIRECT_CONTEXT_SUMMARY_INVALID");
    const pin=this.direct.contextAdmission(sessionId);
    const encrypted=this.crypto.encrypt(replayed.text,contextEpochAad(org,project,sessionId,plan.epoch,plan.sourceHash));
    ledger.applyCompaction(plan.request,providerCallId,plan.decision,(tx:SqliteUnit,summary,current)=>{
      if(summary!==replayed.text||current.agentVersionId!==pin.agentVersionId
        ||current.assignmentVersionId!==pin.assignmentVersionId)fail("DIRECT_PIN_REVOKED");
      const existing=tx.get(`SELECT * FROM direct_context_epochs WHERE org_id=? AND project_id=? AND session_id=?
        AND epoch=?`,org,project,sessionId,plan.epoch);
      if(existing) {
        if(existing.provider_call_id!==providerCallId||existing.source_hash!==plan.sourceHash
          ||existing.summary_hash!==encrypted.hash)fail("DIRECT_CONTEXT_EPOCH_CONFLICT");
        return;
      }
      const latest=tx.get(`SELECT epoch,source_end_seq,summary_hash FROM direct_context_epochs
        WHERE org_id=? AND project_id=? AND session_id=? ORDER BY epoch DESC LIMIT 1`,org,project,sessionId);
      if((latest?Number(latest.epoch)+1:1)!==plan.epoch
        ||(latest?Number(latest.source_end_seq)+1:1)!==plan.start)fail("DIRECT_CONTEXT_EPOCH_CONFLICT");
      const rows=tx.all(`SELECT seq,kind,tool_call_id,body_hash FROM direct_context_facts
        WHERE org_id=? AND project_id=? AND session_id=? AND seq BETWEEN ? AND ? ORDER BY seq`,
        org,project,sessionId,plan.start,plan.end);
      const actual=sha(JSON.stringify(["direct-context-source-v1",latest?String(latest.summary_hash):null,
        rows.map(r=>[Number(r.seq),String(r.kind),r.tool_call_id===null?null:String(r.tool_call_id),String(r.body_hash)])]));
      if(actual!==plan.sourceHash)fail("DIRECT_CONTEXT_EPOCH_CONFLICT");
      tx.run(`INSERT INTO direct_context_epochs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        org,project,sessionId,plan.epoch,plan.start,plan.end,plan.sourceHash,encrypted.cipher,
        encrypted.hash,providerCallId,pin.agentVersionId,pin.assignmentVersionId,pin.scopeHash,new Date().toISOString());
    });
  }
}
