// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSnapshot, OrchestrionDesktopApi } from "../shared/contracts";
import App from "./App";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@xterm/xterm", () => ({ Terminal: class { loadAddon() {} open() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
let root: Root | null = null;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; container?.remove(); window.history.replaceState({}, "", "#/"); });
async function fixture(governed = false) {
  window.history.replaceState({}, "", "#/");
  const mode = governed ? "governed" as const : "native" as const;
  const snapshot: DesktopSnapshot = {
    appServer: { status: "ready", codexVersion: "fixture", diagnostic: null },
    projects: [{ id: "project", name: "Atlas", path: "/fixture", createdAt: "2026-01-01T00:00:00Z", executionMode: mode }],
    agents: [{ id: "agent", projectId: "project", name: "Builder", instructions: "", createdAt: "2026-01-01T00:00:00Z", executionMode: mode }],
    sessions: [], runtimes: {},
  };
  const api = {
    bootstrap: vi.fn(async () => structuredClone(snapshot)), listModels: vi.fn(async () => []),
    getWindowState: vi.fn(async () => ({ isFullScreen: false })), onWindowState: vi.fn(() => vi.fn()), onEvent: vi.fn(() => vi.fn()),
    renameProject: vi.fn(async ({ name }: { name: string }) => ({ ...snapshot.projects[0], name })),
    renameAgent: vi.fn(async ({ name }: { name: string }) => ({ ...snapshot.agents[0], name })),
    deleteProject: vi.fn(async () => {}), deleteAgent: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "orchestrion", { configurable: true, value: api as unknown as OrchestrionDesktopApi });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  return api;
}
function trigger(name: string) { return container.querySelector<HTMLButtonElement>(`.tree-more-button[aria-label='${name} actions']`)!; }
function item(label: string) { return [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(button => button.textContent?.trim() === label)!; }
async function click(button: HTMLButtonElement) { await act(async () => { button.click(); await Promise.resolve(); }); }

describe("sidebar action menus", () => {
  it("opens from an ellipsis without collapsing the row, supports arrow keys and returns Escape focus", async () => {
    await fixture(); const anchor = trigger("Atlas");
    await click(anchor);
    expect(container.querySelector(".agent-row")).not.toBeNull();
    expect(document.activeElement).toBe(item("Rename project"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(item("Remove project"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it("renames native metadata through the preload API", async () => {
    const api = await fixture(); await click(trigger("Atlas")); await click(item("Rename project"));
    const input = container.querySelector<HTMLInputElement>("[role=dialog] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New atlas");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector("[role=dialog]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(api.renameProject).toHaveBeenCalledWith({ projectId: "project", name: "New atlas" });
    expect(trigger("New atlas")).not.toBeNull();
  });

  it("confirms empty removal and retains the tree when the service refuses a nonempty branch", async () => {
    const api = await fixture(); api.deleteProject.mockRejectedValueOnce(new Error("Remove this project's agents individually before removing the project."));
    await click(trigger("Atlas")); await click(item("Remove project"));
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alertdialog]")?.textContent).toContain("Only an empty project");
    await act(async () => { container.querySelector("[role=alertdialog]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(api.deleteProject).toHaveBeenCalledWith({ projectId: "project" });
    expect(container.textContent).toContain("agents individually");
    expect(trigger("Atlas")).not.toBeNull();
  });

  it("never offers metadata rename/removal for governed project or published Agent bindings", async () => {
    const api = await fixture(true);
    await click(trigger("Atlas"));
    expect(item("Project overview")).toBeDefined(); expect(item("Rename project")).toBeUndefined(); expect(item("Remove project")).toBeUndefined();
    await click(trigger("Builder"));
    expect(item("Agent profile")).toBeDefined(); expect(item("Capabilities")).toBeDefined();
    expect(item("Rename agent")).toBeUndefined(); expect(item("Remove agent")).toBeUndefined();
    expect(api.renameAgent).not.toHaveBeenCalled(); expect(api.deleteAgent).not.toHaveBeenCalled();
  });
});
