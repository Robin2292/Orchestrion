import { ipcMain } from "electron";
import { localFailure } from "../shared/local-contracts";
import { UPDATER_IPC } from "../shared/contracts";
import type { TrustedDocuments } from "./background/sender";
import type { DesktopUpdater } from "./updater";

/** Keep updater commands in the trusted main process, outside the utility host. */
export function registerUpdaterIpc(updater: DesktopUpdater, documents: TrustedDocuments): () => void {
  const channels = [UPDATER_IPC.check, UPDATER_IPC.download, UPDATER_IPC.quitAndInstall, UPDATER_IPC.getState];
  for (const channel of channels) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const document = documents.identity(event);
    if (!document || args.length !== 2 || args[1] !== document.id) return localFailure("NOT_AUTHENTICATED");
    if (args[0] !== undefined) return localFailure("INVALID_PAYLOAD");
    if (channel === UPDATER_IPC.getState) return updater.getState();
    if (channel === UPDATER_IPC.check) return updater.check();
    if (channel === UPDATER_IPC.download) return updater.download();
    updater.quitAndInstall();
    return undefined;
  });
  const unsubscribe = updater.subscribe(state => documents.publish(UPDATER_IPC.state, state));
  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
