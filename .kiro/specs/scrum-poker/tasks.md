# Implementation Plan: Scrum Poker

## Overview

This plan implements a real-time Scrum Poker application with a Node.js/Express backend and Angular standalone-component frontend. Tasks are ordered by dependency: shared types first, then backend services, then frontend services and components, followed by integration wiring, responsive design, accessibility, and finally Docker/Kubernetes deployment. Property-based tests and unit tests are placed alongside the features they validate.

## Tasks

- [x] 1. Set up project structure and shared types
  - [x] 1.1 Initialize Node.js backend project with TypeScript
    - Create `server/` directory with `package.json`, `tsconfig.json`
    - Install dependencies: `express`, `ws`, `uuid`, `jsonwebtoken`, `cors`
    - Install dev dependencies: `typescript`, `ts-node`, `jest`, `ts-jest`, `fast-check`, `@types/*`
    - Configure Jest for backend testing
    - _Requirements: 17.1_

  - [x] 1.2 Initialize Angular frontend project
    - Create Angular project in `client/` using Angular CLI with standalone components (no NgModules)
    - Install dev dependencies: `fast-check`, `@testing-library/angular` (if needed)
    - _Requirements: 17.1_

  - [x] 1.3 Define shared data models and types
    - Create `shared/types.ts` with `NumericCardValue`, `SpecialCardValue`, `CardValue`, `FIBONACCI_SEQUENCE`, `SPECIAL_CARDS`, `ALL_CARDS`
    - Define `User`, `VotingRound`, `HistoryEntry`, `ParticipantVote`, `VotingMetrics`, `SessionState`, `WebSocketMessage` interfaces
    - Ensure types are importable by both backend and frontend
    - _Requirements: 5.1, 5.2, 11.1, 11.2, 11.3, 11.4_

- [x] 2. Implement backend Auth Service
  - [x] 2.1 Implement Auth Service with login, token validation, and logout
    - Create `server/services/auth-service.ts`
    - Implement `login(username, isAnonymous)` — validate non-empty input, generate UUID, create JWT token, assign default role `'participant'`
    - Implement `validateToken(token)` — decode and verify token, return `User` or `null`
    - Implement `logout(token)` — invalidate token, remove from active sessions
    - Implement `getActiveTokens(userId)` — return all active tokens for cross-tab support
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_

  - [x] 2.2 Create auth REST routes
    - Create `server/routes/auth.ts` with Express router
    - POST `/api/auth/login` — call AuthService.login, return token + user
    - GET `/api/auth/validate` — validate Authorization header token, return user
    - POST `/api/auth/logout` — invalidate session token
    - Return appropriate HTTP status codes (200, 400, 401)
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

  - [x] 2.3 Write property test for default role assignment
    - **Property 1: Default role assignment**
    - Generate random usernames and anonymous flags, verify role is always `'participant'`
    - **Validates: Requirements 1.4, 2.4**

  - [x] 2.4 Write unit tests for Auth Service
    - Test login with valid username, empty username, anonymous login with valid/empty display name
    - Test token generation, validation, and expiry
    - Test logout invalidation and cross-tab token retrieval
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_

- [x] 3. Implement backend Metrics Engine
  - [x] 3.1 Implement Metrics Engine calculation logic
    - Create `server/services/metrics-engine.ts`
    - Implement `calculate(selections)` — compute average, mode, spread, distribution from card selections
    - Implement outlier detection using Fibonacci index distance > 2 from mode
    - Set `insufficientData: true` when fewer than 2 numeric votes
    - Exclude special cards (`coffee`, `no-clue`, `break`) from numeric calculations
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 3.2 Write property test for metrics calculation correctness
    - **Property 8: Metrics calculation correctness**
    - Generate arrays of card selections (numeric + special), verify average equals arithmetic mean of numeric values, mode equals most frequent numeric value, spread equals max minus min, distribution counts match
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**

  - [x] 3.3 Write property test for outlier detection correctness
    - **Property 9: Outlier detection correctness**
    - Generate selections with known mode, verify a vote is an outlier iff its Fibonacci index differs from mode's index by more than 2
    - **Validates: Requirements 11.5**

  - [x] 3.4 Write property test for insufficient data detection
    - **Property 10: Insufficient data detection**
    - Generate selections with 0–1 numeric votes (rest special cards), verify `insufficientData` is `true`; generate selections with 2+ numeric votes, verify `insufficientData` is `false`
    - **Validates: Requirements 11.6**

  - [x] 3.5 Write unit tests for Metrics Engine
    - Test specific examples: e.g., selections `[1, 2, 3]`, all special cards, single vote, no votes, tie for mode
    - Test outlier edge cases: vote exactly 2 Fibonacci steps from mode (not outlier), vote 3 steps away (outlier)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

- [x] 4. Implement backend Session Manager
  - [x] 4.1 Implement Session Manager core logic
    - Create `server/services/session-manager.ts`
    - Implement participant management: `addParticipant`, `removeParticipant`, `getParticipants`
    - Implement round lifecycle: `startRound(storyDescription)` — validate non-empty, create VotingRound with status `'voting'`
    - Implement `selectCard(userId, cardValue)` — record selection, last-write-wins for same user
    - Implement `revealCards()` — change round status to `'revealed'`, compute metrics via MetricsEngine
    - Implement `clearBoard()` — save round to history (newest-first), reset current round to null
    - Implement `getHistory()`, `clearHistory()`, `getSessionState()`
    - _Requirements: 7.2, 7.4, 8.1, 8.2, 8.4, 9.1, 9.2, 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 14.1, 14.3, 15.2, 15.3_

  - [x] 4.2 Write property test for card selection last-write-wins
    - **Property 5: Card selection last-write-wins**
    - Generate random sequences of card values for a single user, verify only the last value is recorded
    - **Validates: Requirements 8.1, 8.2**

  - [x] 4.3 Write property test for story submission starts round
    - **Property 6: Story submission starts round**
    - Generate random non-empty strings, verify `startRound` creates a VotingRound with status `'voting'` and the submitted description
    - **Validates: Requirements 7.2**

  - [x] 4.4 Write property test for clear board saves and resets
    - **Property 11: Clear board saves and resets**
    - Generate random completed rounds, call clearBoard, verify round is added to history and current round is reset to null
    - **Validates: Requirements 12.2, 12.3**

  - [x] 4.5 Write property test for history ordering newest-first
    - **Property 13: History ordering newest-first**
    - Generate sequences of completed rounds, verify history list is ordered with most recent at index 0
    - **Validates: Requirements 13.3**

  - [x] 4.6 Write property test for clear history empties all entries
    - **Property 14: Clear history empties all entries**
    - Generate random history states with 1+ entries, clear history, verify empty list
    - **Validates: Requirements 14.3**

  - [x] 4.7 Write property test for history entry data completeness
    - **Property 12: History entry data completeness**
    - Generate random history entries, verify each contains story description, participant votes (with display names and card values or null), and complete metrics
    - **Validates: Requirements 13.4**

  - [x] 4.8 Write unit tests for Session Manager
    - Test add/remove participants, start round with empty description (error), card selection outside active round (ignored)
    - Test reveal with no votes (insufficientData), clear board before reveal (ignored), role change during active vote
    - _Requirements: 7.2, 7.4, 8.1, 8.2, 9.1, 12.1, 12.2, 12.3, 13.1, 14.3, 15.2, 15.3_

- [x] 5. Checkpoint — Backend services
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement backend WebSocket handler and Express server
  - [x] 6.1 Implement WebSocket handler
    - Create `server/websocket/handler.ts`
    - Authenticate incoming connections via token query parameter
    - Route client events (`story:submit`, `card:select`, `cards:reveal`, `board:clear`, `role:change`, `history:clear`) to SessionManager
    - Broadcast server events (`round:started`, `card:voted`, `cards:revealed`, `board:cleared`, `participant:joined`, `participant:left`, `role:changed`, `history:cleared`, `session:state`, `error`)
    - Enforce role-based authorization (only moderators can reveal, clear, submit stories)
    - Send full `session:state` on reconnect
    - Handle participant disconnect — remove from active list, broadcast updated participant list
    - _Requirements: 7.2, 8.4, 9.2, 12.4, 15.1, 15.2, 15.3, 15.5, 4.5_

  - [x] 6.2 Implement Express server entry point
    - Create `server/server.ts`
    - Configure Express with JSON parsing, mount `/api/auth` routes
    - Serve Angular static files from `../client/dist`
    - Fallback route for Angular SPA (`*` → `index.html`)
    - Create HTTP server, attach WebSocket server
    - Read port from `PORT` environment variable (default 3000)
    - _Requirements: 17.2, 15.1_

  - [x] 6.3 Write unit tests for WebSocket handler
    - Test message routing, authentication on connect, unauthorized action errors
    - Test participant join/leave broadcasts, state sync on reconnect
    - _Requirements: 15.1, 15.2, 15.3, 15.5_

- [x] 7. Implement frontend Auth Service and Login Component
  - [x] 7.1 Implement frontend AuthService
    - Create `client/src/app/services/auth.service.ts`
    - Implement `login(username, isAnonymous)` — POST to `/api/auth/login`, store token in `localStorage`
    - Implement `validateSession()` — GET `/api/auth/validate` with Authorization header
    - Implement `logout()` — POST `/api/auth/logout`, clear `localStorage`, listen for `storage` events for cross-tab logout
    - Implement `getToken()`, `getCurrentUser()` as Angular Signal
    - On init, check `localStorage` for existing token and validate
    - _Requirements: 1.2, 2.2, 3.1, 3.2, 3.3_

  - [x] 7.2 Implement LoginComponent
    - Create `client/src/app/components/login/login.component.ts` as standalone component
    - Display login form with username input field and submit button
    - Display anonymous login option with display name input field
    - Validate non-empty input, show validation error messages
    - On successful login, navigate to poker page
    - If session already exists (token in localStorage), redirect to poker page bypassing login
    - Add ARIA labels to all form inputs and buttons
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.2, 19.1, 19.2_

  - [x] 7.3 Write unit tests for LoginComponent and AuthService
    - Test form rendering, validation errors, successful login redirect
    - Test token storage in localStorage, cross-tab logout via storage events
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

- [x] 8. Implement frontend WebSocket and Session State services
  - [x] 8.1 Implement WebSocketService
    - Create `client/src/app/services/websocket.service.ts`
    - Implement `connect(token)` — open WebSocket connection with token
    - Implement `disconnect()`, `send(event, data)`, `on<T>(event)` returning Observable
    - Implement `connectionState` as Angular Signal (`'connected'`, `'disconnected'`, `'reconnecting'`)
    - Implement auto-reconnect with exponential backoff: delay = `min(2^n * 1000, 30000)` ms
    - _Requirements: 15.1, 15.4, 15.5_

  - [x] 8.2 Write property test for exponential backoff calculation
    - **Property 15: Exponential backoff calculation**
    - Generate random attempt indices (0–20), verify delay equals `min(2^n * 1000, 30000)` ms
    - **Validates: Requirements 15.4**

  - [x] 8.3 Implement SessionStateService
    - Create `client/src/app/services/session-state.service.ts`
    - Expose Angular Signals: `currentRound`, `participants`, `selections`, `isRevealed`, `metrics`, `history`, `currentUser`
    - Subscribe to WebSocket events and update state reactively
    - Handle `session:state` event for full state sync on reconnect
    - _Requirements: 15.5, 6.1, 6.2, 6.3, 9.3, 9.4, 13.1, 13.2_

  - [x] 8.4 Write unit tests for WebSocketService and SessionStateService
    - Test connection lifecycle, reconnection backoff timing, message serialization
    - Test state updates from WebSocket events, full state sync
    - _Requirements: 15.1, 15.4, 15.5_

- [x] 9. Implement frontend PokerPage, CardDeck, and Board components
  - [x] 9.1 Implement PokerPageComponent
    - Create `client/src/app/components/poker-page/poker-page.component.ts` as standalone component
    - Main layout container composing: CardDeckComponent, BoardComponent, StoryManagerComponent, MetricsComponent, SessionHistoryComponent, ProfileComponent
    - Subscribe to SessionStateService for reactive state
    - Set up Angular routing: `/login` → LoginComponent, `/poker` → PokerPageComponent, default redirect
    - Add route guard to redirect unauthenticated users to login
    - _Requirements: 4.1, 16.1_

  - [x] 9.2 Implement CardDeckComponent
    - Create `client/src/app/components/card-deck/card-deck.component.ts` as standalone component
    - Render 14 cards (11 numeric: 0,1,2,3,5,8,13,21,34,55,89 + 3 special: Coffee, ?, Break)
    - Each card is a distinct, tappable element with value clearly visible
    - Highlight currently selected card
    - Disable all cards when no voting round is active
    - On card tap, emit selection to WebSocketService (`card:select` event)
    - Add ARIA labels for each card, support keyboard navigation (Tab + Enter/Space to select)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 8.1, 8.2, 8.4, 19.1, 19.2_

  - [x] 9.3 Implement BoardComponent
    - Create `client/src/app/components/board/board.component.ts` as standalone component
    - Display one card placeholder per connected participant in a responsive grid/row layout
    - Face-down state: show participant display name only, indicate "voted" status without revealing value
    - Face-up state (after reveal): show selected card value or "No Vote"
    - Trigger Card_Flip_Animation on reveal event
    - Announce card state changes to screen readers using ARIA live regions
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 9.3, 9.4, 19.1, 19.3_

  - [x] 9.4 Write property test for board participant count invariant
    - **Property 3: Board participant count invariant**
    - Generate random participant lists (1–50), verify the number of card placeholders equals the number of participants
    - **Validates: Requirements 6.1**

  - [x] 9.5 Write property test for pre-reveal card value secrecy
    - **Property 4: Pre-reveal card value secrecy**
    - Generate random selections during an active unrevealed round, verify board state visible to other users contains no card values — only "voted" indicators and display names
    - **Validates: Requirements 6.2, 6.3, 8.3**

  - [x] 9.6 Write property test for post-reveal card display completeness
    - **Property 7: Post-reveal card display completeness**
    - Generate participants with optional selections, verify after reveal every card shows either the selected value or "No Vote"
    - **Validates: Requirements 9.3, 9.4**

  - [x] 9.7 Write unit tests for CardDeckComponent and BoardComponent
    - Test card rendering (14 cards), selection highlighting, disabled state
    - Test participant placeholders, face-down/face-up states, "No Vote" display
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 9.3, 9.4_

- [x] 10. Implement Card Flip Animation
  - [x] 10.1 Implement Card_Flip_Animation
    - Create CSS/TypeScript animation for 3D card flip along vertical axis
    - Animation duration: 600ms per card
    - Use CSS `transform: rotateY()` with `perspective` for 3D effect
    - Respect `prefers-reduced-motion` media query — skip animation and show values immediately when enabled
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 10.2 Write unit tests for Card Flip Animation
    - Test animation triggers on reveal, completes within 600ms
    - Test reduced-motion preference skips animation
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 11. Implement StoryManager, Metrics, SessionHistory, and Profile components
  - [x] 11.1 Implement StoryManagerComponent (Moderator only)
    - Create `client/src/app/components/story-manager/story-manager.component.ts` as standalone component
    - Text input for story description with non-empty validation
    - "Reveal Cards" button — enabled only during active voting round
    - "Clear Board" button — enabled only after cards are revealed
    - Send `story:submit`, `cards:reveal`, `board:clear` events via WebSocketService
    - Show/hide based on user role (Moderator only)
    - Add ARIA labels and keyboard support for all controls
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 9.1, 12.1, 12.3, 12.4, 19.1, 19.2_

  - [x] 11.2 Implement MetricsComponent
    - Create `client/src/app/components/metrics/metrics.component.ts` as standalone component
    - Display after card reveal: average, mode, spread, distribution chart, outlier highlights
    - Show "insufficient data" message when fewer than 2 numeric votes
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 11.3 Implement SessionHistoryComponent
    - Create `client/src/app/components/session-history/session-history.component.ts` as standalone component
    - Vertical sidebar listing completed voting rounds (story description, average, mode)
    - New entries prepended to top of list
    - Expandable detail view with individual participant votes and full metrics
    - "Clear History" button with confirmation dialog (Moderator only)
    - Send `history:clear` event via WebSocketService on confirmed clear
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 14.1, 14.2, 14.3, 14.4_

  - [x] 11.4 Implement ProfileComponent
    - Create `client/src/app/components/profile/profile.component.ts` as standalone component
    - Display current username and role
    - Toggle to switch between Moderator and Participant roles
    - Send `role:change` event via WebSocketService on role switch
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 11.5 Write property test for role change round-trip
    - **Property 2: Role change round-trip**
    - Generate random users, change role from participant to moderator and back, verify original role state is restored
    - **Validates: Requirements 4.3, 4.4**

  - [x] 11.6 Write unit tests for StoryManager, Metrics, SessionHistory, and Profile components
    - Test story input validation, button enable/disable states
    - Test metric display, insufficient data message, outlier highlighting
    - Test history entry listing, detail expansion, clear with confirmation dialog
    - Test role display and toggle
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 9.1, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 4.1, 4.2, 4.3, 4.4_

- [x] 12. Checkpoint — Core features complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement responsive design
  - [x] 13.1 Add responsive layout styles
    - Ensure Scrum Poker page renders correctly on viewport widths from 320px to 2560px
    - For viewports < 768px: reflow CardDeck into a scrollable horizontal strip or wrapped grid
    - For viewports < 768px: collapse SessionHistory sidebar into an expandable overlay or bottom sheet
    - Ensure all interactive elements have minimum 44x44 CSS pixel tap targets
    - Test on latest Chrome, Firefox, Safari, and Edge
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 13.2 Write unit tests for responsive layout
    - Test card deck reflow at mobile breakpoint
    - Test sidebar collapse behavior
    - Test tap target minimum sizes
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

- [x] 14. Implement accessibility compliance
  - [x] 14.1 Add ARIA labels, keyboard navigation, live regions, and contrast
    - Audit all interactive elements for ARIA labels (cards, buttons, form inputs)
    - Ensure full keyboard navigation: Tab through cards, Enter/Space to select, Tab to buttons
    - Add ARIA live regions for card state changes (selected, revealed, reset) to announce to screen readers
    - Verify minimum 4.5:1 color contrast ratio for all text content (WCAG 2.1 Level AA)
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [x] 14.2 Write accessibility tests
    - Integrate `axe-core` into test suite for automated ARIA audit
    - Test keyboard navigation flows for card selection, story submission, and board actions
    - Verify ARIA live region announcements on card state changes
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

- [x] 15. Checkpoint — Frontend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Docker containerization
  - [x] 16.1 Create Dockerfile with multi-stage build
    - Stage 1: Build Angular frontend (`npm run build`)
    - Stage 2: Build Node.js backend (compile TypeScript)
    - Stage 3: Production image — copy compiled backend + Angular dist, install production dependencies only
    - Serve Angular static files and run Node.js backend on a single configurable port (`PORT` env var)
    - Exclude dev dependencies, source maps, and test files from final image
    - Build command should be: docker build -t siddhivinayaksk/scrum-pocker .
    - Push image to docker repo: docker push siddhivinayaksk/scrum-pocker:latest
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

  - [x] 16.2 Write smoke tests for Docker build
    - Verify Docker image builds successfully
    - Verify final image does not contain dev dependencies, source maps, or test files
    - _Requirements: 17.3, 17.4_

- [x] 17. Kubernetes deployment manifests
  - [x] 17.1 Create Kubernetes Deployment and Service manifests
    - Create `k8s/deployment.yaml` — define Deployment with container image, resource requests/limits for CPU and memory
    - Configure readiness probe and liveness probe (HTTP GET to health endpoint)
    - Create `k8s/service.yaml` — expose application on port 80 using ClusterIP or LoadBalancer service type
    - Add a health check endpoint (`/api/health`) to the Express server
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [x] 17.2 Write smoke tests for Kubernetes manifests
    - Validate manifests with `kubectl apply --dry-run=client`
    - Verify health check endpoint responds correctly
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

- [x] 18. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Implement global theme and CSS custom properties
  - [x] 19.1 Define CSS custom property color palette in `client/src/styles.scss`
    - Add all CSS custom properties on `:root` as specified in the design: primary, secondary, accent palettes, gradient definitions, surface colors, text colors, toast colors, card value color scale (cool→warm), special card accent colors, and shadow tokens
    - Include `--gradient-primary`, `--gradient-page-bg`, and all `--surface-*` variables
    - Include `--card-color-0` through `--card-color-89` for numeric cards and `--card-color-coffee`, `--card-color-no-clue`, `--card-color-break` for special cards
    - Include `--toast-error`, `--toast-warning`, `--toast-info` color variables
    - Include `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-card`, `--shadow-card-hover`, `--shadow-card-selected` shadow tokens
    - _Requirements: 20.1, 20.4_

- [x] 20. Update CardDeckComponent with styling, color coding, labels, and animations
  - [x] 20.1 Add value-based color coding and card styling to CardDeckComponent
    - Implement `CARD_COLOR_MAP` and `SPECIAL_CARD_COLOR_MAP` as specified in the design to map each card value to its CSS custom property color
    - Implement `getCardColor(value: CardValue)` pure function
    - Style each unselected card with colored border (using its mapped color), gradient or solid background fill, rounded corners (`border-radius: 12px`), and subtle shadow (`--shadow-card`)
    - Style selected cards with distinct background, prominent border highlight, and elevated shadow (`--shadow-card-selected`)
    - Apply cooler tones (blues, greens) for lower numeric values (0–3) and warmer tones (oranges, reds) for higher values (34–89)
    - Style special cards (Coffee, No Clue, Break) with their unique accent colors (`--card-color-coffee`, `--card-color-no-clue`, `--card-color-break`)
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

  - [x] 20.2 Add special card text labels
    - Implement `SPECIAL_CARD_LABELS` mapping as specified in the design: `'coffee' → { icon: '☕', label: 'Coffee' }`, `'no-clue' → { icon: '?', label: 'Unknown' }`, `'break' → { icon: '⏸', label: 'Break' }`
    - Render each special card with the icon and a text label below it in a smaller font size than the icon
    - Include the label text in the ARIA label for each special card
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5_

  - [x] 20.3 Add hover effects to cards
    - On hover over an unselected card, apply slight elevation change (transition to `--shadow-card-hover`) and border color shift within 100ms
    - Use CSS `transition` for smooth hover effect
    - _Requirements: 21.5_

  - [x] 20.4 Implement card selection animation
    - Add CSS class `.card-deck__card--selected` with `transform: translateY(-20px) scale(1.05)`, `transition: transform 300ms ease-out, box-shadow 300ms ease-out, border-color 300ms ease-out`, and `box-shadow: var(--shadow-card-selected)`
    - Add deselection transition on `.card-deck__card:not(.card-deck__card--selected)` with matching 300ms ease-out timing
    - When selecting a different card, animate the previously selected card back to resting position and the newly selected card upward simultaneously
    - Add `@media (prefers-reduced-motion: reduce)` rule to disable transitions while preserving visual state changes (color, border)
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_

  - [x] 20.5 Write property test for card value-to-color monotonicity
    - **Property 16: Card value-to-color monotonicity**
    - Generate pairs of numeric card values `(a, b)` where `a < b`, verify the Fibonacci index of `a` maps to a lower (cooler) index in the color scale than `b`
    - Use generator: `fc.tuple(fc.constantFrom(...FIBONACCI_SEQUENCE), fc.constantFrom(...FIBONACCI_SEQUENCE)).filter(([a, b]) => a < b)`
    - **Validates: Requirements 21.3**

  - [x] 20.6 Write property test for card text-background contrast ratio
    - **Property 17: Card text-background contrast ratio**
    - Generate card values and visual states (unselected, selected, hovered, disabled), compute contrast ratio between text and background colors, verify >= 4.5:1
    - Use generator: `fc.tuple(fc.constantFrom(...ALL_CARDS), fc.constantFrom('unselected', 'selected', 'hovered', 'disabled'))`
    - **Validates: Requirements 21.6**

  - [x] 20.7 Write unit tests for CardDeckComponent styling, labels, and animations
    - Test value-based color coding: verify lower values get cooler colors, higher values get warmer colors
    - Test special card labels: verify "Coffee", "Unknown", "Break" labels are rendered below icons
    - Test hover effect: verify elevation and border color change on hover
    - Test selection animation: verify translateY(-20px) and scale(1.05) applied on selected card
    - Test reduced-motion: verify transitions are disabled but visual states still apply
    - Test ARIA labels include special card label text
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 22.1, 22.2, 22.3, 22.4, 22.5, 26.1, 26.2, 26.3, 26.4, 26.5_

- [x] 21. Update BoardComponent with board clear animation
  - [x] 21.1 Implement board clear animation
    - Add CSS class `.board__card--clearing` with `animation: boardCardClear 400ms ease-in forwards`
    - Define `@keyframes boardCardClear` with fade-out (opacity 1→0) and downward slide (translateY 0→30px)
    - Apply stagger delay dynamically: each card's `animation-delay` = `index * 50ms` via `[style.animation-delay]`
    - After the last card's animation completes (total duration = `400 + (n-1) * 50` ms), reset the board to its initial empty state
    - Add `@media (prefers-reduced-motion: reduce)` rule to skip animation and reset board immediately
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_

  - [x] 21.2 Write property test for board clear animation stagger delay
    - **Property 19: Board clear animation stagger delay**
    - Generate random card counts (1–50), verify card at index `i` has animation delay of `i * 50` milliseconds
    - Use generator: `fc.integer({ min: 1, max: 50 })`
    - **Validates: Requirements 24.3**

  - [x] 21.3 Write unit tests for board clear animation
    - Test clearing animation class is applied to each card on board clear
    - Test stagger delay values are correctly computed (index * 50ms)
    - Test board resets to initial empty state after animation completes
    - Test reduced-motion preference skips animation and resets immediately
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_

- [x] 22. Checkpoint — Card and board styling complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Create UserMenuComponent replacing ProfileComponent
  - [x] 23.1 Implement UserMenuComponent
    - Create `client/src/app/components/user-menu/user-menu.component.ts` as standalone component
    - Display a circular avatar icon showing the first letter of the user's display name (uppercase) inside a colored circle
    - Implement `getAvatarLetter(displayName: string)` returning `displayName.charAt(0).toUpperCase()`
    - On avatar click, open a dropdown menu containing: user display name, current role label, role switch option, logout option
    - Close dropdown when clicking outside the menu or pressing Escape key
    - Role switch sends `role:change` event via WebSocketService
    - Logout calls `AuthService.logout()` and redirects to login page
    - Keyboard accessible: open with Enter/Space, navigate with arrow keys, select with Enter
    - ARIA support: avatar button has `aria-label`, menu uses `role="menu"` and `role="menuitem"` patterns
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7_

  - [x] 23.2 Replace ProfileComponent with UserMenuComponent in PokerPageComponent
    - Update `client/src/app/components/poker-page/poker-page.component.ts` to import and render `UserMenuComponent` in the header area instead of `ProfileComponent`
    - Remove `ProfileComponent` from the PokerPageComponent template
    - _Requirements: 23.1, 23.2_

  - [x] 23.3 Write property test for avatar first-letter extraction
    - **Property 18: Avatar first-letter extraction**
    - Generate random non-empty display names, verify avatar letter equals the uppercase form of the first character
    - Use generator: `fc.string({ minLength: 1, maxLength: 50 })`
    - **Validates: Requirements 23.1**

  - [x] 23.4 Write unit tests for UserMenuComponent
    - Test avatar renders first letter of display name in uppercase
    - Test dropdown opens on avatar click and closes on outside click and Escape key
    - Test role switch option sends `role:change` WebSocket event
    - Test logout option calls AuthService.logout() and redirects to login
    - Test keyboard navigation: Enter/Space opens menu, arrow keys navigate, Enter selects
    - Test ARIA labels on avatar button and all menu options
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7_

- [x] 24. Create ToastService and ToastComponent
  - [x] 24.1 Implement ToastService
    - Create `client/src/app/services/toast.service.ts`
    - Implement `show(type: ToastType, message: string)` — create `ToastMessage` with UUID, add to queue
    - Implement `dismiss(id: string)` — remove toast from queue
    - Expose `toasts` as Angular Signal of `ToastMessage[]`
    - Auto-dismiss each toast after 5 seconds
    - Enforce maximum 3 visible toasts; remove oldest when a 4th is added
    - _Requirements: 25.5, 25.6_

  - [x] 24.2 Implement ToastComponent
    - Create `client/src/app/components/toast/toast.component.ts` as standalone component
    - Position toasts in top-right corner of viewport using fixed positioning
    - Stack multiple toasts vertically
    - Color-code by type: red accent (`--toast-error`) for errors, amber (`--toast-warning`) for warnings, blue (`--toast-info`) for informational
    - Include manual dismiss button on each toast
    - Add ARIA live region (`aria-live="assertive"` for errors, `aria-live="polite"` for info/warning) for screen reader announcements
    - _Requirements: 25.5, 25.6, 25.7, 25.8_

  - [x] 24.3 Write property test for toast maximum visible count
    - **Property 20: Toast maximum visible count**
    - Generate random sequences of toast additions (1–10), verify at most 3 visible toasts at any time; when a 4th is added, the oldest is removed
    - Use generator: `fc.array(fc.record({ type: fc.constantFrom('error', 'warning', 'info'), message: fc.string({ minLength: 1 }) }), { minLength: 1, maxLength: 10 })`
    - **Validates: Requirements 25.6**

  - [x] 24.4 Write unit tests for ToastService and ToastComponent
    - Test toast creation with correct type and message
    - Test auto-dismiss after 5 seconds
    - Test manual dismiss before timeout
    - Test max 3 visible toasts (oldest removed when 4th added)
    - Test color coding: red for error, amber for warning, blue for info
    - Test ARIA live region announcements
    - Test toast positioning in top-right corner
    - _Requirements: 25.5, 25.6, 25.7, 25.8_

- [x] 25. Integrate toast notifications into services
  - [x] 25.1 Integrate ToastService into WebSocketService
    - Inject `ToastService` into `WebSocketService`
    - Call `ToastService.show('error', ...)` on WebSocket connection failure with descriptive message indicating connection issue and reconnection status
    - Call `ToastService.show('error', ...)` on card selection transmission failure informing participant the vote was not recorded
    - Call `ToastService.show('warning', ...)` during reconnection attempts with "Reconnecting..." status
    - _Requirements: 25.1, 25.2_

  - [x] 25.2 Integrate ToastService into AuthService
    - Inject `ToastService` into `AuthService`
    - Call `ToastService.show('error', ...)` on authentication request failures (login or session validation) with descriptive error message
    - _Requirements: 25.3_

  - [x] 25.3 Integrate ToastService into SessionStateService
    - Inject `ToastService` into `SessionStateService`
    - Call `ToastService.show('error', ...)` when receiving `error` events from the server (unauthorized actions, etc.) informing user the action is not permitted
    - _Requirements: 25.4_

  - [x] 25.4 Add ToastComponent to the app root
    - Add `ToastComponent` to the root `AppComponent` or `PokerPageComponent` so toasts render globally across all pages
    - _Requirements: 25.6_

- [x] 26. Update LoginComponent and PokerPageComponent with theme styling
  - [x] 26.1 Apply theme styling to LoginComponent
    - Update `client/src/app/components/login/login.component.scss` to use CSS custom properties
    - Apply gradient background, styled input fields with themed borders and focus states, visually prominent submit button using `--color-primary` and `--gradient-primary`, branded header area
    - Ensure reduced-motion preference still applies full color theme without motion effects
    - _Requirements: 20.1, 20.5, 20.6, 20.7_

  - [x] 26.2 Apply theme styling to PokerPageComponent
    - Update `client/src/app/components/poker-page/poker-page.component.ts` styles
    - Apply `--gradient-page-bg` as the page background
    - Wrap each section (Card_Deck, Board, Metrics, Story input) in styled containers with distinct `--surface-*` background colors, `border-radius: 12px`, and subtle box shadows (`--shadow-md`)
    - Style all buttons with themed backgrounds, hover transitions, and active state feedback
    - _Requirements: 20.2, 20.3, 20.5_

  - [x] 26.3 Write unit tests for theme application
    - Test CSS custom properties are defined on `:root`
    - Test LoginComponent uses themed styles (gradient background, styled inputs, themed button)
    - Test PokerPageComponent uses gradient page background and styled section containers
    - Test reduced-motion preference preserves full color theme
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

- [x] 27. Final checkpoint — UI/UX improvements complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests use `fast-check` library and validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design specifies TypeScript for both backend (Node.js) and frontend (Angular)
- Tasks 19–27 implement UI/UX improvements for Requirements 20–26 and Correctness Properties 16–20
