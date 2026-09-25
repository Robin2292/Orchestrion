import { describe, expect, it } from "vitest";
import type { DesktopSnapshot } from "../shared/contracts";
import { normalizeApprovalDecisions, reduceDesktopSnapshot, updateDraft } from "./state";

const snapshot: DesktopSnapshot = {
  appServer: { status: "ready", codexVersion: "1.0", diagnostic: null }, projects: [], agents: [], sessions: [],
  runtimes: {
    a: { status: "waiting", activeTurnId: "t1", error: null, messages: [], pendingRequests: [{ requestId: 7, sessionId: "a", threadId: "x", turnId: "t1", itemId: null, method: "item/commandExecution/requestApproval", title: "Allow", detail: "", createdAt: "" }] },
    b: { status: "running", activeTurnId: "t2", error: null, messages: [], pendingRequests: [] },
  },
};

describe("desktop renderer state", () => {
  it("resolves only the request in its owning session", () => {
    const next = reduceDesktopSnapshot(snapshot, { type: "request-resolved", requestId: 7, sessionId: "a" });
    expect(next.runtimes.a.pendingRequests).toHaveLength(0);
    expect(next.runtimes.b.status).toBe("running");
  });

  it("keeps drafts isolated per session", () => {
    const first = updateDraft({}, "a", "first draft");
    const next = updateDraft(first, "b", "second draft");
    expect(next).toEqual({ a: "first draft", b: "second draft" });
  });

  it("uses a legacy fallback only when the server omits its decision list", () => {
    expect(normalizeApprovalDecisions()).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(normalizeApprovalDecisions([])).toEqual([]);
    expect(normalizeApprovalDecisions(["cancel", "accept"])).toEqual(["cancel", "accept"]);
  });
});
