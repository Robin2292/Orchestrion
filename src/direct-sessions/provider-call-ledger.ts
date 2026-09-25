import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { KeychainAdapter } from "../main/credentials/keychain";
import { CODEX_TEXT_MAX_OUTPUT_TOKENS } from "../providers/codex-responses-text";
import { StorageError, type SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import { DirectSessionService, type DirectExecutionBinding } from "./service";
import { DirectProviderCallRepository, type DirectProviderCallRow } from "./provider-call-repository";

const DIGEST_VERSION="local-provider-request-v1";
const MAX_INPUT_BYTES=65536,MAX_OUTPUT_TOKENS=1024,MAX_COST_MICROS=1_000_000_000_000;
// Version 1 subscription calls reserved only 1,024 output tokens. This value
// is accepted solely to identify an already SETTLED durable result; no legacy
// request may be reserved or claimed for a new physical dispatch.
const LEGACY_CODEX_TEXT_OUTPUT_TOKENS_V1=1024;
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const deny=(code:string):never=>{throw new StorageError(code);};
const positive=(n:unknown,max:number)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0&&n<=max;
const money=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0&&n<=1_000_000;
const now=()=>new Date().toISOString();

/** Host-selected immutable pricing. Subscription calls record tokens and zero
 * marginal USD; no unverified API-equivalent price is inferred. */
export interface ProviderPricing {
  readonly kind:"fixture_synthetic"|"codex_subscription";
  readonly modelId:"fixture-readonly-v1"|"gpt-6-luna";
  readonly billing:"metered"|"subscription_zero_actual";
  readonly maxOutputTokens:number;readonly inputUsdPerMillion:number;
  readonly outputUsdPerMillion:number;
  readonly authBindingHash?:string;
}
export interface FixtureRequest {
  sessionId:string;attemptId:string;binding:DirectExecutionBinding;logicalSlot:string;
  physicalIndex:number;messages:readonly {role:"system"|"user"|"assistant";content:string}[];
  pricing:ProviderPricing;
}
export type FixturePricing=ProviderPricing;
export interface FixtureUsage {inputTokens:number;outputTokens:number}
export type ReservedFixtureCall={kind:"reserved";id:string;digest:string;reservedTokens:number;reservedMicrousd:number}
  |{kind:"replayable"|"applied";id:string;digest:string;reservedTokens:number;reservedMicrousd:number};
type Envelope={v:1;n:string;c:string;t:string};

/** The only Local Direct physical ProviderCall and budget authority. SQLite
 * commits are synchronous and precede every fixture pull. */
export class DirectProviderCallLedger {
  constructor(private readonly store:SqliteFoundation,private readonly direct:DirectSessionService,
    private readonly keychain:KeychainAdapter) {}
  private repo<T>(work:(r:DirectProviderCallRepository)=>T):T {
    return this.store.transaction(tx=>work(new DirectProviderCallRepository(tx,this.store.workspace.org_id)));
  }
  private account(keyId:string):string {return sha(JSON.stringify(["direct-provider-capsule-v1",keyId]));}
  private keyCheck(keyId:string,value:Buffer):Buffer {
    return createHmac("sha256",value).update(JSON.stringify(["direct-provider-capsule-key-check-v1",keyId])).digest();
  }
  private verifiedKey(record:{id:string;checkHash:string}):Buffer {
    const value=this.keychain.read(this.account(record.id));
    if(!value||value.length!==32) {value?.fill(0);return deny("PROVIDER_CAPSULE_KEY_UNAVAILABLE");}
    const expected=Buffer.from(record.checkHash,"hex"),actual=this.keyCheck(record.id,value);
    if(expected.length!==32||!timingSafeEqual(expected,actual)) {
      value.fill(0);return deny("PROVIDER_CAPSULE_KEY_UNAVAILABLE");
    }
    return value;
  }
  private key():Buffer {
    const existing=this.repo(r=>r.key());
    if(existing)return this.verifiedKey(existing);
    const keyId=randomUUID();
    const account=this.account(keyId);
    const generated=randomBytes(32);
    try {this.keychain.compareExchange(account,null,generated);}
    catch { /* an uncertain CAS is resolved by the read below */ }
    finally {generated.fill(0);}
    const value=this.keychain.read(account);
    if(!value||value.length!==32) {value?.fill(0);return deny("PROVIDER_CAPSULE_KEY_UNAVAILABLE");}
    try {
      const checkHash=this.keyCheck(keyId,value).toString("hex");
      const record=this.repo(r=>{const current=r.key();if(current)return current;
        r.insertKey(keyId,checkHash);return {id:keyId,checkHash};});
      if(record.id!==keyId) {value.fill(0);return this.verifiedKey(record);}
      // The native adapter returns a copy; the caller wipes it after use.
      return value;
    } catch(error) {value.fill(0);throw error;}
  }
  private request(raw:FixtureRequest,legacyReplay=false) {
    const p=raw.pricing;
    if(!((p?.kind==="fixture_synthetic"&&p.modelId==="fixture-readonly-v1")
        ||(p?.kind==="codex_subscription"&&p.modelId==="gpt-6-luna"
          &&p.billing==="subscription_zero_actual"&&p.inputUsdPerMillion===0
          &&p.outputUsdPerMillion===0&&typeof p.authBindingHash==="string"
          &&/^[0-9a-f]{64}$/.test(p.authBindingHash)))
      ||(p?.kind==="fixture_synthetic"&&p.authBindingHash!==undefined)
      || !["metered","subscription_zero_actual"].includes(p.billing)
      || !positive(p.maxOutputTokens,p.kind==="codex_subscription"
        ?CODEX_TEXT_MAX_OUTPUT_TOKENS:MAX_OUTPUT_TOKENS)
      || (p.kind==="codex_subscription"&&p.maxOutputTokens!==
        (legacyReplay?LEGACY_CODEX_TEXT_OUTPUT_TOKENS_V1:CODEX_TEXT_MAX_OUTPUT_TOKENS))
      || !money(p.inputUsdPerMillion)||!money(p.outputUsdPerMillion)
      || !Number.isSafeInteger(raw.physicalIndex)||raw.physicalIndex<1||raw.physicalIndex>1000
      || typeof raw.logicalSlot!=="string"||!raw.logicalSlot||raw.logicalSlot.length>128
      || !Array.isArray(raw.messages)||raw.messages.length<1||raw.messages.length>256
      || raw.messages.some(m=>!m||!["system","user","assistant"].includes(m.role)
        || typeof m.content!=="string"||Object.keys(m).sort().join()!=="content,role")
      || raw.messages[raw.messages.length-1].role!=="user"
      || raw.messages.some((m,i)=>m.role==="system"&&(i>1||i>0&&raw.messages[i-1]?.role!=="system"))
      || raw.messages.some((m,i)=>m.role==="assistant"&&(i===0||raw.messages[i-1]?.role!=="user"))
      || raw.messages.some((m,i)=>m.role==="user"&&i>0&&raw.messages[i-1]?.role==="user"))
      deny("PROVIDER_RESERVATION_BASIS_INVALID");
    const canonical=JSON.stringify({version:DIGEST_VERSION,provider:"local",model:p.modelId,
      messages:raw.messages,maxTokens:p.maxOutputTokens});
    const inputBytes=Buffer.byteLength(JSON.stringify(raw.messages));
    if(inputBytes<1||inputBytes>MAX_INPUT_BYTES) deny("PROVIDER_REQUEST_TOO_LARGE");
    // Subscription transport can report provider-side framing tokens absent
    // from our JSON. Reserve a conservative bound before physical I/O.
    const inputLimit=p.kind==="codex_subscription"?Math.min(MAX_INPUT_BYTES,inputBytes*4):inputBytes;
    const reservedTokens=inputLimit+p.maxOutputTokens;
    const priced=Math.ceil(inputLimit*p.inputUsdPerMillion+p.maxOutputTokens*p.outputUsdPerMillion);
    const reservedMicrousd=p.billing==="metered"?priced:0;
    if(!Number.isSafeInteger(priced)||priced>MAX_COST_MICROS) deny("PROVIDER_RESERVATION_BASIS_INVALID");
    return {digest:sha(canonical),inputBytes,reservedTokens,reservedMicrousd,
      pricing:JSON.stringify({...p,maxInputTokens:inputLimit,digestVersion:DIGEST_VERSION})};
  }
  /** Match persisted v1 pricing only for a fully settled subscription call.
   * The caller's new reservation basis is never downgraded for fresh I/O. */
  private replayBasis(raw:FixtureRequest,row:DirectProviderCallRow,current:ReturnType<DirectProviderCallLedger["request"]>) {
    if(row.request_digest===current.digest&&row.pricing_json===current.pricing)return current;
    if(row.lifecycle!=="settled"||row.result_state==="none"
      ||raw.pricing.kind!=="codex_subscription"
      ||raw.pricing.maxOutputTokens!==CODEX_TEXT_MAX_OUTPUT_TOKENS
      ||row.digest_version!==DIGEST_VERSION)return current;
    const legacy=this.request({...raw,pricing:{...raw.pricing,
      maxOutputTokens:LEGACY_CODEX_TEXT_OUTPUT_TOKENS_V1}},true);
    return row.request_digest===legacy.digest&&row.pricing_json===legacy.pricing
      &&row.model_id===raw.pricing.modelId&&row.reserved_tokens===legacy.reservedTokens
      &&row.reserved_microusd===legacy.reservedMicrousd?legacy:current;
  }
  private binding(row:DirectProviderCallRow,raw:FixtureRequest,digest:string,pin:{agentId:string;
    agentVersionId:string;assignmentVersionId:string;authorityHash:string;configHash:string}):void {
    if(row.org_id!==this.store.workspace.org_id||row.session_id!==raw.sessionId
      ||row.attempt_id!==raw.attemptId||row.agent_id!==pin.agentId
      ||row.agent_version_id!==pin.agentVersionId||row.assignment_version_id!==pin.assignmentVersionId
      ||row.authority_hash!==pin.authorityHash||row.config_hash!==pin.configHash
      ||row.placement_id!==raw.binding.placementBindingId||row.workspace_id!==raw.binding.workspaceBindingId
      ||row.source_revision!==raw.binding.sourceRevision||row.fencing_token!==raw.binding.fencingToken
      ||row.logical_slot!==raw.logicalSlot||row.physical_index!==raw.physicalIndex
      ||row.request_digest!==digest||row.digest_version!==DIGEST_VERSION)
      deny("PROVIDER_REQUEST_REPLAY_MISMATCH");
  }
  reserve(raw:FixtureRequest):ReservedFixtureCall {
    const q=this.request(raw);const key=this.key();key.fill(0);
    const existing=this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"replay",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id),row=r.slot(raw.attemptId,raw.logicalSlot,raw.physicalIndex);
      if(!row)return null;
      const basis=this.replayBasis(raw,row,q);
      this.binding(row,raw,basis.digest,pin);
      if(row.pricing_json!==basis.pricing) deny("PROVIDER_REQUEST_REPLAY_MISMATCH");
      return row;
    });
    if(existing) {
      if(existing.lifecycle==="started"||existing.lifecycle==="unknown") deny("PROVIDER_EXECUTION_DISPATCH_AMBIGUOUS");
      if(existing.lifecycle==="released") deny("PROVIDER_CALL_RELEASED");
      return {kind:existing.lifecycle==="reserved"?"reserved":existing.result_state==="applied"?"applied":"replayable",
        id:existing.id,digest:existing.request_digest,reservedTokens:existing.reserved_tokens,
        reservedMicrousd:existing.reserved_microusd};
    }
    return this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"dispatch",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id);
      const previous=r.latest(raw.attemptId,raw.logicalSlot);
      if(raw.physicalIndex!==(previous?.physical_index??0)+1
        ||(previous&&previous.lifecycle!=="released")) deny("PROVIDER_PHYSICAL_ATTEMPT_CONFLICT");
      for(const [scope,id,limitTokens,limitUsd] of [
        ["org",this.store.workspace.org_id,pin.budget.organization.modelTokens,pin.budget.organization.costUsd],
        ["agent",pin.budget.agentPrincipalId,pin.budget.principal.modelTokens,pin.budget.principal.costUsd],
        ["session",raw.sessionId,pin.assignmentBudget.modelTokens,pin.assignmentBudget.costUsd],
      ] as const) {
        const spent=r.spend(scope,id);
        if(!Number.isSafeInteger(spent.tokens)||!Number.isSafeInteger(spent.microusd)
          ||spent.tokens+q.reservedTokens>limitTokens
          ||(spent.microusd+q.reservedMicrousd)/1_000_000>limitUsd)
          deny("PROVIDER_BUDGET_EXCEEDED");
      }
      const id=randomUUID();
      r.insert({org_id:this.store.workspace.org_id,id,session_id:raw.sessionId,attempt_id:raw.attemptId,
        agent_id:pin.agentId,agent_version_id:pin.agentVersionId,
        assignment_version_id:pin.assignmentVersionId,authority_hash:pin.authorityHash,
        config_hash:pin.configHash,placement_id:raw.binding.placementBindingId,
        workspace_id:raw.binding.workspaceBindingId,source_revision:raw.binding.sourceRevision,
        fencing_token:raw.binding.fencingToken,logical_slot:raw.logicalSlot,
        physical_index:raw.physicalIndex,request_digest:q.digest,digest_version:DIGEST_VERSION,
        model_id:raw.pricing.modelId,pricing_json:q.pricing,reserved_tokens:q.reservedTokens,
        reserved_microusd:q.reservedMicrousd} as DirectProviderCallRow,now());
      return {kind:"reserved",id,digest:q.digest,reservedTokens:q.reservedTokens,
        reservedMicrousd:q.reservedMicrousd};
    });
  }
  claim(raw:FixtureRequest,id:string):string {
    const q=this.request(raw);
    const key=this.key();key.fill(0);
    return this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"dispatch",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id),row=r.id(id);
      if(!row)throw new StorageError("PROVIDER_CALL_UNAVAILABLE");this.binding(row,raw,q.digest,pin);
      if(row.pricing_json!==q.pricing)deny("PROVIDER_REQUEST_REPLAY_MISMATCH");
      if(row.lifecycle!=="reserved")deny("PROVIDER_EXECUTION_DISPATCH_AMBIGUOUS");
      const token=randomUUID();if(!r.claim(id,sha(token),now()))deny("PROVIDER_CALL_STATE_CONFLICT");
      return token;
    });
  }
  release(id:string):void {this.repo(r=>{if(!r.release(id))deny("PROVIDER_CALL_STATE_CONFLICT");});}
  unknown(id:string,token:string):void {
    this.repo(r=>{const row=r.id(id);if(!row||row.dispatch_token_hash!==sha(token))throw new StorageError("PROVIDER_CALL_UNAVAILABLE");
      if(row.lifecycle==="unknown")return;
      if(!r.unknown(id,sha(token),now()))deny("PROVIDER_CALL_STATE_CONFLICT");});
  }
  private aad(row:DirectProviderCallRow):Buffer {
    return Buffer.from(JSON.stringify(["direct-capsule-v1",row.org_id,row.session_id,row.attempt_id,
      row.id,row.agent_version_id,row.assignment_version_id,row.authority_hash,row.config_hash,
      row.placement_id,row.workspace_id,row.source_revision,row.fencing_token,row.logical_slot,
      row.physical_index,row.request_digest,row.pricing_json,row.reserved_tokens,row.reserved_microusd]));
  }
  private encrypt(row:DirectProviderCallRow,payload:{text:string;usage:FixtureUsage;cost:number;wouldHave:number}) {
    const key=this.key(),nonce=randomBytes(12);
    try {const plain=Buffer.from(JSON.stringify(payload));
      try {const cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(this.aad(row));
        const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
        return {json:JSON.stringify({v:1,n:nonce.toString("base64"),c:encrypted.toString("base64"),
          t:cipher.getAuthTag().toString("base64")} satisfies Envelope),hash:sha(plain)};
      } finally {plain.fill(0);}
    } finally {key.fill(0);nonce.fill(0);}
  }
  private decrypt(row:DirectProviderCallRow):{text:string;usage:FixtureUsage;cost:number;wouldHave:number} {
    if(!row.capsule_json||!row.capsule_hash)throw new StorageError("PROVIDER_RESULT_UNREPLAYABLE");
    if(Buffer.byteLength(row.capsule_json)>100000)deny("PROVIDER_RESULT_CAPSULE_CORRUPT");
    let envelope:Envelope;
    try {envelope=JSON.parse(row.capsule_json) as Envelope;
      if(envelope.v!==1||Object.keys(envelope).sort().join()!=="c,n,t,v")throw Error();}
    catch {return deny("PROVIDER_RESULT_CAPSULE_CORRUPT");}
    const key=this.key();
    try {const nonce=Buffer.from(envelope.n,"base64"),tag=Buffer.from(envelope.t,"base64");
      if(nonce.length!==12||tag.length!==16)deny("PROVIDER_RESULT_CAPSULE_CORRUPT");
      const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAAD(this.aad(row));
      decipher.setAuthTag(tag);
      const plain=Buffer.concat([decipher.update(Buffer.from(envelope.c,"base64")),decipher.final()]);
      try {if(!timingSafeEqual(Buffer.from(sha(plain),"hex"),Buffer.from(row.capsule_hash,"hex")))
          deny("PROVIDER_RESULT_CAPSULE_CORRUPT");
        const payload=JSON.parse(plain.toString("utf8"));
        if(typeof payload.text!=="string"||!payload.usage||payload.cost!==row.actual_microusd
          ||payload.wouldHave!==row.would_have_microusd
          ||payload.usage.inputTokens+payload.usage.outputTokens!==row.actual_tokens)
          deny("PROVIDER_RESULT_CAPSULE_CORRUPT");
        return payload;
      } finally {plain.fill(0);}
    } catch {return deny("PROVIDER_RESULT_CAPSULE_CORRUPT");}
    finally {key.fill(0);}
  }
  settle(id:string,token:string,usage:FixtureUsage,text:string):void {
    const row=this.repo(r=>r.id(id));
    if(!row||row.lifecycle!=="started"||row.dispatch_token_hash!==sha(token))throw new StorageError("PROVIDER_CALL_STATE_CONFLICT");
    const p=JSON.parse(row.pricing_json) as FixturePricing&{maxInputTokens:number};
    if(!positive(usage?.inputTokens,p.maxInputTokens)||!Number.isSafeInteger(usage.outputTokens)
      ||usage.outputTokens<0||usage.outputTokens>p.maxOutputTokens
      ||typeof text!=="string"||!text.trim()||Buffer.byteLength(text)>32768)
      deny("PROVIDER_SETTLEMENT_INVALID");
    const priced=Math.ceil(usage.inputTokens*p.inputUsdPerMillion+usage.outputTokens*p.outputUsdPerMillion);
    const cost=p.billing==="metered"?priced:0,wouldHave=p.billing==="metered"?0:priced;
    if(!Number.isSafeInteger(priced)||cost>row.reserved_microusd)deny("PROVIDER_SETTLEMENT_EXCEEDS_RESERVATION");
    const capsule=this.encrypt(row,{text,usage,cost,wouldHave});
    this.repo(r=>{const current=r.id(id);if(!current||current.lifecycle!=="started"
      ||current.dispatch_token_hash!==sha(token))deny("PROVIDER_CALL_STATE_CONFLICT");
      if(!r.settle(id,sha(token),usage.inputTokens+usage.outputTokens,cost,wouldHave,
        capsule.json,capsule.hash,now()))deny("PROVIDER_CALL_STATE_CONFLICT");});
  }
  replay(raw:FixtureRequest):{id:string;state:"replayable"|"applied";text:string;usage:FixtureUsage;cost:number;wouldHave:number} {
    const q=this.request(raw);
    const row=this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"replay",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id);
      const found=r.slot(raw.attemptId,raw.logicalSlot,raw.physicalIndex);
      if(!found)throw new StorageError("PROVIDER_CALL_UNAVAILABLE");
      const basis=this.replayBasis(raw,found,q);this.binding(found,raw,basis.digest,pin);
      if(found.pricing_json!==basis.pricing||found.lifecycle!=="settled"||found.result_state==="none")
        deny("PROVIDER_RESULT_UNREPLAYABLE");
      return found;
    });
    const payload=this.decrypt(row);
    return {id:row.id,state:row.result_state as "replayable"|"applied",text:payload.text,
      usage:payload.usage,cost:row.actual_microusd!,wouldHave:row.would_have_microusd!};
  }
  apply(raw:FixtureRequest,id:string,decision:string):{text:string;cost:number;wouldHave:number} {
    return this.applyFinal(raw,id,decision,()=>{});
  }
  /** Final answer facts can be committed in the same transaction as the
   * ProviderCall APPLIED decision and terminal attempt transition. */
  applyFinal(raw:FixtureRequest,id:string,decision:string,
    checkpoint:(tx:SqliteUnit,text:string,pin:{agentVersionId:string;assignmentVersionId:string})=>void):
    {text:string;cost:number;wouldHave:number} {
    const q=this.request(raw);
    const replay=this.replay(raw);
    if(replay.id!==id)deny("PROVIDER_REQUEST_REPLAY_MISMATCH");
    return this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"replay",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id),row=r.id(id);
      if(!row)throw new StorageError("PROVIDER_CALL_UNAVAILABLE");
      const basis=this.replayBasis(raw,row,q);this.binding(row,raw,basis.digest,pin);
      if(row.pricing_json!==basis.pricing||row.lifecycle!=="settled")deny("PROVIDER_RESULT_UNREPLAYABLE");
      const continuation=JSON.stringify({version:"direct-provider-decision-v1",kind:"terminal_final",
        providerCallId:id,attemptId:raw.attemptId,logicalSlot:raw.logicalSlot,nextSlot:null,
        generation:1,fenceHash:sha(JSON.stringify([row.authority_hash,row.fencing_token,row.capsule_hash]))});
      const hash=sha(JSON.stringify(["final",id,row.capsule_hash,decision,continuation]));
      if(row.result_state==="applied") {
        if(row.decision_hash!==hash||row.continuation_json!==continuation)
          deny("PROVIDER_DECISION_REPLAY_MISMATCH");
        checkpoint(tx,replay.text,pin);
        return {text:replay.text,cost:replay.cost,wouldHave:replay.wouldHave};
      }
      if(row.result_state!=="replayable"||!r.apply(id,hash,continuation,now()))
        deny("PROVIDER_DECISION_CHECKPOINT_REQUIRED");
      checkpoint(tx,replay.text,pin);
      if(!r.finishAttempt(raw.sessionId,raw.attemptId))deny("PROVIDER_DECISION_CHECKPOINT_REQUIRED");
      return {text:replay.text,cost:replay.cost,wouldHave:replay.wouldHave};
    });
  }
  /** A4C summary application shares A5D's APPLIED checkpoint transaction. The
   * callback writes the context epoch in that transaction; it cannot execute I/O. */
  applyCompaction(raw:FixtureRequest,id:string,decision:string,
    checkpoint:(tx:SqliteUnit,summary:string,pin:{agentVersionId:string;assignmentVersionId:string})=>void):string {
    const q=this.request(raw),replay=this.replay(raw);
    if(replay.id!==id||!decision)deny("PROVIDER_REQUEST_REPLAY_MISMATCH");
    return this.direct.withProviderAttempt(raw.sessionId,raw.attemptId,raw.binding,"replay",(tx,pin)=>{
      const r=new DirectProviderCallRepository(tx,this.store.workspace.org_id),row=r.id(id);
      if(!row)throw new StorageError("PROVIDER_CALL_UNAVAILABLE");
      const basis=this.replayBasis(raw,row,q);this.binding(row,raw,basis.digest,pin);
      if(row.pricing_json!==basis.pricing||row.lifecycle!=="settled")deny("PROVIDER_RESULT_UNREPLAYABLE");
      const continuation=JSON.stringify({version:"direct-provider-decision-v1",kind:"context_compaction",
        providerCallId:id,attemptId:raw.attemptId,logicalSlot:raw.logicalSlot,
        fenceHash:sha(JSON.stringify([row.authority_hash,row.fencing_token,row.capsule_hash]))});
      const decisionHash=sha(JSON.stringify(["compaction",id,row.capsule_hash,decision,continuation]));
      if(row.result_state==="applied") {
        if(row.decision_hash!==decisionHash||row.continuation_json!==continuation)
          deny("PROVIDER_DECISION_REPLAY_MISMATCH");
      } else if(row.result_state!=="replayable"||!r.apply(id,decisionHash,continuation,now()))
        deny("PROVIDER_DECISION_CHECKPOINT_REQUIRED");
      checkpoint(tx,replay.text,pin);
      return replay.text;
    });
  }
}
