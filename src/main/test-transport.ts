import type { RpcTransport } from "./json-rpc";

export class FakeTransport implements RpcTransport {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(error: Error) => void>();

  write(message: string): void {
    this.sent.push(JSON.parse(message.trim()) as Record<string, unknown>);
  }

  close(): void { this.closed = true; }
  onData(listener: (chunk: string) => void): () => void { this.dataListeners.add(listener); return () => this.dataListeners.delete(listener); }
  onExit(listener: (error: Error) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  receive(payload: object): void { for (const listener of this.dataListeners) listener(`${JSON.stringify(payload)}\n`); }
  receiveRaw(chunk: string): void { for (const listener of this.dataListeners) listener(chunk); }
  exit(error = new Error("test exit")): void { for (const listener of this.exitListeners) listener(error); }

  request(method: string): Record<string, unknown> {
    const found = [...this.sent].reverse().find((entry) => entry.method === method && entry.id !== undefined);
    if (!found) throw new Error(`No ${method} request was sent`);
    return found;
  }

  respondTo(method: string, result: unknown): void {
    this.receive({ jsonrpc: "2.0", id: this.request(method).id, result });
  }
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
