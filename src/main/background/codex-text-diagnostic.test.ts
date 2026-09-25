import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { BackgroundHost, type HostProcess } from "./client";
import { reportCodexTextDiagnostic } from "../../providers/codex-text-diagnostics";

class Child extends EventEmitter implements HostProcess {
  postMessage(_message:unknown) {}
  kill() {this.emit("exit",0);return true;}
}

it("forwards only allowlisted Codex text metadata across the utility boundary",async()=>{
  const child=new Child(),host=new BackgroundHost(()=>child,async()=>"",
    {start:100,request:1000,stop:100,maxPending:8});
  const received:unknown[]=[];
  host.on("codex-text-diagnostic",value=>received.push(value));
  const starting=host.start();child.emit("message",{type:"ready"});
  expect(await starting).toBe(true);
  child.emit("message",{type:"codex-text-diagnostic",diagnostic:{kind:"failure",
    code:"PROVIDER_PROTOCOL_ERROR",stage:"event_shape"}});
  child.emit("message",{type:"codex-text-diagnostic",diagnostic:{kind:"transport_completed"}});
  expect(received).toEqual([{kind:"failure",code:"PROVIDER_PROTOCOL_ERROR",stage:"event_shape"},
    {kind:"transport_completed"}]);
  const canary="SYNTHETIC_PRIVATE_RESPONSE";
  for(const diagnostic of [
    {kind:"failure",code:"PROVIDER_PROTOCOL_ERROR",stage:"event_shape",response:canary},
    {kind:"failure",code:"PROVIDER_PROTOCOL_ERROR",stage:canary},
    {kind:"failure",code:canary,stage:null},
    {kind:"transport_completed",response:canary},
  ])child.emit("message",{type:"codex-text-diagnostic",diagnostic});
  child.emit("message",{type:"codex-text-diagnostic",
    diagnostic:{kind:"transport_completed"},token:canary});
  expect(received).toHaveLength(2);
  expect(JSON.stringify(received)).not.toContain(canary);
  const stopped=host.stop();child.emit("exit",0);await stopped;
});

it("cannot turn a valid transport result into UNKNOWN when diagnostic IPC throws",()=>{
  let calls=0;
  expect(()=>reportCodexTextDiagnostic(()=>{calls++;throw Error("synthetic IPC failure");},
    {kind:"transport_completed"})).not.toThrow();
  expect(calls).toBe(1);
});
