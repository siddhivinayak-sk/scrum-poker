# Agile Application Catalog — Client

Angular 21 frontend for the Agile Application Catalog (Scrum Poker + Retrospective Board).

## Tech Stack

- **Angular 21** with standalone components
- **Signals** for reactive state management
- **RxJS** for WebSocket event streams
- **Vitest** for unit testing
- **fast-check** for property-based testing
- **SCSS** for component styles

## Development Server

```bash
npm start
```

Starts on `http://localhost:4200/` with proxy to backend at `localhost:3000`.

## Building

```bash
# Development build
ng build

# Production build
ng build --configuration=production
```

Build artifacts are stored in `dist/`.

## Running Tests

```bash
# Unit tests (Vitest)
ng test

# Or directly
npx vitest --run
```

## Project Structure

```
src/app/
├── components/
│   ├── login/                  # Login page
│   ├── lobby/                  # Landing page (Scrum Poker + Retro tiles)
│   ├── session-create/         # Poker session creation
│   ├── session-poker-page/     # Poker session board
│   ├── board/                  # Poker voting board (cards)
│   ├── card-deck/              # Poker card deck
│   ├── facilitator-flow/       # Moderator workflow controls
│   ├── issue-list-panel/       # Issue/story list management
│   ├── metrics/                # Voting metrics display
│   ├── consensus-indicator/    # Agreement indicator
│   ├── session-history/        # Round history
│   ├── story-manager/          # Story submission
│   ├── user-menu/              # User avatar + dropdown menu
│   ├── retro-create/           # Retrospective board creation
│   ├── retro-board/            # Retrospective board view
│   ├── retro-login/            # Retro session join page
│   ├── qr-code/                # QR code display
│   ├── session-settings/       # Session settings panel
│   ├── countdown-overlay/      # Auto-reveal countdown
│   ├── voting-timer/           # Voting elapsed time
│   └── stars-animation/        # Reveal celebration animation
├── services/
│   ├── auth.service.ts         # JWT authentication
│   ├── websocket.service.ts    # Poker WebSocket connection
│   ├── retro-websocket.service.ts  # Retro WebSocket connection
│   ├── session-state.service.ts    # Poker session state (signals)
│   ├── retro-state.service.ts      # Retro session state (signals)
│   ├── retro-export.service.ts     # CSV export/import
│   ├── retro-screenshot.service.ts # Board screenshot capture
│   ├── toast.service.ts        # Toast notifications
│   └── base-path.service.ts    # URL prefix handling
├── guards/
│   ├── auth.guard.ts           # Requires login
│   ├── session-auth.guard.ts   # Requires poker session auth
│   └── retro-auth.guard.ts     # Requires retro session auth
├── app.routes.ts               # Route definitions (lazy-loaded)
├── app.config.ts               # App configuration
└── app.ts                      # Root component
```

## Key Patterns

- **Standalone components** — no NgModules, each component declares its own imports
- **Signals** — `signal()`, `computed()`, `effect()` for reactive state
- **Lazy loading** — all routes use `loadComponent()` for code splitting
- **Path alias** — `@shared/*` maps to `../shared/*` for shared types
- **WebSocket reconnection** — exponential backoff, max 10 retries then redirect to login

## Environment

The app reads `window.__BASE_PATH__` at runtime (injected by the server) to handle deployments under a URL prefix (e.g., `/scrum-poker`).
