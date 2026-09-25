import type { LocalToolSourceCatalog } from "../shared/tool-source-contracts";
import type { ToolGrant } from "../shared/tool-grant-contracts";
import { DESKTOP_BRIDGE_VERSION,type OrchestrionDesktopApi } from "../shared/contracts";

export const LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE = "Direct Tool authoring controls are out of date or incomplete. Fully quit and restart the desktop app; reloading this page is not enough.";

/** Creating immutable Agent versions with direct grants requires the exact
 * isolated-preload capability and every mutation method used by the editor. */
export function localAgentBindingBridgeAvailable(api: Pick<OrchestrionDesktopApi,"bridgeInfo" | "localAgents"> | undefined): boolean {
  const info: unknown=api?.bridgeInfo;
  return isRecord(info) && info.version === DESKTOP_BRIDGE_VERSION
    && isRecord(info.capabilities) && isRecord(info.capabilities.localAgents)
    && info.capabilities.localAgents.directToolGrants === true
    && typeof api?.localAgents?.create === "function" && typeof api?.localAgents?.createVersion === "function";
}

export function localAgentDirectAuthoring(workspace: unknown): {
  catalog: LocalToolSourceCatalog;
  templates: { catalogId: string; grant: ToolGrant }[];
} | null {
  if (!isRecord(workspace) || !isRecord(workspace.toolSourceCatalog)
    || !Array.isArray(workspace.toolGrantTemplates)) return null;
  return { catalog:workspace.toolSourceCatalog as LocalToolSourceCatalog,
    templates:workspace.toolGrantTemplates as { catalogId:string;grant:ToolGrant }[] };
}

function isRecord(value: unknown): value is Record<string,unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
