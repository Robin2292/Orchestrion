// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterBridgeApi, UpdaterState } from "../shared/contracts";
import { UpdateEntry } from "./UpdateEntry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idle: UpdaterState = {
  phase: "idle", currentVersion: "0.1.0", availableVersion: null,
  progressPercent: null, changelog: [], error: null,
};
const available: UpdaterState = {
  ...idle, phase: "available", availableVersion: "0.2.0",
  changelog: [{ version: "0.2.0", notes: ["A real release note"] }],
};

function fakeBridge(initial: UpdaterState = idle) {
  let current = initial;
  const listeners = new Set<(state: UpdaterState) => void>();
  const emit = (next: UpdaterState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const bridge: UpdaterBridgeApi = {
    getState: vi.fn(async () => current),
    onState: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
    check: vi.fn(async () => current),
    download: vi.fn(async () => current),
    quitAndInstall: vi.fn(async () => undefined),
  };
  return { bridge, emit, listeners };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(bridge?: UpdaterBridgeApi, workspaceDirty = false, onDiscardWorkspaceChanges = () => undefined) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<UpdateEntry bridge={bridge} workspaceDirty={workspaceDirty} onDiscardWorkspaceChanges={onDiscardWorkspaceChanges} />); });
  return container;
}
const trigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".update-entry-trigger")!;
const popover = (host: HTMLElement) => host.querySelector<HTMLElement>("#update-entry-popover");
async function click(host: HTMLElement, text: string) {
  const button = [...popover(host)!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(text));
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => button!.click());
}

describe("UpdateEntry live bridge", () => {
  it("shows the idle control without a prototype flag and Later does not mutate state", async () => {
    const { bridge } = fakeBridge();
    const host = await mount(bridge);
    expect(trigger(host).dataset.phase).toBe("idle");
    await act(async () => trigger(host).click());
    expect(popover(host)?.textContent).toContain("Current version v0.1.0");
    await click(host, "Later");
    expect(popover(host)).toBeNull();
    expect(bridge.check).not.toHaveBeenCalled();
  });

  it("follows main state through discovery, download progress, and restart command", async () => {
    const { bridge, emit } = fakeBridge();
    const host = await mount(bridge);
    await act(async () => emit({ ...idle, phase: "checking" }));
    await act(async () => emit(available));
    expect(trigger(host).dataset.phase).toBe("available");
    await act(async () => trigger(host).click());
    expect(popover(host)?.textContent).toContain("A real release note");
    vi.mocked(bridge.download).mockImplementation(async () => {
      const next: UpdaterState = { ...available, phase: "downloading", progressPercent: 0 };
      emit(next);
      return next;
    });
    await click(host, "Download update");
    expect(bridge.download).toHaveBeenCalledOnce();
    await act(async () => emit({ ...available, phase: "downloading", progressPercent: 47 }));
    expect(popover(host)?.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("47");
    await act(async () => emit({ ...available, phase: "ready", progressPercent: 100 }));
    vi.mocked(bridge.quitAndInstall).mockImplementation(async () => {
      emit({ ...available, phase: "installing", progressPercent: 100 });
    });
    await click(host, "Restart to update");
    expect(bridge.quitAndInstall).toHaveBeenCalledOnce();
    expect(trigger(host).dataset.phase).toBe("installing");
  });

  it("reports up to date only after a real checking event settles idle", async () => {
    const { bridge, emit } = fakeBridge();
    const host = await mount(bridge);
    vi.mocked(bridge.check).mockImplementation(async () => {
      emit({ ...idle, phase: "checking" });
      emit(idle);
      return idle;
    });
    await act(async () => trigger(host).click());
    await click(host, "Check for updates");
    expect(popover(host)?.textContent).toContain("You're up to date");
  });

  it("labels recovery as a new check after a failed download", async () => {
    const { bridge, emit } = fakeBridge();
    const host = await mount(bridge);
    await act(async () => emit({ ...available, phase: "error", error: "Update download failed" }));
    await act(async () => trigger(host).click());
    expect(popover(host)?.textContent).toContain("Update download failed");
    await click(host, "Later");
    expect(trigger(host).dataset.phase).toBe("error");
    await act(async () => trigger(host).click());
    vi.mocked(bridge.check).mockImplementation(async () => {
      const next: UpdaterState = { ...idle, phase: "checking" };
      emit(next);
      return next;
    });
    await click(host, "Check again");
    expect(bridge.check).toHaveBeenCalledOnce();
    expect(bridge.download).not.toHaveBeenCalled();
    expect(trigger(host).dataset.phase).toBe("checking");
  });

  it("does not restart a dirty workspace when the user cancels", async () => {
    const { bridge } = fakeBridge({ ...available, phase: "ready", progressPercent: 100 });
    const discard = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const host = await mount(bridge, true, discard);
    await act(async () => trigger(host).click());
    await click(host, "Restart to update");
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes and restart to update?");
    expect(discard).not.toHaveBeenCalled();
    expect(bridge.quitAndInstall).not.toHaveBeenCalled();
    expect(trigger(host).dataset.phase).toBe("ready");
    confirm.mockRestore();
  });

  it("does not call a development no-op check an update success", async () => {
    const { bridge } = fakeBridge();
    const host = await mount(bridge);
    await act(async () => trigger(host).click());
    await click(host, "Check for updates");
    expect(popover(host)?.textContent).toContain("Update checks are available in the installed app");
    expect(popover(host)?.textContent).not.toContain("You're up to date");
  });

  it("does not overwrite a newer event with the initial snapshot and unsubscribes", async () => {
    const { bridge, emit, listeners } = fakeBridge();
    let finish!: (state: UpdaterState) => void;
    vi.mocked(bridge.getState).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const host = await mount(bridge);
    await act(async () => emit(available));
    await act(async () => finish(idle));
    expect(trigger(host).dataset.phase).toBe("available");
    await act(async () => root?.unmount());
    root = null;
    expect(listeners.size).toBe(0);
  });

  it("redacts bridge failures and leaves a retry control", async () => {
    const { bridge } = fakeBridge();
    vi.mocked(bridge.getState).mockRejectedValue(new Error("SECRET_TOKEN"));
    const host = await mount(bridge);
    expect(trigger(host).dataset.phase).toBe("error");
    await act(async () => trigger(host).click());
    expect(popover(host)?.textContent).toContain("Update service unavailable");
    expect(popover(host)?.textContent).not.toContain("SECRET_TOKEN");
  });
});
