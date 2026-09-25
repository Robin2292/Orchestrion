import type { App } from "electron";

/** Window close on macOS may leave the app alive. Full app quit revokes IPC first,
 * awaits the bounded host stop, then completes the original quit exactly once. */
export function installBackgroundShutdown(app: Pick<App, "on" | "quit">, revoke: () => void, stop: () => Promise<void>): void {
  let ready = false;
  let quitting = false;
  app.on("before-quit", (event) => {
    if (ready) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    revoke();
    const finish = () => { ready = true; app.quit(); };
    void stop().then(finish, finish);
  });
}
