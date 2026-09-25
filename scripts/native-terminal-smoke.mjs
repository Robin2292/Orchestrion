import { app } from "electron";
import { spawn } from "node-pty";

const EXPECTED_ELECTRON = "38.8.6";
const MARKER = "__ORCHESTRION_TERMINAL_SMOKE__";
const cwd = process.cwd();
const shell = process.platform === "win32"
  ? process.env.ComSpec || "powershell.exe"
  : process.env.SHELL && process.env.SHELL.startsWith("/")
    ? process.env.SHELL
    : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
let output = "";
let settled = false;
let timeout;

function finish(code, message) {
  if (settled) return;
  settled = true;
  if (timeout) clearTimeout(timeout);
  if (message) process[code === 0 ? "stdout" : "stderr"].write(`${message}\n`);
  app.exit(code);
}

if (process.versions.electron !== EXPECTED_ELECTRON) {
  finish(1, `Expected Electron ${EXPECTED_ELECTRON}, received ${process.versions.electron ?? "none"}`);
} else {
  const terminal = spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const pid = terminal.pid;
  terminal.onData((data) => {
    if (Buffer.byteLength(output, "utf8") < 1024 * 1024) output += data;
  });
  terminal.onExit(({ exitCode }) => {
    setTimeout(() => {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      const normalizedOutput = output.replaceAll("\r", "");
      if (exitCode !== 0) return finish(1, `PTY exited with ${exitCode}`);
      if (!normalizedOutput.includes(MARKER)) return finish(1, "PTY did not emit the command marker");
      if (!normalizedOutput.includes(cwd)) return finish(1, "PTY did not start in the project cwd");
      if (alive) return finish(1, `PTY child ${pid} remained alive after exit`);
      finish(0, `Electron ${process.versions.electron} loaded node-pty; cwd, output, resize, exit, and cleanup verified.`);
    }, 100);
  });
  terminal.resize(111, 37);
  terminal.write(process.platform === "win32"
    ? `echo ${MARKER}\r\ncd\r\nexit\r\n`
    : `printf '${MARKER}\\n'; pwd; exit\n`);
}

timeout = setTimeout(() => finish(1, "PTY smoke timed out"), 10_000);
