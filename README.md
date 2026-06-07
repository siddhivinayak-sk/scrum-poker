# Agile Application Catalog

A real-time collaborative tool for agile teams. Includes **Scrum Poker** for story estimation and a **Retrospective Board** for structured sprint retrospectives — both with real-time collaboration via WebSocket.

## Features

### 🃏 Planning Poker

#### Core Estimation Flow
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
- **Back to Lobby**: 🏠 button on both poker and retro session pages to return to the lobby at any time
- **Connection resilience**: Auto-reconnect with exponential backoff; redirects to login after 10 failed attempts
- **Compact card design**: Optimized card layout with larger text area and smaller action buttons

---

### 📋 Retrospective Board

#### Board Creation & Templates
- **25 predefined templates**: Went Well/To Improve/Action Items, Start/Stop/Continue, Mad/Sad/Glad, Sailboat, Starfish, 4Ls, KALM, DAKI, and 18 more
- **Template preview**: See column names before creating the board
- **Configurable board name**: Name your retrospective (e.g., "Sprint 42 Retro")
- **Max votes per user**: Set a vote budget (default: 6)

#### Advanced Configuration
- **Hide cards initially** (default: on): Cards are hidden until the moderator reveals them (prevents bias)
- **Disable voting initially** (default: on): Voting is locked until the moderator enables it
- **Hide vote count** (default: on): Vote counts are not visible on cards
- **One vote per card**: Each participant can only vote once per card
- **Show card author**: Display who wrote each card
- **Password protection**: Require a password to join the board
- **Enable GIF/emoji**: Allow emoji insertion on cards
- **Column layout**: Switch between vertical (side-by-side) and horizontal (stacked) layouts
- **Live settings**: Moderator can change all settings at any time via the ⚙️ gear icon

#### Card Management
- **Add cards**: Click + on any column to add a new card
- **Edit cards**: Click on card text to edit inline
- **Delete cards**: Card author or moderator can delete cards
- **Drag-and-drop**: Move cards between columns or reorder within a column
- **Merge cards**: Drag one card onto another to merge their text (with confirmation popup)
- **Auto-focus**: Newly created cards automatically receive focus for immediate typing
- **Owner highlight**: Cards you just added are visually highlighted with a distinct background
- **Comments**: Add threaded comments to any card
- **Emoji insertion**: Quick emoji picker on each card

#### Voting System
- **Vote on cards**: Click 👍 to vote on important topics
- **Vote budget**: Remaining votes displayed in the header
- **One-vote-per-card mode**: Optional restriction to prevent vote stacking
- **Unvote**: Remove your vote from a card

#### Moderator Controls
- **Reveal cards**: Make all hidden cards visible to everyone (with animation)
- **Enable voting**: Unlock voting for all participants
- **Complete retrospective**: Lock the board to prevent further edits
- **Board settings**: ⚙️ gear icon opens a settings dialog to change configuration live
- **Context setting**: Set a sprint context description at the top of the board

#### Column Management
- **Template-based columns**: Columns created from the selected template
- **Add columns**: ➕ button opens a dialog to add new columns
- **Delete columns**: 🗑️ button with confirmation dialog
- **Drag-and-drop reorder**: Drag column headers to rearrange

#### Data Export & Sharing
- **Copy session link**: 🔗 button in the header copies the join URL
- **Export CSV**: Download all board data as CSV (columns, cards, votes, comments)
- **Import CSV**: Upload a CSV to pre-populate the board
- **Screenshot**: Capture the entire board as a PNG image (clipboard or download)

#### Collaboration
- **Real-time sync**: All changes broadcast instantly to all participants via WebSocket
- **Participant list**: See who's connected
- **Role switching**: Switch between moderator and participant roles
- **Auto-reconnect**: Exponential backoff reconnection with full state restoration
- **Password-protected boards**: Optional password required to join

#### Navigation
- **Lobby integration**: "Create Retrospective Board" tile alongside "Start New Game"
- **Join via URL**: Paste a retro session URL in the lobby's "Join Existing Session" field
- **Back to lobby**: 🏠 button in the header to return to the lobby
- **Session ID display**: Session ID shown in the header for reference

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Angular 21)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Login   │  │  Lobby   │  │  Poker   │  │   Retro   │  │
│  │Component │  │Component │  │  Page    │  │   Board   │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │
│        │              │            │              │          │
│  ┌─────┴──────────────┴────────────┴──────────────┴──────┐  │
│  │    Services (WebSocket, RetroWebSocket, Auth, State)   │  │
│  └───────────────────────────┬───────────────────────────┘  │
└──────────────────────────────┼───────────────────────────────┘
                               │ WebSocket + REST
┌──────────────────────────────┼───────────────────────────────┐
│                  Server (Node.js + Express)                    │
│  ┌───────────────────────────┼───────────────────────────┐   │
│  │         WebSocket Handlers (path-based routing)        │   │
│  │   /ws → Poker Handler    /retro → Retro Handler       │   │
│  └───────────────────────────┼───────────────────────────┘   │
│                              │                                │
│  ┌──────────────┐  ┌────────┴───────┐  ┌────────────────┐   │
│  │ Auth Service │  │ Session        │  │  REST Routes   │   │
│  │ (JWT tokens) │  │ Registries     │  │ /api/sessions  │   │
│  └──────────────┘  │ (Poker+Retro)  │  │ /api/retro     │   │
│                     └────────────────┘  └────────────────┘   │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  GameSession (poker)  │  RetroSession (retrospective) │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
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
│   │   ├── components/
│   │   │   ├── lobby/           # Landing page with poker + retro tiles
│   │   │   ├── poker-page/      # Scrum poker session page
│   │   │   ├── retro-create/    # Retrospective board creation form
│   │   │   ├── retro-board/     # Retrospective board view (columns, cards, toolbar)
│   │   │   ├── retro-login/     # Retro session join/login page
│   │   │   ├── board/           # Poker board component
│   │   │   ├── card-deck/       # Poker card deck
│   │   │   └── ...             # Other poker components
│   │   ├── guards/          # Route guards (auth, session-auth, retro-auth)
│   │   └── services/        # WebSocket, RetroWebSocket, Auth, State, RetroState
│   └── package.json
├── server/                  # Node.js backend
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.ts          # Authentication endpoints
│   │   │   ├── sessions.ts      # Poker session endpoints
│   │   │   └── retro-routes.ts  # Retrospective session endpoints
│   │   ├── services/
│   │   │   ├── game-session.ts          # Poker session state
│   │   │   ├── session-registry.ts      # Poker session registry
│   │   │   ├── retro-session.ts         # Retro session state
│   │   │   ├── retro-session-registry.ts # Retro session registry
│   │   │   ├── retro-templates.ts       # 25 retro templates
│   │   │   └── auth-service.ts          # JWT auth
│   │   ├── websocket/
│   │   │   ├── handler.ts        # Poker WebSocket handler
│   │   │   └── retro-handler.ts  # Retro WebSocket handler
│   │   └── server.ts        # Express + WS server entry point
│   └── package.json
├── shared/                  # Shared TypeScript types
│   ├── types.ts             # All shared types (poker + retro)
│   └── retro-templates.ts   # Template definitions for frontend
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

## How to Use: Story Estimation (Planning Poker)

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
- Click the **🏠 Home button** in the session header to return to the lobby at any time

---

## How to Use: Retrospective Board

### Step 1: Create a Retrospective Board (Moderator)

1. From the lobby, click **"Create Retrospective Board"**
2. Enter a **Board Name** (e.g., "Sprint 42 Retro")
3. Set **Max Votes Per User** (default: 6)
4. Select a **Template** from 25 options (e.g., "Start, Stop, Continue")
5. Preview the column names below the dropdown
6. Optionally expand **Advanced Settings** to adjust (defaults are pre-selected for a structured retro):
   - Hide cards initially ✓ (enabled by default — for unbiased card writing)
   - Disable voting initially ✓ (enabled by default — moderator controls when voting starts)
   - Hide vote count ✓ (enabled by default — prevents vote anchoring)
   - One vote per card
   - Password protection
   - Column layout (vertical/horizontal)
7. Click **"Create Board"**

### Step 2: Invite Participants

1. Click the **🔗 link button** in the header to copy the session URL
2. Share the URL with your team
3. Participants open the link, enter their display name, and join
4. Or paste the retro URL in the lobby's **"Join Existing Session"** field

### Step 3: Add Cards

1. Click the **+** button on any column to add a new card
2. Type your thought in the card's text area (auto-focused for immediate typing)
3. Press Enter or click away to save
4. Add as many cards as needed to any column
5. Your own cards are highlighted with a distinct background color

### Step 3b: Merge Cards (Optional)

1. Drag one card and drop it onto another card
2. A confirmation popup shows a preview of the merged text
3. Click **"Merge"** to combine the cards (target text + separator + source text)
4. Click **"Cancel"** to leave both cards unchanged
5. Merging is disabled on completed boards

### Step 4: Moderator Workflow

The moderator controls the flow using the toolbar buttons:

1. **👁️ Reveal Cards** — Make all hidden cards visible (if "Hide cards initially" was enabled)
2. **🗳️ Enable Voting** — Unlock voting (if "Disable voting initially" was enabled)
3. **✅ Complete** — Lock the board when the retrospective is done

### Step 5: Vote on Cards

1. Once voting is enabled, click **👍** on cards you find important
2. Your remaining vote count is shown in the header
3. Discuss the most-voted items as a team

### Step 6: Manage Columns

- **Add column**: Click ➕ in the toolbar, enter a name in the dialog
- **Delete column**: Click 🗑️ on the column header (with confirmation)
- **Reorder columns**: Drag column headers to rearrange

### Step 7: Export & Share

- **📥 Export CSV**: Download all board data
- **📤 Import CSV**: Upload cards from a file
- **📸 Screenshot**: Capture the board as an image
- **⚙️ Settings**: Change board configuration at any time (moderator only)

### Step 8: Navigate

- **🏠 Home button**: Return to the lobby at any time
- **Session ID**: Displayed in the header for reference

---

## API Reference

### REST Endpoints

#### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | No | Login with display name |
| GET | `/api/auth/validate` | Yes | Validate session token |
| POST | `/api/auth/logout` | Yes | Invalidate token |

#### Poker Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sessions` | Yes | Create a new poker session |
| GET | `/api/sessions/mine` | Yes | List user's sessions |
| GET | `/api/sessions/:id` | Yes | Get session info |
| GET | `/api/sessions/:id/exists` | No | Check if session exists |
| PUT | `/api/sessions/:id/config` | Yes | Update session config |

#### Retrospective Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/retro/sessions` | Yes | Create a new retro session |
| GET | `/api/retro/sessions/:id` | Yes | Get retro session state |
| GET | `/api/retro/sessions/:id/exists` | No | Check if retro session exists |
| POST | `/api/retro/sessions/:id/verify-password` | No | Verify board password |
| GET | `/api/retro/sessions/:id/export` | Yes | Export board as CSV |
| POST | `/api/retro/sessions/:id/import` | Yes | Import cards from CSV |

### WebSocket Events

#### Poker Events (path: `/ws`)

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

#### Retrospective Events (path: `/retro`)

**Client → Server:**

| Event | Data | Description |
|-------|------|-------------|
| `retro:card:add` | `{ columnId, text }` | Add a card to a column |
| `retro:card:edit` | `{ cardId, text }` | Edit card text |
| `retro:card:remove` | `{ cardId }` | Remove a card |
| `retro:card:move` | `{ cardId, targetColumnId, targetIndex }` | Move card |
| `retro:card:merge` | `{ sourceCardId, targetCardId }` | Merge two cards |
| `retro:card:vote` | `{ cardId }` | Vote on a card |
| `retro:card:unvote` | `{ cardId }` | Remove vote from a card |
| `retro:comment:add` | `{ cardId, text }` | Add comment to a card |
| `retro:comment:remove` | `{ cardId, commentId }` | Remove a comment |
| `retro:column:add` | `{ name }` | Add a new column |
| `retro:column:remove` | `{ columnId }` | Remove a column |
| `retro:column:reorder` | `{ orderedIds }` | Reorder columns |
| `retro:column:rename` | `{ columnId, name }` | Rename a column |
| `retro:context:update` | `{ text }` | Update board context |
| `retro:cards:reveal` | `{}` | Reveal all hidden cards |
| `retro:voting:enable` | `{}` | Enable voting |
| `retro:board:complete` | `{}` | Lock the board |
| `retro:config:update` | `{ config }` | Update board settings |
| `role:change` | `{ role }` | Switch role |

**Server → Client:**

| Event | Data | Description |
|-------|------|-------------|
| `retro:session:state` | `{ state }` | Full state on connect/reconnect |
| `retro:card:added` | `{ card, columnId }` | Card was added |
| `retro:card:edited` | `{ cardId, text }` | Card text updated |
| `retro:card:removed` | `{ cardId }` | Card was removed |
| `retro:card:moved` | `{ cardId, targetColumnId, targetIndex }` | Card was moved |
| `retro:card:merged` | `{ targetCard, removedCardId, removedFromColumnId }` | Cards were merged |
| `retro:card:voted` | `{ cardId, votes, votedBy, votesRemaining }` | Vote updated |
| `retro:comment:added` | `{ cardId, comment }` | Comment added |
| `retro:comment:removed` | `{ cardId, commentId }` | Comment removed |
| `retro:column:added` | `{ column }` | Column added |
| `retro:column:removed` | `{ columnId }` | Column removed |
| `retro:column:reordered` | `{ orderedIds }` | Columns reordered |
| `retro:column:renamed` | `{ columnId, name }` | Column renamed |
| `retro:context:updated` | `{ text }` | Context updated |
| `retro:cards:revealed` | `{}` | Cards now visible |
| `retro:voting:enabled` | `{}` | Voting now active |
| `retro:board:completed` | `{}` | Board locked |
| `retro:config:updated` | `{ config }` | Config changed |
| `retro:participant:joined` | `{ participants }` | Participant list updated |
| `retro:participant:left` | `{ participants }` | Participant list updated |
| `retro:error` | `{ message, code }` | Error notification |

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

The Docker image is available on Docker Hub: [siddhivinayaksk/scrum-pocker](https://hub.docker.com/r/siddhivinayaksk/scrum-pocker)

```bash
# Pull the latest image
docker pull siddhivinayaksk/scrum-pocker:latest

# Or pull a specific version
docker pull siddhivinayaksk/scrum-pocker:0.0.3
```

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
- **Integration tests**: End-to-end flows through WebSocket handler + GameSession/RetroSession

### Poker Correctness Properties
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

### Retrospective Board Correctness Properties
1. Board name validation (non-empty trimmed string)
2. Max votes validation (positive integer)
3. Template-to-columns mapping (columns match template definition)
4. Configuration toggle isolation (changing one doesn't affect others)
5. Session ID uniqueness
6. Password authentication (access iff password matches)
7. Display name case-insensitive uniqueness
8. Column addition (appends with correct order)
9. Column removal cascades to cards
10. Column reorder preserves cards
11. Card addition (correct text and author)
12. Card edit updates only text
13. Card removal permissions (author or moderator only)
14. Card move between columns preserves data
15. Voting mechanics (increment/decrement, budget enforcement)
16. Disabled voting prevents all votes
17. Card visibility when hidden (own cards only)
18. Card reveal makes all visible
19. Completed board rejects all modifications
20. Reconnect restores full board state
21. CSV export completeness
22. CSV import/export round trip
23. Invalid CSV rejection
24. Session isolation (concurrent sessions independent)
25. Inactive session cleanup (30 min + 0 participants)
26. Context editable only by moderator
27. Icon buttons have accessibility attributes
28. Merge operation correctness (combined text with separator, source removed)
29. Cancel merge is a no-op (board state unchanged)
30. Completed board prevents merge

