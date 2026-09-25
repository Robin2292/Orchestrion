import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BackgroundHost, type HostProcess } from "./client";
import { CODEX_ACCOUNT_UI_CHANNEL } from "../../shared/codex-account-ui-contracts";
import { CODEX_AUTHORIZE_URL, CODEX_CLIENT_ID, CODEX_REDIRECT_URI } from "../credentials/codex-oauth-provider";

class Child extends EventEmitter implements HostProcess {
  sent: Array<Record<string, unknown>> = [];
  postMessage(message: Record<string, unknown>) { this.sent.push(message); }
  kill() { this.emit("exit", 0); return true; }
}
const document = { id: "document-1", isActive: () => true };
const validUrl = () => {
  const url = new URL(CODEX_AUTHORIZE_URL);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI, scope: "openid profile email offline_access",
    code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s".repeat(43),
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "orchestrion" }))
    url.searchParams.set(key, value);
  return url.toString();
};

describe("Codex OAuth browser effect boundary", () => {
  it("opens only the exact host-built URL for a live explicit opt-in start", async () => {
    const child = new Child(), files = vi.fn(async () => ""), browser = vi.fn(async () => {});
    const host = new BackgroundHost(() => child, files,
      { start: 100, request: 1000, stop: 100, maxPending: 8 }, () => {}, undefined, browser);
    const starting = host.start(); child.emit("message", { type: "ready" }); await starting;
    const input = { operation: "start", projectId: "project", explicitOptIn: true };
    const pending = host.invoke(CODEX_ACCOUNT_UI_CHANNEL, input, document);
    await vi.waitFor(() => expect(child.sent[0]?.type).toBe("invoke"));
    const id = child.sent[0].id;
    for (const changed of [
      validUrl().replace("auth.openai.com", "evil.example"),
      `${validUrl()}&access_token=secret`,
      validUrl().replace("localhost%3A1455", "127.0.0.1%3A1455"),
    ]) {
      child.emit("message", { type: "open-oauth-url", id, url: changed });
      expect(child.sent.at(-1)).toEqual({ type: "opened", id, ok: false });
    }
    expect(browser).not.toHaveBeenCalled();
    child.emit("message", { type: "open-oauth-url", id, url: validUrl() });
    await vi.waitFor(() => expect(browser).toHaveBeenCalledExactlyOnceWith(validUrl()));
    expect(files).not.toHaveBeenCalled();
    child.emit("message", { type: "result", id, value: { ok: true } });
    await pending;

    const read = host.invoke(CODEX_ACCOUNT_UI_CHANNEL, { operation: "read", projectId: "project" }, document);
    await vi.waitFor(() => expect(child.sent.at(-1)?.type).toBe("invoke"));
    const readId = child.sent.at(-1)!.id;
    child.emit("message", { type: "open-oauth-url", id: readId, url: validUrl() });
    expect(child.sent.at(-1)).toEqual({ type: "opened", id: readId, ok: false });
    child.emit("message", { type: "result", id: readId, value: { ok: true } });
    await read;
    const stopped = host.stop(); child.emit("exit", 0); await stopped;
  });
});
