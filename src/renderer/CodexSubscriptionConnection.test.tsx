/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { CodexAccountUiValue } from "../shared/codex-account-ui-contracts";
import { DesktopApiProvider } from "./api-context";
import { CodexSubscriptionConnection } from "./CodexSubscriptionConnection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const unavailable: CodexAccountUiValue = { availability: "unavailable", state: "unavailable",
  accountDisplay: null, executionReady: false };
const disconnected: CodexAccountUiValue = { availability: "available", state: "disconnected",
  accountDisplay: null, executionReady: false };
let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function render(read: CodexAccountUiValue) {
  const codexAccount = vi.fn(async (request: Parameters<OrchestrionDesktopApi["codexAccount"]>[0]) =>
    request.operation === "read" ? read : disconnected);
  const api = { codexAccount } as unknown as OrchestrionDesktopApi;
  await act(async () => root.render(<DesktopApiProvider api={api}>
    <CodexSubscriptionConnection projectId="project-one" />
  </DesktopApiProvider>));
  return codexAccount;
}

describe("experimental subscription account UI", () => {
  it("starts unchecked, accurately labels unavailable registration and separates native login", async () => {
    const request = await render(unavailable);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const connect = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Connect subscription")!;
    expect(checkbox.checked).toBe(false);
    expect(connect.disabled).toBe(true);
    expect(container.textContent).toContain("EXPERIMENTAL");
    expect(container.textContent).toContain("not officially supported");
    expect(container.textContent).toContain("Native Codex App Server login is separate");
    expect(container.textContent).toContain("Sign-in unavailable");
    await act(async () => checkbox.click());
    expect(connect.disabled).toBe(true);
    expect(request.mock.calls.map(([value]) => value.operation)).toEqual(["read"]);
  });

  it("requires an explicit opt-in and never presents credential presence as execution readiness", async () => {
    const request = await render(disconnected);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const connect = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Connect subscription")!;
    expect(connect.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(connect.disabled).toBe(false);
    await act(async () => connect.click());
    expect(request).toHaveBeenCalledWith({ operation: "start", projectId: "project-one", explicitOptIn: true });
    expect(container.textContent).not.toContain("execution ready");
  });
  it("renders only the verified display and keeps native login separate from a connected credential", async () => {
    await render({ availability: "available", state: "connected", accountDisplay: "••••", executionReady: false });
    expect(container.textContent).toContain("Credential present");
    expect(container.textContent).toContain("Account ••••");
    expect(container.textContent).toContain("Agent execution readiness and subscription entitlements are checked separately");
    expect(container.textContent).toContain("Native Codex App Server login is separate");
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Disconnect local credential")).toBe(true);
  });
  it("drops a late poll from the previously displayed Project", async () => {
    vi.useFakeTimers();
    try {
      let resolveOld!: (value: CodexAccountUiValue) => void;
      const oldPoll = new Promise<CodexAccountUiValue>(resolve => { resolveOld = resolve; });
      let oldReads = 0;
      const connected: CodexAccountUiValue = { availability: "available", state: "connected",
        accountDisplay: "••••", executionReady: false };
      const codexAccount = vi.fn((request: Parameters<OrchestrionDesktopApi["codexAccount"]>[0]) => {
        if (request.projectId === "old-project") return ++oldReads === 1
          ? Promise.resolve({ ...disconnected, state: "pending" as const }) : oldPoll;
        return Promise.resolve(connected);
      });
      const api = { codexAccount } as unknown as OrchestrionDesktopApi;
      await act(async () => root.render(<DesktopApiProvider api={api}>
        <CodexSubscriptionConnection projectId="old-project" />
      </DesktopApiProvider>));
      await act(async () => vi.advanceTimersByTime(1500));
      expect(codexAccount).toHaveBeenCalledWith({ operation: "read", projectId: "old-project" });
      await act(async () => root.render(<DesktopApiProvider api={api}>
        <CodexSubscriptionConnection projectId="new-project" />
      </DesktopApiProvider>));
      expect(container.textContent).toContain("Account ••••");
      await act(async () => resolveOld(disconnected));
      expect(container.textContent).toContain("Account ••••");
      expect(container.textContent).not.toContain("Not connected");
    } finally { vi.useRealTimers(); }
  });
});
