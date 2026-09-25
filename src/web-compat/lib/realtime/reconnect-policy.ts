export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "disconnected";

/**
 * The one production reconnect budget for every realtime channel.
 *
 * Consumers may decide whether a closed channel is finished or needs a token
 * refresh, but they do not own retry cadence. Keeping cadence here prevents
 * two views of the same outage from creating different retry pressure and
 * different user expectations.
 */
export interface RealtimeReconnectPolicy {
  fastRetryAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  standbyProbeMs: number;
  rehydrateGapMs: number;
}

export const REALTIME_RECONNECT_POLICY: Readonly<RealtimeReconnectPolicy> = Object.freeze({
  fastRetryAttempts: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 5_000,
  standbyProbeMs: 30_000,
  rehydrateGapMs: 30_000,
});

/** Test-only policy overrides use this same shape without giving production
 * consumers another named budget to import. */
export type RealtimeReconnectPolicyOverride = Partial<RealtimeReconnectPolicy>;

export type RealtimeRecoveryState =
  | "inactive"
  | "connecting"
  | "live"
  | "recovering"
  | "standby"
  | "action_required"
  | "stopped";

/**
 * Project transport facts into mutually exclusive operator semantics.
 *
 * This is deliberately pure: the hook owns transitions, while every UI uses
 * the same interpretation of whether Orchestrion is recovering automatically
 * or a person has to act.
 */
export function deriveRealtimeRecoveryState({
  connectionState,
  reconnectExhausted,
  unauthenticated,
}: {
  connectionState: RealtimeConnectionState;
  reconnectExhausted: boolean;
  unauthenticated: boolean;
}): RealtimeRecoveryState {
  if (connectionState === "connected") return "live";
  if (unauthenticated) return "action_required";
  if (reconnectExhausted) return "standby";
  if (connectionState === "reconnecting") return "recovering";
  if (connectionState === "connecting") return "connecting";
  if (connectionState === "idle") return "inactive";
  return "stopped";
}
