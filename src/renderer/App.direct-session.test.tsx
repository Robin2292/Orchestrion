// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import App from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@xterm/xterm",()=>({Terminal:class {open(){} dispose(){}}}));
class TestResizeObserver {observe(){} disconnect(){}}
Object.defineProperty(globalThis,"ResizeObserver",{configurable:true,value:TestResizeObserver});
Object.defineProperty(globalThis,"requestAnimationFrame",{configurable:true,value:(callback:FrameRequestCallback)=>{callback(0);return 1;}});
Object.defineProperty(globalThis,"cancelAnimationFrame",{configurable:true,value:()=>undefined});

let root:Root|null=null;
afterEach(async()=>{if(root) await act(async()=>root?.unmount());root=null;document.body.innerHTML="";window.history.replaceState({},"","#/");});

it("groups host Direct Sessions separately from legacy chat and opens the pinned detail",async()=>{
  const projectId="00000000-0000-4000-8000-000000000001";
  const sessionId="00000000-0000-4000-8000-000000000002";
  const item={id:sessionId,projectId,agentId:"00000000-0000-4000-8000-000000000003",
    agentVersionId:"00000000-0000-4000-8000-000000000004",
    assignmentId:"00000000-0000-4000-8000-000000000005",
    assignmentVersionId:"00000000-0000-4000-8000-000000000006",
    lifecycle:"active",title:"Evidence review",createdAt:"2026-09-24T00:00:00Z",
    latestAttempt:null,provenance:"released"};
  const pin={revision:1,hash:`sha256:${"0".repeat(64)}`};
  const api={
    bootstrap:vi.fn(async()=>({appServer:{status:"ready",codexVersion:"test",diagnostic:null},
      projects:[{id:projectId,name:"Atlas",path:"/tmp/atlas",createdAt:"2026-09-24T00:00:00Z"}],
      agents:[{id:"legacy-agent",projectId,name:"Old Agent",instructions:"",createdAt:"2026-09-24T00:00:00Z"}],
      sessions:[{id:"old-chat",agentId:"legacy-agent",title:"Old chat",threadId:null,model:null,
        modelProvider:null,reasoningEffort:null,titleSource:"provisional",createdAt:"2026-09-24T00:00:00Z",updatedAt:"2026-09-24T00:00:00Z"}],runtimes:{}})),
    listModels:vi.fn(async()=>[]),getWindowState:vi.fn(async()=>({isFullScreen:false})),
    onWindowState:vi.fn(()=>vi.fn()),onEvent:vi.fn(()=>vi.fn()),
    loadAttachmentPreviews:vi.fn(async()=>({})),
    localAgents:{snapshot:vi.fn(async()=>({workspace:{projectId,agents:[]}}))},
    localAssignments:{request:vi.fn()},
    localDirectSessions:{request:vi.fn(async(request:{operation:string})=>request.operation==="list"
      ? {kind:"page",expected:pin,items:[item]}
      : {kind:"detail",expected:pin,session:{...item,deleted:false,deleting:false}})},
  } as unknown as OrchestrionDesktopApi;
  Object.defineProperty(window,"orchestrion",{configurable:true,value:api});
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);
  await act(async()=>{root?.render(<App/>);await Promise.resolve();await Promise.resolve();});
  expect(node.textContent).toContain("Direct Sessions");
  expect(node.textContent).toContain("Legacy Sessions");
  const direct=node.querySelector<HTMLButtonElement>(`[aria-label="Evidence review, Direct Session, active"]`)!;
  await act(async()=>{direct.click();await Promise.resolve();});
  expect(window.location.hash).toContain(`/direct-sessions/${sessionId}`);
  expect(node.textContent).toContain(item.assignmentVersionId);
  expect(node.querySelector(".workspace-panel")).toBeNull();
});
