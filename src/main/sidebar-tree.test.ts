import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/contracts";
import { tmpdir } from "node:os";
import { DesktopRuntime } from "./runtime";
import { JsonMetadataStore } from "./store";
import { JsonRpcConnection } from "./json-rpc";
import { BackgroundService } from "./background/service";
import { WorkspaceTerminalService } from "./workspace-terminal";
import { tick, FakeTransport } from "./test-transport";

async function realHostFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestrion-sidebar-actions-"));
  await writeFile(join(root, "proof.txt"), "BEFORE");
  const transport = new FakeTransport(), store = JsonMetadataStore.inUserData(root);
  const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "fixture" }));
  const terminals = new WorkspaceTerminalService(id => runtime.projectPathForSession(id), { spawn: () => { throw new Error("Unexpected PTY spawn"); } });
  const service = new BackgroundService(runtime, terminals);
  let active = true;
  const document = { id: "sidebar-document", isActive: () => active, publish: () => {}, openSystem: async () => {} };
  await service.invoke(IPC.bootstrap, undefined, document);
  const project = await runtime.createProject({ name: "Project", path: root });
  const agent = await runtime.createAgent({ projectId: project.id, name: "Agent", instructions: "" });
  const session = await runtime.createSession({ agentId: agent.id });
  return { root, store, runtime, service, document, transport, project, agent, session,
    revoke() { active = false; service.revoke(document.id); },
    async cleanup() { await service.shutdown(); await rm(root, { recursive: true, force: true }); },
  };
}

describe("native sidebar metadata through the authenticated background service", () => {
  it("renames metadata, refuses nonempty removal, and keeps the workspace files", async () => {
    const f = await realHostFixture();
    try {
      await f.service.invoke(IPC.renameProject, { projectId: f.project.id, name: " Renamed project " }, f.document);
      await f.service.invoke(IPC.renameAgent, { agentId: f.agent.id, name: " Renamed agent " }, f.document);
      await expect(f.service.invoke(IPC.deleteProject, { projectId: f.project.id }, f.document)).rejects.toThrow("agents individually");
      await expect(f.service.invoke(IPC.deleteAgent, { agentId: f.agent.id }, f.document)).rejects.toThrow("sessions individually");
      expect(f.runtime.snapshot().projects[0].name).toBe("Renamed project");
      expect(f.runtime.snapshot().agents[0].name).toBe("Renamed agent");
      expect((await f.store.read()).sessions).toHaveLength(1);
      await f.service.invoke(IPC.deleteSession, { sessionId: f.session.id }, f.document);
      await f.service.invoke(IPC.deleteAgent, { agentId: f.agent.id }, f.document);
      await f.service.invoke(IPC.deleteProject, { projectId: f.project.id }, f.document);
      expect(await f.store.read()).toEqual({ projects: [], agents: [], sessions: [] });
      expect(f.runtime.snapshot()).toMatchObject({ projects: [], agents: [], sessions: [] });
      expect(await readFile(join(f.root, "proof.txt"), "utf8")).toBe("BEFORE");
      expect(f.transport.sent).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("checks child creation and empty removal in the same store queue", async () => {
    const f = await realHostFixture();
    try {
      await f.runtime.deleteSession({ sessionId: f.session.id });
      const creating = f.runtime.createSession({ agentId: f.agent.id });
      const removing = f.runtime.deleteAgent({ agentId: f.agent.id });
      const results = await Promise.allSettled([creating, removing]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected" });
      expect((await f.store.read()).agents).toHaveLength(1);
      expect((await f.store.read()).sessions).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  for (const channel of [IPC.renameProject, IPC.renameAgent, IPC.deleteProject, IPC.deleteAgent]) {
    for (const stage of ["queued", "staged"] as const) {
      it(`does not persist or publish ${channel} revoked while ${stage}`, async () => {
        const f = await realHostFixture(); let release = () => {}; let staged = false;
        try {
          // Both removal requests target empty metadata; refusal must be auth, not emptiness.
          await f.runtime.deleteSession({ sessionId: f.session.id });
          if (channel === IPC.deleteProject) await f.runtime.deleteAgent({ agentId: f.agent.id });
          const file = join(f.root, "orchestrion-desktop.json");
          const before = await readFile(file, "utf8");
          const beforeSnapshot = f.runtime.snapshot();
          const gate = new Promise<void>(resolve => { release = resolve; });
          if (stage === "queued") Reflect.set(f.store, "writes", gate);
          const doc = stage === "queued" ? f.document : { ...f.document, isActive: () => {
            if (readdirSync(f.root).some(name => name.startsWith("orchestrion-desktop.json.") && name.endsWith(".tmp") && statSync(join(f.root, name)).size > 0)) {
              staged = true; f.revoke();
            }
            return f.document.isActive();
          } };
          const input = channel === IPC.renameProject ? { projectId: f.project.id, name: "AFTER_REVOKE" }
            : channel === IPC.renameAgent ? { agentId: f.agent.id, name: "AFTER_REVOKE" }
              : channel === IPC.deleteProject ? { projectId: f.project.id } : { agentId: f.agent.id };
          let settled = false;
          const pending = f.service.invoke(channel, input, doc).catch((error: Error) => error).finally(() => { settled = true; });
          if (stage === "queued") { await tick(); expect(settled).toBe(false); f.revoke(); release(); }
          expect(await pending).toMatchObject({ message: "NOT_AUTHENTICATED" });
          if (stage === "staged") expect(staged).toBe(true);
          expect(await readFile(file, "utf8")).toBe(before);
          expect(f.runtime.snapshot()).toEqual(beforeSnapshot);
          await f.store.renameProject(f.project.id, "Follow up");
          expect(JSON.stringify(await f.store.read())).not.toContain("AFTER_REVOKE");
        } finally { release(); await f.cleanup(); }
      });
    }
  }
});
