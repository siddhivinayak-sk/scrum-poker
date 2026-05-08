# Scrum Poker — Agent Instructions

Real-time collaborative planning poker and retrospective tool.  
Stack: **Angular 21 (frontend)** · **Node.js/Express + WebSocket (backend)** · **Shared TypeScript types**

---

## Build & Dev Commands

```bash
# Start backend (port 3000, ts-node watch)
cd server && npm run dev

# Start frontend (port 4200, proxies /api and /ws to localhost:3000)
cd client && npm start

# Run server tests (Jest)
cd server && npm test

# Run client tests (Vitest, via Angular CLI)
cd client && npm test

# Production Docker build
docker build -t scrum-poker .
```

## Project Layout

| Path | Purpose |
|------|---------|
| `shared/types.ts` | **Single source of truth** for all shared TypeScript types, enums, and card constants. Both client and server import from here. |
| `client/src/app/components/` | Angular standalone components, one folder per component |
| `client/src/app/services/` | Angular services (`providedIn: 'root'`); use `inject()` + Signals for state |
| `client/src/app/guards/` | Route guards: `authGuard`, `sessionAuthGuard`, `retroAuthGuard` |
| `server/src/services/game-session.ts` | `GameSession` class — per-session state machine |
| `server/src/services/session-registry.ts` | `SessionRegistry` — singleton Map of all active sessions |
| `server/src/websocket/handler.ts` | Poker WebSocket event routing & broadcasting |
| `server/src/websocket/retro-handler.ts` | Retro WebSocket event routing |

## Key Conventions

### Angular (client)
- **Standalone components only** — no NgModules. Every component declares its own `imports: [...]`.
- **Signals over BehaviorSubject** — use `signal()`, `computed()`, `effect()` for reactive state; avoid adding new RxJS streams unless bridging from WS events.
- **Lazy-loaded routes** — all routes beyond `LoginComponent` use `loadComponent()` in `app.routes.ts`.
- **Path alias `@shared/*`** — maps to `../shared/*`. Use `import { X } from '@shared/types'` (not relative `../../shared/types`).
- **Strict TypeScript** — `strict`, `strictTemplates`, `noImplicitReturns` are all enabled; no `any` casts.

### Server
- **`GameSession` class** encapsulates per-session state; don't add module-level mutable state to `session-manager.ts`.
- **WebSocket routing** — `server.ts` splits WS upgrades: paths starting with `/retro` → `retroWss`, all others → poker `wss`.
- **JWT auth** — tokens stored in `localStorage` on the client under keys `scrum-poker-token` / `scrum-poker-user`. The server verifies with `jsonwebtoken`.
- **`BASE_PATH` / `PRESERVE_PATH` env vars** — control public URL prefix in Docker/K8s deployments. Health check is always at `/api/health` regardless of `BASE_PATH`.

### Shared types
- All card values, voting system types, WebSocket message shapes, and permission helpers live in `shared/types.ts`.
- Server `jest.config.ts` includes `../shared` in `roots` so shared tests run as part of `npm test` in `server/`.

## Testing
- **Server**: Jest + `ts-jest`. Test files: `**/*.test.ts` and `**/*.spec.ts` under `server/src/` and `shared/`.
- **Client**: Vitest (invoked via `ng test`). Uses `@testing-library/angular` and `fast-check` for property-based tests.
- **Integration/smoke**: `tests/docker-smoke.test.sh` and `tests/k8s-smoke.test.sh` for deployment validation.

## Common Pitfalls
- The client test runner is **Vitest**, not Karma/Jasmine — don't add Karma config or `TestBed` patterns that are incompatible with Vitest.
- `@shared/*` is a TypeScript path alias; Jest resolves it via the `tsconfig` in `jest.config.ts` — don't add a separate `moduleNameMapper`.
- `VotingRound.selections` is a `Map<string, CardValue>`, not a plain object — handle serialization/deserialization carefully across the WS boundary.
- The retro feature has its own separate session registry (`retro-session-registry.ts`), WebSocket handler, and routes — keep poker and retro concerns isolated.
