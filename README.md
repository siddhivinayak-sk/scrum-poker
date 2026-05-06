# Scrum Poker

A real-time collaborative estimation tool for agile teams. Moderators create sessions, team members join and vote on story points using planning poker cards, and results are revealed simultaneously to avoid anchoring bias.

## Features

### Core Estimation Flow
- **Multiple voting systems**: Fibonacci, Modified Fibonacci, T-Shirt sizes, Power of 2
- **Real-time voting**: All participants see who has voted (face-down cards) without seeing values
- **Simultaneous reveal**: Cards flip together to prevent bias
- **Re-vote**: If votes diverge significantly, moderator can trigger a re-vote on the same story
- **Voting metrics**: Average, mode, spread, distribution, and outlier detection after reveal
- **Consensus indicator**: Visual indicator showing Full Agreement, Partial Agreement, or High Divergence

### Session Management
- **Multi-session support**: Multiple isolated sessions can run concurrently
- **Session resume**: Moderators can resume previously created sessions from the lobby
- **Configurable permissions**: Reveal and issue management permissions can be set to moderator-only, all-players, or specific participants
- **Auto-reveal**: Optionally reveal cards automatically when all participants have voted
- **Countdown animation**: Optional 3-2-1 countdown before auto-reveal

### Issue/Story List Management
- **Issue panel**: Sidebar panel for managing stories to estimate
- **Bulk import**: Paste multiple stories (one per line) for quick setup
- **Drag-and-drop reorder**: Reorder the backlog by dragging
- **Progress tracking**: Visual distinction between pending, estimating, and estimated stories
- **One-click estimation**: Select an issue from the list to start a new voting round

### Moderator Controls
- **Remove participants**: Moderator can remove disruptive users (hover over their card to see the ✕ button)
- **Session settings**: Gear icon in the header opens a floating settings panel
- **Facilitator flow**: Guided workflow prompts (idle → voting → revealed → next story)

### Collaboration
- **QR code sharing**: Generate a QR code for easy session joining on mobile
- **Duplicate name prevention**: Case-insensitive name uniqueness within a session
- **WebSocket reconnection**: Automatic reconnection with exponential backoff on connection drops
- **Full state restoration**: All session state (participants, round, history, issues) restored on reconnect

### UX Enhancements
- **Stars animation**: Celebratory particle animation on card reveal (respects prefers-reduced-motion)
- **Voting timer**: Shows elapsed voting time, stops on reveal
- **Session history**: Collapsible history of completed rounds with metrics
- **Game name**: Optional session name displayed in the header for all participants
- **Responsive design**: Desktop sidebar with accordion sections; mobile overlay for history

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser (Angular)                    │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Login   │  │    Lobby     │  │  Session Poker   │  │
│  │Component │  │  Component   │  │    Page           │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
│        │              │                    │             │
│        └──────────────┼────────────────────┘             │
│                       │                                  │
│  ┌────────────────────┼──────────────────────────────┐  │
│  │         Services (WebSocket, Auth, State)          │  │
│  └────────────────────┼──────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────┘
                        │ WebSocket + REST
┌───────────────────────┼──────────────────────────────────┐
│                  Server (Node.js + Express)               │
│  ┌────────────────────┼──────────────────────────────┐  │
│  │            WebSocket Handler                       │  │
│  │  (session-scoped event routing & broadcasting)    │  │
│  └────────────────────┼──────────────────────────────┘  │
│                       │                                  │
│  ┌──────────────┐  ┌─┴────────────┐  ┌──────────────┐  │
│  │ Auth Service │  │ Session      │  │   REST       │  │
│  │ (JWT tokens) │  │ Registry     │  │   Routes     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                       │                                  │
│  ┌────────────────────┴──────────────────────────────┐  │
│  │              GameSession (per-session state)       │  │
│  │  participants, rounds, history, issues, config    │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Angular 21, Standalone Components, Signals, RxJS |
| Backend | Node.js, Express, WebSocket (ws library) |
| Auth | JWT tokens (jsonwebtoken) |
| Testing (Server) | Jest, fast-check (property-based testing) |
| Testing (Client) | Vitest, fast-check |
| Shared | TypeScript types in `shared/types.ts` |
| Deployment | Docker multi-stage build, Kubernetes |

---

## Project Structure

```
scrum-poker-app/
├── client/                  # Angular frontend
│   ├── src/app/
│   │   ├── components/      # UI components
│   │   ├── guards/          # Route guards (auth, session-auth)
│   │   └── services/        # WebSocket, Auth, SessionState, Toast
│   └── package.json
├── server/                  # Node.js backend
│   ├── src/
│   │   ├── routes/          # REST API (auth, sessions)
│   │   ├── services/        # GameSession, SessionRegistry, AuthService
│   │   ├── websocket/       # WebSocket handler
│   │   └── server.ts        # Express + WS server entry point
│   └── package.json
├── shared/                  # Shared TypeScript types
│   └── types.ts
├── k8s/                     # Kubernetes manifests
├── Dockerfile               # Multi-stage Docker build
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm 9+

### Installation

```bash
# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

### Running in Development

**Terminal 1 — Backend:**
```bash
cd server
npm run dev
```
Server starts on `http://localhost:3000`

**Terminal 2 — Frontend:**
```bash
cd client
npm start
```
Angular dev server starts on `http://localhost:4200` with proxy to backend.

### Running Tests

```bash
# Server tests (Jest)
cd server
npm test

# Client tests (Vitest)
cd client
npm test
```

### Building for Production

```bash
# Docker build (recommended)
docker build -t scrum-poker .
docker run -p 3000:3000 scrum-poker
```

Or manually:
```bash
# Build client
cd client
npm run build -- --configuration=production

# Build server
cd ../server
npm run build

# Start production server
npm start
```

---

## How to Use: Story Estimation Process

### Step 1: Create a Session (Moderator)

1. Open the app and log in with a display name
2. Click **"Start New Game"** from the lobby
3. Optionally enter a **Game Name** (e.g., "Sprint 42 Planning")
4. Select a **Voting System** (Fibonacci is the default)
5. Optionally expand **Advanced Settings** to configure:
   - Reveal permission (who can flip cards)
   - Issue permission (who can manage the story list)
   - Auto-reveal (flip automatically when everyone votes)
   - Countdown animation
6. Click **"Create Session"**

### Step 2: Invite Team Members

1. Share the session link using **"Copy Link"** button in the header
2. Or click **"QR Code"** to show a scannable QR code
3. Team members open the link, enter their display name, and join

### Step 3: Add Stories to Estimate

1. In the **Issues panel** (right sidebar), type a story title and click **Add**
2. Or use **Bulk import** to paste multiple stories (one per line)
3. Drag stories to reorder the backlog

### Step 4: Start Estimation

**Option A — From the Issue List:**
- Click the **"Estimate"** button next to a story in the issue panel
- This automatically starts a voting round with that story's title

**Option B — Manual Entry:**
- Type a story description in the **"Story Description"** input field
- Click **"Submit Story"**

### Step 5: Vote

1. All participants see the card deck at the bottom of the page
2. Each person clicks a card to cast their vote
3. Face-down cards appear on the board showing who has voted (without revealing values)

### Step 6: Reveal Cards

- **Manual reveal**: Moderator (or anyone with reveal permission) clicks **"Reveal Cards"**
- **Auto-reveal**: If enabled, cards flip automatically once everyone has voted
- A celebratory stars animation plays on reveal

### Step 7: Discuss Results

After reveal, the board shows:
- Each participant's card value (face-up)
- **Voting metrics**: Average, mode, spread
- **Consensus indicator**: Green ✓ (full agreement), Yellow ~ (partial), Red ⚠ (high divergence)

### Step 8: Decide Next Action

The **Facilitator Flow** panel shows contextual actions:
- **"Re-Vote"** — Start a fresh vote on the same story (previous votes are discarded, not saved to history)
- **"Clear & Next Story"** — Save the round to history, mark the issue as estimated, and move on

### Step 9: Repeat

Continue estimating stories from the issue list. The progress indicator shows `{estimated} / {total}`.

### Step 10: Resume Later (Optional)

- Sessions persist as long as they have activity (cleaned up after 30 minutes of inactivity with 0 participants)
- Moderators can resume sessions from the **"Your Previous Sessions"** section on the lobby page

---

## API Reference

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | No | Login with display name |
| GET | `/api/auth/validate` | Yes | Validate session token |
| POST | `/api/auth/logout` | Yes | Invalidate token |
| POST | `/api/sessions` | Yes | Create a new session |
| GET | `/api/sessions/mine` | Yes | List user's sessions |
| GET | `/api/sessions/:id` | Yes | Get session info |
| GET | `/api/sessions/:id/exists` | No | Check if session exists |
| PUT | `/api/sessions/:id/config` | Yes | Update session config |

### WebSocket Events

**Client → Server:**

| Event | Data | Description |
|-------|------|-------------|
| `story:submit` | `{ storyDescription }` | Start a new voting round |
| `card:select` | `{ cardValue }` | Cast a vote |
| `cards:reveal` | `{}` | Reveal all cards |
| `board:clear` | `{}` | Clear board, save to history |
| `round:revote` | `{}` | Re-vote on current story |
| `participant:remove` | `{ userId }` | Remove a participant (moderator only) |
| `issue:add` | `{ titles: string[] }` | Add issues to the list |
| `issue:remove` | `{ issueId }` | Remove an issue |
| `issue:reorder` | `{ orderedIds: string[] }` | Reorder the issue list |
| `issue:select` | `{ issueId }` | Select issue for estimation |
| `role:change` | `{ role }` | Change own role |
| `history:clear` | `{}` | Clear all history |

**Server → Client:**

| Event | Data | Description |
|-------|------|-------------|
| `session:state` | Full session state | Sent on connect/reconnect |
| `round:started` | `{ round }` | New voting round started |
| `card:voted` | `{ userId }` | A participant voted (no value) |
| `cards:revealed` | `{ selections, metrics }` | Cards revealed with results |
| `board:cleared` | `{ historyEntry }` | Board cleared, round saved |
| `participant:joined` | `{ participants }` | Updated participant list |
| `participant:left` | `{ participants }` | Updated participant list |
| `participant:removed` | `{ reason }` | Sent to removed user |
| `issue:list-updated` | `{ issues }` | Issue list changed |
| `session:config-updated` | `{ config }` | Config changed |
| `auto:reveal-triggered` | `{ countdown }` | Auto-reveal initiated |
| `error` | `{ message, code }` | Error notification |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `BASE_PATH` | `` | URL prefix (e.g., `/scrum-poker`) |
| `PRESERVE_PATH` | `false` | Set to `true` if ingress preserves the path |
| `NODE_ENV` | `development` | Environment mode |

---

## Deployment

### Docker

```bash
docker build -t scrum-poker .
docker run -p 3000:3000 -e BASE_PATH=/scrum-poker scrum-poker
```

### Kubernetes

Manifests are in the `k8s/` directory:
- `k8s.yaml` — Deployment + Service
- `ingress.yaml` — Ingress configuration

---

## Testing Strategy

The project uses a combination of:
- **Unit tests**: Concrete examples and edge cases
- **Property-based tests**: Universal correctness properties validated with random inputs (fast-check)
- **Integration tests**: End-to-end flows through WebSocket handler + GameSession

Key correctness properties tested:
1. Removable participants always excludes the moderator themselves
2. Participant removal discards their vote and removes from list
3. Display name uniqueness is case-insensitive with trimming
4. Voting duration equals revealedAt - startedAt in milliseconds
5. Issue list add appends correctly
6. Bulk import splits on newlines, filters empty lines
7. Issue list reorder preserves data
8. Issue selection starts round with correct description
9. Issue list included in session state on reconnect
10. Re-vote preserves story, resets state, doesn't save history
11. Consensus level computation matches specification
12. Facilitator progress counts estimated vs total correctly
13. Timestamps stored in UTC ISO 8601 format

---

## License

Private — Internal use only.
