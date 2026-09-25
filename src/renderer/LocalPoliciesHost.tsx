import { useEffect,useMemo,useRef,useState,type ReactNode } from "react";
import {
  AlertTriangle,ArrowDownToLine,Check,ChevronRight,FlaskConical,History,
  Layers3,LoaderCircle,RefreshCw,Save,ShieldCheck,X,
} from "lucide-react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { P0RuleSchema } from "../shared/policy/p0-evaluator";
import type {
  LocalPolicySimulationView,LocalPolicyUiItem,LocalPolicyUiWorkspace,
} from "../shared/policy/p2-ui-contracts";
import type { z } from "zod";
import { LocalRouteLink,useLocalNavigation,type LocalRoute } from "./navigation";

type Rule = z.infer<typeof P0RuleSchema>;
type PolicyRoute = Extract<LocalRoute,{ kind:"local-policies" | "local-policy" }>;
type DirtyHandler = (dirty: boolean,discard: () => void) => void;
type ConfirmAction = "review"|"publish"|"activate"|"rollback";
type ConfirmTarget = Readonly<{
  action:ConfirmAction;
  label:string;
  expected:Readonly<LocalPolicyUiWorkspace["expected"]>;
  pin:Readonly<{ id:string;releaseHash:string;stateRevision:number }>;
  expectedSequence:number;
  evidence:string;
}>;

const CONFIRMATION_EXPIRED="Policy confirmation expired because its release or evidence changed. Reopen the action from the current release.";

const ERROR_MESSAGES: Record<string,string> = {
  REVISION_CONFLICT:"Policy history changed. Reload before continuing; the stale request had no effect.",
  POLICY_RELEASE_STALE:"A newer Policy release exists. Reload before continuing; the stale request had no effect.",
  POLICY_STATE_CONFLICT:"This release changed. Reload before continuing; the stale request had no effect.",
  POLICY_HASH_CONFLICT:"Release evidence changed. Reload before continuing; the request had no effect.",
  AUTHORITY_SCOPE_WIDENING:"That rule would widen the upstream ceiling. Narrow its path and try again.",
  POLICY_APPROVAL_RUNTIME_UNSUPPORTED:"Not Ready: Local approval dispatch is unavailable. Keep this Policy unpublished or choose allow/deny.",
  POLICY_AUTHORITY_UNAVAILABLE:"The Local host cannot prove the upstream ceiling. Reload after its Tool contract, grant, and Connector are ready.",
  SERVICE_UNAVAILABLE:"The Local Policy host is unavailable. No operation was assumed to succeed.",
  OUTCOME_UNKNOWN:"The result is unknown. Reload persisted Policy history before trying again.",
};

export function policyUiErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : error instanceof Error ? error.message : "SERVICE_UNAVAILABLE";
  return ERROR_MESSAGES[code] ?? "The Policy operation was refused. Reload and review the effective ceiling.";
}

export function LocalPoliciesHost({ route,workspace,loadError,api,onWorkspaceChange,onDirtyStateChange }: {
  route: PolicyRoute;
  workspace: LocalPolicyUiWorkspace | null;
  loadError: string | null;
  api: OrchestrionDesktopApi | undefined;
  onWorkspaceChange: (workspace: LocalPolicyUiWorkspace) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  if (!workspace) return <PolicyShell title="Policies" detail="Author, simulate, and release narrow Local access rules.">
    <div className="policy-empty" role={loadError ? "alert" : "status"}><ShieldCheck size={27} /><h2>{loadError ? "Policy desk unavailable" : "Loading Policy history…"}</h2><p>{loadError ?? "The Local host is proving immutable release evidence."}</p></div>
  </PolicyShell>;
  const selectedId = route.kind === "local-policy" ? route.releaseId : workspace.items[0]?.release.id ?? null;
  const selected = workspace.items.find((item) => item.release.id === selectedId) ?? null;
  return <PolicyWorkspace workspace={workspace} selected={selected} api={api} onWorkspaceChange={onWorkspaceChange} onDirtyStateChange={onDirtyStateChange} />;
}

function PolicyWorkspace({ workspace,selected,api,onWorkspaceChange,onDirtyStateChange }: {
  workspace:LocalPolicyUiWorkspace;selected:LocalPolicyUiItem|null;api:OrchestrionDesktopApi|undefined;
  onWorkspaceChange:(workspace:LocalPolicyUiWorkspace)=>void;onDirtyStateChange:DirtyHandler;
}) {
  const { replace } = useLocalNavigation();
  const [rules,setRules] = useState<Rule[]>(() => cloneRules(selected?.release.definition.rules ?? []));
  const [baseline,setBaseline] = useState(() => JSON.stringify(selected?.release.definition.rules ?? []));
  const [simulation,setSimulation] = useState<LocalPolicySimulationView|null>(null);
  const [resource,setResource] = useState("/workspace/public/example.txt");
  const [mode,setMode] = useState<"read"|"write">("read");
  const [busy,setBusy] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [reloadRequired,setReloadRequired] = useState(false);
  const [confirm,setConfirm] = useState<ConfirmTarget|null>(null);
  const confirmAnchor = useRef<HTMLElement|null>(null);
  const confirmationPending = useRef(false);
  const dirty = !!selected && JSON.stringify(rules) !== baseline;
  const selectedId = selected?.release.id;
  const current = useRef({ workspace,selected,dirty,reloadRequired });
  current.current={ workspace,selected,dirty,reloadRequired };

  useEffect(() => {
    const next = cloneRules(selected?.release.definition.rules ?? []);
    setRules(next);setBaseline(JSON.stringify(next));setSimulation(null);setError(null);setReloadRequired(false);
  },[selectedId]);
  useEffect(() => {
    const discard = () => { const next=JSON.parse(baseline) as Rule[];setRules(next);setSimulation(null); };
    onDirtyStateChange(dirty,discard);
    return () => onDirtyStateChange(false,() => undefined);
  },[baseline,dirty,onDirtyStateChange]);

  const counts = useMemo(() => workspace.items.reduce((value,item) => ({
    ready:value.ready+(item.readiness.state === "ready" ? 1 : 0),
    active:value.active+(item.selection?.releaseId === item.release.id && item.selection.action !== "deactivate" ? 1 : 0),
  }),{ ready:0,active:0 }),[workspace]);
  const validation = validateRules(rules);
  const mutate = async (label:string,operation:() => Promise<{ workspace:LocalPolicyUiWorkspace;selectedReleaseId:string|null }>,target?:ConfirmTarget) => {
    setBusy(label);setError(null);setSimulation(null);
    try {
      const value=await operation();
      if(!target||confirmationMatches(target,current.current)){onWorkspaceChange(value.workspace);setReloadRequired(false);
        if(value.selectedReleaseId) replace({ kind:"local-policy",projectId:value.workspace.projectId,releaseId:value.selectedReleaseId });}
    } catch(reason) {
      if(!target||confirmationMatches(target,current.current)){
        const message=policyUiErrorMessage(reason);setError(message);
        const code=reason&&typeof reason==="object"&&"code" in reason?reason.code:null;
        if(["REVISION_CONFLICT","POLICY_RELEASE_STALE","POLICY_STATE_CONFLICT","POLICY_HASH_CONFLICT","OUTCOME_UNKNOWN"].includes(String(code))) setReloadRequired(true);
      }
    } finally { setBusy(null); }
  };
  const reload = async () => {
    if(!api)return;
    const invalidated=!!confirm;
    if(invalidated){confirmationPending.current=false;setConfirm(null);restoreConfirmFocus();}
    setBusy("reload");setError(null);setSimulation(null);
    try { const value=await api.localPolicies.snapshot();onWorkspaceChange(value.workspace);setReloadRequired(false);if(invalidated)setError(CONFIRMATION_EXPIRED); }
    catch(reason){setError(policyUiErrorMessage(reason));setReloadRequired(true);}
    finally{setBusy(null);}
  };
  const identity = () => ({ expected:workspace.expected,requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID() });
  const pin = () => ({ id:selected!.release.id,releaseHash:selected!.release.releaseHash,stateRevision:selected!.release.stateRevision });
  const draft = () => selected&&api&&mutate("draft",() => api.localPolicies.draft({ operation:"draft",...identity(),payload:{ source:pin(),rules } }));
  const transition = (target:ConfirmTarget) => api
    ? mutate(target.action,() => api.localPolicies.transition({ operation:"transition",expected:target.expected,requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),payload:{ ...target.pin,action:target.action as "review"|"publish" } }),target)
    : Promise.resolve();
  const select = (target:ConfirmTarget) => api
    ? mutate(target.action,() => api.localPolicies.select({ operation:"select",expected:target.expected,requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),payload:{ ...target.pin,action:target.action as "activate"|"rollback",expectedSequence:target.expectedSequence } }),target)
    : Promise.resolve();
  const simulate = async () => {
    if(!selected||!api)return;setBusy("simulate");setError(null);setSimulation(null);
    try { const value=await api.localPolicies.simulate({ operation:"simulate",expected:workspace.expected,payload:{ ...pin(),resource:{ resourceType:"workspace_path",value:resource,mode } } });setSimulation(value.simulation);onWorkspaceChange(value.workspace); }
    catch(reason){setError(policyUiErrorMessage(reason));setReloadRequired(true);}
    finally{setBusy(null);}
  };

  const reviewDisabled = !actionEligible("review",selected,dirty)||busy!==null;
  const publishDisabled = !actionEligible("publish",selected,dirty)||busy!==null;
  const activateDisabled = !actionEligible("activate",selected,dirty)||busy!==null;
  const rollbackDisabled = !actionEligible("rollback",selected,dirty)||busy!==null;
  const restoreConfirmFocus = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    const anchor=confirmAnchor.current;
    if(anchor?.isConnected&&!anchor.matches(":disabled")){anchor.focus();return;}
    const nextAction=document.querySelector<HTMLButtonElement>(".policy-release-actions button:not(:disabled):not([aria-disabled='true'])");
    (nextAction??document.querySelector<HTMLButtonElement>(".policy-host button:not(:disabled)"))?.focus();
  }));
  const openConfirm = (action:ConfirmAction,anchor:HTMLElement) => {
    if(!selected||!actionEligible(action,selected,dirty)||reloadRequired)return;
    confirmationPending.current=false;confirmAnchor.current=anchor;
    setConfirm(Object.freeze({ action,label:`r${selected.release.revision} · ${targetLabel(selected)}`,expected:Object.freeze({ ...workspace.expected }),
      pin:Object.freeze({ id:selected.release.id,releaseHash:selected.release.releaseHash,stateRevision:selected.release.stateRevision }),
      expectedSequence:selected.selection?.sequence??0,evidence:confirmationEvidence(workspace,selected) }));
  };
  const closeConfirm = () => { confirmationPending.current=false;setConfirm(null);restoreConfirmFocus(); };
  const invalidateConfirm = () => { confirmationPending.current=false;setConfirm(null);setError(CONFIRMATION_EXPIRED);restoreConfirmFocus(); };
  const runConfirmed = async () => {
    if(!confirm||confirmationPending.current)return;
    const target=confirm;
    if(!confirmationMatches(target,current.current)){invalidateConfirm();return;}
    confirmationPending.current=true;setConfirm(null);
    try { if(target.action==="review"||target.action==="publish")await transition(target);else await select(target); }
    finally { confirmationPending.current=false;restoreConfirmFocus(); }
  };
  useEffect(()=>{if(confirm&&!confirmationMatches(confirm,current.current))invalidateConfirm();},[confirm,selected,workspace,dirty,reloadRequired]);
  return <PolicyShell title="Policies" detail="Narrow the effective ceiling, test a synthetic resource, then publish an immutable release."
    action={<button className="button secondary-button" disabled={busy!==null} onClick={() => void reload()}><RefreshCw className={busy==="reload"?"spin":""} size={14}/>Reload</button>}>
    <section className="policy-metrics" aria-label="Policy summary"><Metric label="Immutable releases" value={workspace.items.length}/><Metric label="Ready to review" value={counts.ready}/><Metric label="Active bindings" value={counts.active}/></section>
    {error&&<div className="policy-alert" role="alert"><AlertTriangle size={16}/><span>{error}</span>{reloadRequired&&<button onClick={() => void reload()}>Reload policies</button>}</div>}
    {!workspace.items.length?<div className="policy-empty" role="status"><Layers3 size={27}/><h2>No Policy releases yet</h2><p>Create the first organization release through the trusted Local setup flow. This desk never invents an authority source.</p></div>
      :!selected?<div className="policy-empty" role="alert"><AlertTriangle size={27}/><h2>Policy release not found</h2><p>The deep link does not belong to this Local project.</p></div>
      :<div className="policy-layout">
        <aside className="policy-release-rail" aria-label="Immutable Policy history"><span className="eyebrow">Release history</span>{workspace.items.map((item)=><LocalRouteLink key={item.release.id} className={`policy-release-row ${item.release.id===selected.release.id?"selected":""}`} aria-current={item.release.id===selected.release.id?"page":undefined} to={{ kind:"local-policy",projectId:workspace.projectId,releaseId:item.release.id }}><span><strong>r{item.release.revision}</strong><small>{targetLabel(item)}</small></span><span className={`policy-state ${item.readiness.state}`}>{item.selection?.releaseId===item.release.id&&item.selection.action!=="deactivate"?"Active":item.release.lifecycle}</span><ChevronRight size={14}/></LocalRouteLink>)}</aside>
        <main className="policy-authoring">
          <section className="policy-card policy-editor-card"><header><div><span className="eyebrow">Immutable release r{selected.release.revision}</span><h2>{selected.release.definition.policy_key}</h2><p>{selected.release.toolName} · {targetLabel(selected)}</p></div><span className={`policy-readiness ${selected.readiness.state}`}>{selected.readiness.label}</span></header>
            <div className="policy-ceiling-banner"><ShieldCheck size={18}/><div><strong>Changes can only narrow this ceiling</strong><p>{scopeSummary(selected.upstreamScope)} → {scopeSummary(selected.effectiveScope)}</p></div></div>
            <div className="policy-rules-heading"><div><h3>Narrowing rules</h3><p>Deny wins. Approval-required rules remain typed Not Ready in Local.</p></div><button className="button secondary-button" onClick={()=>setRules((current)=>[...current,newRule(current.length)])}>Add rule</button></div>
            <div className="policy-rule-list">{rules.map((rule,index)=><RuleEditor key={`${index}:${rule.rule_id}`} rule={rule} index={index} only={rules.length===1} onChange={(next)=>{setRules((current)=>current.map((item,i)=>i===index?next:item));setSimulation(null);}} onRemove={()=>{setRules((current)=>current.filter((_,i)=>i!==index));setSimulation(null);}}/>)}</div>
            {validation&&<p className="policy-validation" role="alert">{validation}</p>}
            <div className="policy-editor-actions"><span>{dirty?"Unsaved changes":"Matches immutable release"}</span><button className="button primary-button" disabled={!dirty||!!validation||busy!==null||reloadRequired} onClick={()=>void draft()}>{busy==="draft"?<LoaderCircle className="spin" size={14}/>:<Save size={14}/>}Save new draft</button></div>
          </section>
          <section className="policy-card"><header><div><span className="eyebrow">Effective diff</span><h2>{selected.diff.length} server-proved change{selected.diff.length===1?"":"s"}</h2></div></header>{selected.diff.length?<ul className="policy-diff">{selected.diff.map((entry)=><li key={entry.ruleId}><span className={entry.change}>{entry.change}</span><strong>{entry.ruleId}</strong><small>{entry.before?.matcher.value??"∅"} → {entry.after?.matcher.value??"∅"}</small></li>)}</ul>:<p className="policy-muted">No rule changes against the active baseline.</p>}</section>
        </main>
        <aside className="policy-evidence-column">
          <section className="policy-card policy-simulation"><header><div><span className="eyebrow">Zero-dispatch preview</span><h2>Test a resource</h2></div><FlaskConical size={18}/></header><p className="policy-muted">Synthetic evaluation only. No Tool or external system is called.</p><label>Resource path<input aria-label="Simulation resource path" value={resource} onChange={(event)=>{setResource(event.target.value);setSimulation(null);}}/></label><label>Mode<select aria-label="Simulation mode" value={mode} onChange={(event)=>{setMode(event.target.value as "read"|"write");setSimulation(null);}}><option value="read">Read</option><option value="write">Write</option></select></label><button className="button policy-simulate-button" disabled={busy!==null||reloadRequired} onClick={()=>void simulate()}>{busy==="simulate"?<LoaderCircle className="spin" size={14}/>:<FlaskConical size={14}/>}Run simulation</button>{simulation&&<SimulationResult value={simulation}/>}</section>
          <section className="policy-card policy-release-actions"><span className="eyebrow">Review & release</span><button disabled={reviewDisabled} aria-disabled={reviewDisabled||reloadRequired} onClick={(event)=>{if(!reviewDisabled&&!reloadRequired)openConfirm("review",event.currentTarget);}}><Check size={14}/>Mark reviewed<ChevronRight size={14}/></button><button disabled={publishDisabled} aria-disabled={publishDisabled||reloadRequired} onClick={(event)=>{if(!publishDisabled&&!reloadRequired)openConfirm("publish",event.currentTarget);}}><ShieldCheck size={14}/>Publish immutable release<ChevronRight size={14}/></button><button className="primary" disabled={activateDisabled} aria-disabled={activateDisabled||reloadRequired} onClick={(event)=>{if(!activateDisabled&&!reloadRequired)openConfirm("activate",event.currentTarget);}}><ArrowDownToLine size={14}/>Activate release<ChevronRight size={14}/></button><button disabled={rollbackDisabled} aria-disabled={rollbackDisabled||reloadRequired} onClick={(event)=>{if(!rollbackDisabled&&!reloadRequired)openConfirm("rollback",event.currentTarget);}}><History size={14}/>Roll back to this release<ChevronRight size={14}/></button>{selected.readiness.state!=="ready"&&<div className="policy-not-ready"><AlertTriangle size={15}/><div><strong>{selected.readiness.label}</strong><p>{selected.readiness.remediation}</p></div></div>}</section>
          <details className="policy-card policy-advanced"><summary>Advanced evidence</summary><dl><Fact label="Release fingerprint" value={selected.release.releaseHash}/><Fact label="State revision" value={String(selected.release.stateRevision)}/><Fact label="Upstream release" value={selected.upstreamRelease?`r${selected.upstreamRelease.revision}`:"Organization root"}/><Fact label="Applicable stack" value={selected.applicableReleases.map((item)=>`r${item.revision}`).join(" → ")}/></dl><h3>Effective scope</h3><pre>{JSON.stringify(selected.effectiveScope,null,2)}</pre><p>Preview only · grants authority: false</p></details>
        </aside>
      </div>}
    {confirm&&<ConfirmPolicyDialog target={confirm} busy={busy!==null} onCancel={closeConfirm} onConfirm={()=>void runConfirmed()}/>}
  </PolicyShell>;
}

function RuleEditor({ rule,index,only,onChange,onRemove }: { rule:Rule;index:number;only:boolean;onChange:(rule:Rule)=>void;onRemove:()=>void }) {
  return <fieldset className="policy-rule"><legend>Rule {String(index+1).padStart(2,"0")}</legend><label>Rule ID<input aria-label={`Rule ${index+1} ID`} value={rule.rule_id} onChange={(event)=>onChange({ ...rule,rule_id:event.target.value })}/></label><label>Path<input aria-label={`Rule ${index+1} path`} value={rule.matcher.value} onChange={(event)=>onChange({ ...rule,matcher:{ ...rule.matcher,value:event.target.value } })}/></label><label>Match<select aria-label={`Rule ${index+1} match`} value={rule.matcher.kind} onChange={(event)=>onChange({ ...rule,matcher:{ ...rule.matcher,kind:event.target.value as Rule["matcher"]["kind"] } })}><option value="path_prefix">Path and children</option><option value="exact">Exact path</option></select></label><label>Decision<select aria-label={`Rule ${index+1} decision`} value={rule.decision} onChange={(event)=>onChange({ ...rule,decision:event.target.value as Rule["decision"] })}><option value="allow">Allow</option><option value="require_approval">Require approval · Not Ready</option><option value="deny">Deny</option></select></label><label>Reason code<input aria-label={`Rule ${index+1} reason`} value={rule.reason_code} onChange={(event)=>onChange({ ...rule,reason_code:event.target.value })}/></label><button type="button" aria-label={`Remove rule ${index+1}`} disabled={only} onClick={onRemove}><X size={14}/>Remove</button></fieldset>;
}

function SimulationResult({ value }: { value:LocalPolicySimulationView }) {
  return <div className={`policy-simulation-result ${value.state}`} aria-live="polite"><strong>{value.state==="not_ready"?"Not Ready":value.state}</strong>{value.canonicalResource&&<p>{value.canonicalResource.value}</p>}{value.matchedRules.map((rule)=><small key={`${rule.releaseId}:${rule.ruleId}`}>{rule.ruleId}</small>)}{value.decision?.reasonCodes.map((code)=><small key={code}>{code}</small>)}{value.diagnostics.map((item)=><p key={item.code}>{item.correctiveAction}</p>)}<span>0 dispatches</span></div>;
}

const CONFIRMATION_COPY:Record<ConfirmAction,{ title:(label:string)=>string;body:string;confirm:string }>={
  review:{ title:(label)=>`Mark release ${label} reviewed?`,body:"This records review of the exact immutable draft. It does not publish or activate the release.",confirm:"Mark reviewed" },
  publish:{ title:(label)=>`Publish immutable release ${label}?`,body:"Publishing freezes this reviewed release. It does not activate it.",confirm:"Publish release" },
  activate:{ title:(label)=>`Activate Policy release ${label}?`,body:"The active binding will move to this exact published release. Live requests still require effect-time Policy admission.",confirm:"Activate release" },
  rollback:{ title:(label)=>`Restore historical release ${label}?`,body:"The active binding will move to this exact historical release. Audit history remains intact.",confirm:"Confirm rollback" },
};

function ConfirmPolicyDialog({ target,busy,onCancel,onConfirm }: { target:ConfirmTarget;busy:boolean;onCancel:()=>void;onConfirm:()=>void }) {
  const dialog=useRef<HTMLElement>(null);
  const copy=CONFIRMATION_COPY[target.action];
  const trap=(event:React.KeyboardEvent<HTMLElement>)=>{if(event.key==="Escape"){event.preventDefault();onCancel();return;}if(event.key!=="Tab")return;const controls=[...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")],first=controls[0],last=controls.at(-1);if(!first||!last)return;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
  return <div className="policy-dialog-backdrop"><section ref={dialog} className="policy-dialog" role="alertdialog" aria-modal="true" aria-labelledby="policy-confirm-title" onKeyDown={trap}><button className="dialog-close" aria-label="Close confirmation" onClick={onCancel}><X size={16}/></button><ShieldCheck size={24}/><h2 id="policy-confirm-title">{copy.title(target.label)}</h2><p>{copy.body}</p><div><button autoFocus className="button secondary-button" onClick={onCancel}>Cancel</button><button className="button primary-button" disabled={busy} onClick={onConfirm}>{copy.confirm}</button></div></section></div>;
}

function PolicyShell({ title,action,children }: { title:string;detail:string;action?:ReactNode;children:ReactNode }) { return <div className="policy-host"><header className="policy-header local-page-heading"><h1>{title}</h1>{action}</header>{children}</div>; }
function Metric({ label,value }: { label:string;value:number }) { return <div><span>{String(value).padStart(2,"0")}</span><small>{label}</small></div>; }
function Fact({ label,value }: { label:string;value:string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function scopeSummary(scope:Record<string,unknown>) { const path=typeof scope.workspace_dir==="string"?scope.workspace_dir:typeof scope.base_path==="string"?scope.base_path:null;return path??"No effective path"; }
function targetLabel(item:LocalPolicyUiItem) { const target=item.release.target;return target.layer==="organization"?"Organization":target.layer==="workflow"?`Workflow · ${target.workflowId}`:target.layer==="agent"?`Agent version · ${target.versionId}`:`Workflow node · ${target.nodeId}`; }
function actionEligible(action:ConfirmAction,item:LocalPolicyUiItem|null,dirty:boolean){
  if(!item||dirty||item.readiness.state!=="ready")return false;
  const active=!!item.selection&&item.selection.releaseId===item.release.id&&item.selection.action!=="deactivate";
  if(action==="review")return item.release.lifecycle==="draft";
  if(action==="publish")return item.release.lifecycle==="reviewed";
  if(action==="activate")return item.release.lifecycle==="published"&&!active;
  return item.release.lifecycle==="published"&&!active&&!!item.selection;
}
function confirmationEvidence(workspace:LocalPolicyUiWorkspace,item:LocalPolicyUiItem){return JSON.stringify({
  projectId:workspace.projectId,expected:workspace.expected,
  release:{ id:item.release.id,revision:item.release.revision,releaseHash:item.release.releaseHash,stateRevision:item.release.stateRevision,
    lifecycle:item.release.lifecycle,target:item.release.target,toolName:item.release.toolName,policyKey:item.release.definition.policy_key },
  readiness:item.readiness,selection:item.selection,baselineRelease:item.baselineRelease,upstreamRelease:item.upstreamRelease,applicableReleases:item.applicableReleases,
});}
function confirmationMatches(target:ConfirmTarget,state:{ workspace:LocalPolicyUiWorkspace;selected:LocalPolicyUiItem|null;dirty:boolean;reloadRequired:boolean }){
  return !state.reloadRequired&&actionEligible(target.action,state.selected,state.dirty)&&!!state.selected
    &&target.pin.id===state.selected.release.id&&target.evidence===confirmationEvidence(state.workspace,state.selected);
}
function cloneRules(rules:Rule[]):Rule[]{return rules.map((rule)=>({ ...rule,matcher:{ ...rule.matcher } }));}
function newRule(index:number):Rule{return { rule_id:`rule-${index+1}`,resource_type:"workspace_path",mode:"read",matcher:{ kind:"path_prefix",value:"/workspace" },decision:"deny",reason_code:"POLICY_EXPLICIT_DENY" };}
function validateRules(rules:Rule[]):string|null{if(!rules.length)return"Keep at least one explicit rule.";const ids=new Set<string>();for(const rule of rules){if(!rule.rule_id.trim()||!rule.matcher.value.trim()||!rule.reason_code.trim())return"Every rule needs an ID, path, and reason code.";if(ids.has(rule.rule_id))return`Rule ID “${rule.rule_id}” is duplicated.`;ids.add(rule.rule_id);}return null;}
