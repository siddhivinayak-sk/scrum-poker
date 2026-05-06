import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { sessionRegistry } from './services/session-registry';
import { handleWebSocket, setWebSocketServer } from './websocket/handler';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade manually — this gives us control over the path
// and lets us log upgrade attempts for debugging
server.on('upgrade', (request, socket, head) => {
  const reqUrl = request.url || '';
  console.log(`WebSocket upgrade request: ${reqUrl}`);

  // Accept upgrade on any path — the ws handler validates token/session
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

/**
 * BASE_PATH: the public URL prefix the browser sees (e.g. /scrum-poker).
 * PRESERVE_PATH: set to "true" if the ingress forwards the full path
 *   (e.g. container receives /scrum-poker/login instead of /login).
 */
const rawBasePath = process.env.BASE_PATH || '';
const PUBLIC_PATH = rawBasePath === '/' ? '' : rawBasePath.replace(/\/+$/, '');
const preservePath = process.env.PRESERVE_PATH === 'true';

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

// Attach WebSocket server
setWebSocketServer(wss);
wss.on('connection', handleWebSocket);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Scrum Poker server listening on port ${PORT}`);
  console.log(`PUBLIC_PATH: ${PUBLIC_PATH || '/'}`);
  console.log(`Ingress mode: ${preservePath ? 'path-preserving' : 'path-stripping'}`);
  console.log(`Router mounted at: ${preservePath && PUBLIC_PATH ? PUBLIC_PATH : '/'}`);
  sessionRegistry.startCleanupTimer();
});

export { app, server, wss };
