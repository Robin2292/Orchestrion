// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import { DirectSessionHost, readDirectSessions } from "./DirectSessionHost";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId="00000000-0000-4000-8000-000000000001";
const sessionId="00000000-0000-4000-8000-000000000002";
const pin={revision:1,hash:`sha256:${"0".repeat(64)}`};
const session={id:sessionId,projectId,agentId:"00000000-0000-4000-8000-000000000003",
  agentVersionId:"00000000-0000-4000-8000-000000000004",
  assignmentId:"00000000-0000-4000-8000-000000000005",
  assignmentVersionId:"00000000-0000-4000-8000-000000000006",
  lifecycle:"active" as const,title:"Review evidence",createdAt:"2026-09-24T00:00:00Z",
  deleted:false,deleting:false,latestAttempt:null,provenance:"released" as const};
let root:Root|null=null;
afterEach(async()=>{if(root) await act(async()=>root?.unmount());root=null;document.body.innerHTML="";});

describe("Direct Session workbench",()=>{
  it("paginates the host projection and rejects a changed fence",async()=>{
    const request=vi.fn(async()=>({kind:"page" as const,expected:pin,
      items:[] as typeof session[]}));
    const api={localDirectSessions:{request}} as unknown as OrchestrionDesktopApi;
    expect(await readDirectSessions(api)).toEqual({expected:pin,items:[]});
    expect(request).toHaveBeenCalledWith({operation:"list",limit:100,offset:0});
  });

  it("shows exact Direct pins, the bounded text route and host lifecycle actions",async()=>{
    let lifecycle:"active"|"archived"="active";
    const request=vi.fn(async(input:{operation:string})=>{
      if(input.operation==="get") return {kind:"detail",expected:pin,session:{...session,lifecycle}};
      if(input.operation==="archive") {lifecycle="archived";return {kind:"command",expected:pin,resultRef:sessionId,replayed:false};}
      throw new Error("UNEXPECTED_OPERATION");
    });
    const api={localDirectSessions:{request},localAssignments:{request:vi.fn()}} as unknown as OrchestrionDesktopApi;
    const onConnectProviders=vi.fn();
    const node=document.createElement("div");document.body.append(node);root=createRoot(node);
    await act(async()=>{root?.render(<DirectSessionHost api={api} projectId={projectId} projectName="Atlas" sessionId={sessionId} onSelect={vi.fn()} onChanged={vi.fn(async()=>undefined)} onConnectProviders={onConnectProviders}/>);await Promise.resolve();});
    expect(node.textContent).toContain("Direct · released");
    expect(node.textContent).toContain("Atlas");
    expect(node.textContent).toContain(session.agentVersionId);
    expect(node.textContent).toContain(session.assignmentVersionId);
    expect(node.textContent).toContain("Full execution controls remain unavailable");
    expect(node.textContent).toContain("Experimental Codex text · gpt-6-luna");
    await act(async()=>node.querySelector<HTMLButtonElement>(".direct-model-route button")!.click());
    expect(onConnectProviders).toHaveBeenCalledOnce();
    expect([...node.querySelectorAll("button")].filter(button=>["Start","Resume","Cancel","Retry"].includes(button.textContent??""))
      .every(button=>button.disabled)).toBe(true);
    const archive=[...node.querySelectorAll("button")].find(button=>button.textContent?.includes("Archive"))!;
    await act(async()=>{archive.click();await Promise.resolve();});
    expect(request).toHaveBeenCalledWith(expect.objectContaining({operation:"archive",payload:{sessionId}}));
    expect(node.textContent).toContain("Restore");
  });

  it("navigates from a confirmed create even when the sidebar refresh fails",async()=>{
    const newId="00000000-0000-4000-8000-000000000007";
    const assignment={assignment:{id:session.assignmentId,projectId,status:"active"},
      migrationState:"governed",currentVersion:{id:session.assignmentVersionId,
        revision:2,agentVersionId:session.agentVersionId},
      agent:{identityState:"governed",identity:{name:"Reviewer"}}};
    const directRequest=vi.fn(async(input:{operation:string})=>input.operation==="list"
      ? {kind:"page",expected:pin,items:[]}
      : {kind:"command",expected:pin,resultRef:newId,replayed:false});
    const api={localDirectSessions:{request:directRequest},localAssignments:{request:vi.fn(async()=>({
      kind:"page",expected:pin,items:[assignment],
    }))}} as unknown as OrchestrionDesktopApi;
    const onSelect=vi.fn();
    const onChanged=vi.fn(async()=>{throw new Error("SERVICE_UNAVAILABLE");});
    const node=document.createElement("div");document.body.append(node);root=createRoot(node);
    await act(async()=>{root?.render(<DirectSessionHost api={api} projectId={projectId} projectName="Atlas" sessionId={null} onSelect={onSelect} onChanged={onChanged}/>);await Promise.resolve();});
    const select=node.querySelector<HTMLSelectElement>("select")!;
    const name=node.querySelector<HTMLInputElement>("input")!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")?.set?.call(select,session.assignmentId);
      select.dispatchEvent(new Event("change",{bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set?.call(name,"Review evidence");
      name.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>{node.querySelector<HTMLButtonElement>("[type='submit']")!.click();await Promise.resolve();});
    expect(onSelect).toHaveBeenCalledWith(newId);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(directRequest.mock.calls.filter(([input])=>input.operation==="create")).toHaveLength(1);
    expect(node.querySelector("[role='alert']")).toBeNull();
  });

  it("shows durable history after a confirmed text turn without accepting provider fields from UI",async()=>{
    let items:{seq:number;role:"user"|"assistant";text:string}[]=[];
    const request=vi.fn(async(input:{operation:string;payload?:{prompt:string}})=>{
      if(input.operation==="get")return {kind:"detail",expected:pin,session};
      if(input.operation==="history")return {kind:"history",items};
      if(input.operation==="turn") {
        items=[{seq:1,role:"user",text:input.payload!.prompt},{seq:2,role:"assistant",text:"Reply"}];
        return {kind:"turn",expected:pin,attemptId:"attempt",text:"Reply",
          costMicrousd:0,wouldHaveMicrousd:0,replayed:false};
      }
      throw Error("UNEXPECTED_OPERATION");
    });
    const api={localDirectSessions:{request},localAssignments:{request:vi.fn()}} as unknown as OrchestrionDesktopApi;
    const node=document.createElement("div");document.body.append(node);root=createRoot(node);
    await act(async()=>{root?.render(<DirectSessionHost api={api} projectId={projectId} projectName="Atlas"
      sessionId={sessionId} onSelect={vi.fn()} onChanged={vi.fn(async()=>undefined)}/>);await Promise.resolve();});
    const area=node.querySelector<HTMLTextAreaElement>("#direct-text-prompt")!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set?.call(area,"Question");
      area.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>{node.querySelector<HTMLButtonElement>(".direct-text-chat [type='submit']")!.click();await Promise.resolve();});
    expect(request).toHaveBeenCalledWith(expect.objectContaining({operation:"turn",
      payload:{sessionId,prompt:"Question"}}));
    expect(node.textContent).toContain("Reply");
  });

  it("labels pending deletion and retries only through host cleanup",async()=>{
    let cleanupAvailable=false;
    const request=vi.fn(async(input:{operation:string})=>{
      if(input.operation==="get") return {kind:"detail",expected:pin,session:{...session,deleting:true}};
      if(input.operation==="delete") {
        if (!cleanupAvailable) throw new Error("DIRECT_PROVIDER_UNAVAILABLE");
        return {kind:"command",expected:pin,resultRef:sessionId,replayed:false};
      }
      throw new Error("UNEXPECTED_OPERATION");
    });
    const api={localDirectSessions:{request},localAssignments:{request:vi.fn()}} as unknown as OrchestrionDesktopApi;
    const onSelect=vi.fn();
    const node=document.createElement("div");document.body.append(node);root=createRoot(node);
    await act(async()=>{root?.render(<DirectSessionHost api={api} projectId={projectId} projectName="Atlas" sessionId={sessionId} onSelect={onSelect} onChanged={vi.fn(async()=>undefined)}/>);await Promise.resolve();});
    expect(node.textContent).toContain("Deletion pending");
    expect(node.textContent).toContain("bound provider references cannot be cleaned up by this build");
    expect([...node.querySelectorAll<HTMLButtonElement>(".direct-session-actions button")].filter(button=>button.textContent?.includes("Rename")||button.textContent?.includes("Archive")).every(button=>button.disabled)).toBe(true);
    await act(async()=>[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("Retry deletion"))!.click());
    await act(async()=>{[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("Retry cleanup"))!.click();await Promise.resolve();});
    expect(request).toHaveBeenCalledWith(expect.objectContaining({operation:"delete",payload:{sessionId}}));
    expect(node.textContent).toContain("Deletion pending");
    expect(node.textContent).toContain("not ready for the experimental Codex text route");
    cleanupAvailable=true;
    await act(async()=>[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("Retry deletion"))!.click());
    await act(async()=>{[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("Retry cleanup"))!.click();await Promise.resolve();});
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
