import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RequestId = string | number;

export interface RpcTransport {
  write(message: string): void;
  close(): void;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
}

export class ChildProcessTransport implements RpcTransport {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  write(message: string): void {
    if (!this.child.stdin.writable) throw new Error("Codex app-server stdin is closed");
    this.child.stdin.write(message);
  }

  close(): void {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  onData(listener: (chunk: string) => void): () => void {
    const handler = (chunk: Buffer) => listener(chunk.toString("utf8"));
    this.child.stdout.on("data", handler);
    return () => this.child.stdout.off("data", handler);
  }

  onExit(listener: (error: Error) => void): () => void {
    const exit = (code: number | null, signal: NodeJS.Signals | null) =>
      listener(new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "none"})`));
    const failure = (error: Error) => listener(error);
    this.child.once("exit", exit);
    this.child.once("error", failure);
    return () => {
      this.child.off("exit", exit);
      this.child.off("error", failure);
    };
  }
}

interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingClientRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcConnection extends EventEmitter {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingClientRequest>();
  private stopped = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly transport: RpcTransport) {
    super();
    this.cleanups.push(transport.onData((chunk) => this.accept(chunk)));
    this.cleanups.push(transport.onExit((error) => this.handleExit(error)));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.stopped) throw new Error("Codex app-server is not running");
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  respond(id: RequestId, result: unknown): void {
    if (this.stopped) throw new Error("Codex app-server is not running");
    this.send({ jsonrpc: "2.0", id, result });
  }

  reject(id: RequestId, code: number, message: string): void {
    if (this.stopped) throw new Error("Codex app-server is not running");
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(reason = new Error("Codex app-server stopped")): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.rejectPending(reason);
    this.transport.close();
  }

  private send(payload: object): void {
    this.transport.write(`${JSON.stringify(payload)}\n`);
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.route(JSON.parse(line) as RpcMessage);
      } catch (error) {
        this.emit("protocolError", new Error(`Invalid app-server JSON: ${asError(error).message}`));
      }
    }
  }

  private route(message: RpcMessage): void {
    if (message.method) {
      this.emit(message.id === undefined ? "notification" : "serverRequest", message);
      return;
    }
    if (message.id === undefined) {
      this.emit("protocolError", new Error("JSON-RPC response did not include an id"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emit("protocolError", new Error(`Received response for unknown request ${String(message.id)}`));
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? "unknown"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending(error);
    this.emit("exit", error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
