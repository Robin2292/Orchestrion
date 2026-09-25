// @vitest-environment jsdom
import { act } from "react";
import { createHash } from "node:crypto";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import { AgentSoulEditor, soulDiff } from "./AgentSoulEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const node = document.createElement("div"); document.body.append(node);
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; node.replaceChildren(); });
const snapshot = (content: string) => ({ content,
  hash:`sha256:${createHash("sha256").update(Buffer.from(content,"utf8")).digest("hex")}` });

describe("Agent SOUL editor", () => {
  it("shows exact version changes and requires a saved draft before publish", async () => {
    const agentId="00000000-0000-4000-8000-000000000001", versionId="version-1";
    let draft={...snapshot("# Agent\n"),source:"version_preview" as "version_preview"|"managed_file",publishedVersionId:versionId};
    const request=vi.fn(async (input: Record<string, unknown>) => {
      if (input.operation==="save") {
        draft={...snapshot(String(input.content)),source:"managed_file",publishedVersionId:versionId};
        return {kind:"draft" as const,draft};
      }
      if (input.operation==="publish") return {kind:"published" as const,versionId:"version-2",draft};
      return {kind:"draft" as const,draft};
    });
    const api={localAgentSoul:{request}} as unknown as OrchestrionDesktopApi;
    const latest={id:versionId,agentId,versionNumber:1,soul:snapshot("# Agent\n"),
      definition:{systemPrompt:"# Agent\n"}} as LocalAgentVersion;
    const onPublished=vi.fn(),onDirty=vi.fn();
    root=createRoot(node);
    await act(async () => root?.render(<AgentSoulEditor api={api} agentId={agentId} latest={latest}
      expected={{revision:1,hash:`sha256:${"0".repeat(64)}`}}
      onPublished={onPublished} onDirtyStateChange={onDirty} />));
    const textarea=node.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("# Agent\n");
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
    setter.call(textarea,"# Agent\nNew rule\n");
    await act(async () => textarea.dispatchEvent(new Event("input",{bubbles:true})));
    expect(onDirty).toHaveBeenCalledWith(true,expect.any(Function));
    const button=(name:string) => [...node.querySelectorAll<HTMLButtonElement>("button")]
      .find((item)=>item.textContent?.includes(name))!;
    expect(button("Publish new version").disabled).toBe(true);
    expect(button("Reload").disabled).toBe(true);
    const readsBefore = request.mock.calls.filter(([input]) => input.operation === "read").length;
    await act(async () => button("Reload").click());
    expect(request.mock.calls.filter(([input]) => input.operation === "read")).toHaveLength(readsBefore);
    expect(textarea.value).toBe("# Agent\nNew rule\n");
    await act(async () => button("Save draft").click());
    expect(request).toHaveBeenCalledWith(expect.objectContaining({operation:"save",content:"# Agent\nNew rule\n"}));
    expect(button("Publish new version").disabled).toBe(false);
    await act(async () => button("Publish new version").click());
    expect(request).toHaveBeenCalledWith(expect.objectContaining({operation:"publish",publishedVersionId:versionId}));
    expect(onPublished).toHaveBeenCalledOnce();
    expect(soulDiff("one\ntwo", "one\nthree")).toEqual([
      {kind:"same",line:"one"},{kind:"removed",line:"two"},{kind:"added",line:"three"},
    ]);
  });
  it("requires explicit discard before reloading an externally changed SOUL draft", async () => {
    const agentId="00000000-0000-4000-8000-000000000001";
    let draft={...snapshot("Original\n"),source:"managed_file" as const,publishedVersionId:"version-1"};
    const request=vi.fn(async () => ({kind:"draft" as const,draft}));
    const api={localAgentSoul:{request}} as unknown as OrchestrionDesktopApi;
    const latest={id:"version-1",agentId,versionNumber:1,soul:snapshot("Original\n"),
      definition:{systemPrompt:"Original\n"}} as LocalAgentVersion;
    root=createRoot(node);
    await act(async () => root?.render(<AgentSoulEditor api={api} agentId={agentId} latest={latest}
      expected={{revision:1,hash:`sha256:${"0".repeat(64)}`}}
      onPublished={vi.fn()} onDirtyStateChange={vi.fn()} />));
    const textarea=node.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
    setter.call(textarea,"Unsaved local text\n");
    await act(async () => textarea.dispatchEvent(new Event("input",{bubbles:true})));
    draft={...snapshot("External text\n"),source:"managed_file",publishedVersionId:"version-1"};
    const button=(name:string) => [...node.querySelectorAll<HTMLButtonElement>("button")]
      .find((item)=>item.textContent?.includes(name))!;
    expect(button("Reload").disabled).toBe(true);
    expect(textarea.value).toBe("Unsaved local text\n");
    await act(async () => button("Discard edits").click());
    expect(textarea.value).toBe("Original\n");
    expect(button("Reload").disabled).toBe(false);
    await act(async () => button("Reload").click());
    expect(textarea.value).toBe("External text\n");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
