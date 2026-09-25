import type { Event, WebContents, WebContentsDidStartNavigationEventParams } from "electron";

export interface RendererDocumentIdentity {
  id: string;
  isActive(): boolean;
}

interface RendererDocumentState {
  contents: WebContents;
  generation: number;
  active: boolean;
  onNavigation: (details: Event<WebContentsDidStartNavigationEventParams>) => void;
  onFrameReady: (event: Event, isMainFrame: boolean) => void;
  onRendererGone: () => void;
  onDestroyed: () => void;
}

type CloseOwner = (ownerId: string) => void;

/**
 * Treats every top-level renderer document as a distinct terminal principal.
 * WebContents ids survive reloads, so terminal authority must not use them alone.
 */
export class RendererDocumentLifecycle {
  private readonly states = new Map<number, RendererDocumentState>();

  constructor(private readonly closeOwner: CloseOwner) {}

  identityFor(contents: WebContents): RendererDocumentIdentity {
    const state = this.states.get(contents.id) ?? this.bind(contents);
    const generation = state.generation;
    return {
      id: documentId(contents.id, generation),
      isActive: () => this.states.get(contents.id) === state
        && state.generation === generation
        && state.active
        && !contents.isDestroyed(),
    };
  }

  dispose(): void {
    for (const state of [...this.states.values()]) this.unbind(state);
  }

  private bind(contents: WebContents): RendererDocumentState {
    let state!: RendererDocumentState;
    state = {
      contents,
      generation: 0,
      active: !contents.isDestroyed(),
      onNavigation: (details) => {
        if (details.isMainFrame && !details.isSameDocument) this.revoke(state, false);
      },
      onFrameReady: (_event, isMainFrame) => {
        if (isMainFrame && this.states.get(contents.id) === state && !contents.isDestroyed()) state.active = true;
      },
      onRendererGone: () => this.revoke(state, false),
      onDestroyed: () => this.unbind(state),
    };
    this.states.set(contents.id, state);
    contents.on("did-start-navigation", state.onNavigation);
    contents.on("did-frame-finish-load", state.onFrameReady);
    contents.on("render-process-gone", state.onRendererGone);
    contents.on("destroyed", state.onDestroyed);
    return state;
  }

  private revoke(state: RendererDocumentState, active: boolean): void {
    if (this.states.get(state.contents.id) !== state) return;
    const ownerId = documentId(state.contents.id, state.generation);
    state.generation += 1;
    state.active = active;
    this.closeOwner(ownerId);
  }

  private unbind(state: RendererDocumentState): void {
    if (this.states.get(state.contents.id) !== state) return;
    this.revoke(state, false);
    state.contents.removeListener("did-start-navigation", state.onNavigation);
    state.contents.removeListener("did-frame-finish-load", state.onFrameReady);
    state.contents.removeListener("render-process-gone", state.onRendererGone);
    state.contents.removeListener("destroyed", state.onDestroyed);
    this.states.delete(state.contents.id);
  }
}

function documentId(webContentsId: number, generation: number): string {
  return `web-contents-${webContentsId}:document-${generation}`;
}
