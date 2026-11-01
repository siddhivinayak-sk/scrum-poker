/**
 * Chat behind a base path (integration, real sockets on localhost):
 * R21.1–R21.6.
 *
 * `server.ts` reads `BASE_PATH` / `PRESERVE_PATH` at module load, so every
 * configuration loads a fresh copy of it through `jest.isolateModules` with
 * `PORT=0` (the precedent of `upgrade-log.spec.ts`). The real module-level
 * server, its `upgrade` routing, both WebSocketServers and the real chat
 * handlers are exercised; tokens and sessions come from the same isolated
 * module instances.
 *
 * Clients build their URL exactly like `WebSocketService` and
 * `RetroWebSocketService` do from the base path the server injects as
 * `window.__BASE_PATH__` (`PUBLIC_PATH`). A path-stripping ingress is modelled
 * by removing the prefix before the request reaches the container; a
 * path-preserving ingress forwards the URL unchanged.
 */
import { once } from 'events';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  BoardKind,
  CHAT_ACK_TIMEOUT_MS,
  CHAT_EVENTS,
  ChatHistoryPayload,
  ChatMessage,
  ChatMessageAddedPayload,
  ChatMessageSendPayload,
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  WebSocketMessage,
} from '../../../../shared/types';
import { quiet } from './ws-harness';

jest.setTimeout(30_000);

type ServerModule = typeof import('../../server');
type AuthModule = typeof import('../../services/auth-service');
type PokerRegistry = typeof import('../../services/session-registry')['sessionRegistry'];
type RetroRegistry = typeof import('../../services/retro-session-registry')['retroSessionRegistry'];
type Env = Partial<Record<'BASE_PATH' | 'PRESERVE_PATH', string>>;

/** How the ingress in front of the container treats the public prefix. */
type Ingress = 'preserve' | 'strip';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Window after the last expected delivery in which no further chat frame may arrive. */
const QUIET_MS = 300;

const RETRO_CONFIG: RetroConfiguration = {
  boardName: 'Base Path Chat Retro',
  maxVotesPerUser: 6,
  templateId: 'went-well-improve-actions',
  hideCardsInitially: false,
  disableVotingInitially: false,
  hideVoteCount: false,
  oneVotePerCard: false,
  showCardAuthor: false,
  password: null,
  enableGifEmoji: true,
  columnLayout: 'vertical',
  allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
};

const ALL_CHAT_EVENTS = new Set<string>(
  (['poker', 'retro'] as const).flatMap((k) => Object.values(CHAT_EVENTS[k]))
);

// ---------------------------------------------------------------------------
// Console: module load and every upgrade write log lines; keep them quiet.
// console.error stays live so an unexpected server error is visible.
// ---------------------------------------------------------------------------

let consoleSpies: jest.SpyInstance[] = [];

beforeAll(() => {
  consoleSpies = [
    jest.spyOn(console, 'log').mockImplementation(() => undefined),
    jest.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];
});

afterAll(() => {
  consoleSpies.forEach((s) => s.mockRestore());
});

// ---------------------------------------------------------------------------
// App lifecycle: one fresh server.ts per configuration
// ---------------------------------------------------------------------------

interface AppCtx {
  mod: ServerModule;
  auth: AuthModule;
  pokerRegistry: PokerRegistry;
  retroRegistry: RetroRegistry;
  port: number;
  /** The request URL each WebSocketServer emitted with `connection`. */
  connectedUrls: Record<BoardKind, string[]>;
  clients: TestClient[];
}

async function startApp(env: Env): Promise<AppCtx> {
  const keys = ['BASE_PATH', 'PRESERVE_PATH', 'PORT'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  delete process.env.BASE_PATH;
  delete process.env.PRESERVE_PATH;
  if (env.BASE_PATH !== undefined) process.env.BASE_PATH = env.BASE_PATH;
  if (env.PRESERVE_PATH !== undefined) process.env.PRESERVE_PATH = env.PRESERVE_PATH;
  process.env.PORT = '0';

  let mod!: ServerModule;
  let auth!: AuthModule;
  let pokerRegistry!: PokerRegistry;
  let retroRegistry!: RetroRegistry;
  try {
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      mod = require('../../server') as ServerModule;
      auth = require('../../services/auth-service') as AuthModule;
      pokerRegistry = (require('../../services/session-registry') as typeof import('../../services/session-registry'))
        .sessionRegistry;
      retroRegistry = (
        require('../../services/retro-session-registry') as typeof import('../../services/retro-session-registry')
      ).retroSessionRegistry;
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  if (!mod.server.listening) await once(mod.server, 'listening');
  const port = (mod.server.address() as AddressInfo).port;

  const connectedUrls: Record<BoardKind, string[]> = { poker: [], retro: [] };
  mod.wss.on('connection', (_ws: WebSocket, req: IncomingMessage) => connectedUrls.poker.push(req.url ?? ''));
  mod.retroWss.on('connection', (_ws: WebSocket, req: IncomingMessage) => connectedUrls.retro.push(req.url ?? ''));

  return { mod, auth, pokerRegistry, retroRegistry, port, connectedUrls, clients: [] };
}

async function stopApp(ctx: AppCtx): Promise<void> {
  for (const c of ctx.clients) {
    if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
  }
  await Promise.all(ctx.clients.map((c) => c.closed));
  ctx.mod.pokerLivenessProbe.stop();
  ctx.mod.retroLivenessProbe.stop();
  for (const s of ctx.mod.wss.clients) s.terminate();
  for (const s of ctx.mod.retroWss.clients) s.terminate();
  ctx.mod.wss.close();
  ctx.mod.retroWss.close();
  // _reset also stops the poker cleanup timer the listen callback started.
  ctx.pokerRegistry._reset();
  ctx.retroRegistry._reset();
  ctx.mod.server.closeAllConnections();
  await new Promise<void>((resolve) => ctx.mod.server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Client: the Board_Page URL, the ingress, a real `ws` socket
// ---------------------------------------------------------------------------

/**
 * The URL a Board_Page opens, built like the client services do:
 * poker `${basePath}?token=…&sessionId=…`, retro `${basePath}/retro?token=…&sessionId=…`.
 */
function boardPageUrl(kind: BoardKind, host: string, basePath: string, token: string, sessionId: string): string {
  return kind === 'retro'
    ? `ws://${host}${basePath}/retro?token=${token}&sessionId=${sessionId}`
    : `ws://${host}${basePath}?token=${token}&sessionId=${sessionId}`;
}

/** The request target that reaches the container after the ingress. */
function containerRequestPath(browserUrl: string, basePath: string, ingress: Ingress): string {
  const u = new URL(browserUrl);
  let pathname = u.pathname;
  if (ingress === 'strip' && basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    pathname = pathname.slice(basePath.length) || '/';
  }
  return `${pathname}${u.search}`;
}

interface TestClient {
  kind: BoardKind;
  ws: WebSocket;
  /** The request target sent to the container. */
  requestPath: string;
  frames: WebSocketMessage[];
  closed: Promise<void>;
  waitFor(pred: (m: WebSocketMessage) => boolean, timeoutMs?: number): Promise<WebSocketMessage>;
  chatFrames(): WebSocketMessage[];
}

async function openClient(ctx: AppCtx, kind: BoardKind, requestPath: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${requestPath}`);
  const frames: WebSocketMessage[] = [];
  const waiters = new Set<() => void>();
  ws.on('error', () => undefined);
  ws.on('message', (data: WebSocket.RawData) => {
    frames.push(JSON.parse(data.toString()) as WebSocketMessage);
    waiters.forEach((w) => w());
  });
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

  const waitFor: TestClient['waitFor'] = (pred, timeoutMs = CHAT_ACK_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const found = (): WebSocketMessage | undefined => frames.find(pred);
      const hit = found();
      if (hit) {
        resolve(hit);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for a ${kind} frame on ${requestPath.split('?')[0]}`));
      }, timeoutMs);
      const waiter = (): void => {
        const m = found();
        if (!m) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(m);
      };
      waiters.add(waiter);
    });

  const client: TestClient = {
    kind,
    ws,
    requestPath,
    frames,
    closed,
    waitFor,
    chatFrames: () => frames.filter((m) => ALL_CHAT_EVENTS.has(m.event)),
  };
  ctx.clients.push(client);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('close', (code: number) => reject(new Error(`Connection closed before open (${code})`)));
  });
  return client;
}

function historyOf(m: WebSocketMessage): ChatMessage[] {
  return (m.data as ChatHistoryPayload).messages;
}

function addedOf(m: WebSocketMessage): ChatMessage {
  return (m.data as ChatMessageAddedPayload).message;
}

function sendFrame(kind: BoardKind, payload: ChatMessageSendPayload): string {
  return JSON.stringify({ event: CHAT_EVENTS[kind].send, data: payload, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

interface Config {
  name: string;
  env: Env;
  /** `PUBLIC_PATH`, i.e. the `window.__BASE_PATH__` the client reads. */
  clientBasePath: string;
  ingress: Ingress;
}

const CONFIGS: Config[] = [
  {
    name: 'R21.1: BASE_PATH=/scrum-poker, PRESERVE_PATH=true (path-preserving ingress)',
    env: { BASE_PATH: '/scrum-poker', PRESERVE_PATH: 'true' },
    clientBasePath: '/scrum-poker',
    ingress: 'preserve',
  },
  {
    name: 'R21.1: BASE_PATH=/scrum-poker/ (trailing slash), PRESERVE_PATH=true (path-preserving ingress)',
    env: { BASE_PATH: '/scrum-poker/', PRESERVE_PATH: 'true' },
    clientBasePath: '/scrum-poker',
    ingress: 'preserve',
  },
  {
    name: 'R21.2: BASE_PATH=/scrum-poker, PRESERVE_PATH unset (path-stripping ingress)',
    env: { BASE_PATH: '/scrum-poker' },
    clientBasePath: '/scrum-poker',
    ingress: 'strip',
  },
  {
    name: 'R21.2: BASE_PATH=/scrum-poker/ (trailing slash), PRESERVE_PATH=TRUE (not the exact string "true")',
    env: { BASE_PATH: '/scrum-poker/', PRESERVE_PATH: 'TRUE' },
    clientBasePath: '/scrum-poker',
    ingress: 'strip',
  },
  {
    name: 'R21.3: BASE_PATH unset, PRESERVE_PATH unset',
    env: {},
    clientBasePath: '',
    ingress: 'preserve',
  },
  {
    name: 'R21.3: BASE_PATH empty, PRESERVE_PATH=true',
    env: { BASE_PATH: '', PRESERVE_PATH: 'true' },
    clientBasePath: '',
    ingress: 'preserve',
  },
  {
    name: 'R21.3: BASE_PATH=/, PRESERVE_PATH=true',
    env: { BASE_PATH: '/', PRESERVE_PATH: 'true' },
    clientBasePath: '',
    ingress: 'preserve',
  },
];

let nameCounter = 0;
const uniqueName = (prefix: string): string => `${prefix}${++nameCounter}`;

describe.each(CONFIGS)('chat behind a base path (integration): $name', (config) => {
  let ctx: AppCtx;

  beforeAll(async () => {
    ctx = await startApp(config.env);
  });

  afterAll(async () => {
    await stopApp(ctx);
  });

  it('delivers one message per Board_Kind to every connection, sends history on connect and keeps the buffers separate (R21.1–R21.6)', async () => {
    const host = `127.0.0.1:${ctx.port}`;
    const pathFor = (kind: BoardKind, token: string, sessionId: string): string =>
      containerRequestPath(
        boardPageUrl(kind, host, config.clientBasePath, token, sessionId),
        config.clientBasePath,
        config.ingress
      );

    const owner = ctx.auth.login(uniqueName('Owner'), false);
    const peer = ctx.auth.login(uniqueName('Peer'), false);
    const late = ctx.auth.login(uniqueName('Late'), false);
    const pokerSessionId = ctx.pokerRegistry.createSession(owner.user.id, DEFAULT_SESSION_CONFIG).sessionId;
    const retroSessionId = ctx.retroRegistry.createSession(owner.user.id, RETRO_CONFIG).sessionId;
    const pokerSession = ctx.pokerRegistry.getSession(pokerSessionId)!;
    const retroSession = ctx.retroRegistry.getSession(retroSessionId)!;
    const sessionIdOf: Record<BoardKind, string> = { poker: pokerSessionId, retro: retroSessionId };

    // Two Board_Connections per Board_Kind, opened through the configured ingress.
    const clients: Record<BoardKind, TestClient[]> = { poker: [], retro: [] };
    for (const kind of ['poker', 'retro'] as const) {
      for (const user of [owner, peer]) {
        clients[kind].push(await openClient(ctx, kind, pathFor(kind, user.token, sessionIdOf[kind])));
      }
    }

    // R21.5: each connection gets the (empty) Chat_History of its own Board_Kind on open.
    for (const kind of ['poker', 'retro'] as const) {
      for (const c of clients[kind]) {
        const history = await c.waitFor((m) => m.event === CHAT_EVENTS[kind].history);
        expect(historyOf(history)).toEqual([]);
      }
    }

    // One Chat_Message per Board_Kind: the owner chats on poker, the peer on retro.
    const sent: Record<BoardKind, ChatMessageSendPayload> = {
      poker: { sessionId: pokerSessionId, clientMessageId: randomUUID(), text: 'Poker hello behind the prefix' },
      retro: { sessionId: retroSessionId, clientMessageId: randomUUID(), text: 'Retro hello behind the prefix' },
    };
    const sender: Record<BoardKind, TestClient> = { poker: clients.poker[0], retro: clients.retro[1] };
    const senderUser: Record<BoardKind, typeof owner> = { poker: owner, retro: peer };
    sender.poker.ws.send(sendFrame('poker', sent.poker));
    sender.retro.ws.send(sendFrame('retro', sent.retro));

    // R21.1–R21.3: the added event of that Board_Kind reaches every open connection
    // of the Board_Session, the sender included (its Own_Message becomes `sent`).
    const delivered = {} as Record<BoardKind, ChatMessage>;
    for (const kind of ['poker', 'retro'] as const) {
      const isOurs = (m: WebSocketMessage): boolean =>
        m.event === CHAT_EVENTS[kind].added && addedOf(m).clientMessageId === sent[kind].clientMessageId;
      const received = await Promise.all(clients[kind].map((c) => c.waitFor(isOurs)));
      delivered[kind] = addedOf(received[0]);
      for (const r of received) expect(addedOf(r)).toEqual(delivered[kind]);
      expect(delivered[kind]).toMatchObject({
        seq: 1,
        clientMessageId: sent[kind].clientMessageId,
        authorId: senderUser[kind].user.id,
        text: sent[kind].text,
      });
    }

    // Nothing else arrives: per connection exactly [history, added] of its own Board_Kind.
    await quiet(QUIET_MS);
    for (const kind of ['poker', 'retro'] as const) {
      for (const c of clients[kind]) {
        expect(c.chatFrames().map((m) => m.event)).toEqual([CHAT_EVENTS[kind].history, CHAT_EVENTS[kind].added]);
      }
    }

    // R21.6: each Chat_Buffer holds only the message sent from its own Board_Page.
    expect(pokerSession.chat.history()).toEqual([delivered.poker]);
    expect(retroSession.chat.history()).toEqual([delivered.retro]);

    // R21.5: a connection opened later receives the Chat_History of its own Board_Kind only.
    for (const kind of ['poker', 'retro'] as const) {
      const c = await openClient(ctx, kind, pathFor(kind, late.token, sessionIdOf[kind]));
      clients[kind].push(c);
      const history = await c.waitFor((m) => m.event === CHAT_EVENTS[kind].history);
      expect(historyOf(history)).toEqual([delivered[kind]]);
    }
    await quiet(QUIET_MS);
    for (const kind of ['poker', 'retro'] as const) {
      expect(clients[kind][2].chatFrames().map((m) => m.event)).toEqual([CHAT_EVENTS[kind].history]);
    }

    // R21.4: every request reached the WebSocketServer of its Board_Kind with
    // its full, unmodified URL, and every connection is still open.
    expect(ctx.connectedUrls.poker).toEqual(clients.poker.map((c) => c.requestPath));
    expect(ctx.connectedUrls.retro).toEqual(clients.retro.map((c) => c.requestPath));
    for (const c of [...clients.poker, ...clients.retro]) {
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
    }
  });
});

// ---------------------------------------------------------------------------
// R21.4: no new configuration, unchanged Board_Page connection URLs
// ---------------------------------------------------------------------------

describe('chat needs no new configuration and keeps the connection URLs (R21.4)', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
      return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
    });
  }

  it('the server reads only the environment variables it read before the chat feature', () => {
    const names = new Set<string>();
    for (const f of sourceFiles(path.join(REPO_ROOT, 'server/src'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        names.add(m[1]);
      }
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/process\.env\s*\[/);
    }
    expect([...names].sort()).toEqual(['BASE_PATH', 'JWT_SECRET', 'PORT', 'PRESERVE_PATH']);
  });

  it('both client WebSocket services still open the URLs this test connects with', () => {
    const poker = fs.readFileSync(path.join(REPO_ROOT, 'client/src/app/services/websocket.service.ts'), 'utf8');
    const retro = fs.readFileSync(path.join(REPO_ROOT, 'client/src/app/services/retro-websocket.service.ts'), 'utf8');

    for (const src of [poker, retro]) {
      expect(src).toContain('const basePath = this.basePath.getBasePath();');
    }
    expect(poker).toContain('let url = `${protocol}//${window.location.host}${basePath}?token=${this.token}`;');
    expect(poker).toContain('url += `&sessionId=${this.sessionId}`;');
    expect(retro).toContain(
      'const url = `${protocol}//${window.location.host}${basePath}/retro?token=${this.token}&sessionId=${this.sessionId}`;'
    );
  });
});
