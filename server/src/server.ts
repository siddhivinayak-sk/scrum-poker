import express from 'express';
import http, { IncomingMessage } from 'http';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { retroRouter } from './routes/retro-routes';
import { sessionRegistry } from './services/session-registry';
import {
  handleWebSocket,
  setWebSocketServer,
  removePokerConnection,
  getRegisteredPokerSessionId,
} from './websocket/handler';
import {
  handleRetroWebSocket,
  removeRetroConnection,
  getRegisteredRetroSessionId,
} from './websocket/retro-handler';
import { attachLivenessProbe } from './websocket/liveness';
import { BoardKind, WS_MAX_PAYLOAD_BYTES } from '../../shared/types';

/**
 * The part of an upgrade request URL that is safe to log: everything before the
 * first `?`, so no query string (and no `token` / `sessionId`) is written (R23.1).
 */
export function redactUpgradeUrl(url: string | undefined): string {
  if (url === undefined) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Attach an `error` listener to an accepted WebSocket and write at most one log
 * line when the socket closes after an error (R23.7, R23.8).
 *
 * Only the Board_Kind, the registered session ID (from the client-map lookup,
 * never the URL), the error `code` and the close code are written. The error
 * message, frame payload and request URL are never stored or logged.
 */
/**
 * The close code `ws` sends when its receiver rejects a frame, derived from the
 * error's public `code` (ws 8 receiver: `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` and
 * `WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH` close with 1009, `WS_ERR_INVALID_UTF8`
 * with 1007, every other `WS_ERR_*` with 1002).
 *
 * Needed because, after such an error, `ws` stops reading the socket and so never
 * parses the client's close reply: its `close` event then reports 1006 even
 * though the connection was closed with the code above (R23.8).
 */
function protocolErrorCloseCode(code: string | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' || code === 'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH') {
    return 1009;
  }
  if (code === 'WS_ERR_INVALID_UTF8') return 1007;
  return code.startsWith('WS_ERR_') ? 1002 : undefined;
}

export function attachSocketErrorLog(
  ws: WebSocket,
  boardKind: BoardKind,
  lookupSessionId: (ws: WebSocket) => string | undefined,
  log: (line: string) => void,
): void {
  let errored = false;
  let errorCode: string | undefined;
  let sessionId: string | undefined;
  let logged = false;

  ws.on('error', (err: unknown) => {
    if (errored) return;
    errored = true;
    const code = (err as { code?: unknown } | null)?.code;
    errorCode = typeof code === 'string' ? code : undefined;
    // The session ID as registered in the client map at the moment of the error.
    sessionId = lookupSessionId(ws);
  });

  ws.on('close', (closeCode: number) => {
    if (!errored || logged) return;
    logged = true;
    const parts = [`kind=${boardKind}`];
    if (sessionId !== undefined) parts.push(`session=${sessionId}`);
    if (errorCode !== undefined) parts.push(`code=${errorCode}`);
    parts.push(`close=${protocolErrorCloseCode(errorCode) ?? closeCode}`);
    log(`WebSocket error: ${parts.join(' ')}`);
  });
}

export interface UpgradeHandlerOptions {
  /** PUBLIC_PATH as derived from BASE_PATH (trailing slashes removed, '' for unset/empty/'/'). */
  publicPath: string;
  /** true only when PRESERVE_PATH is the exact string 'true'. */
  preservePath: boolean;
  pokerWss: WebSocketServer;
  retroWss: WebSocketServer;
  /** Defaults to console.log. */
  log?: (line: string) => void;
  /** Defaults to the client-map lookups of the poker and retro handlers. */
  lookupSessionId?: {
    poker(ws: WebSocket): string | undefined;
    retro(ws: WebSocket): string | undefined;
  };
}

/**
 * Build the HTTP `upgrade` listener that logs one redacted line per request and
 * routes it to the poker or retro WebSocketServer (R23.1, R23.3, R23.7).
 */
export function createUpgradeHandler(
  o: UpgradeHandlerOptions,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const log = o.log ?? ((line: string) => console.log(line));
  const lookup = o.lookupSessionId ?? {
    poker: getRegisteredPokerSessionId,
    retro: getRegisteredRetroSessionId,
  };

  return (request, socket, head) => {
    const reqUrl = request.url || '';
    log(`WebSocket upgrade request: ${redactUpgradeUrl(request.url)}`);

    // When the ingress preserves the full path (PRESERVE_PATH=true), the URL
    // includes the PUBLIC_PATH prefix (e.g. /scrum-poker/retro?...).
    // Strip the prefix before checking the WS route so retro connections are
    // not accidentally sent to the poker handler.
    const routingPath =
      o.preservePath && o.publicPath && reqUrl.startsWith(o.publicPath)
        ? reqUrl.slice(o.publicPath.length)
        : reqUrl;

    if (routingPath.startsWith('/retro')) {
      // Route retro WebSocket connections to the retro handler
      o.retroWss.handleUpgrade(request, socket, head, (ws) => {
        attachSocketErrorLog(ws, 'retro', (s) => lookup.retro(s), log);
        o.retroWss.emit('connection', ws, request);
      });
    } else {
      // All other paths go to the existing poker handler
      o.pokerWss.handleUpgrade(request, socket, head, (ws) => {
        attachSocketErrorLog(ws, 'poker', (s) => lookup.poker(s), log);
        o.pokerWss.emit('connection', ws, request);
      });
    }
  };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
const retroWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

/**
 * BASE_PATH: the public URL prefix the browser sees (e.g. /scrum-poker).
 * PRESERVE_PATH: set to "true" if the ingress forwards the full path
 *   (e.g. container receives /scrum-poker/login instead of /login).
 *
 * Declared early so the WebSocket upgrade handler can reference them.
 */
const rawBasePath = process.env.BASE_PATH || '';
const PUBLIC_PATH = rawBasePath === '/' ? '' : rawBasePath.replace(/\/+$/, '');
const preservePath = process.env.PRESERVE_PATH === 'true';

// Handle WebSocket upgrade manually — this gives us control over the path
// and lets us log upgrade attempts (without the query string) for debugging
server.on(
  'upgrade',
  createUpgradeHandler({
    publicPath: PUBLIC_PATH,
    preservePath,
    pokerWss: wss,
    retroWss,
    lookupSessionId: {
      poker: getRegisteredPokerSessionId,
      retro: getRegisteredRetroSessionId,
    },
  }),
);

// Global middleware
app.use(express.json());
app.use(cors());

// Health check — always at /api/health regardless of base path (for K8s probes)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Build the Angular client path
const clientPath = path.join(__dirname, '../../client/dist/client/browser');

// Log static file info at startup
console.log(`Static files directory: ${clientPath}`);
console.log(`Directory exists: ${fs.existsSync(clientPath)}`);
if (fs.existsSync(clientPath)) {
  const files = fs.readdirSync(clientPath);
  console.log(`Files (${files.length}): ${files.join(', ')}`);
}

// Read and modify index.html with base href and runtime config
const indexHtmlPath = path.join(clientPath, 'index.html');
let indexHtml = '';
const baseHref = PUBLIC_PATH ? PUBLIC_PATH + '/' : '/';

if (fs.existsSync(indexHtmlPath)) {
  indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

  // Replace <base href="/">
  indexHtml = indexHtml.replace(/<base\s+href="\/"\s*\/?>/i, `<base href="${baseHref}">`);

  // Inject runtime config
  indexHtml = indexHtml.replace(
    '</head>',
    `<script>window.__BASE_PATH__ = '${PUBLIC_PATH}';</script></head>`
  );
} else {
  console.warn(`Warning: index.html not found at ${indexHtmlPath}. SPA fallback will return 404.`);
  indexHtml = '<html><body><h1>Client not built</h1><p>Run npm run build in the client directory.</p></body></html>';
}

// If PUBLIC_PATH is set, also rewrite all relative asset references to absolute paths.
// This ensures assets load correctly even if <base href> is somehow not respected
// (e.g. some browsers have quirks with modulepreload and base href).
if (PUBLIC_PATH) {
  // Rewrite: href="chunk-xxx.js" → href="/scrum-poker/chunk-xxx.js"
  // Rewrite: src="main-xxx.js" → src="/scrum-poker/main-xxx.js"
  // Rewrite: href="styles-xxx.css" → href="/scrum-poker/styles-xxx.css"
  // Rewrite: href="favicon.ico" → href="/scrum-poker/favicon.ico"
  // Only rewrite relative URLs (no leading / or http)
  indexHtml = indexHtml.replace(
    /(<(?:link|script)[^>]*?\s(?:href|src))="(?!\/|https?:\/\/)([^"]+)"/gi,
    `$1="${baseHref}$2"`
  );
}

console.log(`Base href set to: ${baseHref}`);
if (PUBLIC_PATH) {
  console.log(`Asset URLs rewritten with prefix: ${baseHref}`);
}

// File extension regex — requests for static assets should not get index.html
const HAS_FILE_EXT = /\.\w{2,}$/;

/**
 * Create a sub-router that handles all app routes:
 * API, static files, and SPA fallback.
 * This router is mounted at "/" or "/scrum-poker" depending on ingress mode.
 */
const appRouter = express.Router();

// API routes on the sub-router
appRouter.use('/api/auth', authRouter);
appRouter.use('/api/sessions', sessionsRouter);
appRouter.use('/api/retro', retroRouter);
appRouter.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Static files on the sub-router
// IMPORTANT: index: false prevents express.static from serving index.html
// for directory requests (e.g. GET /). We need the SPA fallback to serve
// our rewritten index.html instead of the raw file from disk.
appRouter.use(express.static(clientPath, { index: false }));

// SPA fallback on the sub-router — only for navigation requests (no file extension)
appRouter.get('*', (req, res, next) => {
  if (HAS_FILE_EXT.test(req.path)) {
    // Static file not found by express.static above — return 404, not index.html
    return next();
  }
  res.type('html').send(indexHtml);
});

// Mount the sub-router at the correct path
if (preservePath && PUBLIC_PATH) {
  // Path-preserving ingress: container receives /scrum-poker/...
  app.use(PUBLIC_PATH, appRouter);
} else {
  // Path-stripping ingress or no base path: container receives /...
  app.use('/', appRouter);
}

// Attach WebSocket servers
setWebSocketServer(wss);
wss.on('connection', handleWebSocket);
retroWss.on('connection', handleRetroWebSocket);

// Liveness probe for the poker server: ping every connection every 30 seconds
// and drop the participant after two consecutive missed pongs (R11.20–R11.22).
const pokerLivenessProbe = attachLivenessProbe(wss, {
  onDead: (ws) => removePokerConnection(ws),
});

// A second, fully separate probe for the retro server. The two probes share no
// state, so a closure detected on one server never touches the other server's
// sockets (R11.22, R13.9, R13.14).
const retroLivenessProbe = attachLivenessProbe(retroWss, {
  onDead: (ws) => removeRetroConnection(ws),
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Scrum Poker server listening on port ${PORT}`);
  console.log(`PUBLIC_PATH: ${PUBLIC_PATH || '/'}`);
  console.log(`Ingress mode: ${preservePath ? 'path-preserving' : 'path-stripping'}`);
  console.log(`Router mounted at: ${preservePath && PUBLIC_PATH ? PUBLIC_PATH : '/'}`);
  sessionRegistry.startCleanupTimer();
});

export { app, server, wss, retroWss, pokerLivenessProbe, retroLivenessProbe };
