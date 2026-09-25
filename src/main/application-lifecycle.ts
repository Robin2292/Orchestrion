import type { DesktopRuntime } from "./runtime";
import type { WorkspaceTerminalService } from "./workspace-terminal";

export interface DesktopServices {
  runtime: DesktopRuntime | null;
  terminalService: WorkspaceTerminalService | null;
  unregisterIpc: (() => void) | null;
}

export const EMPTY_DESKTOP_SERVICES: DesktopServices = {
  runtime: null,
  terminalService: null,
  unregisterIpc: null,
};

/**
 * Revokes renderer documents and closes every PTY before the runtime and
 * service references become unreachable during application shutdown.
 */
export function shutdownDesktopServices(services: DesktopServices): DesktopServices {
  services.unregisterIpc?.();
  services.runtime?.shutdown();
  return { ...EMPTY_DESKTOP_SERVICES };
}
