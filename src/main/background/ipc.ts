import { REALTIME_NOTICE } from "../../shared/realtime-contracts";
import { dialog, ipcMain, shell } from "electron";
import { IPC, selectedAttachmentPaths, type DesktopWindowState } from "../../shared/contracts";
import { LocalFailureSchema, localFailure } from "../../shared/local-contracts";
import { requestSchemas, validateRequest } from "./requests";
import type { BackgroundHost } from "./client";
import type { TrustedDocuments } from "./sender";

export function registerBackgroundIpc(host: BackgroundHost, documents: TrustedDocuments, windowState: () => DesktopWindowState): () => void {
  const documentChannel = "orchestrion:document-identity";
  ipcMain.handle(documentChannel, async (event, ...args: unknown[]) => {
    if (args.length) return localFailure("INVALID_PAYLOAD");
    const id = await documents.handshake(event);
    return id ?? localFailure("NOT_AUTHENTICATED");
  });
  const channels = [...Object.keys(requestSchemas), IPC.chooseProjectDirectory, IPC.chooseAttachments,
    IPC.chooseAttachmentFolder, IPC.windowState];
  for (const channel of channels) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const document = documents.identity(event);
    if (!document) return localFailure("NOT_AUTHENTICATED");
    const input = args[0];
    if (args.length !== 2) return localFailure("INVALID_PAYLOAD");
    if (args[1] !== document.id) return localFailure("NOT_AUTHENTICATED");
    if (channel in requestSchemas) {
      if (!validateRequest(channel, input)) return localFailure("INVALID_PAYLOAD");
      return host.invoke(channel, input, document);
    }
    if (input !== undefined) return localFailure("INVALID_PAYLOAD");
    if (channel === IPC.windowState) return windowState();
    const result = await dialog.showOpenDialog({ properties: channel === IPC.chooseAttachments
      ? ["openFile", "multiSelections"] : channel === IPC.chooseProjectDirectory ? ["openDirectory", "createDirectory"] : ["openDirectory"] });
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    if (channel === IPC.chooseProjectDirectory) return result.canceled ? null : result.filePaths[0] ?? null;
    const attachments = await host.invoke(IPC.describeDroppedAttachments, selectedAttachmentPaths(result), document);
    if (LocalFailureSchema.safeParse(attachments).success) return attachments;
    if (!Array.isArray(attachments)) return localFailure("SERVICE_UNAVAILABLE");
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    return channel === IPC.chooseAttachments ? attachments : attachments[0] ?? null;
  });
  const publish = (channel: string, value: unknown, documentId?: string) => {
    if (channel === IPC.event || ((channel === IPC.terminalEvent || channel === REALTIME_NOTICE) && documentId)) documents.publish(channel, value, documentId);
  };
  const unavailable = () => documents.publish(IPC.event, {
    type: "diagnostic", diagnostic: { code: "server_exited", message: "Background host stopped. Unconfirmed operations were not retried. Reconnect to recover persisted sessions." },
  });
  host.on("unavailable", unavailable);
  host.on("event", publish);
  return () => { for (const channel of [...channels, documentChannel]) ipcMain.removeHandler(channel); host.off("event", publish); host.off("unavailable", unavailable); documents.dispose(); };
}
export const openSystemFile = (path: string) => shell.openPath(path);
export const openOAuthBrowser = (url: string) => shell.openExternal(url);
