import type { WorkspaceSurfaceId } from "./workspace-panel-state";

export type WorkspaceSurfaceAvailability = "ready" | "not-ready";

export interface WorkspaceSurfaceContext {
  sessionId: string | null;
  project: { id: string; name: string; path: string } | null;
}

export interface WorkspaceSurfaceDescriptor {
  id: WorkspaceSurfaceId;
  label: string;
  eyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  availability: WorkspaceSurfaceAvailability;
}

export interface WorkspaceSurfacePresentation {
  surface: WorkspaceSurfaceDescriptor;
  tabId: string;
  tabControls: string;
  panelId: string;
  panelLabelledBy: string;
  active: boolean;
  hidden: boolean;
  opened: boolean;
}

/** A future remote runtime can supply descriptors without changing the panel layout contract. */
export interface WorkspaceSurfaceProvider {
  kind: "local" | "cloud";
  getSurfaces(context: WorkspaceSurfaceContext): readonly WorkspaceSurfaceDescriptor[];
}

const LOCAL_SURFACES: readonly WorkspaceSurfaceDescriptor[] = [
  {
    id: "files",
    label: "Files",
    eyebrow: "Local project",
    emptyTitle: "Browse project files",
    emptyDescription: "Read-only files from the project attached to this session.",
    availability: "ready",
  },
  {
    id: "terminal",
    label: "Terminal",
    eyebrow: "Local process",
    emptyTitle: "Terminal",
    emptyDescription: "A local shell scoped to this session's project.",
    availability: "ready",
  },
  {
    id: "side-chat",
    label: "Side chat",
    eyebrow: "Companion thread",
    emptyTitle: "Not connected",
    emptyDescription: "Side chat is not available in this desktop build.",
    availability: "not-ready",
  },
] as const;

export const localWorkspaceSurfaceProvider: WorkspaceSurfaceProvider = {
  kind: "local",
  getSurfaces: () => LOCAL_SURFACES,
};

export function workspaceSurfacePresentations(
  surfaces: readonly WorkspaceSurfaceDescriptor[],
  activeSurfaceId: WorkspaceSurfaceId | null,
  openSurfaceIds: readonly WorkspaceSurfaceId[] = [],
): readonly WorkspaceSurfacePresentation[] {
  const effectiveActiveId = activeSurfaceId && surfaces.some((surface) => surface.id === activeSurfaceId)
    ? activeSurfaceId
    : null;
  const effectiveOpenSurfaceIds = openSurfaceIds.length > 0
    ? openSurfaceIds
    : effectiveActiveId ? [effectiveActiveId] : [];
  return surfaces.map((surface) => {
    const active = surface.id === effectiveActiveId;
    const tabId = `workspace-panel-tab-${surface.id}`;
    const panelId = `workspace-panel-surface-${surface.id}`;
    return {
      surface,
      tabId,
      tabControls: panelId,
      panelId,
      panelLabelledBy: tabId,
      active,
      hidden: !active,
      opened: effectiveOpenSurfaceIds.includes(surface.id),
    };
  });
}
