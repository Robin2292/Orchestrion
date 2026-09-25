import type { IpcMainInvokeEvent, WebContents } from "electron";
import { RendererDocumentLifecycle, type RendererDocumentIdentity } from "../renderer-document-lifecycle";
import { createNavigationGuard } from "../navigation";

/** Main owns this list; neither renderer IDs nor caller-supplied URLs authorize. */
export class TrustedDocuments {
  private readonly trusted = new Map<WebContents, (url: string) => boolean>();
  private readonly lifecycle: RendererDocumentLifecycle;
  constructor(revoke: (id: string) => void) { this.lifecycle = new RendererDocumentLifecycle(revoke); }
  add(contents: WebContents, expectedUrl: string): void {
    this.trusted.set(contents, createNavigationGuard(expectedUrl));
    this.lifecycle.identityFor(contents); // bind BEFORE any load/navigation
    contents.once("destroyed", () => this.trusted.delete(contents));
  }
  async handshake(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): Promise<string | null> {
    const immediate = this.identity(event);
    if (immediate) return immediate.id;
    const allowed = this.trusted.get(event.sender);
    if (!allowed || event.sender.isDestroyed() || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame || !allowed(event.senderFrame.url)) return null;
    const pending = this.lifecycle.identityFor(event.sender);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer); event.sender.removeListener("did-frame-finish-load", loaded);
        const current = this.identity(event); resolve(current?.id === pending.id ? current.id : null);
      };
      const loaded = (_event: unknown, main: boolean) => { if (main) finish(); };
      const timer = setTimeout(finish, 5000);
      event.sender.on("did-frame-finish-load", loaded);
    });
  }
  identity(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): RendererDocumentIdentity | null {
    const { sender, senderFrame } = event;
    const allowed = this.trusted.get(sender);
    if (!allowed || sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame
        || !allowed(senderFrame.url) || !allowed(sender.getURL())) return null;
    const identity = this.lifecycle.identityFor(sender);
    return identity.isActive() ? identity : null;
  }
  publish(channel: string, value: unknown, documentId?: string): void {
    for (const contents of this.trusted.keys()) {
      const identity = this.identity({ sender: contents, senderFrame: contents.mainFrame });
      if (identity && (!documentId || identity.id === documentId)) contents.send(channel, value);
    }
  }
  dispose(): void { this.lifecycle.dispose(); this.trusted.clear(); }
}
