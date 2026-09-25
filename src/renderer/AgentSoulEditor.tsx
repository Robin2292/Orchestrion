import { AlertCircle, ExternalLink, FileText, RefreshCw, Save, Send } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { AgentSoulDraft } from "../shared/agent-soul-contracts";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import type { CatalogAgentVersionSchema } from "../shared/assignment-ui-contracts";
import type { LocalVersionPinSchema } from "../shared/local-contracts";
import type { z } from "zod";

type Version = LocalAgentVersion | z.infer<typeof CatalogAgentVersionSchema>;
type Pin = z.infer<typeof LocalVersionPinSchema>;

export function soulText(version: Version): string {
  return version.soul?.content ?? version.definition.systemPrompt ?? "";
}

/** A bounded linear comparison: unchanged prefix/suffix surround exact removed
 * and added middle blocks. It never hides bytes or fabricates legacy provenance. */
export function soulDiff(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start
    && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [
    ...a.slice(0, start).map((line) => ({ kind: "same" as const, line })),
    ...a.slice(start, a.length - end).map((line) => ({ kind: "removed" as const, line })),
    ...b.slice(start, b.length - end).map((line) => ({ kind: "added" as const, line })),
    ...a.slice(a.length - end).map((line) => ({ kind: "same" as const, line })),
  ];
}

export function AgentSoulVersionDiff({ current, previous }: { current: Version; previous: Version | null }) {
  const lines = soulDiff(previous ? soulText(previous) : "", soulText(current));
  return <section className="agent-soul-version" aria-label="SOUL version comparison">
    <div className="agent-soul-section-head"><div><span className="eyebrow">Published behavior</span><h3>SOUL.md · v{current.versionNumber}</h3></div><span>{current.soul ? current.soul.hash : "Legacy prompt · no SOUL snapshot"}</span></div>
    <p>{previous ? `Compared with v${previous.versionNumber}` : "First version"}. {current.soul ? "Exact UTF-8 snapshot stored with this version." : "Historical prompt is shown without inventing a SOUL file."}</p>
    <pre className="agent-soul-diff" aria-label="SOUL Markdown diff">{lines.map((item, index) => <span key={index} className={item.kind}>{item.kind === "added" ? "+" : item.kind === "removed" ? "−" : " "} {item.line}{"\n"}</span>)}</pre>
  </section>;
}

function message(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : "SERVICE_UNAVAILABLE";
  const messages: Record<string,string> = {
    SOUL_CONFLICT: "SOUL.md or the published Agent version changed. Your text is kept here; copy it before discarding edits and reloading.",
    SOUL_TOO_LARGE: "SOUL.md exceeds the 128 KiB limit. Shorten it before saving or publishing.",
    SOUL_INVALID_CONTENT: "SOUL.md must be valid UTF-8 Markdown with no NUL bytes. Publishing also requires nonempty text.",
    SOUL_FILE_UNAVAILABLE: "The managed SOUL.md file could not be read or opened. Check the file in application data and reload.",
    REVISION_CONFLICT: "The Agent ledger changed. Reload the current version before publishing.",
    OUTCOME_UNKNOWN: "The host could not confirm that action. Reload the draft and version history before retrying.",
    NOT_AUTHENTICATED: "Your Local access changed. Reopen the Agent page.",
  };
  return messages[code] ?? "The Local SOUL editor is unavailable. Reload and try again.";
}

export function AgentSoulEditor({ api, agentId, latest, expected, onPublished, onDirtyStateChange }: {
  api: OrchestrionDesktopApi;
  agentId: string;
  latest: Version;
  expected: Pin;
  onPublished: () => Promise<void> | void;
  onDirtyStateChange: (dirty: boolean, discard: () => void) => void;
}) {
  const [draft, setDraft] = useState<AgentSoulDraft | null>(null);
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== null && content !== draft.content;
  useEffect(() => {
    onDirtyStateChange(dirty, () => setContent(draft?.content ?? ""));
    return () => onDirtyStateChange(false, () => undefined);
  }, [dirty, draft, onDirtyStateChange]);
  useEffect(() => {
    let active = true;
    if (!api.localAgentSoul?.request) { setError("Restart Orchestrion to use the SOUL.md editor."); return; }
    void api.localAgentSoul.request({ operation: "read", agentId }).then((value) => {
      if (active && value.kind === "draft") { setDraft(value.draft); setContent(value.draft.content); setError(null); }
    }).catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [api, agentId]);

  const reload = async () => {
    if (!api.localAgentSoul?.request) return;
    setBusy(true);
    try {
      const value = await api.localAgentSoul.request({ operation: "read", agentId });
      if (value.kind !== "draft") throw new Error("SERVICE_UNAVAILABLE");
      setDraft(value.draft); setContent(value.draft.content); setError(null);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!api.localAgentSoul?.request || !draft) return;
    setBusy(true); setError(null);
    try {
      const value = await api.localAgentSoul.request({ operation: "save", agentId,
        content, expectedHash: draft.hash, publishedVersionId: draft.publishedVersionId });
      if (value.kind !== "draft") throw new Error("SERVICE_UNAVAILABLE");
      setDraft(value.draft); setContent(value.draft.content);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!api.localAgentSoul?.request || !draft?.publishedVersionId || dirty) return;
    setBusy(true); setError(null);
    try {
      const value = await api.localAgentSoul.request({ operation: "publish", agentId,
        publishedVersionId: draft.publishedVersionId, expectedHash: draft.hash, expected,
        requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
      if (value.kind !== "published") throw new Error("SERVICE_UNAVAILABLE");
      setDraft(value.draft); setContent(value.draft.content);
      await onPublished();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };
  const open = async () => {
    if (!api.localAgentSoul?.request || !draft || dirty) return;
    setBusy(true); setError(null);
    try {
      const value = await api.localAgentSoul.request({ operation: "open", agentId, expectedHash: draft.hash });
      if (value.kind !== "opened") throw new Error("SERVICE_UNAVAILABLE");
      setDraft(value.draft); setContent(value.draft.content);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  return <section className="agent-soul-editor" aria-label="SOUL.md editor">
    <div className="agent-soul-section-head"><div><span className="eyebrow"><FileText size={13} /> Agent behavior draft</span><h3>SOUL.md</h3></div><span>{draft?.source === "managed_file" ? "Managed Local file" : draft ? "Unsaved preview" : "Loading…"}</span></div>
    <p>One Agent owns this document across Projects. Saving updates its draft; Publish creates an immutable Agent version. Configure Tool access separately and keep credentials out of this file.</p>
    {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    <div className="agent-soul-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Markdown</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div>
    {preview ? <div className="agent-soul-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
      : <textarea aria-label="SOUL.md Markdown" className="agent-soul-textarea" value={content} disabled={!draft || busy}
        onChange={(event) => setContent(event.target.value)} spellCheck={false} />}
    <div className="agent-soul-actions"><span role="status">{dirty ? "Unsaved changes" : draft ? `Draft ${draft.hash.slice(0, 20)}…` : "Loading draft"}</span>
      {dirty && <button type="button" className="button secondary-button" disabled={busy} onClick={() => setContent(draft!.content)}>Discard edits</button>}
      <button type="button" className="button secondary-button" disabled={busy || !draft || dirty} onClick={() => void reload()}><RefreshCw size={14} /> Reload</button>
      <button type="button" className="button secondary-button" disabled={busy || !draft || dirty} onClick={() => void open()}><ExternalLink size={14} /> Open managed file</button>
      <button type="button" className="button secondary-button" disabled={busy || !draft || (!dirty && draft.source === "managed_file")} onClick={() => void save()}><Save size={14} /> Save draft</button>
      <button type="button" className="button primary-button" disabled={busy || !draft || draft.source !== "managed_file" || dirty || !content.trim() ||
        (latest.soul?.hash === draft.hash)} onClick={() => void publish()}><Send size={14} /> Publish new version</button></div>
    {draft && <details className="agent-soul-draft-diff"><summary>Compare draft with published v{latest.versionNumber}</summary>
      <pre className="agent-soul-diff">{soulDiff(soulText(latest), content).map((item,index) => <span key={index} className={item.kind}>{item.kind === "added" ? "+" : item.kind === "removed" ? "−" : " "} {item.line}{"\n"}</span>)}</pre></details>}
  </section>;
}
