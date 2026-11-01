/**
 * Upgrade_Log_Line tests (R22.10, R23.1–R23.3).
 *
 * Each BASE_PATH / PRESERVE_PATH combination loads a fresh copy of `server.ts`
 * (via `jest.isolateModules`) listening on an ephemeral port, so the real
 * `upgrade` wiring, the real poker / retro WebSocketServers and the real
 * connection handlers are exercised with real `ws` clients. Every request
 * carries a `token` query parameter holding a sample JWT (valid, invalid,
 * expired) or none at all (missing); all but the valid one are closed by the
 * handler with code 4001.
 */
import { once } from 'events';
import type { IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { Duplex } from 'stream';
import { format } from 'util';
import jwt from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import { DEFAULT_SESSION_CONFIG, RetroConfiguration } from '../../../shared/types';

type ServerModule = typeof import('../server');
type AuthModule = typeof import('../services/auth-service');
type PokerRegistry = typeof import('../services/session-registry')['sessionRegistry'];
type RetroRegistry = typeof import('../services/retro-session-registry')['retroSessionRegistry'];
type Target = 'poker' | 'retro';
type TokenKind = 'valid' | 'invalid' | 'expired' | 'missing';

const UPGRADE_PREFIX = 'WebSocket upgrade request: ';
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const TOKEN_KINDS: TokenKind[] = ['valid', 'invalid', 'expired', 'missing'];

const RETRO_CONFIG: RetroConfiguration = {
  boardName: 'Upgrade Log Retro',
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

// --- Console capture (every console method) ---

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const captured: string[] = [];
const consoleSpies: jest.SpyInstance[] = [];

beforeAll(() => {
  for (const m of CONSOLE_METHODS) {
    consoleSpies.push(
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        captured.push(format(...args));
      }),
    );
  }
});

afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

// --- App lifecycle ---

interface AppCtx {
  mod: ServerModule;
  auth: AuthModule;
  pokerRegistry: PokerRegistry;
  retroRegistry: RetroRegistry;
  port: number;
  /** The request objects the HTTP server handed to its `upgrade` listeners. */
  upgradeRequests: IncomingMessage[];
  /** The request objects each WebSocketServer emitted with `connection`. */
  connected: Record<Target, IncomingMessage[]>;
  handleUpgrade: Record<Target, jest.SpyInstance>;
  clients: Set<WebSocket>;
}

type Env = Partial<Record<'BASE_PATH' | 'PRESERVE_PATH', string>>;

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
      mod = require('../server') as ServerModule;
      auth = require('../services/auth-service') as AuthModule;
      pokerRegistry = (require('../services/session-registry') as typeof import('../services/session-registry')).sessionRegistry;
      retroRegistry = (require('../services/retro-session-registry') as typeof import('../services/retro-session-registry')).retroSessionRegistry;
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  if (!mod.server.listening) await once(mod.server, 'listening');
  const port = (mod.server.address() as AddressInfo).port;

  const ctx: AppCtx = {
    mod,
    auth,
    pokerRegistry,
    retroRegistry,
    port,
    upgradeRequests: [],
    connected: { poker: [], retro: [] },
    handleUpgrade: {
      poker: jest.spyOn(mod.wss, 'handleUpgrade'),
      retro: jest.spyOn(mod.retroWss, 'handleUpgrade'),
    },
    clients: new Set(),
  };
  mod.server.prependListener('upgrade', (req: IncomingMessage) => {
    ctx.upgradeRequests.push(req);
  });
  mod.wss.on('connection', (_ws: WebSocket, req: IncomingMessage) => {
    ctx.connected.poker.push(req);
  });
  mod.retroWss.on('connection', (_ws: WebSocket, req: IncomingMessage) => {
    ctx.connected.retro.push(req);
  });
  return ctx;
}

async function stopApp(ctx: AppCtx): Promise<void> {
  for (const c of ctx.clients) c.terminate();
  ctx.handleUpgrade.poker.mockRestore();
  ctx.handleUpgrade.retro.mockRestore();
  ctx.mod.pokerLivenessProbe.stop();
  ctx.mod.retroLivenessProbe.stop();
  for (const c of ctx.mod.wss.clients) c.terminate();
  for (const c of ctx.mod.retroWss.clients) c.terminate();
  ctx.mod.wss.close();
  ctx.mod.retroWss.close();
  ctx.pokerRegistry._reset();
  ctx.retroRegistry._reset();
  ctx.mod.server.closeAllConnections();
  await new Promise<void>((resolve) => ctx.mod.server.close(() => resolve()));
}

function resetRecorders(ctx: AppCtx): void {
  captured.length = 0;
  ctx.upgradeRequests.length = 0;
  ctx.connected.poker.length = 0;
  ctx.connected.retro.length = 0;
  ctx.handleUpgrade.poker.mockClear();
  ctx.handleUpgrade.retro.mockClear();
}

// --- Tokens ---

let nameCounter = 0;

function makeToken(ctx: AppCtx, kind: TokenKind): string | undefined {
  nameCounter += 1;
  const name = `UpgradeUser${nameCounter}`;
  switch (kind) {
    case 'valid':
      return ctx.auth.login(name, false).token;
    case 'invalid':
      // JWT-shaped, but signed with a secret the server does not know.
      return jwt.sign(
        { userId: `forged-${nameCounter}`, displayName: name, role: 'participant', isAnonymous: false },
        'not-the-server-secret',
        { expiresIn: '1h' },
      );
    case 'expired': {
      // A real login whose 24h expiry already lies in the past: issue it 25h ago.
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now - 25 * 60 * 60 * 1000);
      let token: string;
      try {
        token = ctx.auth.login(name, false).token;
      } finally {
        spy.mockRestore();
      }
      const decoded = jwt.decode(token) as { exp: number };
      expect(decoded.exp * 1000).toBeLessThan(now);
      return token;
    }
    case 'missing':
      return undefined;
  }
}

// --- Client ---

type Outcome = { opened: boolean; closeCode: number };

function connect(ctx: AppCtx, url: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${url}`);
    ctx.clients.add(ws);
    let opened = false;
    ws.on('message', () => {
      // The handler accepted the connection and sent its first state frame.
      if (!opened) {
        opened = true;
        ws.close(1000);
      }
    });
    ws.on('close', (code: number) => {
      ctx.clients.delete(ws);
      resolve({ opened, closeCode: code });
    });
    ws.on('error', reject);
  });
}

// --- Assertions shared by every request ---

function expectNoSecretsInConsole(tokens: string[]): void {
  const output = captured.join('\n');
  expect(output).not.toMatch(JWT_PATTERN);
  expect(output).not.toContain('token=');
  expect(output).not.toContain('?');
  for (const t of tokens) expect(output).not.toContain(t);
}

// --- Matrix ---

interface Route {
  /** The request path before the query string (what the log line must hold). */
  path: string;
  /** The WebSocketServer the pre-feature routing rule sends the path to. */
  target: Target;
}

interface Combo {
  name: string;
  env: Env;
  routes: Route[];
}

const COMBOS: Combo[] = [
  {
    name: 'BASE_PATH unset, PRESERVE_PATH unset',
    env: {},
    routes: [
      { path: '/', target: 'poker' },
      { path: '/retro', target: 'retro' },
    ],
  },
  {
    name: 'BASE_PATH=/scrum-poker, PRESERVE_PATH unset (path-stripping ingress)',
    env: { BASE_PATH: '/scrum-poker' },
    routes: [
      { path: '/', target: 'poker' },
      { path: '/retro', target: 'retro' },
      // Without PRESERVE_PATH the prefix is never stripped, so this stays poker.
      { path: '/scrum-poker/retro', target: 'poker' },
    ],
  },
  {
    name: 'BASE_PATH=/scrum-poker/, PRESERVE_PATH=true (path-preserving ingress)',
    env: { BASE_PATH: '/scrum-poker/', PRESERVE_PATH: 'true' },
    routes: [
      { path: '/scrum-poker', target: 'poker' },
      { path: '/scrum-poker/retro', target: 'retro' },
      { path: '/retro', target: 'retro' },
      { path: '/', target: 'poker' },
    ],
  },
  {
    name: 'BASE_PATH unset, PRESERVE_PATH=true',
    env: { PRESERVE_PATH: 'true' },
    routes: [
      { path: '/', target: 'poker' },
      { path: '/retro', target: 'retro' },
    ],
  },
];

describe.each(COMBOS)('Upgrade_Log_Line with $name', ({ env, routes }) => {
  let ctx: AppCtx;
  let sessionIds: Record<Target, string>;

  beforeAll(async () => {
    ctx = await startApp(env);
    sessionIds = {
      poker: ctx.pokerRegistry.createSession('upgrade-log-owner', DEFAULT_SESSION_CONFIG).sessionId,
      retro: ctx.retroRegistry.createSession('upgrade-log-owner', RETRO_CONFIG).sessionId,
    };
  });

  afterAll(async () => {
    await stopApp(ctx);
  });

  const cases = routes.flatMap((r) => TOKEN_KINDS.map((kind) => ({ ...r, kind })));

  test.each(cases)('$path with a $kind token → $target', async ({ path, target, kind }) => {
    const token = makeToken(ctx, kind);
    resetRecorders(ctx);

    const sessionId = sessionIds[target];
    const query = token === undefined ? `sessionId=${sessionId}` : `token=${token}&sessionId=${sessionId}`;
    const url = `${path}?${query}`;

    const outcome = await connect(ctx, url);

    // The handler outcome: only the valid token is admitted; the rest get 4001.
    if (kind === 'valid') {
      expect(outcome.opened).toBe(true);
    } else {
      expect(outcome).toEqual({ opened: false, closeCode: 4001 });
    }

    // Exactly one Upgrade_Log_Line, holding only the part before '?' (R23.1).
    const upgradeLines = captured.filter((l) => l.startsWith(UPGRADE_PREFIX));
    expect(upgradeLines).toEqual([`${UPGRADE_PREFIX}${path}`]);
    expect(upgradeLines[0]).not.toContain(sessionId);

    // No JWT, no `token=` and no '?' anywhere in the console output (R23.1, R23.2).
    expectNoSecretsInConsole(token === undefined ? [] : [token]);

    // Same WebSocketServer as before, with the same request object and its
    // full, unmodified URL, query string included (R23.3).
    expect(ctx.upgradeRequests).toHaveLength(1);
    const request = ctx.upgradeRequests[0];
    expect(request.url).toBe(url);

    const other: Target = target === 'poker' ? 'retro' : 'poker';
    expect(ctx.handleUpgrade[target]).toHaveBeenCalledTimes(1);
    expect(ctx.handleUpgrade[target].mock.calls[0][0]).toBe(request);
    expect(ctx.handleUpgrade[other]).not.toHaveBeenCalled();
    expect(ctx.connected[target]).toHaveLength(1);
    expect(ctx.connected[target][0]).toBe(request);
    expect(ctx.connected[target][0].url).toBe(url);
    expect(ctx.connected[other]).toHaveLength(0);
  });
});

describe('redactUpgradeUrl and the handler without a request URL', () => {
  let ctx: AppCtx;

  beforeAll(async () => {
    ctx = await startApp({});
  });

  afterAll(async () => {
    await stopApp(ctx);
  });

  it.each([
    ['/retro?token=eyJa.eyJb.c&sessionId=abc', '/retro'],
    ['/?token=abc', '/'],
    ['/scrum-poker/retro', '/scrum-poker/retro'],
    ['/a?b?c', '/a'],
    ['?token=abc', ''],
    ['', ''],
  ])('redactUpgradeUrl(%j) === %j', (url, expected) => {
    expect(ctx.mod.redactUpgradeUrl(url)).toBe(expected);
  });

  it('returns the empty string for a request with no URL', () => {
    expect(ctx.mod.redactUpgradeUrl(undefined)).toBe('');
  });

  it('writes one line with the empty string and routes to poker when the request has no URL', () => {
    const received: Record<Target, IncomingMessage[]> = { poker: [], retro: [] };
    const stub = (kind: Target): WebSocketServer =>
      ({
        handleUpgrade: (req: IncomingMessage) => {
          received[kind].push(req);
        },
        emit: () => true,
      }) as unknown as WebSocketServer;
    const lines: string[] = [];
    const handler = ctx.mod.createUpgradeHandler({
      publicPath: '/scrum-poker',
      preservePath: true,
      pokerWss: stub('poker'),
      retroWss: stub('retro'),
      log: (line) => lines.push(line),
    });

    const request = { headers: {} } as IncomingMessage;
    handler(request, new Duplex(), Buffer.alloc(0));

    expect(lines).toEqual([UPGRADE_PREFIX]);
    expect(received.poker).toEqual([request]);
    expect(received.poker[0]).toBe(request);
    expect(received.retro).toHaveLength(0);
  });
});
