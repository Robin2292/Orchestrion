import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { RendererDocumentLifecycle } from "./renderer-document-lifecycle";
import { WorkspaceTerminalService, type WorkspacePty, type WorkspacePtyFactory } from "./workspace-terminal";

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  readonly id = 41;
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  removeListener(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  isDestroyed() { return this.destroyed; }
  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  asWebContents() { return this as unknown as WebContents; }
}

function navigation(isMainFrame: boolean, isSameDocument = false) {
  return { isMainFrame, isSameDocument, url: "file:///renderer.html", frame: null };
}

describe("RendererDocumentLifecycle", () => {
  it("revokes only top-level document changes and renderer loss, then removes every listener", () => {
    const contents = new FakeWebContents();
    const closed: string[] = [];
    const lifecycle = new RendererDocumentLifecycle((ownerId) => closed.push(ownerId));
    const first = lifecycle.identityFor(contents.asWebContents());
    expect(first).toMatchObject({ id: "web-contents-41:document-0" });
    expect(first.isActive()).toBe(true);

    contents.emit("did-start-navigation", navigation(false));
    contents.emit("did-start-navigation", navigation(true, true));
    expect(closed).toEqual([]);
    expect(first.isActive()).toBe(true);

    contents.emit("did-start-navigation", navigation(true));
    expect(closed).toEqual(["web-contents-41:document-0"]);
    expect(first.isActive()).toBe(false);
    const reloaded = lifecycle.identityFor(contents.asWebContents());
    expect(reloaded.id).toBe("web-contents-41:document-1");
    expect(reloaded.isActive()).toBe(false);
    contents.emit("did-frame-finish-load", {}, false, 1, 1);
    expect(reloaded.isActive()).toBe(false);
    contents.emit("did-frame-finish-load", {}, true, 1, 1);
    expect(reloaded.isActive()).toBe(true);

    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(closed.at(-1)).toBe("web-contents-41:document-1");
    expect(reloaded.isActive()).toBe(false);
    lifecycle.dispose();
    expect([...contents.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("leaves a reloaded renderer with a closed panel owning zero PTYs", async () => {
    const contents = new FakeWebContents();
    const pty = fakePty();
    const factory: WorkspacePtyFactory = { spawn: () => pty };
    const service = new WorkspaceTerminalService(() => "/projects/session-1", factory);
    const lifecycle = new RendererDocumentLifecycle((ownerId) => service.closeOwner(ownerId));
    const document = lifecycle.identityFor(contents.asWebContents());
    await service.create({ ...document, publish: vi.fn() }, { sessionId: "session-1", columns: 80, rows: 24 });
    expect(service.activeTerminalCount).toBe(1);

    contents.emit("did-start-navigation", navigation(true));
    expect(service.activeTerminalCount).toBe(0);
    expect(pty.kill).toHaveBeenCalledOnce();
    contents.emit("did-frame-finish-load", {}, true, 1, 1);
    expect(service.activeTerminalCount).toBe(0);
    lifecycle.dispose();
  });

  it("revokes the renderer document when a macOS window is closed without application quit", async () => {
    const contents = new FakeWebContents();
    const pty = fakePty();
    const service = new WorkspaceTerminalService(() => "/projects/session-1", { spawn: () => pty });
    const lifecycle = new RendererDocumentLifecycle((ownerId) => service.closeOwner(ownerId));
    const document = lifecycle.identityFor(contents.asWebContents());
    await service.create({ ...document, publish: vi.fn() }, { sessionId: "session-1", columns: 80, rows: 24 });

    contents.destroyed = true;
    contents.emit("destroyed");

    expect(document.isActive()).toBe(false);
    expect(service.activeTerminalCount).toBe(0);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect([...contents.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});

function fakePty(): WorkspacePty {
  return {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
