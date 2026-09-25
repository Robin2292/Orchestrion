"use client";

import { useCallback, useEffect, useRef } from "react";
import { useState } from "react";
import {
  deriveRealtimeRecoveryState,
  REALTIME_RECONNECT_POLICY,
  type RealtimeConnectionState,
  type RealtimeReconnectPolicyOverride,
  type RealtimeRecoveryState,
} from "../realtime/reconnect-policy";
import { type RealtimeTransport, closeSocketSafely, getBackoffDelay, isSocketConnecting, isSocketOpen } from "../realtime/ws-utils";

type WebSocketPayload = string | ArrayBufferLike | Blob | ArrayBufferView;
export type { RealtimeConnectionState, RealtimeRecoveryState } from "../realtime/reconnect-policy";

/** Why a consumer vetoed a reconnect. A bare ``false`` only says "do not
 * reconnect", which is not enough to render: a channel the consumer shut
 * down because the work finished and a channel that died because the
 * session expired are both dead sockets, but they need different states
 * and different copy. Consumers that know which one it is say so.
 *
 * - ``"done"``: the consumer stopped listening on purpose — the run
 *   reached a terminal status, the subject changed. Nothing is wrong, so
 *   the channel reports ``idle`` rather than a red ``Offline``.
 * - ``"unauthenticated"``: the token could not be refreshed. Only the user
 *   can clear this, so it is surfaced separately from an unreachable
 *   backend. */
export type RealtimeStopReason = "done" | "unauthenticated";

/** ``true`` reconnects. Anything else stops the channel; a
 * :type:`RealtimeStopReason` additionally says why. */
export type RealtimeReconnectDecision = boolean | RealtimeStopReason;

export interface RealtimeChannelContext {
  socket: RealtimeTransport;
  isReconnect: boolean;
  reconnectAttempt: number;
}

interface UseRealtimeChannelOptions {
  enabled?: boolean;
  /**
   * Stable owner identity for the physical subscription. A change tears down
   * the current socket and creates a new one even when the URL is unchanged
   * (for example, the same Run ID viewed under a different organization).
   */
  channelIdentity?: string | null;
  getUrl: () => string;
  createTransport?: (url: string) => RealtimeTransport;
  initialConnectDelayMs?: number;
  /** The production cadence always comes from REALTIME_RECONNECT_POLICY.
   * Tests may shrink its clocks and budget through this explicit seam. */
  reconnectPolicyOverride?: RealtimeReconnectPolicyOverride;
  binaryType?: BinaryType;
  onBeforeConnect?: () => void;
  onOpen?: (ctx: RealtimeChannelContext) => void;
  onMessage?: (event: MessageEvent, ctx: RealtimeChannelContext) => void;
  onClose?: (event: CloseEvent, ctx: RealtimeChannelContext) => void;
  onError?: (event: Event, ctx: RealtimeChannelContext) => void;
  shouldReconnect?: (event: CloseEvent, attempt: number) => RealtimeReconnectDecision | Promise<RealtimeReconnectDecision>;
  onReconnectScheduled?: (attempt: number, delayMs: number) => void;
  onReconnectExhausted?: (attempt: number) => void;
  /** Fired on the open event of a reconnect when the wall-clock gap
   * between the last received message and reconnect exceeded
   * ``reconnectGapMs``. Consumers should treat this as a signal that
   * the backend event buffer may have dropped intermediate state and
   * trigger a fresh snapshot fetch / re-hydration. Without it the
   * client would silently resume from a stale point. */
  onReconnectGap?: (gapMs: number, ctx: RealtimeChannelContext) => void;
}

interface UseRealtimeChannelResult {
  send: (data: WebSocketPayload) => boolean;
  close: (code?: number, reason?: string) => void;
  disableReconnect: () => void;
  enableReconnect: () => void;
  connectionState: RealtimeConnectionState;
  reconnectAttempt: number;
  /** True from the moment the fast-backoff budget is spent until the
   * channel is live again. While true the hook keeps probing on a long
   * interval and on network/focus signals, so this means "not live, still
   * trying" — never "given up". Surfaced so the UI can tell the reader
   * that what they are looking at may be stale. */
  reconnectExhausted: boolean;
  /** True once a consumer stopped the channel with ``"unauthenticated"``:
   * the socket was rejected and the token could not be refreshed. Unlike
   * an unreachable backend this cannot resolve itself, so the UI has to
   * ask the user to sign in rather than promise a retry. */
  unauthenticated: boolean;
  /** Business-facing recovery semantics derived from the transport state. */
  recoveryState: RealtimeRecoveryState;
}

export function useRealtimeChannel({
  enabled = true,
  channelIdentity = null,
  getUrl,
  createTransport,
  initialConnectDelayMs = 80,
  reconnectPolicyOverride,
  binaryType,
  onBeforeConnect,
  onOpen,
  onMessage,
  onClose,
  onError,
  shouldReconnect,
  onReconnectScheduled,
  onReconnectExhausted,
  onReconnectGap,
}: UseRealtimeChannelOptions): UseRealtimeChannelResult {
  const backoffBaseMs = reconnectPolicyOverride?.backoffBaseMs
    ?? REALTIME_RECONNECT_POLICY.backoffBaseMs;
  const backoffMaxMs = reconnectPolicyOverride?.backoffMaxMs
    ?? REALTIME_RECONNECT_POLICY.backoffMaxMs;
  const fastRetryAttempts = reconnectPolicyOverride?.fastRetryAttempts
    ?? REALTIME_RECONNECT_POLICY.fastRetryAttempts;
  const standbyRetryMs = reconnectPolicyOverride?.standbyProbeMs
    ?? REALTIME_RECONNECT_POLICY.standbyProbeMs;
  const reconnectGapMs = reconnectPolicyOverride?.rehydrateGapMs
    ?? REALTIME_RECONNECT_POLICY.rehydrateGapMs;
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(enabled ? "connecting" : "idle");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const wsRef = useRef<RealtimeTransport | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const standbyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectEnabledRef = useRef(true);
  const closedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  // True once the fast-backoff budget is spent. Gates the standby probe
  // and the network/focus listeners so they stay inert during normal
  // backoff and never race the scheduled retry.
  const exhaustedRef = useRef(false);
  // True while the channel is stopped on a failed token refresh. Keeps the
  // network/focus probes armed — the session may have been renewed in
  // another tab — without arming the standby interval, which would only
  // re-ask a question the backend has already answered.
  const unauthenticatedRef = useRef(false);
  // Wall clock of the last standby probe, so a burst of focus/online
  // events cannot hammer a backend that is still down.
  const lastStandbyProbeAtRef = useRef(0);
  // Last-message timestamp (ms). Used by the gap detection on reconnect
  // open: if the gap between last message and reconnect exceeds
  // ``reconnectGapMs``, the consumer is told to rehydrate because the
  // server's event buffer likely dropped intermediate events.
  const lastMessageAtRef = useRef<number>(0);
  const channelGenerationRef = useRef(0);

  const callbacksRef = useRef({
    onBeforeConnect,
    onOpen,
    onMessage,
    onClose,
    onError,
    shouldReconnect,
    onReconnectScheduled,
    onReconnectExhausted,
    onReconnectGap,
    reconnectGapMs,
  });

  useEffect(() => {
    callbacksRef.current = {
      onBeforeConnect,
      onOpen,
      onMessage,
      onClose,
      onError,
      shouldReconnect,
      onReconnectScheduled,
      onReconnectExhausted,
      onReconnectGap,
      reconnectGapMs,
    };
  }, [onBeforeConnect, onOpen, onMessage, onClose, onError, shouldReconnect, onReconnectScheduled, onReconnectExhausted, onReconnectGap, reconnectGapMs]);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (standbyTimerRef.current) {
      clearTimeout(standbyTimerRef.current);
      standbyTimerRef.current = null;
    }
  }, []);

  const disableReconnect = useCallback(() => {
    reconnectEnabledRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (standbyTimerRef.current) {
      clearTimeout(standbyTimerRef.current);
      standbyTimerRef.current = null;
    }
  }, []);

  const enableReconnect = useCallback(() => {
    reconnectEnabledRef.current = true;
  }, []);

  const close = useCallback((code = 1000, reason = "channel closed") => {
    disableReconnect();
    clearTimers();
    closeSocketSafely(wsRef.current, code, reason);
    wsRef.current = null;
    // A deliberate close is not an outage: drop the standby flag so the
    // UI does not claim we are still trying to get back.
    exhaustedRef.current = false;
    setReconnectExhausted(false);
    unauthenticatedRef.current = false;
    setUnauthenticated(false);
    setConnectionState("disconnected");
  }, [clearTimers, disableReconnect]);

  const send = useCallback((data: WebSocketPayload) => {
    const ws = wsRef.current;
    if (!isSocketOpen(ws)) return false;
    ws.send(data);
    return true;
  }, []);

  useEffect(() => {
    const channelGeneration = ++channelGenerationRef.current;
    if (!enabled) {
      closeSocketSafely(wsRef.current, 1000, "channel disabled");
      wsRef.current = null;
      clearTimers();
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
      exhaustedRef.current = false;
      setReconnectExhausted(false);
      unauthenticatedRef.current = false;
      setUnauthenticated(false);
      setConnectionState("idle");
      return;
    }

    reconnectEnabledRef.current = true;
    reconnectAttemptsRef.current = 0;
    closedRef.current = false;
    exhaustedRef.current = false;
    setReconnectExhausted(false);
    unauthenticatedRef.current = false;
    setUnauthenticated(false);
    lastStandbyProbeAtRef.current = 0;
    lastMessageAtRef.current = 0;

    // ── Standby probe ────────────────────────────────────────────
    // Reaching the shared fast-retry budget ends the *fast* retries, not the
    // channel. From here the socket is re-armed on a long flat interval
    // and, sooner, whenever the browser hands us evidence the network may
    // be back. Without this the page sits on "Offline" forever and only a
    // manual reload restores live updates (D38).
    const runStandbyProbe = () => {
      if (closedRef.current || !enabled || !reconnectEnabledRef.current) return;
      if (isSocketOpen(wsRef.current) || isSocketConnecting(wsRef.current)) return;
      lastStandbyProbeAtRef.current = Date.now();
      connectRef.current();
    };

    /** Winds the fast-backoff machinery down without closing the channel:
     * used when a consumer vetoes the reconnect, where neither the standby
     * interval nor a spent attempt counter has any meaning left. */
    const stopFastRetries = () => {
      if (standbyTimerRef.current) {
        clearTimeout(standbyTimerRef.current);
        standbyTimerRef.current = null;
      }
      exhaustedRef.current = false;
      setReconnectExhausted(false);
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
    };

    const scheduleStandbyProbe = () => {
      if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
      standbyTimerRef.current = setTimeout(() => {
        standbyTimerRef.current = null;
        runStandbyProbe();
      }, standbyRetryMs);
    };

    // Network/focus signals only shortcut the wait; they never start a
    // probe during normal backoff, and they respect a floor of
    // ``backoffMaxMs`` so rapid tab switching cannot flood a dead backend.
    // They also cover the expired-session stop, which has no interval of
    // its own: a returning tab is the one moment a session renewed
    // elsewhere is worth re-testing.
    const probeOnSignal = () => {
      if (!exhaustedRef.current && !unauthenticatedRef.current) return;
      if (closedRef.current || !enabled || !reconnectEnabledRef.current) return;
      if (isSocketOpen(wsRef.current) || isSocketConnecting(wsRef.current)) return;
      const sinceLastProbe = Date.now() - lastStandbyProbeAtRef.current;
      if (sinceLastProbe < backoffMaxMs) return;
      if (standbyTimerRef.current) {
        clearTimeout(standbyTimerRef.current);
        standbyTimerRef.current = null;
      }
      runStandbyProbe();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") probeOnSignal();
    };

    window.addEventListener("online", probeOnSignal);
    window.addEventListener("focus", probeOnSignal);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const connect = () => {
      if (closedRef.current || !enabled) return;
      const existing = wsRef.current;
      if (isSocketOpen(existing) || isSocketConnecting(existing)) return;

      callbacksRef.current.onBeforeConnect?.();
      setConnectionState(reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting");
      const ws = createTransport ? createTransport(getUrl()) : new WebSocket(getUrl());
      if (binaryType) ws.binaryType = binaryType;
      wsRef.current = ws;
      const reconnectAttemptAtConnect = reconnectAttemptsRef.current;
      const isReconnectConnection = reconnectAttemptAtConnect > 0;
      const isCurrentSocket = () => (
        channelGenerationRef.current === channelGeneration
        && wsRef.current === ws
        && !closedRef.current
      );

      ws.onopen = () => {
        if (!isCurrentSocket()) return;
        reconnectAttemptsRef.current = 0;
        setReconnectAttempt(0);
        if (standbyTimerRef.current) {
          clearTimeout(standbyTimerRef.current);
          standbyTimerRef.current = null;
        }
        exhaustedRef.current = false;
        setReconnectExhausted(false);
        unauthenticatedRef.current = false;
        setUnauthenticated(false);
        setConnectionState("connected");

        const ctx: RealtimeChannelContext = {
          socket: ws,
          isReconnect: isReconnectConnection,
          reconnectAttempt: reconnectAttemptAtConnect,
        };
        callbacksRef.current.onOpen?.(ctx);

        // Reconnect gap detection: when this open is a reconnect (not
        // the initial connect) and we've previously received at least
        // one message, measure the wall-clock silence. If it exceeds
        // ``reconnectGapMs``, the server's event buffer may have
        // dropped intermediate events and the consumer should rehydrate.
        if (isReconnectConnection && lastMessageAtRef.current > 0) {
          const gapMs = Date.now() - lastMessageAtRef.current;
          if (gapMs >= callbacksRef.current.reconnectGapMs) {
            callbacksRef.current.onReconnectGap?.(gapMs, ctx);
          }
        }
      };

      ws.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        lastMessageAtRef.current = Date.now();
        callbacksRef.current.onMessage?.(event, {
          socket: ws,
          isReconnect: isReconnectConnection,
          reconnectAttempt: reconnectAttemptAtConnect,
        });
      };

      ws.onclose = async (event) => {
        if (channelGenerationRef.current !== channelGeneration) return;
        if (wsRef.current === ws) {
          wsRef.current = null;
        }

        callbacksRef.current.onClose?.(event, {
          socket: ws,
          isReconnect: isReconnectConnection,
          reconnectAttempt: reconnectAttemptAtConnect,
        });

        if (closedRef.current || !enabled || !reconnectEnabledRef.current) return;

        const nextAttempt = reconnectAttemptsRef.current + 1;
        const decision: RealtimeReconnectDecision = callbacksRef.current.shouldReconnect
          ? await callbacksRef.current.shouldReconnect(event, nextAttempt)
          : true;

        if (
          channelGenerationRef.current !== channelGeneration
          || closedRef.current
          || !enabled
          || !reconnectEnabledRef.current
        ) return;

        if (decision !== true) {
          // D38 follow-up: a vetoed reconnect used to return here with
          // the state untouched, so a channel that was "connected" a
          // moment ago kept reporting `Live` for a socket that is closed
          // and nulled. The fast-retry sequence is over either way, so the
          // attempt counter goes back to zero; if a later probe does get
          // through it gets a fresh budget, not a spent one.
          stopFastRetries();
          if (decision === "unauthenticated") {
            // Only the user can clear this, and the standby message would
            // promise a retry that cannot succeed — so drop the standby
            // presentation and say what is actually needed instead. The
            // signal-driven probes stay armed: the session may be renewed
            // in another tab, and a focus event is the moment to find out.
            unauthenticatedRef.current = true;
            setUnauthenticated(true);
            setConnectionState("disconnected");
          } else {
            unauthenticatedRef.current = false;
            setUnauthenticated(false);
            // "done" means the consumer stopped listening because the work
            // is over — a resting channel, not a broken one. A bare `false`
            // says only "do not reconnect"; without a reason the safe read
            // is that live updates are gone, never that they are fine.
            setConnectionState(decision === "done" ? "idle" : "disconnected");
          }
          return;
        }

        if (nextAttempt > fastRetryAttempts) {
          setConnectionState("disconnected");
          // ``reconnectAttemptsRef`` is deliberately left at
          // the shared fast-retry limit so every later failure lands back
          // here instead of replaying the fast backoff against a backend
          // that is still down. ``onReconnectExhausted`` stays a
          // once-per-outage signal: consumers use it to fall back to REST
          // polling, and re-firing it every probe would turn that into a
          // request storm.
          if (!exhaustedRef.current) {
            exhaustedRef.current = true;
            setReconnectExhausted(true);
            callbacksRef.current.onReconnectExhausted?.(nextAttempt);
          }
          scheduleStandbyProbe();
          return;
        }

        reconnectAttemptsRef.current = nextAttempt;
        setReconnectAttempt(nextAttempt);
        setConnectionState("reconnecting");
        const delayMs = getBackoffDelay(nextAttempt, { baseMs: backoffBaseMs, maxMs: backoffMaxMs });
        callbacksRef.current.onReconnectScheduled?.(nextAttempt, delayMs);

        reconnectTimerRef.current = setTimeout(() => {
          connectRef.current();
        }, delayMs);
      };

      ws.onerror = (event) => {
        if (!isCurrentSocket()) return;
        callbacksRef.current.onError?.(event, {
          socket: ws,
          isReconnect: isReconnectConnection,
          reconnectAttempt: reconnectAttemptAtConnect,
        });
        if (ws.readyState !== WebSocket.CLOSED) {
          closeSocketSafely(ws, 1011, "channel error");
        }
      };
    };

    connectRef.current = connect;
    connectTimerRef.current = setTimeout(connect, initialConnectDelayMs);

    return () => {
      channelGenerationRef.current += 1;
      closedRef.current = true;
      window.removeEventListener("online", probeOnSignal);
      window.removeEventListener("focus", probeOnSignal);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimers();
      closeSocketSafely(wsRef.current, 1000, "channel cleanup");
      wsRef.current = null;
    };
  }, [
    enabled,
    channelIdentity,
    getUrl,
    createTransport,
    initialConnectDelayMs,
    backoffBaseMs,
    backoffMaxMs,
    fastRetryAttempts,
    standbyRetryMs,
    binaryType,
    clearTimers,
  ]);

  return {
    send,
    close,
    disableReconnect,
    enableReconnect,
    connectionState,
    reconnectAttempt,
    reconnectExhausted,
    unauthenticated,
    recoveryState: deriveRealtimeRecoveryState({
      connectionState,
      reconnectExhausted,
      unauthenticated,
    }),
  };
}
