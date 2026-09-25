import { describe, expect, it, vi } from "vitest";
import { UPDATER_IPC } from "../shared/contracts";
import type { DesktopUpdater } from "./updater";
import { registerUpdaterIpc } from "./updater-ipc";
import type { TrustedDocuments } from "./background/sender";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel),
} }));

describe("trusted updater IPC", () => {
  it("rejects untrusted documents and payloads and publishes state only through TrustedDocuments", async () => {
    const state = { phase: "idle", currentVersion: "0.1.0", availableVersion: null, progressPercent: null, changelog: [], error: null } as const;
    const subscription: { publishState: ((value: typeof state) => void) | null } = { publishState: null };
    const updater = { getState: () => state, check: vi.fn(async () => state), download: vi.fn(async () => state),
      quitAndInstall: vi.fn(), subscribe: (listener: (value: typeof state) => void) => {
        subscription.publishState = listener;
        return () => { subscription.publishState = null; };
      } } as unknown as DesktopUpdater;
    const publish = vi.fn();
    const documents = { identity: vi.fn((event: { trusted: boolean }) => event.trusted ? { id: "bound-document" } : null), publish } as unknown as TrustedDocuments;
    const dispose = registerUpdaterIpc(updater, documents);
    const getState = handlers.get(UPDATER_IPC.getState)!;
    expect(await getState({ trusted: false }, undefined, "bound-document")).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await getState({ trusted: true }, undefined, "forged-document")).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await getState({ trusted: true }, { extra: true }, "bound-document")).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await getState({ trusted: true }, undefined, "bound-document")).toMatchObject({ phase: "idle", currentVersion: "0.1.0" });
    subscription.publishState?.(state);
    expect(publish).toHaveBeenCalledWith(UPDATER_IPC.state, state);
    dispose();
    expect(subscription.publishState).toBeNull();
    expect(handlers.has(UPDATER_IPC.getState)).toBe(false);
  });
});
