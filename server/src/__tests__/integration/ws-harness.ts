/**
 * Localhost WebSocket integration harness (design: Testing Strategy,
 * "Integration tests (Jest, real `ws` on localhost)").
 *
 * Each harness starts its own `http.Server` on port 0 with both
 * `WebSocketServer`s (`noServer: true`, `maxPayload: WS_MAX_PAYLOAD_BYTES`),
 * the exported `createUpgradeHandler` of `server.ts`, the real poker and retro
 * handlers, the real liveness probes and real tokens from `auth-service`.
 * Clients are real `ws` sockets. `close()` tears everything down and resets
 * the handler, registry and token state, so each test starts clean.
 *
 * Importing `server.ts` for its exports runs its module-level setup, which
 * calls `server.listen(PORT)`. The harness therefore loads the module once
 * with `PORT=0` (so it can never collide with a dev server or another Jest
 * worker on port 3000) and immediately closes the module-level server, its
 * WebSocketServers and its liveness probes. Only the pure exports are used.
 */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import type * as ServerModule from '../../server';
import {
  handleWebSocket,
  removePokerConnection,
  getRegisteredPokerSessionId,
  _reset as resetPokerHandler,
} from '../../websocket/handler';
import {
  handleRetroWebSocket,
  removeRetroConnection,
  getRegisteredRetroSessionId,
  _resetRetroHandler,
} from '../../websocket/retro-handler';
import { attachLivenessProbe, LivenessProbe } from '../../websocket/liveness';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { _resetStore as resetAuthStore } from '../../services/auth-service';
import { BoardKind, WebSocketMessage, WS_MAX_PAYLOAD_BYTES } from '../../../../shared/types';

// ---------------------------------------------------------------------------
// server.ts module: load once, close its module-level instance
// ---------------------------------------------------------------------------

let serverModule: typeof ServerModule | undefined;

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * The `server.ts` module with its module-level server already closed. The
 * listen call runs with `PORT=0`, and the server is closed before it accepts
 * any connection; its probes, WebSocketServers and the session cleanup timer
 * its listen callback may start are stopped too.
 */
export async function loadServerModule(): Promise<typeof ServerModule> {
  if (serverModule) return serverModule;

  const previousPort = process.env.PORT;
  process.env.PORT = '0';
  let mod: typeof ServerModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../server') as typeof ServerModule;
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }

  mod.pokerLivenessProbe.stop();
  mod.retroLivenessProbe.stop();
  mod.wss.close();
  mod.retroWss.close();
  await closeHttpServer(mod.server);
  sessionRegistry.stopCleanupTimer();
  retroSessionRegistry.stopCleanup();

  serverModule = mod;
  return mod;
}

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

/** A server-side socket accepted by one of the harness WebSocketServers. */
export interface ServerSocketRecord {
  kind: BoardKind;
  ws: WebSocket;
  /** Byte length of every `message` event the socket emitted. */
  messageBytes: number[];
  /** Resolves with the server-side close code. */
  closed: Promise<number>;
}

/** A real `ws` client connected through the harness. */
export interface TestClient {
  kind: BoardKind;
  sessionId: string;
  ws: WebSocket;
  /** Every frame received, parsed, in arrival order. */
  frames: WebSocketMessage[];
  /** Client-side errors (kept so none is ever unhandled). */
  errors: Error[];
  /** Resolves with the client-side close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  /** The server-side socket of this connection. */
  server: ServerSocketRecord;
  /** Resolve with the first frame at index >= `from` matching `pred`. */
  waitFor(
    pred: (m: WebSocketMessage) => boolean,
    opts?: { from?: number; timeoutMs?: number }
  ): Promise<WebSocketMessage>;
  /** Events of the frames received from index `from` on. */
  eventsSince(from: number): string[];
  /** Send a text payload (one frame, or fragments when `fin: false`). */
  sendRaw(data: string | Buffer, opts?: { fin?: boolean }): Promise<void>;
}

export interface WsHarness {
  port: number;
  pokerWss: WebSocketServer;
  retroWss: WebSocketServer;
  /** Every line written through the upgrade handler's injected `log`. */
  logLines: string[];
  /** Errors seen by the harness's `uncaughtException` listener. */
  uncaughtExceptions: Error[];
  serverSockets: ServerSocketRecord[];
  /** Open a client and wait until its join frames (state, joined, history) arrive. */
  connect(kind: BoardKind, token: string, sessionId: string): Promise<TestClient>;
  close(): Promise<void>;
}

const HISTORY_EVENT: Record<BoardKind, string> = {
  poker: 'chat:history',
  retro: 'retro:chat:history',
};

const JOINED_EVENT: Record<BoardKind, string> = {
  poker: 'participant:joined',
  retro: 'retro:participant:joined',
};

const DEFAULT_WAIT_MS = 5000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export async function startWsHarness(): Promise<WsHarness> {
  const mod = await loadServerModule();

  // Fresh process-wide state for this test.
  resetPokerHandler();
  _resetRetroHandler();
  sessionRegistry._reset();
  retroSessionRegistry._reset();
  resetAuthStore();

  const logLines: string[] = [];
  const uncaughtExceptions: Error[] = [];
  const onUncaught = (err: Error): void => {
    uncaughtExceptions.push(err);
  };
  process.on('uncaughtException', onUncaught);

  const pokerWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const retroWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  // Same wiring as server.ts: the real handlers, then the liveness probes.
  pokerWss.on('connection', handleWebSocket);
  retroWss.on('connection', handleRetroWebSocket);
  const probes: LivenessProbe[] = [
    attachLivenessProbe(pokerWss, { onDead: (ws) => removePokerConnection(ws) }),
    attachLivenessProbe(retroWss, { onDead: (ws) => removeRetroConnection(ws) }),
  ];

  // Observe server-side sockets after the handlers, so a recorded `message`
  // event means the handler's `message` listener ran for it too.
  const serverSockets: ServerSocketRecord[] = [];
  const record = (kind: BoardKind) => (ws: WebSocket): void => {
    const messageBytes: number[] = [];
    ws.on('message', (data: WebSocket.RawData) => {
      const size = Array.isArray(data)
        ? data.reduce((n, b) => n + b.length, 0)
        : (data as Buffer | ArrayBuffer).byteLength;
      messageBytes.push(size);
    });
    const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)));
    serverSockets.push({ kind, ws, messageBytes, closed });
  };
  pokerWss.on('connection', record('poker'));
  retroWss.on('connection', record('retro'));

  const httpServer = http.createServer();
  httpServer.on(
    'upgrade',
    mod.createUpgradeHandler({
      publicPath: '',
      preservePath: false,
      pokerWss,
      retroWss,
      log: (line) => logLines.push(line),
      lookupSessionId: { poker: getRegisteredPokerSessionId, retro: getRegisteredRetroSessionId },
    })
  );
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  const clients: TestClient[] = [];

  async function connect(kind: BoardKind, token: string, sessionId: string): Promise<TestClient> {
    const path = kind === 'retro' ? '/retro' : '/';
    const query = `token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?${query}`);

    const frames: WebSocketMessage[] = [];
    const errors: Error[] = [];
    const waiters: Array<() => void> = [];
    ws.on('error', (err) => errors.push(err));
    ws.on('message', (data: WebSocket.RawData) => {
      frames.push(JSON.parse(data.toString()) as WebSocketMessage);
      waiters.slice().forEach((w) => w());
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
        waiters.slice().forEach((w) => w());
      })
    );

    const waitFor: TestClient['waitFor'] = (pred, opts = {}) => {
      const from = opts.from ?? 0;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_MS;
      return new Promise((resolve, reject) => {
        const check = (): boolean => {
          for (let i = from; i < frames.length; i++) {
            if (pred(frames[i])) {
              resolve(frames[i]);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const waiter = (): void => {
          if (check()) done();
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for a ${kind} frame`));
        }, timeoutMs);
        const done = (): void => {
          clearTimeout(timer);
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
        };
        waiters.push(waiter);
      });
    };

    const sendRaw: TestClient['sendRaw'] = (data, opts = {}) =>
      new Promise((resolve, reject) => {
        ws.send(data, { binary: false, fin: opts.fin ?? true }, (err) => (err ? reject(err) : resolve()));
      });

    // Earlier open clients of the same session receive this connection's join
    // broadcast; remember where their frames stand so connect() can wait for it.
    const peers = clients
      .filter((c) => c.kind === kind && c.sessionId === sessionId && c.ws.readyState === WebSocket.OPEN)
      .map((c) => ({ client: c, from: c.frames.length }));

    const before = serverSockets.length;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('close', (code: number) => reject(new Error(`Connection closed before open (${code})`)));
    });

    const partial = { kind, ws, frames, errors, closed, waitFor };
    await partial.waitFor((m) => m.event === HISTORY_EVENT[kind]);

    // Connections are opened one at a time, so the newest record is ours.
    const server = serverSockets[serverSockets.length - 1];
    if (serverSockets.length !== before + 1 || server.kind !== kind) {
      throw new Error('Could not match the client to its server-side socket');
    }

    // Return only once every peer has seen the join broadcast, so a test's
    // "frames since" marks never include a late join frame.
    await Promise.all(
      peers.map(({ client: peer, from }) => peer.waitFor((m) => m.event === JOINED_EVENT[kind], { from }))
    );

    const client: TestClient = {
      ...partial,
      sessionId,
      server,
      eventsSince: (from) => frames.slice(from).map((m) => m.event),
      sendRaw,
    };
    clients.push(client);
    return client;
  }

  async function close(): Promise<void> {
    for (const c of clients) {
      if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
    }
    for (const s of serverSockets) {
      if (s.ws.readyState !== WebSocket.CLOSED) s.ws.terminate();
    }
    await Promise.all([...clients.map((c) => c.closed), ...serverSockets.map((s) => s.closed)]);
    probes.forEach((p) => p.stop());
    await Promise.all([
      new Promise<void>((resolve) => pokerWss.close(() => resolve())),
      new Promise<void>((resolve) => retroWss.close(() => resolve())),
    ]);
    await closeHttpServer(httpServer);
    process.off('uncaughtException', onUncaught);

    resetPokerHandler();
    _resetRetroHandler();
    sessionRegistry._reset();
    retroSessionRegistry._reset();
    resetAuthStore();
  }

  return {
    port,
    pokerWss,
    retroWss,
    logLines,
    uncaughtExceptions,
    serverSockets,
    connect,
    close,
  };
}

/** Resolve after `ms` milliseconds (used for "nothing else arrives" windows). */
export function quiet(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
