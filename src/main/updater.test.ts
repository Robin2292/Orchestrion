import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdater, type AutoUpdaterPort } from "./updater";

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

const update = { version: "0.2.0", releaseNotes: "First change\nSecond change", files: [], path: "", sha512: "", releaseDate: "" };
afterEach(() => { vi.useRealTimers(); });

describe("packaged desktop updater", () => {
  it("keeps development inert even when commands are invoked", async () => {
    vi.useFakeTimers();
    const fake = new FakeAutoUpdater();
    const controller = new DesktopUpdater(false, "0.1.0", fake as AutoUpdaterPort);
    controller.start();
    expect(await controller.check()).toMatchObject({ phase: "idle", currentVersion: "0.1.0" });
    expect(await controller.download()).toMatchObject({ phase: "idle" });
    controller.quitAndInstall();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("checks, waits for the user's download, then installs only a ready version", async () => {
    const fake = new FakeAutoUpdater();
    const controller = new DesktopUpdater(true, "0.1.0", fake as AutoUpdaterPort);
    const phases: string[] = [];
    controller.subscribe(state => phases.push(state.phase));
    controller.start();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    controller.quitAndInstall();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    fake.checkForUpdates.mockImplementation(async () => { fake.emit("update-available", update); });
    expect(await controller.check()).toMatchObject({ phase: "available", availableVersion: "0.2.0",
      changelog: [{ version: "0.2.0", notes: ["First change", "Second change"] }] });
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    fake.downloadUpdate.mockImplementation(async () => {
      fake.emit("download-progress", { percent: 39.6 });
      fake.emit("update-downloaded", update);
      return [];
    });
    expect(await controller.download()).toMatchObject({ phase: "ready", progressPercent: 100 });
    controller.quitAndInstall();
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("installing");
    expect(phases).toEqual(["checking", "available", "downloading", "downloading", "ready", "installing"]);
    controller.stop();
  });

  it("redacts transport errors, permits retry, and ignores late progress", async () => {
    const fake = new FakeAutoUpdater();
    const controller = new DesktopUpdater(true, "0.1.0", fake as AutoUpdaterPort);
    controller.start();
    fake.checkForUpdates.mockRejectedValueOnce(new Error("TOKEN_CANARY"));
    expect(await controller.check()).toMatchObject({ phase: "error", error: "Update check failed" });
    fake.checkForUpdates.mockImplementationOnce(async () => { fake.emit("update-available", update); });
    expect(await controller.check()).toMatchObject({ phase: "available" });
    fake.downloadUpdate.mockRejectedValueOnce(new Error("SECRET_DOWNLOAD_CANARY"));
    expect(await controller.download()).toMatchObject({ phase: "error", error: "Update download failed" });
    fake.emit("download-progress", { percent: 88 });
    expect(controller.getState()).toMatchObject({ phase: "error", progressPercent: null });
    expect(JSON.stringify(controller.getState())).not.toContain("CANARY");
    controller.stop();
  });

  it("recovers from a native install error emitted after quitAndInstall returns", async () => {
    const fake = new FakeAutoUpdater();
    const controller = new DesktopUpdater(true, "0.1.0", fake as AutoUpdaterPort);
    controller.start();
    fake.checkForUpdates.mockImplementationOnce(async () => { fake.emit("update-available", update); });
    await controller.check();
    fake.downloadUpdate.mockImplementationOnce(async () => { fake.emit("update-downloaded", update); return []; });
    await controller.download();
    controller.quitAndInstall();
    expect(controller.getState().phase).toBe("installing");
    fake.emit("error", new Error("NATIVE_INSTALL_TOKEN_CANARY"));
    expect(controller.getState()).toMatchObject({ phase: "error", error: "Update installation failed" });
    expect(JSON.stringify(controller.getState())).not.toContain("CANARY");
    fake.checkForUpdates.mockImplementationOnce(async () => { fake.emit("update-not-available", update); });
    expect(await controller.check()).toMatchObject({ phase: "idle", error: null });
    controller.stop();
  });

  it("schedules delayed and daily checks only while running", async () => {
    vi.useFakeTimers();
    const fake = new FakeAutoUpdater();
    const controller = new DesktopUpdater(true, "0.1.0", fake as AutoUpdaterPort);
    controller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    controller.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
