import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { OrchestrionDesktopApi, TerminalEvent } from "../shared/contracts";
import {
  TERMINAL_MAX_COLUMNS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLUMNS,
  TERMINAL_MIN_ROWS,
} from "../shared/contracts";

export type WorkspaceTerminalApi = Pick<
  OrchestrionDesktopApi,
  "createTerminal" | "sendTerminalInput" | "acknowledgeTerminalOutput" | "resizeTerminal" | "closeTerminal" | "closeSessionTerminals" | "onTerminalEvent"
>;

interface WorkspaceTerminalSurfaceProps {
  sessionId: string;
  api: WorkspaceTerminalApi;
}

type TerminalStatus = "starting" | "running" | "exited" | "error";

export function WorkspaceTerminalSurface({ sessionId, api }: WorkspaceTerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let terminalId: string | null = null;
    let resizeFrame: number | null = null;
    const pendingEvents: TerminalEvent[] = [];
    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"DM Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.32,
      scrollback: 5_000,
      theme: {
        background: "#f1f3ef",
        foreground: "#34473e",
        cursor: "#1f6a4d",
        cursorAccent: "#f1f3ef",
        selectionBackground: "#c9ddd1",
        black: "#24342d",
        red: "#9a5148",
        green: "#2c7457",
        yellow: "#8b6e2f",
        blue: "#4c685c",
        magenta: "#755d73",
        cyan: "#36756c",
        white: "#dce4de",
        brightBlack: "#748079",
        brightRed: "#b46559",
        brightGreen: "#3f936e",
        brightYellow: "#a7853e",
        brightBlue: "#668276",
        brightMagenta: "#8c7289",
        brightCyan: "#4b8e83",
        brightWhite: "#f7faf7",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const renderEvent = (event: TerminalEvent) => {
      if (event.type === "output") {
        terminal.write(event.data, () => {
          void api.acknowledgeTerminalOutput({ terminalId: event.terminalId, sessionId, sequence: event.sequence }).catch(() => undefined);
        });
      }
      else {
        terminalId = null;
        setStatus("exited");
        terminal.options.cursorBlink = false;
      }
    };
    const unsubscribe = api.onTerminalEvent((event) => {
      if (disposed || event.sessionId !== sessionId) return;
      if (!terminalId) {
        pendingEvents.push(event);
        return;
      }
      if (event.terminalId === terminalId) renderEvent(event);
    });
    const inputSubscription = terminal.onData((data) => {
      if (!terminalId || disposed) return;
      void api.sendTerminalInput({ terminalId, sessionId, data }).catch((reason: unknown) => {
        if (!disposed) {
          setError(message(reason, "Terminal input could not be sent."));
          setStatus("error");
        }
      });
    });

    const fit = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (!terminalId) return;
      const columns = clamp(terminal.cols, TERMINAL_MIN_COLUMNS, TERMINAL_MAX_COLUMNS);
      const rows = clamp(terminal.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
      void api.resizeTerminal({ terminalId, sessionId, columns, rows }).catch(() => undefined);
    };
    const queueFit = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        fit();
      });
    };
    const resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(container);
    fitAddon.fit();
    const initialColumns = clamp(terminal.cols, TERMINAL_MIN_COLUMNS, TERMINAL_MAX_COLUMNS);
    const initialRows = clamp(terminal.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
    void api.createTerminal({ sessionId, columns: initialColumns, rows: initialRows }).then((handle) => {
      if (disposed) {
        return api.closeTerminal(handle).catch(() => undefined);
      }
      terminalId = handle.terminalId;
      setStatus("running");
      setError(null);
      for (const event of pendingEvents.splice(0)) {
        if (event.terminalId === terminalId) renderEvent(event);
      }
      terminal.focus();
    }).catch((reason: unknown) => {
      if (!disposed) {
        setError(message(reason, "Terminal could not be started."));
        setStatus("error");
      }
    });

    return () => {
      disposed = true;
      void api.closeSessionTerminals({ sessionId }).catch(() => undefined);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      unsubscribe();
      terminal.dispose();
      if (terminalId) void api.closeTerminal({ terminalId, sessionId }).catch(() => undefined);
    };
  }, [api, generation, sessionId]);

  return <div className="workspace-terminal" aria-label="Terminal">
    <div ref={containerRef} className="workspace-terminal-emulator" />
    {status === "starting" && <div className="workspace-terminal-status" role="status">Starting terminal…</div>}
    {(status === "exited" || status === "error") && <div className="workspace-terminal-ended" role="status">
      <span>{error ?? "Terminal exited"}</span>
      <button type="button" onClick={() => { setStatus("starting"); setError(null); setGeneration((value) => value + 1); }}>Start a new terminal</button>
    </div>}
  </div>;
}

function clamp(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
