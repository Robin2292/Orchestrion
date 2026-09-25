import { AlertCircle, CopyPlus, LockKeyhole, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { CatalogAgentVersionSchema } from "../shared/assignment-ui-contracts";
import type { LocalVersionPinSchema } from "../shared/local-contracts";
import type { z } from "zod";
import { buildAgentDefinition, initialLocalAgentForm, type LocalAgentFormState } from "./local-agent-form";
import { DEFAULT_AGENT_SOUL } from "../shared/agent-soul-contracts";

type Pin = z.infer<typeof LocalVersionPinSchema>;
type SourceVersion = z.infer<typeof CatalogAgentVersionSchema>;
type DirtyHandler = (dirty: boolean, discard: () => void) => void;
const EMPTY_GRANTS = { schema_version: "tool_grants@1" as const, grants: [] };

function inputFor(source?: SourceVersion, sourceName?: string): LocalAgentFormState {
  const form = initialLocalAgentForm("agent", source?.definition,
    source ? { name: `${sourceName ?? "Agent"} project variant`, description: null, userGuide: null } : undefined);
  return source ? form : { ...form, systemPrompt: DEFAULT_AGENT_SOUL };
}

/** First-class creation only; compatibility presets keep their existing editor. */
export function GovernedAgentCreateForm({ api, expected, visibility, source, sourceName, onCreated, onDirtyStateChange }: {
  api: OrchestrionDesktopApi;
  expected: Pin;
  visibility: "organization" | "project";
  source?: SourceVersion;
  sourceName?: string;
  onCreated: (id: string) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  const [initial] = useState(() => inputFor(source, sourceName));
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => {
    onDirtyStateChange(dirty, () => setForm(structuredClone(initial)));
    return () => onDirtyStateChange(false, () => undefined);
  }, [dirty, initial, onDirtyStateChange]);

  const update = <K extends keyof LocalAgentFormState>(key: K, value: LocalAgentFormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = source ? null : buildAgentDefinition(form);
    setErrors(built?.errors ?? {});
    const definition = source?.definition ?? (built?.definition ? { ...built.definition, toolGrants: EMPTY_GRANTS } : null);
    if (!definition) return;
    if (definition.nodeType !== "agent" || definition.toolGrants?.grants.length) {
      setSaveError("This version has Tool grants that the current Project Assignment release cannot accept.");
      return;
    }
    setBusy(true); setSaveError(null);
    try {
      const result = await api.localAssignments.request({ operation: "create", expected,
        requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        payload: { name: form.name.trim(), description: form.description.trim() || null,
          userGuide: form.userGuide.trim() || null, definition, visibility,
          sourceVersionId: source?.id ?? null } });
      if (result.kind !== "command") throw new Error("SERVICE_UNAVAILABLE");
      onDirtyStateChange(false, () => undefined);
      onCreated(result.resultRef);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "SERVICE_UNAVAILABLE";
      setSaveError(code === "REVISION_CONFLICT" ? "The Agent ledger changed. Reload this form before saving." :
        code === "OUTCOME_UNKNOWN" ? "The host could not confirm the outcome. Reload before trying again." :
        code === "ASSIGNMENT_NOT_READY" ? "This Agent definition is not supported by current Local Assignment authority." :
        "The Local host could not save this Agent. Reload and try again.");
    } finally { setBusy(false); }
  };

  const field = (label: string, key: keyof LocalAgentFormState, multiline = false) => <label className="agent-field">
    <span>{label}</span>{multiline
      ? <textarea value={String(form[key])} onChange={(event) => update(key, event.target.value)} rows={key === "systemPrompt" ? 6 : 3} />
      : <input value={String(form[key])} onChange={(event) => update(key, event.target.value)} />}
    {errors[key] && <small role="alert">{errors[key]}</small>}
  </label>;

  return <form className="governed-agent-form" onSubmit={(event) => void submit(event)} noValidate>
    <div className="project-agent-pin"><LockKeyhole size={17} /><div><strong>{source ? "Independent Project variant" : visibility === "organization" ? "Reusable organization Agent" : "Project-only Agent"}</strong><p>{source ? `Copies exact source v${source.versionNumber}. You can create a new behavior version after this identity is saved; upstream changes never apply automatically.` : "Saving creates a first-class Agent identity, immutable v1 and a Project membership. It does not release an Assignment version or start work."}</p></div></div>
    {saveError && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{saveError}</span></div>}
    {source && source.definition.toolGrants?.grants.length !== 0 && <div className="agent-inline-alert" role="status"><AlertCircle size={16} /><span>This source version has unconverted or nonempty Tool grants; the current Project variant contract cannot copy it.</span></div>}
    {errors.form && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{errors.form}</span></div>}
    <div className="agent-form-grid">{field("Name", "name")}{field("Description", "description", true)}{field("User guide", "userGuide", true)}</div>
    {!source && <><h2>Behavior and contract</h2><p className="project-agent-help">Only first-class Agent definitions with empty Tool grants can enter this Assignment release path. Model behavior belongs to an immutable Agent version.</p><div className="agent-form-grid">
      {field("Role", "role")}{field("Provider", "providerType")}{field("Model", "modelId")}
      {field("SOUL.md Markdown", "systemPrompt", true)}{field("User prompt template", "userPromptTemplate", true)}
      {field("Input schema JSON", "inputSchema", true)}{field("Output schema JSON", "outputSchema", true)}{field("Output type", "outputType")}
    </div></>}
    <div className="agent-editor-actions"><span className="agent-editor-status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span><button type="submit" className="button primary-button" disabled={busy || (source ? source.definition.toolGrants?.grants.length !== 0 : false)}>{source ? <CopyPlus size={14} /> : <Save size={14} />}{busy ? "Saving…" : source ? "Create Project variant" : "Create Agent"}</button></div>
  </form>;
}
