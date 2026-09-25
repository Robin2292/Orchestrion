import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, KeyRound, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { CodexSubscriptionConnection } from "./CodexSubscriptionConnection";
import { ProviderLogo } from "./ProviderLogo";

type ProviderEntry = { id: string; name: string; detail: string; group: "Popular" | "Other"; methods: readonly string[] };

// Discovery is intentionally broader than Local execution support. Rows with no
// reviewed connection method remain visible but cannot claim readiness.
export const PROVIDER_DIRECTORY: readonly ProviderEntry[] = [
  { id: "openai", name: "OpenAI", detail: "Platform API and experimental ChatGPT subscription", group: "Popular", methods: ["API key", "Subscription OAuth"] },
  { id: "anthropic", name: "Anthropic", detail: "Claude models", group: "Popular", methods: [] },
  { id: "google", name: "Google", detail: "Gemini models", group: "Popular", methods: [] },
  { id: "openrouter", name: "OpenRouter", detail: "Models from multiple providers", group: "Popular", methods: [] },
  { id: "deepseek", name: "DeepSeek", detail: "DeepSeek models", group: "Popular", methods: [] },
  { id: "mistral", name: "Mistral", detail: "Mistral models", group: "Other", methods: [] },
  { id: "xai", name: "xAI", detail: "Grok models", group: "Other", methods: [] },
  { id: "groq", name: "Groq", detail: "Fast model inference", group: "Other", methods: [] },
  { id: "cohere", name: "Cohere", detail: "Command models", group: "Other", methods: [] },
  { id: "local", name: "Local / Custom", detail: "Self hosted model routes", group: "Other", methods: [] },
];

export function filterProviders(query: string): readonly ProviderEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? PROVIDER_DIRECTORY.filter(item => `${item.name} ${item.detail}`.toLocaleLowerCase().includes(needle)) : PROVIDER_DIRECTORY;
}

function ProviderFlow({ projectId, onClose, onManageSubscription }: {
  projectId: string | null; onClose?: () => void; onManageSubscription?: () => void;
}) {
  const flowRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [method, setMethod] = useState<"api" | "oauth" | null>(null);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterProviders(query), [query]);
  const back = () => { if (method) setMethod(null); else setSelected(null); };
  const inDialog = !!onClose;
  useLayoutEffect(() => {
    if (!inDialog) return;
    (selected ? flowRef.current?.querySelector<HTMLElement>("[aria-label='Back to providers']")
      : flowRef.current?.querySelector<HTMLElement>("input[type='search']"))?.focus();
  }, [inDialog, selected, method]);
  return <div ref={flowRef} className="provider-flow">
    <header className="provider-flow-header">
      {selected && <button type="button" className="provider-flow-icon" aria-label="Back to providers" onClick={back}><ArrowLeft size={17} /></button>}
      <div><span className="eyebrow">Orchestrion · Direct Sessions</span><h2>{!selected ? "Connect provider" : method === "api" ? "OpenAI API key" : method === "oauth" ? "ChatGPT subscription" : "Connect OpenAI"}</h2></div>
      {onClose && <button type="button" className="provider-flow-icon provider-flow-close" aria-label="Close provider connections" onClick={onClose}><X size={18} /></button>}
    </header>
    {!selected ? <>
      <label className="provider-flow-search"><Search size={16} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search providers" aria-label="Search providers" /></label>
      <div className="provider-flow-list">
        {(["Popular", "Other"] as const).map(group => {
          const rows = visible.filter(item => item.group === group);
          return rows.length ? <section key={group} aria-label={`${group} providers`}><h3>{group}</h3>{rows.map(item => <button
            type="button" className="provider-flow-row" key={item.id} onClick={() => { setSelected(item.id); setMethod(null); }}
          ><span className="provider-flow-logo"><ProviderLogo providerId={item.id} label={item.name} size={18} /></span><span className="provider-flow-row-copy"><strong>{item.name}</strong><small>{item.detail}</small></span><span className={`provider-flow-tag ${item.methods.length ? "available" : ""}`}>{item.methods.length ? "Connection options" : "Coming later"}</span><ArrowRight size={15} /></button>)}</section> : null;
        })}
        {!visible.length && <p className="provider-flow-empty">No providers match “{query}”.</p>}
      </div>
    </> : selected !== "openai" ? <div className="provider-flow-message"><ProviderLogo providerId={selected} label={selected} size={25} /><h3>{PROVIDER_DIRECTORY.find(item => item.id === selected)?.name}</h3><p>A Local connection and Direct Session adapter are not available for this provider yet.</p></div>
      : !method ? <div className="provider-flow-methods">
        <p>Choose how to connect OpenAI. Connection status and Direct Session execution readiness are checked separately.</p>
        <button type="button" onClick={() => setMethod("api")}><KeyRound size={20} /><span><strong>OpenAI Platform API key</strong><small>Use metered Platform models with the Orchestrion harness.</small></span><ArrowRight size={16} /></button>
        <button type="button" onClick={() => projectId && onManageSubscription ? onManageSubscription() : setMethod("oauth")}><ShieldCheck size={20} /><span><strong>ChatGPT / Codex subscription</strong><small>Experimental OAuth connection for a Personal Local Project.</small></span><ArrowRight size={16} /></button>
      </div> : method === "api" ? <div className="provider-flow-message"><KeyRound size={25} /><h3>OpenAI Platform API key</h3><p>Secure key entry and Direct Session execution are being connected to the Local host. No key is accepted by this screen until that path is ready.</p></div>
        : <div className="provider-flow-message"><h3>Personal Local Project required</h3><p>Open a Personal Local Project before starting this experimental OAuth connection.</p></div>}
  </div>;
}

export function ProviderConnectionDialog({ projectId, onClose, onManageSubscription, returnFocus }: {
  projectId: string | null; onClose: () => void; onManageSubscription?: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const restore = useRef<(() => HTMLElement | null) | undefined>(undefined);
  restore.current = returnFocus;
  useEffect(() => {
    return () => { const previous = previouslyFocused.current;
      const target = restore.current?.() ?? (previous?.isConnected ? previous : null);
      target?.focus(); };
  }, []);
  return <div className="provider-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="provider-dialog" role="dialog" aria-modal="true" aria-label="Connect provider" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [])];
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <ProviderFlow projectId={projectId} onClose={onClose} onManageSubscription={onManageSubscription} />
    </div>
  </div>;
}

export function ProviderSettingsHost({ projectId }: { projectId: string | null }) {
  const subscription = useRef<HTMLDivElement>(null);
  const showSubscription = () => { subscription.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); subscription.current?.focus(); };
  return <section className="management-host provider-settings-host" aria-label="Provider settings">
    <header className="management-header"><div><span className="eyebrow"><Settings2 size={13} /> Settings</span><h1>Providers</h1><p>Manage how Orchestrion connects to model providers for Direct Sessions.</p></div></header>
    <div className="management-body">
      <div className="provider-settings-section"><div className="provider-settings-section-heading"><span className="eyebrow">Connections</span><h2>Connected providers</h2><p>Connection status does not by itself mean a model is ready for Direct Session execution.</p></div>
        {projectId ? <div className="provider-subscription-target" ref={subscription} tabIndex={-1}><CodexSubscriptionConnection projectId={projectId} /></div> : <p className="provider-settings-unavailable">Open a Personal Local Project to view its provider connections.</p>}
      </div>
      <div className="provider-settings-section"><div className="provider-settings-section-heading"><span className="eyebrow">Directory</span><h2>Explore providers</h2><p>Find connection methods and see which Local routes are ready.</p></div><ProviderFlow projectId={projectId} onManageSubscription={showSubscription} /></div>
    </div>
  </section>;
}
