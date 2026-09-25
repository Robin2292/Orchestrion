/** Structural channel seam: WebSocket remains the default implementation. */
export interface RealtimeTransport {
  readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

export function getBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 300, maxMs = 4000 } = options;
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}

export function isSocketOpen(ws: RealtimeTransport | null | undefined): ws is RealtimeTransport {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

export function isSocketConnecting(ws: RealtimeTransport | null | undefined): ws is RealtimeTransport {
  return !!ws && ws.readyState === WebSocket.CONNECTING;
}

export function closeSocketSafely(ws: RealtimeTransport | null | undefined, code = 1000, reason = "closed"): void {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}
