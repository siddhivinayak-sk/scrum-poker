/**
 * Property 35: Upgrade logging is redacted and routing is unchanged
 * (R23.1, R23.2, R23.3).
 *
 * The upgrade handler is built with explicit options (`createUpgradeHandler`)
 * against stub WebSocketServers that record every `handleUpgrade` and `emit`
 * call. `server.ts` is loaded through the integration harness, which loads it
 * with `PORT=0` and closes its module-level server, probes and timers, so only
 * the pure exports are used here.
 */
import type { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { format } from 'util';
import fc from 'fast-check';
import type { WebSocket, WebSocketServer } from 'ws';
import type * as ServerModule from '../server';
import { loadServerModule } from './integration/ws-harness';

type Target = 'poker' | 'retro';

const UPGRADE_PREFIX = 'WebSocket upgrade request: ';
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

// ---------------------------------------------------------------------------
// Independent reimplementation of the pre-feature routing rule (R23.3)
// ---------------------------------------------------------------------------

function expectedTarget(url: string | undefined, publicPath: string, preservePath: boolean): Target {
  const u = url === undefined ? '' : url;
  const stripped =
    preservePath && publicPath.length > 0 && u.substring(0, publicPath.length) === publicPath
      ? u.substring(publicPath.length)
      : u;
  return stripped.substring(0, '/retro'.length) === '/retro' ? 'retro' : 'poker';
}

// ---------------------------------------------------------------------------
// Stub WebSocketServers
// ---------------------------------------------------------------------------

interface UpgradeCall {
  req: IncomingMessage;
  url: string | undefined;
  socket: Duplex;
  head: Buffer;
}

interface EmitCall {
  event: string | symbol;
  args: unknown[];
  url: string | undefined;
}

interface StubServer {
  wss: WebSocketServer;
  upgrades: UpgradeCall[];
  emits: EmitCall[];
  fakeWs: WebSocket;
}

function stubServer(): StubServer {
  const upgrades: UpgradeCall[] = [];
  const emits: EmitCall[] = [];
  // The handler only attaches `error` / `close` listeners to the accepted socket.
  const fakeWs = { on: () => fakeWs } as unknown as WebSocket;
  const wss = {
    handleUpgrade: (
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WebSocket, req: IncomingMessage) => void,
    ) => {
      upgrades.push({ req, url: req.url, socket, head });
      cb(fakeWs, req);
    },
    emit: (event: string | symbol, ...args: unknown[]) => {
      const req = args[1] as IncomingMessage | undefined;
      emits.push({ event, args, url: req?.url });
      return true;
    },
  } as unknown as WebSocketServer;
  return { wss, upgrades, emits, fakeWs };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Path characters: lower-case ASCII, a few upper-case letters (never `J`, so a
// path can never look like a JWT), percent-encoded sequences and unicode. No
// `?` (it starts the query) and no `=` (so `token=` can only come from a query).
const pathChar = fc.constantFrom(
  'a', 'b', 'e', 'o', 'r', 't', 'x', 'z', '0', '9', '-', '_', '~', '.',
  'R', 'E', 'T', 'O',
  '%20', '%2F', '%3F', '%3D', '%E2%9C%93',
  'é', 'ß', '日', '😀',
);
const segment = fc.array(pathChar, { minLength: 1, maxLength: 6 }).map((cs) => cs.join(''));
const pathSegments = fc
  .array(fc.oneof(segment, fc.constantFrom('retro', 'retroX', 'scrum-poker')), { maxLength: 3 })
  .map((ss) => ss.map((s) => `/${s}`).join(''));

const publicPathArb = fc.oneof(
  fc.constant(''),
  fc
    .array(fc.oneof(segment, fc.constantFrom('scrum-poker', 'retro', 'apps')), { minLength: 1, maxLength: 3 })
    .map((ss) => ss.map((s) => `/${s}`).join('')),
);

const tailArb = fc.tuple(
  fc.oneof(
    fc.constantFrom(
      '', '/', '/retro', '/retro/', '/retroX', '/retro/abc', '/x/retro', 'retro',
      '/Retro', '/RETRO', '/re', '/ret', '//retro', '/%72etro', '#/retro',
    ),
    pathSegments,
  ),
  pathSegments,
  fc.option(segment.map((s) => `#${s}`), { nil: '' }),
).map(([head, rest, fragment]) => `${head}${rest}${fragment}`);

type PrefixKind = 'none' | 'full' | 'partial' | 'extended';
const prefixKindArb = fc.constantFrom<PrefixKind>('none', 'full', 'full', 'partial', 'extended');

function applyPrefix(publicPath: string, kind: PrefixKind): string {
  switch (kind) {
    case 'none':
      return '';
    case 'full':
      return publicPath;
    case 'partial':
      return publicPath.slice(0, -1);
    case 'extended':
      return publicPath === '' ? '' : `${publicPath}x`;
  }
}

const b64urlChar = fc.constantFrom(
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
);
const b64url = fc.array(b64urlChar, { minLength: 4, maxLength: 24 }).map((cs) => cs.join(''));
const jwtArb = fc.tuple(b64url, b64url, b64url).map(([h, p, s]) => `eyJ${h}.eyJ${p}.${s}`);

interface Param {
  text: string;
  secrets: string[];
}

const paramArb: fc.Arbitrary<Param> = fc.oneof(
  jwtArb.map((t) => ({ text: `token=${t}`, secrets: [t] })),
  jwtArb.map((t) => ({ text: `token=${encodeURIComponent(t)}%3D`, secrets: [t] })),
  fc.uuid().map((u) => ({ text: `sessionId=${u}`, secrets: [u] })),
  fc.tuple(segment, segment).map(([k, v]) => ({ text: `${k}=${v}`, secrets: [] })),
  fc.constantFrom('?', '??', '#frag', 'next=/retro?x=1', 'q=%E2%9C%93&r=日', 'token=').map((text) => ({
    text,
    secrets: [],
  })),
);

interface UrlCase {
  /** `undefined` when the request carries no URL. */
  url: string | undefined;
  /** How the missing URL is represented on the request object. */
  absentAs: 'missing-key' | 'undefined-value';
  /** The URL text before the first `?` (built, not derived from `url`). */
  pathPart: string;
  /** Token and session ID values placed in the query string. */
  secrets: string[];
}

function urlCaseArb(publicPath: string): fc.Arbitrary<UrlCase> {
  const present = fc
    .tuple(
      prefixKindArb,
      tailArb,
      fc.option(fc.array(paramArb, { maxLength: 5 }), { nil: null }),
    )
    .map(([kind, tail, params]): UrlCase => {
      const pathPart = `${applyPrefix(publicPath, kind)}${tail}`;
      const query = params === null ? null : params.map((p) => p.text).join('&');
      return {
        url: query === null ? pathPart : `${pathPart}?${query}`,
        absentAs: 'missing-key',
        pathPart,
        secrets: params === null ? [] : params.flatMap((p) => p.secrets),
      };
    });
  const absent = fc.constantFrom<UrlCase['absentAs']>('missing-key', 'undefined-value').map(
    (absentAs): UrlCase => ({ url: undefined, absentAs, pathPart: '', secrets: [] }),
  );
  return fc.oneof({ weight: 9, arbitrary: present }, { weight: 1, arbitrary: absent });
}

const scenarioArb = fc
  .tuple(publicPathArb, fc.boolean())
  .chain(([publicPath, preservePath]) =>
    urlCaseArb(publicPath).map((urlCase) => ({ publicPath, preservePath, urlCase })),
  );

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Upgrade handler', () => {
  let mod: typeof ServerModule;

  beforeAll(async () => {
    mod = await loadServerModule();
  });

  // Feature: session-chat, Property 35: Upgrade logging is redacted and routing is unchanged
  it('Property 35: logs one redacted line per request and routes exactly as before', () => {
    const consoleOutput: string[] = [];
    const spies = CONSOLE_METHODS.map((m) =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(format(...args));
      }),
    );

    try {
      fc.assert(
        fc.property(scenarioArb, ({ publicPath, preservePath, urlCase }) => {
          consoleOutput.length = 0;
          const servers: Record<Target, StubServer> = { poker: stubServer(), retro: stubServer() };
          const logLines: string[] = [];
          const handler = mod.createUpgradeHandler({
            publicPath,
            preservePath,
            pokerWss: servers.poker.wss,
            retroWss: servers.retro.wss,
            log: (line) => logLines.push(line),
            lookupSessionId: { poker: () => undefined, retro: () => undefined },
          });

          const request = (
            urlCase.url !== undefined
              ? { url: urlCase.url, headers: {} }
              : urlCase.absentAs === 'undefined-value'
                ? { url: undefined, headers: {} }
                : { headers: {} }
          ) as IncomingMessage;
          const socket = new Duplex();
          const head = Buffer.from('head');

          handler(request, socket, head);

          // R23.1: exactly one Upgrade_Log_Line, holding the text before the first '?'.
          const allLines = [...logLines, ...consoleOutput];
          const upgradeLines = allLines.filter((l) => l.startsWith(UPGRADE_PREFIX));
          expect(upgradeLines).toEqual([`${UPGRADE_PREFIX}${urlCase.pathPart}`]);
          expect(logLines).toEqual(upgradeLines);

          // R23.1, R23.2: no query string, `token=`, JWT, token or session ID value.
          for (const line of allLines) {
            expect(line).not.toContain('?');
            expect(line).not.toContain('token=');
            expect(line).not.toMatch(JWT_PATTERN);
            for (const secret of urlCase.secrets) expect(line).not.toContain(secret);
          }

          // R23.3: the pre-feature routing rule picks the server.
          const target = expectedTarget(urlCase.url, publicPath, preservePath);
          const other: Target = target === 'poker' ? 'retro' : 'poker';
          const chosen = servers[target];

          // The same request object, URL unmodified, reaches handleUpgrade ...
          expect(chosen.upgrades).toHaveLength(1);
          const call = chosen.upgrades[0];
          expect(call.req).toBe(request);
          expect(call.url).toBe(urlCase.url);
          expect(call.socket).toBe(socket);
          expect(call.head).toBe(head);

          // ... and the `connection` event.
          expect(chosen.emits).toHaveLength(1);
          const emitted = chosen.emits[0];
          expect(emitted.event).toBe('connection');
          expect(emitted.args).toHaveLength(2);
          expect(emitted.args[0]).toBe(chosen.fakeWs);
          expect(emitted.args[1]).toBe(request);
          expect(emitted.url).toBe(urlCase.url);
          expect(request.url).toBe(urlCase.url);

          // The other server is untouched.
          expect(servers[other].upgrades).toHaveLength(0);
          expect(servers[other].emits).toHaveLength(0);
        }),
        { numRuns: 300 },
      );
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
