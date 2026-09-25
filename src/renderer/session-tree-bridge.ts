import { DESKTOP_BRIDGE_VERSION, type OrchestrionDesktopApi } from "../shared/contracts";

export const SESSION_TREE_BRIDGE_RESTART_MESSAGE = "Governed Session setup is out of date or incomplete. Fully quit and restart the desktop app.";

/** Like workspace-file controls, check isolated-preload metadata AND each method.
 * A renderer HMR refresh alone cannot install a missing or partial preload. */
export function sessionBindingBridgeAvailable(api: Pick<OrchestrionDesktopApi, "bridgeInfo" | "bindSessionAgent" | "chooseProjectDirectory"> | undefined): boolean {
  const info: unknown = api?.bridgeInfo;
  return isRecord(info) && info.version === DESKTOP_BRIDGE_VERSION
    && isRecord(info.capabilities) && isRecord(info.capabilities.sessionTree)
    && info.capabilities.sessionTree.bindSessionAgent === true
    && typeof api?.bindSessionAgent === "function" && typeof api?.chooseProjectDirectory === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
