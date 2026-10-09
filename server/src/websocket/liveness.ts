import WebSocket, { WebSocketServer } from 'ws';

/**
 * Interval between liveness probes (server-initiated pings), in milliseconds.
 * R11.20: every open connection is pinged every 30 seconds.
 */
export const LIVENESS_INTERVAL_MS = 30_000;

/**
 * Number of consecutive unanswered probes after which a connection is
 * considered dead. R11.21: two consecutive missed pongs.
 */
export const MAX_MISSED_PONGS = 2;

export interface LivenessOptions {
  /** Override the probe interval. Defaults to {@link LIVENESS_INTERVAL_MS}. */
  intervalMs?: number;
  /** Override the missed-pong tolerance. Defaults to {@link MAX_MISSED_PONGS}. */
  maxMissed?: number;
  /** Called once for a connection that stopped answering probes, before it is closed. */
  onDead(ws: WebSocket): void;
}

/** Handle returned by {@link attachLivenessProbe}, used to stop the probe timer. */
export interface LivenessProbe {
  stop(): void;
}

/**
 * Pure transition for the per-connection missed-pong counter.
 *
 * A pong seen since the previous tick resets the counter; otherwise the tick
 * counts as one more missed probe.
 */
export function nextMissedCount(missed: number, pongSeen: boolean): number {
  return pongSeen ? 0 : missed + 1;
}

/**
 * Attach a liveness probe to a WebSocket server.
 *
 * Each tick, every open connection is pinged. A connection that has not
 * answered since the previous tick accumulates a missed count; once that count
 * reaches `maxMissed`, `onDead(ws)` is called and the socket is closed.
 *
 * The probe keeps all of its state in local maps, so attaching separate probes
 * to the poker and retro servers leaves them fully independent (R11.22, R13.9).
 */
export function attachLivenessProbe(
  wss: WebSocketServer,
  options: LivenessOptions
): LivenessProbe {
  const intervalMs = options.intervalMs ?? LIVENESS_INTERVAL_MS;
  const maxMissed = options.maxMissed ?? MAX_MISSED_PONGS;

  // Per-connection probe bookkeeping. WeakMaps so closed sockets are collectable.
  const missedCounts = new WeakMap<WebSocket, number>();
  const pongSeen = new WeakMap<WebSocket, boolean>();
  const tracked = new Set<WebSocket>();

  const track = (ws: WebSocket): void => {
    if (tracked.has(ws)) {
      return;
    }
    tracked.add(ws);
    missedCounts.set(ws, 0);
    // A fresh connection starts as responsive, so its first tick never counts
    // as a missed probe.
    pongSeen.set(ws, true);

    const onPong = (): void => {
      pongSeen.set(ws, true);
    };
    const onClose = (): void => {
      ws.off('pong', onPong);
      tracked.delete(ws);
      missedCounts.delete(ws);
      pongSeen.delete(ws);
    };

    ws.on('pong', onPong);
    ws.once('close', onClose);
  };

  const onConnection = (ws: WebSocket): void => {
    track(ws);
  };

  wss.on('connection', onConnection);

  // Sockets already connected when the probe is attached.
  wss.clients.forEach((client) => track(client as WebSocket));

  const tick = (): void => {
    tracked.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const missed = nextMissedCount(missedCounts.get(ws) ?? 0, pongSeen.get(ws) ?? false);

      if (missed >= maxMissed) {
        tracked.delete(ws);
        missedCounts.delete(ws);
        pongSeen.delete(ws);
        options.onDead(ws);
        ws.terminate();
        return;
      }

      missedCounts.set(ws, missed);
      pongSeen.set(ws, false);

      try {
        ws.ping();
      } catch {
        // A socket that cannot be pinged is handled by the next tick or its
        // own 'close' event; swallow so one bad socket cannot stop the probe.
      }
    });
  };

  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for the probe alone.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let stopped = false;

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      wss.off('connection', onConnection);
      tracked.clear();
    },
  };
}
