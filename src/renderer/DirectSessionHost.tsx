import { AlertCircle, Archive, ArrowLeft, Bot, FolderOpen, LoaderCircle, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { LocalDirectSessionItem } from "../shared/direct-session-ui-contracts";
import type { LocalAssignmentItem } from "../shared/assignment-ui-contracts";
import { readProjectAssignments } from "./ProjectAgentsHost";

type Detail = Extract<Awaited<ReturnType<OrchestrionDesktopApi["localDirectSessions"]["request"]>>, {kind:"detail"}>;
type Pin = Detail["expected"];
const PAGE_SIZE=100;

export async function readDirectSessions(api:OrchestrionDesktopApi):Promise<{expected:Pin;items:LocalDirectSessionItem[]}> {
  const items:LocalDirectSessionItem[]=[];
  let expected:Pin|null=null;
  for (let offset=0;offset<=10_000;offset+=PAGE_SIZE) {
    const value=await api.localDirectSessions.request({operation:"list",limit:PAGE_SIZE,offset});
    if (value.kind!=="page") throw new Error("SERVICE_UNAVAILABLE");
    if (expected && (expected.revision!==value.expected.revision || expected.hash!==value.expected.hash))
      throw new Error("REVISION_CONFLICT");
    expected=value.expected;
    if (offset===10_000 && value.items.length) throw new Error("SERVICE_UNAVAILABLE");
    items.push(...value.items);
    if (value.items.length<PAGE_SIZE) break;
  }
  if (!expected) throw new Error("SERVICE_UNAVAILABLE");
  return {expected,items};
}

const message:Record<string,string>={
  DIRECT_ASSIGNMENT_UNAVAILABLE:"The selected Project Assignment is no longer available for new Sessions.",
  DIRECT_PRINCIPAL_UNAVAILABLE:"The Agent principal is unavailable. Review the Project Assignment.",
  DIRECT_VERSION_UNAVAILABLE:"The pinned Agent or Assignment version is unavailable.",
  DIRECT_VERSION_CHANGED:"The released version changed. Reload and choose again.",
  DIRECT_SESSION_INACTIVE:"This Session is inactive. Reload its lifecycle state.",
  DIRECT_SESSION_STATE_CONFLICT:"The Session state changed. Reload before trying again.",
  DIRECT_PROVIDER_UNAVAILABLE:"This Direct Session is not ready for the experimental Codex text route. Check its released Agent, Tool grants, budget and connection.",
  DIRECT_HARNESS_TEXT_UNKNOWN:"The model call outcome is uncertain. Its token reservation remains held; reload before taking another action.",
  DIRECT_HARNESS_CANCELLED:"The text turn was interrupted. Reload to inspect its recorded state.",
  DIRECT_CONTEXT_RETRY_REQUIRED:"Earlier text context was safely recovered. Reload, then send the same prompt again to continue in a new attempt.",
  DIRECT_CONTEXT_PRESSURE_UNRESOLVED:"This Session has reached its text context limit. Its summary could not be completed.",
  REVISION_CONFLICT:"The Direct Session ledger changed. Reload before trying again.",
  NOT_AUTHENTICATED:"This window is no longer authorized. Reopen the app.",
  OUTCOME_UNKNOWN:"The host could not confirm the outcome. Reload before another action.",
};
export function directSessionError(error:unknown) {
  const code=error instanceof Error?error.message:"SERVICE_UNAVAILABLE";
  return message[code]??"Direct Session storage is unavailable. Reload the page.";
}

export function DirectSessionHost({api,projectId,projectName,sessionId,onSelect,onChanged,onConnectProviders}: {
  api:OrchestrionDesktopApi|undefined;projectId:string;projectName:string;sessionId:string|null;
  onSelect:(id:string|null)=>void;onChanged:()=>Promise<void>;onConnectProviders?:()=>void;
}) {
  const [detail,setDetail]=useState<Detail|null>(null);
  const [assignments,setAssignments]=useState<LocalAssignmentItem[]>([]);
  const [expected,setExpected]=useState<Pin|null>(null);
  const [assignmentId,setAssignmentId]=useState("");
  const [title,setTitle]=useState("");
  const [renaming,setRenaming]=useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [prompt,setPrompt]=useState("");
  const [history,setHistory]=useState<{seq:number;role:"user"|"assistant";text:string}[]>([]);
  const [error,setError]=useState<string|null>(null);

  const reload=useCallback(async()=>{
    if (!api?.localDirectSessions?.request || !api?.localAssignments?.request) {
      setError(directSessionError(new Error("SERVICE_UNAVAILABLE")));setLoading(false);return;
    }
    setLoading(true);setError(null);
    try {
      if (sessionId) {
        const value=await api.localDirectSessions.request({operation:"get",sessionId});
        if (value.kind!=="detail" || !value.session || value.session.projectId!==projectId || value.session.deleted)
          throw new Error("DIRECT_SESSION_UNAVAILABLE");
        setDetail(value);setExpected(value.expected);setTitle(value.session.title);
        try {
          const transcript=await api.localDirectSessions.request({operation:"history",sessionId});
          setHistory(transcript.kind==="history"?transcript.items:[]);
        } catch {setHistory([]);}
      } else {
        const [ledger,page]=await Promise.all([readProjectAssignments(api,projectId),readDirectSessions(api)]);
        if (page.items.some(item=>item.projectId!==projectId)) throw new Error("CONTEXT_MISMATCH");
        setAssignments(ledger.items.filter(item=>item.assignment.status==="active" &&
          item.migrationState==="governed" && item.currentVersion!==null));
        setExpected(page.expected);setDetail(null);setHistory([]);
      }
    } catch(reason) { setDetail(null);setExpected(null);setError(directSessionError(reason)); }
    finally { setLoading(false); }
  },[api,projectId,sessionId]);
  useEffect(()=>{void reload();},[reload]);
  useEffect(()=>{setConfirmDelete(false);setRenaming(false);},[sessionId]);

  const command=async(operation:"create"|"rename"|"archive"|"restore"|"delete")=>{
    if (!api || !expected || busy) return;
    const selected=assignments.find(item=>item.assignment.id===assignmentId);
    const session=detail?.session;
    if (operation==="create" && (!selected?.currentVersion || !title.trim())) return;
    if (operation!=="create" && !session) return;
    setBusy(true);setError(null);
    try {
      const header={expected,requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()};
      const payload=operation==="create"
        ? {assignmentId,assignmentVersionId:selected!.currentVersion!.id,title:title.trim()}
        : operation==="rename" ? {sessionId:session!.id,title:title.trim()}
        : {sessionId:session!.id};
      const result=await api.localDirectSessions.request({operation,...header,payload} as Parameters<typeof api.localDirectSessions.request>[0]);
      if (result.kind!=="command") throw new Error("SERVICE_UNAVAILABLE");
      // The host has committed. Sidebar refresh is secondary and must never
      // turn a confirmed create into a retryable form with a new idempotency key.
      if (operation==="create") onSelect(result.resultRef);
      else if (operation==="delete") onSelect(null);
      else {setRenaming(false);await reload();}
      void onChanged().catch(()=>undefined);
    } catch(reason) {
      if (operation==="delete") await reload();
      setError(directSessionError(reason));
    }
    finally {setBusy(false);setConfirmDelete(false);}
  };

  const session=detail?.session;
  const sendTurn=async()=>{
    if(!api||!session||!expected||busy||session.deleting||session.lifecycle!=="active"||!prompt.trim())return;
    const submitted=prompt.trim();setBusy(true);setError(null);
    try {
      const result=await api.localDirectSessions.request({operation:"turn",expected,
        requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),
        payload:{sessionId:session.id,prompt:submitted}});
      if(result.kind!=="turn")throw new Error("SERVICE_UNAVAILABLE");
      setExpected(result.expected);setPrompt("");
      const transcript=await api.localDirectSessions.request({operation:"history",sessionId:session.id});
      if(transcript.kind==="history")setHistory(transcript.items);
      void onChanged().catch(()=>undefined);
    } catch(reason) {setError(directSessionError(reason));}
    finally {setBusy(false);}
  };
  const selected=assignments.find(item=>item.assignment.id===assignmentId);
  return <section className="direct-workbench" aria-label="Direct Session workbench">
    <header className="direct-workbench-header">
      <div><span className="eyebrow">Project · Direct Session</span><h1>{session?.title??"New Session"}</h1>
        <p>{session ? "A Project bounded context with immutable Agent and Assignment pins." : "Choose a released Project Agent and name this bounded work context."}</p></div>
      <button type="button" className="button secondary-button" onClick={()=>onSelect(null)} disabled={!session}><Plus size={15}/> New Session</button>
    </header>
    <section className="direct-model-route" aria-label="Direct Session model route">
      <div><span className="eyebrow">Model for next Direct call</span><strong>Experimental Codex text · gpt-6-luna</strong>
        <p>Requires a connected subscription, released text-only Codex Agent with no Tool grants, and Project budgets. The host checks every pin before calling it.</p></div>
      <button type="button" className="button secondary-button" onClick={onConnectProviders} disabled={!onConnectProviders}><Plus size={15}/> Connect provider</button>
    </section>
    {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16}/>{error}<button type="button" onClick={()=>void reload()}>Reload</button></div>}
    {loading ? <div className="agent-loading" role="status">Loading Direct Session…</div> : session ? <>
      <div className="direct-session-facts" aria-label="Session identity and lifecycle">
        <div><small>Source</small><strong>Direct · released</strong></div>
        <div><small>Project</small><strong title={projectId}>{projectName}</strong></div>
        <div><small>Agent version</small><strong title={session.agentVersionId}>{session.agentVersionId}</strong></div>
        <div><small>Assignment version</small><strong title={session.assignmentVersionId}>{session.assignmentVersionId}</strong></div>
        <div><small>Lifecycle</small><strong>{session.deleting?"Deletion pending":session.lifecycle}</strong></div>
        <div><small>Latest attempt</small><strong>{session.latestAttempt ? `${session.latestAttempt.outcome} · #${session.latestAttempt.number}` : "Not started"}</strong></div>
      </div>
      <div className="direct-session-actions" aria-label="Direct Session actions">
        <button type="button" className="button secondary-button" disabled={busy || session.deleting} onClick={()=>setRenaming(true)}><Pencil size={14}/> Rename</button>
        <button type="button" className="button secondary-button" disabled={busy || session.deleting} onClick={()=>void command(session.lifecycle==="active"?"archive":"restore")}>{session.lifecycle==="active"?<Archive size={14}/>:<RotateCcw size={14}/>} {session.lifecycle==="active"?"Archive":"Restore"}</button>
        <button type="button" className="button secondary-button danger-outline" disabled={busy} onClick={()=>setConfirmDelete(true)}><Trash2 size={14}/> {session.deleting?"Retry deletion":"Delete"}</button>
      </div>
      {session.deleting && <p className="direct-pending-delete" role="status">Deletion is pending. Provider cleanup has not been confirmed. Retrying asks the host to finish cleanup; bound provider references cannot be cleaned up by this build.</p>}
      <div className="direct-execution-controls" role="group" aria-labelledby="direct-execution-title" aria-describedby="direct-execution-reason">
        <strong id="direct-execution-title">Execution</strong>
        <div>{(["Start","Resume","Cancel","Retry"] as const).map(label=><button key={label} type="button" className="button secondary-button" disabled aria-disabled="true">{label}</button>)}</div>
        <p id="direct-execution-reason">Full execution controls remain unavailable. Eligible Codex Agents can send text turns below; Tool calls are not enabled.</p>
      </div>
      <section className="direct-text-chat" aria-label="Direct Agent text conversation">
        <h2>Text conversation</h2>
        {history.length ? history.map(item=><div key={item.seq} className="direct-text-message"><strong>{item.role==="user"?"You":"Agent"}</strong><p>{item.text}</p></div>)
          : <p>No text turns yet.</p>}
        <form onSubmit={event=>{event.preventDefault();void sendTurn();}}>
          <label htmlFor="direct-text-prompt">Message</label>
          <textarea id="direct-text-prompt" value={prompt} onChange={event=>setPrompt(event.target.value)}
            maxLength={8192} rows={3} disabled={busy||session.deleting||session.lifecycle!=="active"}
            placeholder="Ask this Agent a question"/>
          <button type="submit" className="button primary-button"
            disabled={busy||session.deleting||session.lifecycle!=="active"||!prompt.trim()}>
            {busy?"Sending…":"Send text turn"}</button>
        </form>
      </section>
      {renaming && <form className="direct-inline-form" onSubmit={event=>{event.preventDefault();void command("rename");}}><label>Session name<input autoFocus maxLength={255} value={title} onChange={event=>setTitle(event.target.value)}/></label><button type="button" className="button secondary-button" onClick={()=>{setRenaming(false);setTitle(session.title);}}>Cancel</button><button type="submit" className="button primary-button" disabled={busy || !title.trim()}>Save</button></form>}
      {confirmDelete && <div className="agent-delete-confirm" role="group" aria-label="Confirm Direct Session deletion"><p>{session.deleting?"Ask the host to retry pending cleanup? The Session remains pending if provider cleanup is unavailable.":"Delete this Session and its stored context? This cannot be undone."}</p><button type="button" className="button secondary-button" onClick={()=>setConfirmDelete(false)}>Keep Session</button><button type="button" className="button danger-button" disabled={busy} onClick={()=>void command("delete")}>{session.deleting?"Retry cleanup":"Delete Session"}</button></div>}
      <div className="direct-surface-grid" aria-label="Session surfaces">
        <section><Bot size={18}/><h2>Chat</h2><p>Text turns above use the Direct harness, its context checkpoint and ProviderCall ledger.</p></section>
        <section><FolderOpen size={18}/><h2>Files</h2><p>Session files will appear when a trusted workspace binding is available. Other Sessions remain isolated.</p></section>
        <section><ArrowLeft size={18}/><h2>Terminal</h2><p>The Terminal is unavailable until the host binds this Direct Session to a workspace.</p></section>
      </div>
    </> : !sessionId ? <form className="direct-create-form" onSubmit={event=>{event.preventDefault();void command("create");}}>
      <label>Project Agent<select value={assignmentId} onChange={event=>setAssignmentId(event.target.value)} required><option value="">Choose a released Assignment</option>{assignments.map(item=><option key={item.assignment.id} value={item.assignment.id}>{item.agent.identityState==="governed"?item.agent.identity.name:item.agent.name} · r{item.currentVersion?.revision}</option>)}</select></label>
      {selected?.currentVersion && <p className="direct-version-preview">Agent version {selected.currentVersion.agentVersionId} · Assignment version {selected.currentVersion.id}. These pins remain fixed for this Session.</p>}
      <label>Session name<input value={title} onChange={event=>setTitle(event.target.value)} maxLength={255} required placeholder="What will this Session work on?"/></label>
      <button type="submit" className="button primary-button" disabled={busy || !selected || !title.trim()}>{busy?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} Create Direct Session</button>
      {!assignments.length && <p role="status">No released Project Assignment is available. Configure one in Project Agents first.</p>}
    </form> : null}
  </section>;
}
