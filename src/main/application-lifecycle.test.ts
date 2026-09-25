import { describe, expect, it, vi } from "vitest";
import type { DesktopRuntime } from "./runtime";
import type { WorkspaceTerminalService } from "./workspace-terminal";
import { shutdownDesktopServices } from "./application-lifecycle";

describe("application lifecycle", () => {
  it("unregisters IPC and closes terminals before shutting down and discarding services", () => {
    const order: string[] = [];
    const unregisterIpc = vi.fn(() => order.push("unregister-and-close-all"));
    const runtime = { shutdown: vi.fn(() => order.push("runtime-shutdown")) } as unknown as DesktopRuntime;
    const terminalService = {} as WorkspaceTerminalService;

    const disposed = shutdownDesktopServices({ runtime, terminalService, unregisterIpc });

    expect(order).toEqual(["unregister-and-close-all", "runtime-shutdown"]);
    expect(disposed).toEqual({ runtime: null, terminalService: null, unregisterIpc: null });
  });
});
