import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import type { ProviderReadinessCode } from "../shared/provider-call-contracts";
import { ProviderChunkSchema } from "../shared/provider-call-contracts";
import { ProviderPortError, type LocalProviderAdapter, type ProviderAdapterRequest } from "./call-port";

/** Pure A3 development-profile eligibility; it proves no packaged/live I/O. */
export function localFixtureReadiness(v: LocalAgentVersion): ProviderReadinessCode | null {
  const d = v.definition;
  if (d.nodeType !== "agent") return "REQUEST_MODE_NOT_READY";
  if (d.providerType !== "local") return "PROVIDER_NOT_READY";
  if (d.modelId !== "fixture-readonly-v1") return "MODEL_NOT_READY";
  if (d.toolGrants?.grants.length) return "TOOL_MODE_NOT_READY";
  if (d.outputType !== "text" || d.outputSchema || d.inputSchema || d.role || d.userPromptTemplate || d.timeoutSeconds
    || d.modelParams && Object.keys(d.modelParams).length
    || d.fallbackModels?.length || d.maxRetries !== 0 || d.carryConversation || d.finalizationPrompt || d.jsonExtractionPrompt
    || d.planMode && d.planMode !== "execute_only" || d.interactionMode && d.interactionMode !== "autonomous"
    || d.maxTokens !== null && (d.maxTokens < 1 || d.maxTokens > 1024)) return "REQUEST_MODE_NOT_READY";
  return null;
}

/** Explicit development fixture composition only, never installed in Electron.
 * Frozen F1 records Web calls/accounting, not Local provider/model parity. This
 * one measured no-credential profile adds no registry/catalog or user endpoint.
 * Packaging/live providers need their own measured dependency/credential proof. */
export class WebLocalFixtureAdapter implements LocalProviderAdapter {
  readonly source = "web_provider_adapter" as const;
  #launch: { python: string; backendRoot: string; port: number };
  constructor(launch: { python: string; backendRoot: string; port: number }) {
    if (!launch.python.startsWith("/") || !launch.backendRoot.startsWith("/") || launch.python.includes("\0") || launch.backendRoot.includes("\0")
      || !Number.isInteger(launch.port) || launch.port < 1024 || launch.port > 65535) throw new Error("INVALID_PAYLOAD");
    this.#launch = { ...launch };
  }
  readiness(v: LocalAgentVersion): ProviderReadinessCode | null {
    return localFixtureReadiness(v);
  }
  async *stream(request: ProviderAdapterRequest, signal: AbortSignal): AsyncGenerator<unknown> {
    if (signal.aborted) throw new ProviderPortError("PROVIDER_CANCELLED");
    const { python, backendRoot, port } = this.#launch;
    const cwd = mkdtempSync(join(tmpdir(), "orclocal-a3-provider-"));
    // No inherited credentials, proxy, home, Codex config or user Python hooks.
    const child = spawn(python, ["-B", "-m", "app.services.providers.local_fixture_bridge"], {
      cwd, env: { PYTHONPATH: backendRoot, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
        RATE_LIMIT_MAX_RETRIES: "0", ENV: "test",
        // Settings requires a pagination key even though this isolated process
        // serves no API and signs no cursors. Generate an ephemeral value; never
        // borrow app/user signing material or log the child environment.
        PAGINATION_CURSOR_SIGNING_KEY: randomBytes(32).toString("hex") }, stdio: ["pipe", "pipe", "ignore"],
    });
    let failure: ProviderPortError | undefined, exited = false, pending: (() => void) | undefined;
    let buffer = "", queued: unknown | undefined;
    const decoder = new StringDecoder("utf8");
    const wake = () => { pending?.(); pending = undefined; };
    const fail = (code: ProviderReadinessCode) => { failure ??= new ProviderPortError(code); child.kill("SIGKILL"); wake(); };
    const abort = () => fail("PROVIDER_CANCELLED");
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => fail("PROVIDER_UNAVAILABLE"));
    child.stdin.on("error", () => fail("PROVIDER_UNAVAILABLE"));
    child.on("close", () => { exited = true; rmSync(cwd, { recursive: true, force: true }); wake(); });
    child.stdout.on("data", (bytes: Buffer) => {
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > 131072) { fail("PROVIDER_STREAM_LIMIT"); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          if (queued !== undefined) throw new Error(); // worker must wait for ACK
          queued = ProviderChunkSchema.parse(JSON.parse(line)); wake();
        } catch { fail("PROVIDER_PROTOCOL_ERROR"); return; }
      }
    });
    try {
      if (signal.aborted) abort();
      child.stdin.write(JSON.stringify({ ...request, port }) + "\n");
      while (true) {
        if (failure) throw failure;
        if (queued !== undefined) {
          const value = queued; queued = undefined;
          yield value;
          if (signal.aborted) throw new ProviderPortError("PROVIDER_CANCELLED");
          child.stdin.write("next\n");
        } else if (exited) {
          throw new ProviderPortError("PROVIDER_INCOMPLETE");
        } else await new Promise<void>((resolve) => { pending = resolve; });
      }
    } finally {
      signal.removeEventListener("abort", abort); child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy();
    }
  }
}
