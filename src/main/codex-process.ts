import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ChildProcessTransport, JsonRpcConnection, type RpcTransport, asError } from "./json-rpc";
import type { RuntimeDiagnostic } from "../shared/contracts";

import { hostOwnedWork, type AssertRequestActive } from "./request-guard";

const execFileAsync = promisify(execFile);

export interface CodexProcessDependencies {
  assertActive?: AssertRequestActive;
  locate?: (assertActive: AssertRequestActive) => Promise<{ path: string; version: string }>;
  spawnTransport?: (path: string) => RpcTransport;
}

export interface RunningCodex {
  connection: JsonRpcConnection;
  version: string;
}

export class CodexLaunchError extends Error {
  constructor(public readonly diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
  }
}

export async function locateCodex(assertActive: AssertRequestActive = hostOwnedWork): Promise<{ path: string; version: string }> {
  const configured = process.env.CODEX_PATH?.trim();
  const candidates = [...new Set([
    configured,
    "codex",
    join(homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((candidate): candidate is string => Boolean(candidate)))];
  const failures: string[] = [];
  let nonMissingFailure = false;
  for (const executable of candidates) {
    assertActive();
    try {
      const { stdout, stderr } = await execFileAsync(executable, ["--version"], { timeout: 10_000 });
      assertActive();
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/codex(?:-cli)?\s+(\d+\.\d+\.\d+)/i);
      if (!match) throw new Error(`Unrecognized version output: ${output.trim()}`);
      return { path: executable, version: match[1] };
    } catch (error) {
      assertActive();
      const code = (error as NodeJS.ErrnoException).code;
      nonMissingFailure ||= code !== "ENOENT";
      failures.push(`${executable}: ${asError(error).message}`);
      if (configured) break;
    }
  }
  throw new CodexLaunchError({
    code: nonMissingFailure ? "spawn_failed" : "codex_not_found",
    message: nonMissingFailure ? "Codex CLI could not be inspected." : "Codex CLI was not found. Install Codex or set CODEX_PATH.",
    detail: failures.join("\n"),
  });
}

function spawnCodex(executable: string): RpcTransport {
  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;
  child.stderr.on("data", () => {
    // app-server logs belong on stderr. They are intentionally not treated as protocol data.
  });
  return new ChildProcessTransport(child);
}

export async function launchCodex(dependencies: CodexProcessDependencies = {}): Promise<RunningCodex> {
  const assertActive = dependencies.assertActive ?? hostOwnedWork;
  assertActive();
  const located = await (dependencies.locate ?? locateCodex)(assertActive);
  assertActive(); // discovery may have outlived the requesting document
  let connection: JsonRpcConnection;
  try {
    connection = new JsonRpcConnection((dependencies.spawnTransport ?? spawnCodex)(located.path));
  } catch (error) {
    throw new CodexLaunchError({ code: "spawn_failed", message: "Codex app-server could not be started.", detail: asError(error).message });
  }

  try {
    assertActive();
    const initializeResult = await connection.request("initialize", {
      clientInfo: { name: "orchestrion-desktop", title: "Orchestrion", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    assertActive();
    validateInitializeResult(initializeResult);
    connection.notify("initialized");
    assertActive();
    const accountResult = validateAccountResult(await connection.request("account/read", { refreshToken: false }));
    assertActive();
    if (accountResult.requiresOpenaiAuth && accountResult.account === null) {
      throw new CodexLaunchError({ code: "auth_required", message: "Codex authentication is required." });
    }
    return { connection, version: located.version };
  } catch (error) {
    connection.close();
    assertActive();
    if (error instanceof CodexLaunchError) throw error;
    const detail = asError(error).message;
    const authRequired = /(?:not (?:logged|signed) in|auth(?:entication|orization)? required|unauthorized|\b401\b)/i.test(detail);
    throw new CodexLaunchError({
      code: authRequired ? "auth_required" : "handshake_failed",
      message: authRequired ? "Codex authentication is required." : "Codex app-server handshake failed.",
      detail,
    });
  }
}

function validateInitializeResult(value: unknown): void {
  const result = record(value);
  for (const field of ["userAgent", "codexHome", "platformFamily", "platformOs"] as const) {
    if (typeof result[field] !== "string" || result[field].trim() === "") {
      throw new Error(`Initialize result field ${field} must be a non-empty string`);
    }
  }
}

function validateAccountResult(value: unknown): { account: unknown | null; requiresOpenaiAuth: boolean } {
  const result = record(value);
  if (typeof result.requiresOpenaiAuth !== "boolean" || !(result.account === null || (typeof result.account === "object" && result.account !== null))) {
    throw new Error("Account result is malformed");
  }
  return { account: result.account, requiresOpenaiAuth: result.requiresOpenaiAuth };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
