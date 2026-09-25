import type { ApprovalDecision, DesktopEvent, DesktopSnapshot } from "../shared/contracts";
import { effectiveApprovalDecisions } from "../shared/request-contracts";

export const APPROVAL_DECISIONS: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];

export function normalizeApprovalDecisions(decisions?: ApprovalDecision[]) {
  return effectiveApprovalDecisions({ availableDecisions: decisions });
}

/** Apply bridge events without allowing one session's runtime to bleed into another. */
export function reduceDesktopSnapshot(snapshot: DesktopSnapshot, event: DesktopEvent): DesktopSnapshot {
  if (event.type === "snapshot") return event.snapshot;
  if (event.type === "diagnostic") {
    return { ...snapshot, appServer: { ...snapshot.appServer, status: "error", diagnostic: event.diagnostic } };
  }
  const runtime = snapshot.runtimes[event.sessionId];
  if (!runtime) return snapshot;
  return {
    ...snapshot,
    runtimes: {
      ...snapshot.runtimes,
      [event.sessionId]: { ...runtime, pendingRequests: runtime.pendingRequests.filter((request) => String(request.requestId) !== String(event.requestId)) },
    },
  };
}

export function updateDraft(drafts: Record<string, string>, sessionId: string, value: string) {
  return { ...drafts, [sessionId]: value };
}
