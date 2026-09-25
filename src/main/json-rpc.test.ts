import { describe, expect, it } from "vitest";
import { launchCodex } from "./codex-process";
import { JsonRpcConnection } from "./json-rpc";
import { FakeTransport, tick } from "./test-transport";

describe("Codex JSON-RPC transport", () => {
  it("performs initialize before initialized and keeps server request ids separate", async () => {
    const transport = new FakeTransport();
    const launched = launchCodex({
      locate: async () => ({ path: "codex", version: "0.154.0" }),
      spawnTransport: () => transport,
    });
    await tick();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "orchestrion-desktop" },
        capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
      },
    });
    expect((transport.sent[0].params as Record<string, unknown>).capabilities).not.toHaveProperty("extensions");
    transport.respondTo("initialize", { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
    await tick();
    expect(transport.sent[1]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    expect(transport.sent[2]).toMatchObject({ method: "account/read", params: { refreshToken: false } });
    transport.respondTo("account/read", { account: null, requiresOpenaiAuth: false });
    const running = await launched;
    expect(running.version).toBe("0.154.0");

    const clientRequest = running.connection.request("thread/start", {});
    const clientId = transport.request("thread/start").id;
    const serverRequests: Record<string, unknown>[] = [];
    running.connection.on("serverRequest", (request) => serverRequests.push(request as Record<string, unknown>));
    transport.receive({ jsonrpc: "2.0", id: clientId, method: "item/commandExecution/requestApproval", params: { threadId: "t" } });
    expect(serverRequests).toHaveLength(1);
    let settled = false;
    void clientRequest.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    transport.receive({ jsonrpc: "2.0", id: clientId, result: { thread: { id: "t" } } });
    await expect(clientRequest).resolves.toEqual({ thread: { id: "t" } });
  });

  it("rejects malformed initialize results without sending initialized", async () => {
    const transport = new FakeTransport();
    const launched = launchCodex({ locate: async () => ({ path: "codex", version: "0.154.0" }), spawnTransport: () => transport });
    await tick();
    transport.respondTo("initialize", { userAgent: "codex", codexHome: "", platformFamily: "unix", platformOs: "macos" });
    await expect(launched).rejects.toMatchObject({ diagnostic: { code: "handshake_failed" } });
    expect(transport.sent.some((entry) => entry.method === "initialized")).toBe(false);
    expect(transport.closed).toBe(true);
  });

  it("requires an OpenAI account only when the server says OpenAI auth is required", async () => {
    const requiredTransport = new FakeTransport();
    const required = launchCodex({ locate: async () => ({ path: "codex", version: "0.154.0" }), spawnTransport: () => requiredTransport });
    await tick();
    requiredTransport.respondTo("initialize", { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
    await tick();
    requiredTransport.respondTo("account/read", { account: null, requiresOpenaiAuth: true });
    await expect(required).rejects.toMatchObject({ diagnostic: { code: "auth_required" } });

    const providerTransport = new FakeTransport();
    const provider = launchCodex({ locate: async () => ({ path: "codex", version: "0.154.0" }), spawnTransport: () => providerTransport });
    await tick();
    providerTransport.respondTo("initialize", { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
    await tick();
    providerTransport.respondTo("account/read", { account: { type: "amazonBedrock", usesCodexManagedCredentials: false }, requiresOpenaiAuth: false });
    await expect(provider).resolves.toMatchObject({ version: "0.154.0" });
  });

  it("frames partial lines, reports malformed JSON, and rejects pending requests on exit", async () => {
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport);
    const protocolErrors: Error[] = [];
    connection.on("protocolError", (error) => protocolErrors.push(error as Error));
    const pending = connection.request("thread/read", { threadId: "t" });
    const id = transport.request("thread/read").id;
    transport.receiveRaw(`{"jsonrpc":"2.0","id":${String(id)},"result":`);
    await tick();
    transport.receiveRaw("{}}\nnot-json\n");
    await expect(pending).resolves.toEqual({});
    expect(protocolErrors[0]?.message).toContain("Invalid app-server JSON");

    const abandoned = connection.request("turn/start", {});
    transport.exit(new Error("server vanished"));
    await expect(abandoned).rejects.toThrow("server vanished");
  });
});
