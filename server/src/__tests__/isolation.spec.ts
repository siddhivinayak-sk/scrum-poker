import fs from 'fs';
import path from 'path';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';
import fc from 'fast-check';

import { authRouter } from '../routes/auth';
import { sessionsRouter } from '../routes/sessions';
import { retroRouter } from '../routes/retro-routes';
import { handleWebSocket, _reset as resetPokerHandler } from '../websocket/handler';
import {
  handleRetroWebSocket,
  _resetRetroHandler,
} from '../websocket/retro-handler';
import * as authService from '../services/auth-service';
import { sessionRegistry } from '../services/session-registry';
import { retroSessionRegistry } from '../services/retro-session-registry';
import * as sharedTypes from '../../../shared/types';
import {
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  User,
  WebSocketMessage,
} from '../../../shared/types';

/**
 * Property 28 — "Pre-existing names and routes survive".
 *
 * This is the no-regression net for the poker-retro-ux-improvements feature. It
 * holds a *frozen inventory* of everything the system exposed before the
 * feature — every WebSocket event name both handlers accepted, every REST route
 * with its path, method and status code, every field of the two full-state
 * payloads, and every `shared/types` export — and asserts the current code still
 * honours all of it. It then asserts the reverse direction: the names this
 * feature adds are genuinely new, and the retro half of the server still holds
 * no import reference to the poker half.
 *
 * The inventory is written out by hand rather than derived from the code, which
 * is the whole point: a baseline derived from the implementation would move with
 * it and could never fail.
 *
 * Units exercised: both WebSocket handlers, the three route tables (through
 * supertest), the `shared/types` module namespace, and static import scanning of
 * the retro modules.
 *
 * **Validates: Requirements 13.1, 13.2, 13.3, 13.5, 13.6, 13.9**
 */

// ---------------------------------------------------------------------------
// The frozen pre-change inventory
// ---------------------------------------------------------------------------

/** Client-to-server event names the poker handler accepted before this feature. */
const PRE_EXISTING_POKER_EVENTS = [
  'story:submit',
  'card:select',
  'cards:reveal',
  'board:clear',
  'role:change',
  'history:clear',
  'participant:remove',
  'round:revote',
  'issue:add',
  'issue:remove',
  'issue:reorder',
  'issue:select',
] as const;

/** Client-to-server event names the retro handler accepted before this feature. */
const PRE_EXISTING_RETRO_EVENTS = [
  'retro:card:add',
  'retro:card:edit',
  'retro:card:remove',
  'retro:card:move',
  'retro:card:merge',
  'retro:card:vote',
  'retro:card:unvote',
  'retro:comment:add',
  'retro:comment:remove',
  'retro:column:add',
  'retro:column:remove',
  'retro:column:reorder',
  'retro:column:rename',
  'retro:context:update',
  'retro:cards:reveal',
  'retro:voting:enable',
  'retro:board:complete',
  'retro:config:update',
  'retro:feeling:select',
  'role:change',
] as const;

/**
 * Every WebSocket event name this feature adds. R13.3 requires each to differ
 * from every pre-existing name, which the disjointness test below checks.
 */
const ADDED_WS_EVENTS = ['retro:session:ended'] as const;

/** Top-level fields of the `session:state` payload sent on poker connect. */
const PRE_EXISTING_POKER_STATE_FIELDS = [
  'sessionId',
  'config',
  'ownerId',
  'createdAt',
  'issueList',
  'currentRound',
  'participants',
  'history',
  'isRevealed',
] as const;

/** Top-level fields of the `retro:session:state` payload sent on retro connect. */
const PRE_EXISTING_RETRO_STATE_FIELDS = [
  'sessionId',
  'config',
  'board',
  'participants',
  'ownerId',
  'createdAt',
  'votesRemaining',
  'feelings',
] as const;

/** Fields of the WebSocket message envelope. */
const ENVELOPE_FIELDS = ['event', 'data', 'timestamp'] as const;

/**
 * One entry of the frozen route table: the method and path as registered, a
 * canonical request that needs no fixture, and the status that request answered
 * with before this feature.
 *
 * The status is part of the baseline on purpose — it pins R13.6 as well as
 * R13.5, and it is what makes "the route still resolves" observable: an
 * unregistered path falls through to the sentinel below instead.
 */
interface RouteEntry {
  readonly method: 'get' | 'post' | 'put' | 'delete';
  /** The path as registered, for failure messages. */
  readonly registered: string;
  /** A concrete request path. */
  readonly url: string;
  /** Request body, for the methods that read one. */
  readonly body?: Record<string, unknown>;
  readonly expectedStatus: number;
  /** When set, the `error` field the response body must still carry. */
  readonly expectedError?: string;
}

/**
 * Status code reserved for "no route matched". It is not a code any handler
 * returns, so a route that disappeared is unambiguous rather than being mistaken
 * for a handler's own 404.
 */
const ROUTE_NOT_REGISTERED = 599;

/** A session id no registry holds, so every lookup misses deterministically. */
const ABSENT_ID = 'absent-session-id';

const PRE_EXISTING_ROUTES: readonly RouteEntry[] = [
  // --- health -------------------------------------------------------------
  { method: 'get', registered: 'GET /api/health', url: '/api/health', expectedStatus: 200 },

  // --- auth ---------------------------------------------------------------
  {
    method: 'post',
    registered: 'POST /api/auth/login',
    url: '/api/auth/login',
    body: {},
    expectedStatus: 400,
    expectedError: 'USERNAME_REQUIRED',
  },
  {
    method: 'get',
    registered: 'GET /api/auth/validate',
    url: '/api/auth/validate',
    expectedStatus: 401,
    expectedError: 'TOKEN_REQUIRED',
  },
  {
    method: 'post',
    registered: 'POST /api/auth/logout',
    url: '/api/auth/logout',
    body: {},
    expectedStatus: 401,
    expectedError: 'TOKEN_REQUIRED',
  },

  // --- poker sessions -----------------------------------------------------
  {
    method: 'post',
    registered: 'POST /api/sessions',
    url: '/api/sessions',
    body: {},
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'get',
    registered: 'GET /api/sessions/mine',
    url: '/api/sessions/mine',
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'get',
    registered: 'GET /api/sessions/:sessionId/exists',
    url: `/api/sessions/${ABSENT_ID}/exists`,
    expectedStatus: 200,
  },
  {
    method: 'get',
    registered: 'GET /api/sessions/:sessionId',
    url: `/api/sessions/${ABSENT_ID}`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'put',
    registered: 'PUT /api/sessions/:sessionId/config',
    url: `/api/sessions/${ABSENT_ID}/config`,
    body: {},
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'delete',
    registered: 'DELETE /api/sessions/:sessionId',
    url: `/api/sessions/${ABSENT_ID}`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },

  // --- retro sessions -----------------------------------------------------
  {
    method: 'post',
    registered: 'POST /api/retro/sessions',
    url: '/api/retro/sessions',
    body: {},
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'get',
    registered: 'GET /api/retro/sessions/:sessionId/exists',
    url: `/api/retro/sessions/${ABSENT_ID}/exists`,
    expectedStatus: 200,
  },
  {
    method: 'post',
    registered: 'POST /api/retro/sessions/:sessionId/verify-password',
    url: `/api/retro/sessions/${ABSENT_ID}/verify-password`,
    body: {},
    expectedStatus: 404,
    expectedError: 'SESSION_NOT_FOUND',
  },
  {
    method: 'get',
    registered: 'GET /api/retro/sessions/:sessionId/export',
    url: `/api/retro/sessions/${ABSENT_ID}/export`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'post',
    registered: 'POST /api/retro/sessions/:sessionId/import',
    url: `/api/retro/sessions/${ABSENT_ID}/import`,
    body: {},
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'get',
    registered: 'GET /api/retro/sessions/:sessionId',
    url: `/api/retro/sessions/${ABSENT_ID}`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
];

/** The three routes this feature adds, all at paths no route served before. */
const ADDED_ROUTES: readonly RouteEntry[] = [
  {
    method: 'get',
    registered: 'GET /api/sessions/:sessionId/export',
    url: `/api/sessions/${ABSENT_ID}/export`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'get',
    registered: 'GET /api/retro/sessions/mine',
    url: '/api/retro/sessions/mine',
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
  {
    method: 'delete',
    registered: 'DELETE /api/retro/sessions/:sessionId',
    url: `/api/retro/sessions/${ABSENT_ID}`,
    expectedStatus: 401,
    expectedError: 'UNAUTHORIZED',
  },
];

/** Every name `shared/types` exported at runtime before this feature. */
const PRE_EXISTING_SHARED_EXPORTS = [
  'FIBONACCI_SEQUENCE',
  'SPECIAL_CARDS',
  'ALL_CARDS',
  'VOTING_SYSTEMS',
  'DEFAULT_SESSION_CONFIG',
  'ALL_FEELING_CATEGORIES',
  'FEELING_EMOJI_MAP',
  'DEFAULT_ALLOWED_FEELINGS',
  'RETRO_FEELING_SELECT',
  'RETRO_FEELING_UPDATED',
  'getCardsForVotingSystem',
  'hasPermission',
  'formatDuration',
  'computeConsensusLevel',
] as const;

/** Every runtime name this feature adds to `shared/types`. */
const ADDED_SHARED_EXPORTS = [
  'resolveFluidCardHeight',
  'RETRO_SESSION_ENDED',
  'CONNECTION_LABEL',
] as const;

// ---------------------------------------------------------------------------
// Module inventory for the isolation scan (R13.9)
// ---------------------------------------------------------------------------

const SERVER_SRC = path.resolve(__dirname, '..');

/**
 * The retro half of the server: the registry, the session, the templates, the
 * WebSocket handler and the route table that carries the two new endpoints.
 */
const RETRO_MODULES = [
  'services/retro-session-registry.ts',
  'services/retro-session.ts',
  'services/retro-templates.ts',
  'websocket/retro-handler.ts',
  'routes/retro-routes.ts',
] as const;

/** The poker half. No retro module may name any of these. */
const POKER_MODULES = [
  'session-registry',
  'session-manager',
  'game-session',
  'metrics-engine',
  'websocket/handler',
  'routes/sessions',
] as const;

/** `liveness.ts` is shared by both servers, so it may name neither half. */
const NEUTRAL_MODULE = 'websocket/liveness.ts';

function readServerModule(relative: string): string {
  return fs.readFileSync(path.join(SERVER_SRC, relative), 'utf-8');
}

/**
 * Every module specifier a file imports or re-exports, including the multi-line
 * named form the retro handler uses for `shared/types`.
 */
export function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const fromClause = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareImport = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const pattern of [fromClause, bareImport, dynamicImport, requireCall]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Does `specifier` name `pokerModule`? Compared on the specifier's path tail so
 * `./session-registry`, `../services/session-registry` and
 * `../websocket/handler` all match, while `retro-session-registry` — a different
 * final segment — does not.
 */
function namesPokerModule(specifier: string, pokerModule: string): boolean {
  const normalised = specifier.replace(/\.ts$/, '');
  if (normalised === pokerModule || normalised.endsWith(`/${pokerModule}`)) {
    return true;
  }
  // Single-segment entries such as `game-session` also match a bare relative
  // import inside the same directory (`./game-session`).
  return normalised === `./${pokerModule}`;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type MockWs = WebSocket & {
  sentMessages: string[];
  closedWith?: { code: number; reason: string };
};

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
  });
  mock.close = jest.fn((code?: number, reason?: string) => {
    mock.closedWith = { code: code ?? 1000, reason: reason ?? '' };
    mock.readyState = WebSocket.CLOSED;
  });
  return mock as MockWs;
}

function createRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost:3000' } } as unknown as IncomingMessage;
}

function clientFrame(event: string): Buffer {
  return Buffer.from(
    JSON.stringify({ event, data: {}, timestamp: new Date().toISOString() })
  );
}

function parsedMessages(ws: MockWs): WebSocketMessage[] {
  return ws.sentMessages.map((raw) => JSON.parse(raw) as WebSocketMessage);
}

/** Error codes carried by `error` / `retro:error` frames the socket received. */
function errorCodes(ws: MockWs): string[] {
  return parsedMessages(ws)
    .filter((msg) => msg.event === 'error' || msg.event === 'retro:error')
    .map((msg) => msg.data?.code as string);
}

const moderator: User = {
  id: 'mod-1',
  displayName: 'Moderator',
  role: 'moderator',
  isAnonymous: false,
};

const retroConfig: RetroConfiguration = {
  boardName: 'No-regression board',
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

/**
 * The app under test: the three routers mounted exactly as `server.ts` mounts
 * them, plus a sentinel so an unmatched path is distinguishable from a
 * handler's own 404.
 */
function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/retro', retroRouter);
  app.use((_req, res) => {
    res.status(ROUTE_NOT_REGISTERED).json({ error: 'ROUTE_NOT_REGISTERED' });
  });
  return app;
}

function send(app: express.Express, entry: RouteEntry) {
  const agent = request(app)[entry.method](entry.url);
  return entry.body === undefined ? agent : agent.send(entry.body);
}

// ---------------------------------------------------------------------------
// Property 28 (a) — pre-existing poker event names still route
//
// Feature: poker-retro-ux-improvements, Property 28: For any WebSocket event
// name accepted before this feature, both handlers still route it without an
// UNKNOWN_EVENT error.
// ---------------------------------------------------------------------------

describe('R13.1: pre-existing WebSocket event names still route', () => {
  beforeEach(() => {
    resetPokerHandler();
    _resetRetroHandler();
    sessionRegistry._reset();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    resetPokerHandler();
    _resetRetroHandler();
    sessionRegistry._reset();
    retroSessionRegistry._reset();
  });

  it('R13.1: the poker handler answers no pre-existing event with UNKNOWN_EVENT', () => {
    fc.assert(
      fc.property(
        // `size: 'max'` — without it fast-check's default sizing caps the array
        // at 10 and the longest sequences would never be drawn.
        fc.array(fc.constantFrom(...PRE_EXISTING_POKER_EVENTS), {
          minLength: 1,
          maxLength: PRE_EXISTING_POKER_EVENTS.length,
          size: 'max',
        }),
        (events) => {
          resetPokerHandler();
          sessionRegistry._reset();
          const { sessionId } = sessionRegistry.createSession(
            moderator.id,
            DEFAULT_SESSION_CONFIG
          );

          jest.spyOn(authService, 'validateToken').mockReturnValue(moderator);
          const ws = createMockWs();
          handleWebSocket(ws, createRequest(`/?token=t&sessionId=${sessionId}`));

          for (const event of events) {
            ws.emit('message', clientFrame(event));
          }

          // Routing is what is asserted, not the outcome: an event sent with an
          // empty payload legitimately answers EMPTY_STORY, INVALID_CARD and so
          // on. UNKNOWN_EVENT is the one answer that means the name was dropped.
          expect(errorCodes(ws)).not.toContain('UNKNOWN_EVENT');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('R13.1: the retro handler answers no pre-existing event with UNKNOWN_EVENT', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...PRE_EXISTING_RETRO_EVENTS), {
          minLength: 1,
          maxLength: PRE_EXISTING_RETRO_EVENTS.length,
          size: 'max',
        }),
        (events) => {
          _resetRetroHandler();
          retroSessionRegistry._reset();
          const { sessionId } = retroSessionRegistry.createSession(
            moderator.id,
            retroConfig
          );

          jest.spyOn(authService, 'validateToken').mockReturnValue(moderator);
          const ws = createMockWs();
          handleRetroWebSocket(
            ws,
            createRequest(`/retro?token=t&sessionId=${sessionId}`)
          );

          for (const event of events) {
            ws.emit('message', clientFrame(event));
          }

          expect(errorCodes(ws)).not.toContain('UNKNOWN_EVENT');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('R13.2: the poker full-state payload still carries every pre-existing field', () => {
    const { sessionId } = sessionRegistry.createSession(
      moderator.id,
      DEFAULT_SESSION_CONFIG
    );
    jest.spyOn(authService, 'validateToken').mockReturnValue(moderator);
    const ws = createMockWs();
    handleWebSocket(ws, createRequest(`/?token=t&sessionId=${sessionId}`));

    const envelope = parsedMessages(ws).find((msg) => msg.event === 'session:state');
    expect(envelope).toBeDefined();
    expect(Object.keys(envelope!)).toEqual(expect.arrayContaining([...ENVELOPE_FIELDS]));
    expect(Object.keys(envelope!.data.state)).toEqual(
      expect.arrayContaining([...PRE_EXISTING_POKER_STATE_FIELDS])
    );
  });

  it('R13.2: the retro full-state payload still carries every pre-existing field', () => {
    const { sessionId } = retroSessionRegistry.createSession(moderator.id, retroConfig);
    jest.spyOn(authService, 'validateToken').mockReturnValue(moderator);
    const ws = createMockWs();
    handleRetroWebSocket(ws, createRequest(`/retro?token=t&sessionId=${sessionId}`));

    const envelope = parsedMessages(ws).find(
      (msg) => msg.event === 'retro:session:state'
    );
    expect(envelope).toBeDefined();
    expect(Object.keys(envelope!)).toEqual(expect.arrayContaining([...ENVELOPE_FIELDS]));
    expect(Object.keys(envelope!.data.state)).toEqual(
      expect.arrayContaining([...PRE_EXISTING_RETRO_STATE_FIELDS])
    );
  });

  it('R13.1: the UNKNOWN_EVENT detector is not vacuous — both handlers still reject a name neither accepts', () => {
    // Without this, a routing table that answered *nothing* would satisfy the two
    // properties above: they only assert the absence of UNKNOWN_EVENT.
    const pokerSession = sessionRegistry.createSession(moderator.id, DEFAULT_SESSION_CONFIG);
    jest.spyOn(authService, 'validateToken').mockReturnValue(moderator);
    const pokerWs = createMockWs();
    handleWebSocket(
      pokerWs,
      createRequest(`/?token=t&sessionId=${pokerSession.sessionId}`)
    );
    pokerWs.emit('message', clientFrame('definitely:not:an:event'));
    expect(errorCodes(pokerWs)).toContain('UNKNOWN_EVENT');

    const retroSession = retroSessionRegistry.createSession(moderator.id, retroConfig);
    const retroWs = createMockWs();
    handleRetroWebSocket(
      retroWs,
      createRequest(`/retro?token=t&sessionId=${retroSession.sessionId}`)
    );
    retroWs.emit('message', clientFrame('definitely:not:an:event'));
    expect(errorCodes(retroWs)).toContain('UNKNOWN_EVENT');

    // `retro:session:ended` is server-to-client only, so the retro handler has no
    // inbound case for it — which is also how R13.3's "name absent before" reads
    // from the handler's side.
    const endedWs = createMockWs();
    handleRetroWebSocket(
      endedWs,
      createRequest(`/retro?token=t&sessionId=${retroSession.sessionId}`)
    );
    endedWs.emit('message', clientFrame(sharedTypes.RETRO_SESSION_ENDED));
    expect(errorCodes(endedWs)).toContain('UNKNOWN_EVENT');
  });

  it('R13.3: every added event name differs from every pre-existing one', () => {
    const preExisting = new Set<string>([
      ...PRE_EXISTING_POKER_EVENTS,
      ...PRE_EXISTING_RETRO_EVENTS,
    ]);
    for (const added of ADDED_WS_EVENTS) {
      expect(preExisting.has(added)).toBe(false);
    }
    expect([...ADDED_WS_EVENTS]).toContain(sharedTypes.RETRO_SESSION_ENDED);
  });
});

// ---------------------------------------------------------------------------
// Property 28 (b) — pre-existing routes still resolve
//
// Feature: poker-retro-ux-improvements, Property 28: For any REST route served
// before this feature, the route still resolves at its path and method and
// answers with the status code it answered with before.
// ---------------------------------------------------------------------------

describe('R13.5/R13.6: pre-existing REST routes still resolve', () => {
  let app: express.Express;

  beforeEach(() => {
    sessionRegistry._reset();
    retroSessionRegistry._reset();
    authService._resetStore();
    app = createApp();
  });

  afterEach(() => {
    sessionRegistry._reset();
    retroSessionRegistry._reset();
    authService._resetStore();
  });

  it('R13.5/R13.6: every pre-existing route resolves at its path and method with its existing status', async () => {
    // Enumerating the frozen route table directly: `fc.constantFrom` over 16
    // entries with numRuns 100 would re-draw the same rows many times over and
    // leave coverage to chance, so each row is exercised exactly once.
    for (const entry of PRE_EXISTING_ROUTES) {
      const response = await send(app, entry);

      expect({ route: entry.registered, status: response.status }).toEqual({
        route: entry.registered,
        status: entry.expectedStatus,
      });
      if (entry.expectedError !== undefined) {
        expect({ route: entry.registered, error: response.body?.error }).toEqual({
          route: entry.registered,
          error: entry.expectedError,
        });
      }
    }
  });

  it('R13.5: no pre-existing route falls through to the unmatched-path sentinel', async () => {
    for (const entry of PRE_EXISTING_ROUTES) {
      const response = await send(app, entry);
      expect({ route: entry.registered, status: response.status }).not.toEqual({
        route: entry.registered,
        status: ROUTE_NOT_REGISTERED,
      });
    }
  });

  it('R13.5: the three added routes resolve without shadowing their pre-existing siblings', async () => {
    for (const entry of ADDED_ROUTES) {
      const response = await send(app, entry);
      expect({ route: entry.registered, status: response.status }).toEqual({
        route: entry.registered,
        status: entry.expectedStatus,
      });
    }

    // `GET /api/retro/sessions/mine` is registered ahead of
    // `GET /api/retro/sessions/:sessionId`; the literal must not swallow the
    // parameterised route, and the parameterised route must not swallow `mine`.
    const exists = await request(app).get(`/api/retro/sessions/${ABSENT_ID}/exists`);
    expect(exists.status).toBe(200);
    expect(exists.body).toEqual({ exists: false });

    const mine = await request(app).get('/api/retro/sessions/mine');
    expect(mine.status).toBe(401);

    // Likewise `GET /api/sessions/:sessionId/export` sits ahead of
    // `GET /api/sessions/:sessionId`, whose unauthenticated answer is unchanged.
    const pokerSession = await request(app).get(`/api/sessions/${ABSENT_ID}`);
    expect(pokerSession.status).toBe(401);

    const pokerExists = await request(app).get(`/api/sessions/${ABSENT_ID}/exists`);
    expect(pokerExists.status).toBe(200);
    expect(pokerExists.body).toEqual({ exists: false });
  });

  it('R13.6: an authenticated pre-existing route still answers with its existing response fields', async () => {
    const { token, user } = authService.login('Owner', false);
    const created = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: DEFAULT_SESSION_CONFIG });

    expect(created.status).toBe(201);
    expect(Object.keys(created.body)).toEqual(
      expect.arrayContaining(['sessionId', 'config', 'createdAt'])
    );

    const info = await request(app)
      .get(`/api/sessions/${created.body.sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(info.status).toBe(200);
    expect(Object.keys(info.body)).toEqual(
      expect.arrayContaining([
        'sessionId',
        'config',
        'participantCount',
        'createdAt',
        'ownerId',
      ])
    );
    expect(info.body.ownerId).toBe(user.id);
  });
});

// ---------------------------------------------------------------------------
// Property 28 (c) — the retro half imports no poker module
//
// Feature: poker-retro-ux-improvements, Property 28: For any retro module file,
// its import specifiers reference no poker module.
// ---------------------------------------------------------------------------

describe('R13.9: retro and poker concerns stay isolated', () => {
  it('R13.9: no retro module names a poker module in any import specifier', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RETRO_MODULES),
        fc.constantFrom(...POKER_MODULES),
        (retroModule, pokerModule) => {
          const specifiers = importSpecifiersOf(readServerModule(retroModule));
          const offending = specifiers.filter((specifier) =>
            namesPokerModule(specifier, pokerModule)
          );
          expect({ retroModule, pokerModule, offending }).toEqual({
            retroModule,
            pokerModule,
            offending: [],
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('R13.9: the shared liveness probe names neither the retro nor the poker half', () => {
    const specifiers = importSpecifiersOf(readServerModule(NEUTRAL_MODULE));
    for (const specifier of specifiers) {
      for (const pokerModule of POKER_MODULES) {
        expect(namesPokerModule(specifier, pokerModule)).toBe(false);
      }
      expect(specifier).not.toMatch(/retro/);
    }
  });

  it('R13.9: the import scanner sees the specifiers it is asked to police', () => {
    // A guard on the scanner itself: a regex that silently matched nothing would
    // make the property above vacuously true. The retro handler's `shared/types`
    // import spans several lines, which is the case most at risk.
    const specifiers = importSpecifiersOf(readServerModule('websocket/retro-handler.ts'));
    expect(specifiers).toEqual(
      expect.arrayContaining([
        'ws',
        '../services/auth-service',
        '../services/retro-session-registry',
        '../services/retro-session',
        '../../../shared/types',
      ])
    );

    // And it does flag a poker specifier when one is present: the poker route
    // table imports the poker handler, so scanning it must not come back empty.
    const pokerRouteSpecifiers = importSpecifiersOf(readServerModule('routes/sessions.ts'));
    expect(
      pokerRouteSpecifiers.some((specifier) =>
        POKER_MODULES.some((pokerModule) => namesPokerModule(specifier, pokerModule))
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared export inventory
// ---------------------------------------------------------------------------

describe('R13.2/R13.3: shared/types keeps every pre-existing export', () => {
  it('R13.2: every pre-existing runtime export is still exported', () => {
    const exported = new Set(Object.keys(sharedTypes));
    for (const name of PRE_EXISTING_SHARED_EXPORTS) {
      expect({ name, present: exported.has(name) }).toEqual({ name, present: true });
    }
  });

  it('R13.3: every added runtime export is a name shared/types did not export before', () => {
    const preExisting = new Set<string>(PRE_EXISTING_SHARED_EXPORTS);
    const exported = new Set(Object.keys(sharedTypes));
    for (const name of ADDED_SHARED_EXPORTS) {
      expect({ name, wasPreExisting: preExisting.has(name) }).toEqual({
        name,
        wasPreExisting: false,
      });
      expect({ name, present: exported.has(name) }).toEqual({ name, present: true });
    }
  });

  it('R13.4: an added field left out of a stored record falls back to its documented default', () => {
    // `fluidCardHeight` is the one payload field this feature adds to an
    // existing record, and `resolveFluidCardHeight` is the single coercion point
    // every reader goes through.
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, null, 'true', 0, 1, {}, []),
        (absentish) => {
          expect(sharedTypes.resolveFluidCardHeight(absentish)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
