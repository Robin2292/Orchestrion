import { FileText, Maximize2, MessageCircle, Minimize2, PanelRight, Plus, Terminal, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { workspacePanelControlPresentations } from "./workspace-panel-state";
import type { WorkspacePanelAction, WorkspacePanelGeometry, WorkspacePanelState } from "./workspace-panel-state";
import { localWorkspaceSurfaceProvider, workspaceSurfacePresentations } from "./workspace-surfaces";
import type { WorkspaceSurfaceContext, WorkspaceSurfaceProvider } from "./workspace-surfaces";
import type { WorkspaceSurfaceId } from "./workspace-panel-state";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import { WorkspaceFilesSurface } from "./WorkspaceFiles";
import type { WorkspaceFileApi } from "./WorkspaceFiles";
import { WorkspaceTerminalSurface } from "./WorkspaceTerminal";
import type { WorkspaceTerminalApi } from "./WorkspaceTerminal";

type WorkspacePanelApi = Partial<Pick<
  OrchestrionDesktopApi,
  "listWorkspaceDirectory" | "createTerminal" | "sendTerminalInput" | "acknowledgeTerminalOutput" | "resizeTerminal" | "closeTerminal" | "closeSessionTerminals" | "onTerminalEvent"
>> & WorkspaceFileApi;

interface WorkspacePanelControlsProps {
  state: WorkspacePanelState;
  sessionId: string | null;
  dispatch: (action: WorkspacePanelAction) => void;
}

interface WorkspacePanelProps {
  state: WorkspacePanelState;
  dispatch: (action: WorkspacePanelAction) => void;
  geometry: WorkspacePanelGeometry;
  context: WorkspaceSurfaceContext;
  provider?: WorkspaceSurfaceProvider;
  api?: WorkspacePanelApi;
  onDirtyStateChange?: (dirty: boolean, discard: () => void) => void;
}

export function WorkspacePanelControls({ state, sessionId, dispatch }: WorkspacePanelControlsProps) {
  return <div className="workspace-panel-controls" aria-label="Workspace panel controls">
    {workspacePanelControlPresentations(state).map((control) => <button
      key={control.id}
      className={`workspace-panel-control ${control.id === "toggle" && control.pressed ? "active" : ""}`}
      type="button"
      onClick={() => dispatch(control.id === "toggle" ? { type: "toggle", sessionId } : { type: "toggle-maximize" })}
      {...(control.id === "toggle" ? { "aria-controls": "workspace-panel", "aria-expanded": state.open } : {})}
      aria-pressed={control.pressed}
      aria-label={control.label}
      title={control.label}
    >{control.icon === "panel" ? <PanelRight size={16} /> : control.icon === "restore" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>)}
  </div>;
}

export function WorkspacePanel({ state, geometry, context, provider = localWorkspaceSurfaceProvider, api, dispatch, onDirtyStateChange }: WorkspacePanelProps) {
  const pendingFocus = useRef<WorkspaceSurfaceId | "picker-add" | null>(null);
  const addSurfaceButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "picker-add") addSurfaceButtonRef.current?.focus();
    else document.getElementById(`workspace-panel-tab-${target}`)?.focus();
  }, [state.activeSurfaceId, state.openSurfaceIds]);
  if (state.sessionId !== context.sessionId) return null;

  const surfaces = provider.getSurfaces(context);
  const presentations = workspaceSurfacePresentations(surfaces, state.activeSurfaceId, state.openSurfaceIds);
  const activePresentation = presentations.find((presentation) => presentation.active) ?? null;
  const openedPresentations = presentations.filter((presentation) => presentation.opened);
  const filesConnected = Boolean(context.sessionId && context.project && api?.listWorkspaceDirectory);
  const terminalConnected = Boolean(
    context.sessionId
    && context.project
    && api?.createTerminal
    && api.sendTerminalInput
    && api.acknowledgeTerminalOutput
    && api.resizeTerminal
    && api.closeTerminal
    && api.closeSessionTerminals
    && api.onTerminalEvent,
  );
  const panelStyle = { "--workspace-panel-width": `${state.open ? geometry.renderedWidth : 0}px` } as CSSProperties;

  return <aside
    id={state.open ? "workspace-panel" : undefined}
    className={`workspace-panel ${state.open ? "" : "workspace-panel-closed"} ${state.maximized ? "maximized" : "docked"}`}
    style={panelStyle}
    aria-label="Project tools"
    aria-hidden={!state.open || undefined}
  >
    <div className="workspace-surface-tabs" hidden={!state.open}>
      <nav className="workspace-surface-tablist" role="tablist" aria-label="Open workspace surfaces">
      {openedPresentations.map(({ surface, tabId, tabControls: presentationControls, active }, index) => {
        return <span className={`workspace-surface-tab ${active ? "active" : ""}`} key={surface.id}>
        <button id={tabId} className="workspace-surface-tab-button" type="button" role="tab" aria-selected={active} aria-controls={presentationControls} tabIndex={active || (state.activeSurfaceId === null && index === 0) ? 0 : -1} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? openedPresentations.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + openedPresentations.length) % openedPresentations.length;
          const next = openedPresentations[nextIndex];
          if (!next || next.surface.id === surface.id) return;
          pendingFocus.current = next.surface.id;
          dispatch({ type: "select-surface", surfaceId: next.surface.id });
        }} onClick={() => dispatch({ type: "select-surface", surfaceId: surface.id })}>
          <SurfaceIcon surfaceId={surface.id} /><span>{surface.label}</span>
        </button>
        <button className="workspace-surface-tab-close" type="button" aria-label={`Close ${surface.label}`} onClick={() => {
          const activeClose = state.activeSurfaceId === surface.id;
          const next = openedPresentations[index + 1] ?? openedPresentations[index - 1];
          pendingFocus.current = activeClose || state.activeSurfaceId === null ? next?.surface.id ?? "picker-add" : state.activeSurfaceId;
          dispatch({ type: "close-surface", surfaceId: surface.id });
        }}><X size={11} /></button>
      </span>;
      })}
      </nav>
      <button ref={addSurfaceButtonRef} className="workspace-surface-tab-add" type="button" aria-label="Open workspace surface picker" title="Open another workspace surface" onClick={() => dispatch({ type: "open-surface-picker" })}><Plus size={14} /></button>
    </div>
    {state.open && state.activeSurfaceId === null && <SurfacePicker presentations={presentations} onSelect={(surfaceId) => dispatch({ type: "select-surface", surfaceId })} />}
    {presentations.filter(({ surface }) => surface.id === "files").map(({ surface, panelId, panelLabelledBy }) => <section
      key={surface.id}
      id={panelId}
      className="workspace-panel-surface"
      role="tabpanel"
      aria-labelledby={panelLabelledBy}
      tabIndex={state.activeSurfaceId === surface.id && filesConnected ? 0 : -1}
      hidden={!state.open || state.activeSurfaceId !== surface.id}
    >
      <WorkspaceFilesSurface
        active={state.open && state.activeSurfaceId === "files" && filesConnected}
        sessionId={filesConnected ? context.sessionId : null}
        project={filesConnected ? context.project : null}
        api={api as Pick<OrchestrionDesktopApi, "listWorkspaceDirectory"> & WorkspaceFileApi}
        onDirtyStateChange={onDirtyStateChange}
      />
    </section>)}
    {state.open && activePresentation?.surface.id === "terminal" && terminalConnected && <section
      id={activePresentation.panelId}
      className="workspace-panel-surface"
      role="tabpanel"
      aria-labelledby={activePresentation.panelLabelledBy}
    >
      <WorkspaceTerminalSurface
        sessionId={context.sessionId!}
        api={api as WorkspaceTerminalApi}
      />
    </section>}
    {state.open && activePresentation?.surface.id === "side-chat" && <section id={activePresentation.panelId} className="workspace-panel-surface workspace-side-chat-placeholder" role="tabpanel" aria-labelledby={activePresentation.panelLabelledBy}>
      <div className="workspace-not-connected"><MessageCircle size={20} /><span>Not connected</span><small>Side chat is not available in this desktop build.</small></div>
    </section>}
    {state.open && activePresentation?.surface.id === "terminal" && !terminalConnected && <section id={activePresentation.panelId} className="workspace-panel-surface workspace-side-chat-placeholder" role="tabpanel" aria-labelledby={activePresentation.panelLabelledBy}>
      <div className="workspace-not-connected"><Terminal size={20} /><span>Not connected</span><small>Terminal is not available for this session.</small></div>
    </section>}
  </aside>;
}

function SurfaceIcon({ surfaceId, size = 14 }: { surfaceId: WorkspaceSurfaceId; size?: number }) {
  return surfaceId === "files" ? <FileText size={size} /> : surfaceId === "terminal" ? <Terminal size={size} /> : <MessageCircle size={size} />;
}

function SurfacePicker({ presentations, onSelect }: { presentations: readonly ReturnType<typeof workspaceSurfacePresentations>[number][]; onSelect: (surfaceId: WorkspaceSurfaceId) => void }) {
  return <section className="workspace-surface-picker" aria-label="Choose a workspace surface">
    <div className="workspace-surface-picker-options">{presentations.map(({ surface }) => <button key={surface.id} type="button" onClick={() => onSelect(surface.id)}><SurfaceIcon surfaceId={surface.id} size={16} /><span>{surface.label}</span></button>)}</div>
  </section>;
}
