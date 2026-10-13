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
- **Allowed feelings**: Choose which feeling emojis are available on the board (default: Happy, Sad, No Feeling)
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

#### Participant Feelings
- **Feelings strip**: Golden-bordered bar on the right side of the toolbar with selectable emoji icons
- **10 feeling categories**: Satisfaction, Frustration, Confidence, Confusion, Boredom, Happy, No Feeling, Glad, Sad, Mad
- **Configurable**: Moderator chooses which feelings are available via board settings (default: Happy, Sad, No Feeling)
- **Toggle selection**: Click an emoji to select your mood; click again to deselect
- **Real-time sync**: Feeling selections broadcast instantly to all participants
- **Moderator summary**: 📊 icon opens a popup showing all participants' feelings (moderator only)
- **Screenshot**: Capture the feelings summary as a PNG from the popup
- **Board completion lock**: Feelings are frozen when the board is marked complete
- **Minimum-one rule**: At least one feeling category must remain enabled

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
│   │   │   ├── feelings-strip/  # Feelings emoji selector strip
│   │   │   ├── feelings-summary-popup/ # Moderator feelings summary dialog
│   │   │   ├── board/           # Poker board component
│   │   │   ├── card-deck/       # Poker card deck
│   │   │   └── ...             # Other poker components
│   │   ├── guards/          # Route guards (auth, session-auth, retro-auth)
│   │   └── services/        # WebSocket, RetroWebSocket, Auth, State, RetroState, Feelings
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
| `retro:feeling:select` | `{ category }` | Select/deselect a feeling (null to deselect) |
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
| `retro:feeling:updated` | `{ userId, category }` | Participant feeling changed (null = deselected) |
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
docker pull siddhivinayaksk/scrum-pocker:0.0.7
```

```bash
docker build -t scrum-poker .
docker run -p 3000:3000 -e BASE_PATH=/scrum-poker scrum-poker
```

### Kubernetes

Manifests are in the `k8s/` directory:
- `k8s.yaml` — Deployment + Service
- `ingress.yaml` — Ingress configuration

### Helm Chart

The chart lives at [`helm/scrum-poker`](helm/scrum-poker). It is published by
[`.github/workflows/helm-publish.yml`](.github/workflows/helm-publish.yml) on every change to
`helm/**` on `main` and on every published GitHub release, to two registries: the GHCR OCI
registry and an HTTP chart repository served from GitHub Pages. The exhaustive values table,
with one row per configurable key, is in [`helm/scrum-poker/README.md`](helm/scrum-poker/README.md).

#### Install from the GHCR OCI registry (recommended)

```bash
helm install scrum-poker oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker \
  --version 0.0.7 \
  --namespace scrum-poker \
  --create-namespace
```

Helm 3.8 or newer is required for OCI registries, and the chart declares
`kubeVersion: ">=1.19.0-0"`, so Kubernetes 1.19+. `--version` is required to pin a release
from an OCI reference: unlike an HTTP repository, an OCI reference without a version does not
resolve to the newest published chart.

#### Install from the GitHub Pages chart repo

```bash
helm repo add scrum-poker https://siddhivinayak-sk.github.io/scrum-poker
helm repo update
helm install scrum-poker scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --create-namespace
```

#### Customizing values

The common case is a handful of `--set` flags. In `zsh`, quote each `--set` argument — unquoted
square brackets glob:

```bash
helm install scrum-poker oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker \
  --version 0.0.7 \
  --namespace scrum-poker --create-namespace \
  --set image.tag=0.0.7 \
  --set ingress.hosts[0].host=poker.example.com \
  --set ingress.hosts[0].paths[0].path=/scrum-poker \
  --set config.basePath=/scrum-poker
```

Anything larger belongs in a values file:

```yaml
# my-values.yaml
replicaCount: 1                       # 1 is the only supported value, see the note below

image:
  repository: siddhivinayaksk/scrum-pocker
  tag: "0.0.7"                        # "" falls back to the chart's appVersion
  pullPolicy: IfNotPresent

service:
  type: ClusterIP                     # ClusterIP | NodePort | LoadBalancer
  port: 80
  targetPort: 3000                    # also published to the container as PORT

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: poker.example.com
      paths:
        - path: /scrum-poker          # must equal config.basePath while preservePath is true
          pathType: Prefix
  tls:
    - secretName: poker-tls
      hosts:
        - poker.example.com

config:
  nodeEnv: production                 # production | development
  basePath: /scrum-poker              # published as BASE_PATH; "" serves at the cluster root
  preservePath: true                  # true when the ingress forwards the full path

auth:
  jwtSecret: ""                       # "" generates a random 32-character secret at install
  existingSecret: ""                  # or name a pre-created Secret; mutually exclusive
  existingSecretKey: JWT_SECRET

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

```bash
helm install scrum-poker oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker \
  --version 0.0.7 \
  --namespace scrum-poker --create-namespace \
  -f my-values.yaml
```

The values overridden most often, with the real defaults from
[`helm/scrum-poker/values.yaml`](helm/scrum-poker/values.yaml). See
[`helm/scrum-poker/README.md`](helm/scrum-poker/README.md) for the full table:

| Value | Default | What it controls |
|-------|---------|------------------|
| `image.repository` | `siddhivinayaksk/scrum-pocker` | Image to deploy |
| `image.tag` | `""` | Image tag; empty falls back to the chart's `appVersion` |
| `service.type` | `ClusterIP` | How the Service is exposed |
| `service.port` | `80` | Port the Service publishes in the cluster |
| `ingress.enabled` | `true` | Whether an Ingress is rendered |
| `ingress.className` | `nginx` | IngressClass that serves the rule |
| `ingress.hosts[0].host` | `""` | Hostname; empty matches any host |
| `ingress.hosts[0].paths[0].path` | `/scrum-poker` | Path routed to the app |
| `config.basePath` | `/scrum-poker` | `BASE_PATH`; empty serves at the cluster root |
| `config.preservePath` | `true` | `PRESERVE_PATH`; false adds an nginx `rewrite-target: /` |
| `auth.jwtSecret` | `""` | JWT key; empty generates a random 32-character value |
| `auth.existingSecret` | `""` | Pre-created Secret holding the JWT key |
| `replicaCount` | `1` | Pod count; `1` is the only supported value |
| `resources.limits.memory` | `512Mi` | Container memory ceiling |

**Constraints the chart enforces**

- `config.basePath` needs a leading `/` and must not end with `/`. An empty value is legal and
  means the cluster root; a bare `/` is legal too. `values.schema.json` applies `^$|^/` and
  `maxLength: 64` first, so a malformed value such as `scrum-poker` is usually rejected before
  any template runs. A trailing slash is caught by a single-field guard that lives in the
  chart's render-time validation block, with
  `config.basePath: "/scrum-poker/" must not end with "/" (supply "/scrum-poker" instead)`.
- While `ingress.enabled` **and** `config.preservePath` are both `true`, `config.basePath` must
  equal every configured ingress path. An empty `basePath` normalises to `/`, and one trailing
  `/` is stripped from an ingress path longer than one character before the comparison. A
  mismatch aborts the render with, verbatim:
  `config.basePath: "/other" does not match ingress.hosts[0].paths[0].path "/scrum-poker" (with config.preservePath=true the ingress forwards the full path, so the two must be equal; set config.basePath to "/scrum-poker", change the ingress path, or set config.preservePath=false)`.
  With `config.preservePath: false` the check does not run, because the ingress rewrites the
  path to `/` before the application sees it.
- `auth.jwtSecret` and `auth.existingSecret` are mutually exclusive; supplying both fails before
  anything is written. Leaving both empty generates a 32-character random value, stored in a
  Secret the chart renders, and `helm upgrade` looks the stored value up and reuses it so issued
  tokens stay valid. The Secret name is the release-qualified chart name plus `-secret`, and the
  release name is used as-is when it already contains the chart name — so a release named
  `scrum-poker` yields `scrum-poker-secret`, while a release named `my-release` yields
  `my-release-scrum-poker-secret`. Rather than guessing, read the name off the release with
  `helm get manifest <release> | grep -A2 'kind: Secret'` or
  `kubectl get secret -l app.kubernetes.io/instance=<release> --namespace <namespace>`. A
  non-empty `auth.existingSecret` renders no Secret at all and reads the key named by
  `auth.existingSecretKey` (default `JWT_SECRET`).
- `replicaCount` must stay `1`: poker and retro session state lives in the memory of a single
  Node.js process, so a second pod holds a second, disconnected set of sessions. The chart does
  **not** block a value above `1` — `values.schema.json` only sets `minimum: 1` — it renders and
  installs, and `NOTES.txt` prints a post-install warning when `replicaCount > 1` without
  `service.sessionAffinity: ClientIP`. Multi-replica is therefore permitted by the chart but
  operationally wrong. `autoscaling.enabled` **is** blocked and must stay `false`:
  `autoscaling.enabled: must be false (got true); the application holds poker and retro session state in process memory and supports exactly one replica`.
- Render before installing. `helm template scrum-poker oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker --version 0.0.7 -f my-values.yaml`
  exercises the same schema and guards offline.

#### Publishing the chart

[`.github/workflows/helm-publish.yml`](.github/workflows/helm-publish.yml) runs on pushes to
`main` and on pull requests that touch `helm/**`, on published releases, and on manual dispatch.
Pull requests lint, render, smoke-test and package only — nothing is published from a PR.

To cut a chart release:

1. Bump `version:` in `helm/scrum-poker/Chart.yaml`.
2. Merge to `main`. GHCR gets the new chart version, and `chart-releaser` cuts a
   `scrum-poker-<version>` GitHub release and refreshes `index.yaml` on `gh-pages`.
3. Optionally publish a GitHub release tagged `v<same version>`. That sets the chart's
   `appVersion` to the release version so it points at the matching Docker Hub tag, and it also
   triggers `build-and-push.yml`.

A push to `main` **without** a `Chart.yaml` version bump is a no-op for the Pages repo, not a
failure: `chart-releaser` creates a release only for a version that does not have one yet, and
`skip_existing: true` makes the re-run skip quietly. GHCR behaves differently — it re-pushes and
overwrites the existing tag for that version.

`workflow_dispatch` accepts an optional `chart_version` input. It overrides the packaged version
for the GHCR push only; `chart-releaser` has no version override, so the Pages repo always
publishes whatever is in `Chart.yaml`.

**One-time manual setup, required before the first run.** CI cannot do any of this for you:

1. **Create the `gh-pages` branch** — `chart-releaser` does not create it:
   ```bash
   git checkout --orphan gh-pages
   git rm -rf .
   printf '# Scrum Poker Helm chart repository\n' > README.md
   cp helm/scrum-poker/artifacthub-repo.yml .
   git add README.md artifacthub-repo.yml
   git commit -m "chore: initialise gh-pages chart repository"
   git push -u origin gh-pages
   git checkout main
   ```
2. **Enable GitHub Pages on the `gh-pages` branch** in Settings > Pages. Until that is done,
   `https://siddhivinayak-sk.github.io/scrum-poker/index.yaml` returns 404 and `helm repo add`
   fails, even though the workflow reports success.
3. **Make the GHCR package public.** The first `helm push` creates a *private* package, so set
   `charts/scrum-poker` to public — and link it to this repository — under the account's Packages
   settings before an anonymous `helm install` can work.
4. **Optional, for Artifact Hub.** Register the repository at
   `https://artifacthub.io/control-panel/repositories`, copy the repository ID into
   [`helm/scrum-poker/artifacthub-repo.yml`](helm/scrum-poker/artifacthub-repo.yml), then deliver
   that file: commit it to the `gh-pages` root for the HTTP repo, and for the OCI repo push it
   under the special `artifacthub.io` tag:
   ```bash
   oras push ghcr.io/siddhivinayak-sk/charts/scrum-poker:artifacthub.io \
     --config /dev/null:application/vnd.cncf.artifacthub.config.v1+yaml \
     helm/scrum-poker/artifacthub-repo.yml:application/vnd.cncf.artifacthub.repository-metadata.layer.v1.yaml
   ```

No repository secrets are needed. Both publish jobs authenticate with the built-in
`GITHUB_TOKEN`.

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

### Participant Feelings Correctness Properties
1. allowedFeelings bounds enforcement (1 to 10 entries)
2. Non-moderator configuration rejection
3. Feelings strip displays exactly allowedFeelings in order
4. Selected feeling is highlighted (exactly one or none)
5. Valid feeling selection updates state and broadcasts
6. Toggle deselection (clicking same feeling sets to null)
7. Disallowed feeling rejection
8. Board completion prevents feeling changes
9. Removing a feeling from allowed clears affected participants
10. Disconnect removes participant feeling
11. New joiner receives full feelings map
12. Summary icon visibility matches moderator status
13. Popup displays participants in case-insensitive alphabetical order

