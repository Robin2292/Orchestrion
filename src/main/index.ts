import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, utilityProcess } from "electron";
import { createNavigationGuard, isLoopbackRendererUrl, prototypeSearch, withPrototypeSearch } from "./navigation";
import { IPC, type DesktopWindowState } from "../shared/contracts";
import { installBackgroundShutdown } from "./background/shutdown";
import { BackgroundHost } from "./background/client";
import { TrustedDocuments } from "./background/sender";
import { openOAuthBrowser, openSystemFile } from "./background/ipc";
import { registerIpc } from "./ipc";
import { DesktopUpdater } from "./updater";
import { registerUpdaterIpc } from "./updater-ipc";

let mainWindow: BrowserWindow | null = null;
let host: BackgroundHost | null = null;
let documents: TrustedDocuments | null = null;
let unregisterIpc: (() => void) | null = null;
let unregisterUpdaterIpc: (() => void) | null = null;
let updater: DesktopUpdater | null = null;
let applicationClosing = false;

function currentWindowState(): DesktopWindowState {
  return { isFullScreen: mainWindow?.isFullScreen() ?? false };
}

function publishWindowState(): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    documents?.publish(IPC.windowState, currentWindowState());
  }
}

function createWindow(): void {
  if (applicationClosing) return;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 560,
    minHeight: 440,
    show: false,
    backgroundColor: "#f7f6f2",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("enter-full-screen", publishWindowState);
  mainWindow.on("leave-full-screen", publishWindowState);
  mainWindow.on("closed", () => { mainWindow = null; });
  const rendererPath = join(__dirname, "../renderer/index.html");
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const updatePrototype = prototypeSearch(process.env);
  const productionFileUrl = pathToFileURL(rendererPath).href;
  const baseRendererUrl = developmentUrl && isLoopbackRendererUrl(developmentUrl)
    ? developmentUrl
    : productionFileUrl;
  const expectedRendererUrl = withPrototypeSearch(baseRendererUrl, updatePrototype);
  documents!.add(mainWindow.webContents, expectedRendererUrl);
  const navigationAllowed = createNavigationGuard(expectedRendererUrl);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!navigationAllowed(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, url) => { if (!navigationAllowed(url)) event.preventDefault(); });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (developmentUrl && isLoopbackRendererUrl(developmentUrl)) void mainWindow.loadURL(expectedRendererUrl);
  else if (updatePrototype) void mainWindow.loadURL(expectedRendererUrl);
  else void mainWindow.loadFile(rendererPath);
}

void app.whenReady().then(async () => {
  if (applicationClosing) return;
  host = new BackgroundHost(() => utilityProcess.fork(join(__dirname, "background.js"), [app.getPath("userData")], {
    serviceName: "Orchestrion Background", stdio: "ignore",
    // No tokens or arbitrary application environment is inherited by the host.
    env: Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "CODEX_PATH", "CODEX_HOME"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [])),
  }), openSystemFile, undefined, (pid) => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* child already exited */ }
  }, app.getPath("userData"), openOAuthBrowser);
  host.on("codex-oauth-diagnostic", diagnostic => {
    console.warn("Codex OAuth callback failed", diagnostic);
  });
  host.on("codex-text-diagnostic", diagnostic => {
    console.warn("Codex Direct text provider", diagnostic);
  });
  documents = new TrustedDocuments((id) => host!.revoke(id));
  unregisterIpc = registerIpc(host, documents, currentWindowState);
  // The updater runs only in Electron main. Development never imports its
  // network-capable implementation or starts a check timer.
  // electron-updater is CommonJS; Node's ESM namespace does not expose its
  // autoUpdater getter as a named export in the packaged main process.
  const autoUpdater = app.isPackaged
    ? (createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater")).autoUpdater
    : null;
  updater = new DesktopUpdater(app.isPackaged, app.getVersion(), autoUpdater);
  unregisterUpdaterIpc = registerUpdaterIpc(updater, documents);
  updater.start();
  void host.start();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

installBackgroundShutdown(app, () => {
  applicationClosing = true;
  updater?.stop(); updater = null;
  unregisterUpdaterIpc?.(); unregisterUpdaterIpc = null;
  unregisterIpc?.(); unregisterIpc = null;
}, () => host?.stop() ?? Promise.resolve());
