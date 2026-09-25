import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, ChevronDown, LayoutGrid, Plus, Search, Zap } from "lucide-react";
import type { ModelOption, ModelReasoningEffort, ModelServiceTier, SessionRecord } from "../shared/contracts";
import { ProviderLogo } from "./ProviderLogo";

interface ModelFamily {
  key: string;
  primary: ModelOption;
  variants: ModelOption[];
}

export interface CompactModelPickerProps {
  open: boolean;
  disabled: boolean;
  session: Pick<SessionRecord, "model" | "modelProvider" | "reasoningEffort" | "serviceTier">;
  models: ModelOption[];
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelOption, effort: string | null, serviceTier: string | null) => Promise<void> | void;
  onConnectProviders?: () => void;
}

function normalizedProvider(model: ModelOption): string {
  return model.providerId ?? "openai";
}

function providerLabel(model: ModelOption): string {
  return model.providerDisplayName ?? (normalizedProvider(model) === "openai" ? "OpenAI" : normalizedProvider(model));
}

export function contextFamilyId(modelId: string): string {
  return modelId.replace(/-(?:\d+(?:\.\d+)?)(?:k|m)$/i, "");
}

export function contextLabel(modelId: string): string {
  const match = modelId.match(/-(\d+(?:\.\d+)?)(k|m)$/i);
  return match ? `${match[1]}${match[2].toUpperCase()}` : "Standard";
}

function displayEffort(value: string): string {
  const aliases: Record<string, string> = { xhigh: "X-High", x_high: "X-High", none: "None" };
  return aliases[value.toLowerCase()] ?? value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function familyKey(model: ModelOption): string {
  return `${normalizedProvider(model)}:${contextFamilyId(model.model)}`;
}

export function modelFamilies(models: ModelOption[]): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const model of models) {
    const key = familyKey(model);
    const current = families.get(key);
    if (!current) {
      families.set(key, { key, primary: model, variants: [model] });
      continue;
    }
    current.variants.push(model);
    if (contextLabel(model.model) === "Standard") current.primary = model;
  }
  return [...families.values()];
}

export function priorityTierForModel(model: ModelOption | null): ModelServiceTier | null {
  if (!model) return null;
  const tiers = model.serviceTiers ?? [];
  return tiers.find((tier) => ["fast", "priority"].includes(tier.id.toLowerCase()))
    ?? tiers.find((tier) => /fast|priority/i.test(`${tier.name} ${tier.description}`))
    ?? null;
}

function supportedTier(model: ModelOption, tier: string | null | undefined): string | null {
  if (!tier) return null;
  return (model.serviceTiers ?? []).some((candidate) => candidate.id === tier) ? tier : null;
}

function effortForModel(model: ModelOption, preferred: string | null | undefined): string | null {
  const options = model.supportedReasoningEfforts;
  if (preferred && options.some((option) => option.reasoningEffort === preferred)) return preferred;
  return model.defaultReasoningEffort || options[0]?.reasoningEffort || null;
}

function searchable(family: ModelFamily): string {
  return family.variants.map((model) => `${model.displayName} ${model.model} ${model.description}`).join(" ").toLowerCase();
}

function currentEffortIndex(efforts: ModelReasoningEffort[], effort: string | null): number {
  const found = efforts.findIndex((candidate) => candidate.reasoningEffort === effort);
  return Math.max(0, found >= 0 ? found : efforts.findIndex((candidate) => candidate.reasoningEffort));
}

export function CompactModelPicker({ open, disabled, session, models, onOpenChange, onChange, onConnectProviders }: CompactModelPickerProps) {
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const activeModel = session.model
    ? models.find((model) => model.model === session.model && model.providerId === session.modelProvider)
      ?? models.find((model) => model.model === session.model && model.providerId === null)
      ?? null
    : models.find((model) => model.isDefault) ?? models[0] ?? null;
  const activeFamily = activeModel ? modelFamilies(models).find((family) => family.key === familyKey(activeModel)) ?? null : null;
  const activeName = activeFamily?.primary.displayName ?? activeModel?.displayName ?? session.model ?? "Model unavailable";
  const efforts = activeModel?.supportedReasoningEfforts ?? [];
  const activeEffort = session.reasoningEffort ?? activeModel?.defaultReasoningEffort ?? efforts[0]?.reasoningEffort ?? null;
  const [effortIndex, setEffortIndex] = useState(() => currentEffortIndex(efforts, activeEffort));
  const lastCommittedEffort = useRef(activeEffort);
  const mutationId = useRef(0);
  const activePriorityTier = priorityTierForModel(activeModel);
  const priorityEnabled = Boolean(activePriorityTier && session.serviceTier === activePriorityTier.id);

  const families = useMemo(() => modelFamilies(models), [models]);
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const model of models) seen.set(normalizedProvider(model), providerLabel(model));
    return [...seen].map(([id, label]) => ({ id, label }));
  }, [models]);
  const visibleFamilies = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return families.filter((family) => {
      const providerMatches = provider === "all" || normalizedProvider(family.primary) === provider;
      return providerMatches && (!needle || searchable(family).includes(needle));
    });
  }, [families, provider, query]);

  useEffect(() => {
    const next = currentEffortIndex(efforts, activeEffort);
    setEffortIndex(next);
    lastCommittedEffort.current = efforts[next]?.reasoningEffort ?? null;
  }, [activeModel?.id, activeEffort]);

  const applyChange = async (model: ModelOption, effort: string | null, tier: string | null, onFailure?: () => void) => {
    const id = ++mutationId.current;
    try {
      await onChange(model, effort, tier);
    } catch {
      if (id === mutationId.current) onFailure?.();
    }
  };

  const chooseModel = (model: ModelOption, preferredEffort?: string | null, preferredTier?: string | null) => {
    const effort = effortForModel(model, preferredEffort);
    const tier = supportedTier(model, preferredTier) ?? model.defaultServiceTier ?? null;
    void applyChange(model, effort, tier);
  };

  const commitEffort = (index: number) => {
    if (!activeModel) return;
    const effort = efforts[index]?.reasoningEffort ?? null;
    if (effort === lastCommittedEffort.current) return;
    const appliedIndex = currentEffortIndex(efforts, activeEffort);
    lastCommittedEffort.current = effort;
    void applyChange(activeModel, effort, session.serviceTier ?? null, () => {
      setEffortIndex(appliedIndex);
      lastCommittedEffort.current = efforts[appliedIndex]?.reasoningEffort ?? null;
    });
  };

  const setContextVariant = (model: ModelOption) => {
    chooseModel(model, activeEffort, session.serviceTier);
  };

  return <>
    <button
      className="composer-model-button"
      type="button"
      onClick={() => onOpenChange(!open)}
      aria-label={`Choose model. Current model ${activeName}${activeEffort ? `, ${displayEffort(activeEffort)} effort` : ""}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      disabled={disabled}
    >
      {priorityEnabled && <Zap className="composer-model-priority" size={12} aria-hidden="true" />}
      <span className="model-name">{activeName}</span>
      {activeEffort && <span className="model-effort">{displayEffort(activeEffort)}</span>}
      <ChevronDown size={13} />
    </button>
    {open && <div className="composer-menu model-menu compact-model-menu" role="dialog" aria-label="Model settings">
      <div className="compact-model-tuning">
        <div className="compact-model-head">
          <button
            className="compact-model-icon priority-tier-toggle"
            type="button"
            aria-label={activePriorityTier ? `Priority service ${priorityEnabled ? "on" : "off"}` : "Priority service unavailable"}
            aria-pressed={priorityEnabled}
            title={activePriorityTier?.description || "Not available for this model"}
            disabled={!activePriorityTier}
            onClick={() => activeModel && void applyChange(activeModel, activeEffort, priorityEnabled ? null : activePriorityTier?.id ?? null)}
          ><Zap size={15} aria-hidden="true" /></button>
          <div className="compact-model-current"><strong>{activeName}</strong>{activeEffort && <span>{displayEffort(activeEffort)}</span>}</div>
          <span className="compact-model-head-spacer" aria-hidden="true" />
        </div>
        {efforts.length > 0 && <div className="compact-effort-control" style={{ "--effort-position": `${efforts.length > 1 ? effortIndex / (efforts.length - 1) * 100 : 0}%` } as CSSProperties}>
          <div className="compact-effort-visual" aria-hidden="true">
            <span className="compact-effort-rail"><span /></span>
            {efforts.map((effort, index) => <span
              className={`compact-effort-tick ${index <= effortIndex ? "passed" : ""} ${index === effortIndex ? "current" : ""}`}
              style={{ left: `${efforts.length > 1 ? index / (efforts.length - 1) * 100 : 0}%` }}
              key={`tick-${effort.reasoningEffort}`}
            />)}
            {efforts.map((effort, index) => <span
              className={`compact-effort-label ${index === 0 ? "first" : ""} ${index === efforts.length - 1 ? "last" : ""} ${index === effortIndex ? "current" : ""}`}
              style={{ left: `${efforts.length > 1 ? index / (efforts.length - 1) * 100 : 0}%` }}
              key={`label-${effort.reasoningEffort}`}
            >{displayEffort(effort.reasoningEffort)}</span>)}
          </div>
          <input
            className="compact-effort-range"
            type="range"
            min={0}
            max={Math.max(0, efforts.length - 1)}
            step={1}
            value={effortIndex}
            aria-label="Effort level"
            aria-valuetext={displayEffort(efforts[effortIndex]?.reasoningEffort ?? "")}
            disabled={efforts.length < 2}
            onInput={(event) => setEffortIndex(Number(event.currentTarget.value))}
            onPointerUp={(event) => commitEffort(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitEffort(Number(event.currentTarget.value))}
            onBlur={(event) => commitEffort(Number(event.currentTarget.value))}
          />
        </div>}
        {activeFamily && activeFamily.variants.length > 1 && <div className="compact-context-row" aria-label="Context window">
          <span>Context</span>
          {activeFamily.variants.map((model) => <button
            type="button"
            key={model.id}
            aria-pressed={model.id === activeModel?.id}
            onClick={() => setContextVariant(model)}
          >{contextLabel(model.model)}</button>)}
        </div>}
      </div>

      <div className="compact-provider-row">
        <div className="compact-provider-tabs" role="tablist" aria-label="Model providers">
          <button type="button" role="tab" aria-selected={provider === "all"} aria-label="All providers" onClick={() => setProvider("all")}><LayoutGrid size={14} aria-hidden="true" /></button>
          {providers.map((item) => <button type="button" role="tab" aria-selected={provider === item.id} aria-label={item.label} title={item.label} onClick={() => setProvider(item.id)} key={item.id}><ProviderLogo providerId={item.id} label={item.label} /></button>)}
        </div>
        <button className="compact-provider-add" type="button" aria-label="Connect provider" title="Connect provider for Orchestrion Sessions" disabled={!onConnectProviders} onClick={onConnectProviders}><Plus size={14} aria-hidden="true" /></button>
      </div>

      <label className="compact-model-search">
        <Search size={13} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }} type="search" placeholder="Search models…" aria-label="Search models" />
      </label>

      <div className="compact-model-list" role="listbox" aria-label="Models">
        {visibleFamilies.map((family) => {
          const selected = activeFamily?.key === family.key;
          const contextOptions = family.variants.map((variant) => contextLabel(variant.model));
          return <button
            className="compact-model-option"
            type="button"
            role="option"
            aria-selected={selected}
            key={family.key}
            onClick={() => chooseModel(family.primary, activeEffort, family.primary.defaultServiceTier)}
          >
            <span className="compact-model-mark"><ProviderLogo providerId={normalizedProvider(family.primary)} label={providerLabel(family.primary)} /></span>
            <span className="compact-model-copy"><strong>{family.primary.displayName}</strong><small>{family.primary.description}</small></span>
            <span className="compact-model-meta">{contextOptions.length > 1 && <small>{contextOptions.at(-1)}</small>}{selected && <Check size={13} aria-hidden="true" />}</span>
          </button>;
        })}
        {visibleFamilies.length === 0 && <div className="model-menu-empty">No models found</div>}
      </div>
    </div>}
  </>;
}
