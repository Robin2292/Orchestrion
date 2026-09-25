// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import { DesktopApiProvider } from "./api-context";
import { ProviderConnectionDialog, ProviderSettingsHost, filterProviders } from "./ProviderConnections";
import { localRouteHash, parseLocalRoute } from "./navigation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });

describe("Desktop provider discovery", () => {
  it("keeps provider Settings as an explicit global route", () => {
    expect(parseLocalRoute("#/settings/providers")).toEqual({ kind: "provider-settings" });
    expect(localRouteHash({ kind: "provider-settings" })).toBe("#/settings/providers");
  });

  it("searches known providers without claiming that catalog visibility means connection readiness", () => {
    expect(filterProviders("goo").map(item => item.name)).toEqual(["Google"]);
    expect(filterProviders("openai")[0]?.methods).toEqual(["API key", "Subscription OAuth"]);
    expect(filterProviders("anthropic")[0]?.methods).toEqual([]);
  });

  it("opens OpenAI methods and leaves unsupported API key ingress unavailable", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const onClose = vi.fn();
    await act(async () => root?.render(<ProviderConnectionDialog projectId={null} onClose={onClose} />));
    expect(container.textContent).toContain("Anthropic");
    const openai = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-row")].find(item => item.textContent?.includes("OpenAI"))!;
    await act(async () => openai.click());
    expect(container.textContent).toContain("OpenAI Platform API key");
    const api = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-methods button")][0];
    await act(async () => api.click());
    expect(container.textContent).toContain("No key is accepted by this screen until that path is ready.");
    expect(container.querySelector("input[type='password']")).toBeNull();
    await act(async () => container?.querySelector<HTMLButtonElement>("[aria-label='Close provider connections']")?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps connection management separate from the provider directory", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<ProviderSettingsHost projectId={null} />));
    expect(container.textContent).toContain("Connected providers");
    expect(container.textContent).toContain("Open a Personal Local Project");
    expect(container.textContent).toContain("Explore providers");
  });

  it("uses one stable subscription card while browsing methods in Settings", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const codexAccount = vi.fn(async ({ operation }: { operation: string }) => ({
      availability: "available" as const, state: operation === "start" ? "pending" as const : "disconnected" as const,
      accountDisplay: null, executionReady: false,
    }));
    const api = { codexAccount } as unknown as OrchestrionDesktopApi;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<DesktopApiProvider api={api}><ProviderSettingsHost projectId={projectId} /></DesktopApiProvider>); await Promise.resolve(); });
    expect(container.querySelectorAll(".codex-subscription-card")).toHaveLength(1);
    expect(codexAccount.mock.calls.filter(([request]) => request.operation === "read")).toHaveLength(1);
    await act(async () => container?.querySelector<HTMLInputElement>(".codex-subscription-opt-in input")?.click());
    await act(async () => { container?.querySelector<HTMLButtonElement>(".codex-subscription-actions button")?.click(); await Promise.resolve(); });
    expect(container.textContent).toContain("Waiting for sign-in");
    const openai = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-row")].find(item => item.textContent?.includes("OpenAI"))!;
    await act(async () => openai.click());
    await act(async () => container?.querySelectorAll<HTMLButtonElement>(".provider-flow-methods button")[1]?.click());
    expect(container.querySelectorAll(".codex-subscription-card")).toHaveLength(1);
    expect(container.textContent).toContain("Waiting for sign-in");
    expect(codexAccount.mock.calls.some(([request]) => request.operation === "cancel")).toBe(false);
  });

  it("routes modal OAuth selection to stable Settings without starting or cancelling sign-in", async () => {
    const onClose = vi.fn(), onManageSubscription = vi.fn();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<ProviderConnectionDialog projectId="00000000-0000-4000-8000-000000000001" onClose={onClose} onManageSubscription={onManageSubscription} />));
    const openai = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-row")].find(item => item.textContent?.includes("OpenAI"))!;
    await act(async () => openai.click());
    await act(async () => container?.querySelectorAll<HTMLButtonElement>(".provider-flow-methods button")[1]?.click());
    expect(onManageSubscription).toHaveBeenCalledOnce();
    expect(container.querySelector(".codex-subscription-card")).toBeNull();
    await act(async () => container?.querySelector<HTMLButtonElement>("[aria-label='Close provider connections']")?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus inside the dialog across provider and method transitions, then restores its invoker", async () => {
    const invoker = document.createElement("button"); invoker.textContent = "Model picker"; document.body.append(invoker); invoker.focus();
    const onClose = vi.fn();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<ProviderConnectionDialog projectId={null} onClose={onClose} returnFocus={() => invoker} />));
    let search = container.querySelector<HTMLInputElement>("input[type='search']")!;
    expect(document.activeElement).toBe(search);
    let openai = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-row")].find(item => item.textContent?.includes("OpenAI"))!;
    await act(async () => openai.click());
    let back = container.querySelector<HTMLButtonElement>("[aria-label='Back to providers']")!;
    expect(document.activeElement).toBe(back);
    await act(async () => container?.querySelectorAll<HTMLButtonElement>(".provider-flow-methods button")[0]?.click());
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    search = container.querySelector<HTMLInputElement>("input[type='search']")!;
    expect(document.activeElement).toBe(search);
    openai = [...container.querySelectorAll<HTMLButtonElement>(".provider-flow-row")].find(item => item.textContent?.includes("OpenAI"))!;
    await act(async () => openai.click());
    back = container.querySelector<HTMLButtonElement>("[aria-label='Back to providers']")!;
    const last = container.querySelectorAll<HTMLButtonElement>(".provider-flow-methods button")[1]!;
    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => last.dispatchEvent(forward));
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(back);
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => back.dispatchEvent(backward));
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root?.render(<div />));
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });

  it("returns focus to a stable model trigger when the picker plus button has unmounted", async () => {
    const picker = document.createElement("button"), plus = document.createElement("button");
    document.body.append(picker, plus); plus.focus();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<ProviderConnectionDialog projectId={null} onClose={vi.fn()} returnFocus={() => picker} />));
    plus.remove();
    await act(async () => root?.render(<div />));
    expect(document.activeElement).toBe(picker);
    picker.remove();
  });
});
