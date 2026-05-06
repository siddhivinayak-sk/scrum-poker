# Implementation Plan: Multi-Team Sessions

## Overview

This plan extends the existing Scrum Poker application from a single shared session to a multi-team session architecture. Tasks are ordered by dependency: shared types first, then backend services, then backend routes/WebSocket, then frontend services, then frontend components, then integration wiring. Each task builds on previous tasks so there is no orphaned code.

## Tasks

- [x] 1. Extend shared types for multi-session support
  - [x] 1.1 Add voting system types, session configuration, and permission types to `shared/types.ts`
    - Add `VotingSystemType` union type (`'fibonacci' | 'modified-fibonacci' | 't-shirt' | 'power-of-2'`)
    - Add `VOTING_SYSTEMS` constant mapping each `VotingSystemType` to its array of card values
    - Add `ExtendedCardValue` type to cover all voting system values
    - Add `PermissionMode` type (`'moderator-only' | 'all-players' | 'select-specific'`)
    - Add `PermissionConfig` interface with `mode` and `allowedUserIds` fields
    - Add `SessionConfiguration` interface with `votingSystem`, `revealPermission`, `issuePermission`, `autoReveal`, `countdownAnimation` fields
    - Add `DEFAULT_SESSION_CONFIG` constant
    - Add `GameSessionState` interface extending `SessionState` with `sessionId`, `config`, `ownerId`, `createdAt`
    - Add `SessionInfo` interface for REST API responses
    - Add optional `votingDurationMs` field to `VotingRound` and `HistoryEntry` interfaces
    - Add `SPECIAL_CARDS` export if not already exported, and add `getCardsForVotingSystem` helper function
    - Add `hasPermission` function for permission evaluation logic
    - _Requirements: 1.5, 5.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 8.1, 8.2, 9.1, 9.2, 10.1, 10.2, 11.1, 11.2, 12.4, 12.5_

  - [x] 1.2 Write property test for voting system card mapping (Property 5)
    - **Property 5: Voting system card mapping**
    - For any voting system type, `getCardsForVotingSystem` returns exactly the defined card values plus the three special cards, with no duplicates and no missing values
    - Use `fc.constantFrom('fibonacci', 'modified-fibonacci', 't-shirt', 'power-of-2')` generator
    - Place test in `server/src/services/__tests__/shared-types.property.test.ts`
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7**

  - [x] 1.3 Write property test for permission evaluation (Property 6)
    - **Property 6: Permission evaluation correctness**
    - For any user with a role and any permission configuration, `hasPermission` returns true iff the specification conditions are met
    - Use `fc.record({ role, userId, mode, allowedIds })` generator
    - Place test in `server/src/services/__tests__/shared-types.property.test.ts`
    - **Validates: Requirements 8.3, 8.4, 8.5, 9.3, 9.4, 9.5**

  - [x] 1.4 Write property test for timer format display (Property 9)
    - **Property 9: Timer format display**
    - For any non-negative duration in milliseconds, `formatDuration` produces `MM:SS` format with zero-padded minutes and seconds
    - Use `fc.integer({ min: 0, max: 5999000 })` generator
    - Place test in `server/src/services/__tests__/shared-types.property.test.ts`
    - **Validates: Requirements 12.5**

- [x] 2. Implement backend GameSession class
  - [x] 2.1 Create `server/src/services/game-session.ts` — refactor SessionManager logic into a class
    - Create `GameSession` class with constructor accepting `sessionId`, `ownerId`, `config: SessionConfiguration`
    - Move all session-manager.ts logic (addParticipant, removeParticipant, getParticipants, startRound, getCurrentRound, selectCard, getSelections, revealCards, clearBoard, getHistory, clearHistory, getSessionState) into instance methods
    - Add `config` property and `updateConfig(partial)` method that merges partial updates
    - Add `lastActivityAt` timestamp updated on every state-changing operation
    - Add `getParticipantCount()` method
    - Add `checkAutoReveal()` method: returns true if `config.autoReveal` is true AND every participant has a selection in the current round
    - Add `hasPermission(userId, permission)` method using the shared `hasPermission` function with the user's role from participants
    - Add `getSessionState()` returning `GameSessionState` with sessionId, config, ownerId, createdAt
    - Compute `votingDurationMs` on `revealCards()` and include in `HistoryEntry` on `clearBoard()`
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 7.8, 8.3, 8.4, 8.5, 9.3, 9.4, 9.5, 10.3, 10.5, 12.3, 12.4_

  - [x] 2.2 Write property test for auto-reveal trigger logic (Property 7)
    - **Property 7: Auto-reveal trigger logic**
    - For any game session with participants and selections, `checkAutoReveal` returns true iff auto-reveal is enabled AND every participant has voted
    - Use generators for participant IDs, selection subsets, and auto-reveal flag
    - Place test in `server/src/services/__tests__/game-session.property.test.ts`
    - **Validates: Requirements 10.3, 10.5**

  - [x] 2.3 Write property test for voting duration computation (Property 8)
    - **Property 8: Voting duration computation**
    - For any valid startedAt/revealedAt timestamp pair, `votingDurationMs` equals the millisecond difference, and this value is included in the history entry
    - Use generators for start timestamps and duration offsets
    - Place test in `server/src/services/__tests__/game-session.property.test.ts`
    - **Validates: Requirements 12.3, 12.4**

  - [x] 2.4 Write property test for config update persistence (Property 10)
    - **Property 10: Session configuration update persistence**
    - For any initial config and sequence of partial updates, the final config reflects the last value set for each field with unchanged fields retaining previous values
    - Use generators for initial configs and arrays of partial config updates
    - Place test in `server/src/services/__tests__/game-session.property.test.ts`
    - **Validates: Requirements 14.2, 14.5**

  - [x] 2.5 Write unit tests for GameSession class
    - Test all instance methods: addParticipant, removeParticipant, startRound, selectCard, revealCards, clearBoard, getHistory, clearHistory
    - Test auto-reveal check with various participant/selection combinations
    - Test permission evaluation for all three modes
    - Test config update merging
    - Test voting duration computation
    - Test state transitions and error conditions
    - Place test in `server/src/services/__tests__/game-session.test.ts`
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 10.3, 10.5, 12.3, 12.4, 14.5_

- [x] 3. Implement backend SessionRegistry
  - [x] 3.1 Create `server/src/services/session-registry.ts`
    - Implement `SessionRegistry` class with a `Map<string, GameSession>` store
    - Implement `createSession(ownerId, config)`: generate unique 8-char base-36 session ID, create GameSession, return GameSessionInfo
    - Implement `getSession(sessionId)`, `deleteSession(sessionId)`, `hasSession(sessionId)`, `getActiveSessionCount()`
    - Implement `updateSessionConfig(sessionId, partialConfig)` that delegates to GameSession.updateConfig
    - Implement `startCleanupTimer()` / `stopCleanupTimer()`: runs every 5 minutes, removes sessions with 0 participants and lastActivityAt > 30 minutes ago
    - Ensure `startCleanupTimer` is idempotent
    - Export a singleton instance for use by routes and WebSocket handler
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 6.1, 6.2, 6.3, 16.1, 16.2, 16.4_

  - [x] 3.2 Write property test for session creation uniqueness (Property 1)
    - **Property 1: Session creation produces unique IDs with correct owner**
    - For any sequence of N creation requests, all session IDs are distinct, each session is retrievable, and each session's ownerId matches the creator
    - Use `fc.array(fc.record({ ownerId: fc.uuid(), config: arbSessionConfig() }))` generator
    - Place test in `server/src/services/__tests__/session-registry.property.test.ts`
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x] 3.3 Write property test for session state isolation (Property 2)
    - **Property 2: Session state isolation**
    - For any two distinct sessions, operations on one session do not change the other session's participants, round state, or history
    - Use generators for two sessions with random operation sequences
    - Place test in `server/src/services/__tests__/session-registry.property.test.ts`
    - **Validates: Requirements 1.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3**

  - [x] 3.4 Write unit tests for SessionRegistry
    - Test session creation, retrieval, deletion, existence check
    - Test session ID uniqueness across multiple creations
    - Test cleanup timer removes inactive sessions after 30 minutes with 0 participants
    - Test cleanup timer skips sessions with active participants
    - Test concurrent session support (multiple active sessions)
    - Test config update delegation
    - Place test in `server/src/services/__tests__/session-registry.test.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 6.1, 6.2, 6.3, 16.1, 16.2, 16.4_

- [x] 4. Checkpoint — Verify backend services
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement session REST routes
  - [x] 5.1 Create `server/src/routes/sessions.ts` with session CRUD endpoints
    - POST `/api/sessions` — create session (requires auth token in Authorization header, extracts ownerId from token)
    - GET `/api/sessions/:sessionId` — get session info (requires auth)
    - PUT `/api/sessions/:sessionId/config` — update session config (requires auth, must be owner or moderator)
    - GET `/api/sessions/:sessionId/exists` — lightweight existence check (no auth required)
    - Validate request bodies, return appropriate HTTP status codes (400, 403, 404)
    - _Requirements: 1.1, 1.4, 4.5, 14.1, 14.2, 14.5_

  - [x] 5.2 Register session routes in `server/src/server.ts`
    - Import and mount `sessionsRouter` at `/api/sessions`
    - Start the session registry cleanup timer on server startup
    - _Requirements: 6.1, 16.4_

  - [x] 5.3 Write unit tests for session REST routes
    - Test POST /api/sessions with valid config, invalid config, missing auth
    - Test GET /api/sessions/:id for existing and non-existing sessions
    - Test PUT /api/sessions/:id/config for valid update, unauthorized user, invalid config
    - Test GET /api/sessions/:id/exists for existing and non-existing sessions
    - Place test in `server/src/routes/__tests__/sessions.test.ts`
    - _Requirements: 1.1, 1.4, 4.5, 14.1, 14.2_

- [x] 6. Update backend WebSocket handler for session scoping
  - [x] 6.1 Modify `server/src/websocket/handler.ts` for session-scoped connections
    - Parse `sessionId` from WebSocket connection query parameters alongside `token`
    - Validate session exists via `SessionRegistry.hasSession()` before accepting connection
    - Reject connections with invalid session ID using close code 4004
    - Change client map structure to `Map<string, Map<string, Set<WebSocket>>>` (sessionId → userId → sockets)
    - Implement `broadcastToSession(sessionId, event, data)` replacing global `broadcast`
    - Implement `sendToUserInSession(sessionId, userId, event, data)` replacing global `sendTo`
    - Route all events through `SessionRegistry.getSession(sessionId)` instead of the module-level `sessionManager`
    - Update `handleEvent` to use the session's `GameSession` instance for all operations
    - Add permission checks using `GameSession.hasPermission()` for `story:submit` and `cards:reveal`
    - Add auto-reveal check after `card:select`: if `checkAutoReveal()` returns true, trigger reveal with optional countdown flag
    - Broadcast `session:config-updated` event when config changes
    - Handle `auto:reveal-triggered` event with countdown flag from session config
    - Update disconnect handler to remove participant from the correct GameSession and clean up session client map
    - _Requirements: 5.4, 5.5, 8.3, 8.4, 8.5, 9.3, 9.4, 9.5, 10.3, 10.4, 10.5, 15.1, 15.2, 15.3, 15.4, 15.5_

  - [x] 6.2 Write property test for WebSocket broadcast isolation (Property 3)
    - **Property 3: WebSocket broadcast isolation**
    - For any event broadcast within a session, only connections in that session receive it; connections in other sessions do not
    - Use generators for multiple sessions with random client counts
    - Place test in `server/src/websocket/__tests__/handler.property.test.ts`
    - **Validates: Requirements 5.4, 5.5, 15.4, 15.5**

  - [x] 6.3 Write unit tests for updated WebSocket handler
    - Test session-scoped connection with valid session ID
    - Test rejection of connection with invalid/missing session ID
    - Test event routing to correct GameSession
    - Test broadcast isolation between sessions
    - Test permission-based event handling (reveal, story submit)
    - Test auto-reveal trigger after last vote
    - Test disconnect cleanup within session scope
    - Place test in `server/src/websocket/__tests__/handler.test.ts` (update existing)
    - _Requirements: 5.4, 5.5, 10.3, 10.4, 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 7. Checkpoint — Verify full backend
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Update frontend services for session support
  - [x] 8.1 Update `WebSocketService` to accept optional `sessionId` parameter
    - Modify `connect(token: string, sessionId?: string)` signature
    - Include `sessionId` in WebSocket connection URL as query parameter when provided
    - Connection URL becomes `ws://host?token={token}&sessionId={sessionId}`
    - _Requirements: 15.1, 15.2_

  - [x] 8.2 Update `SessionStateService` with session configuration signals
    - Add `_sessionConfig` signal of type `SessionConfiguration | null`
    - Add `_votingTimer` signal for timer state
    - Add `_countdownActive` signal (boolean)
    - Add computed `hasRevealPermission` signal using `hasPermission` logic with current user and session config's `revealPermission`
    - Add computed `hasIssuePermission` signal using `hasPermission` logic with current user and session config's `issuePermission`
    - Add computed `votingSystemCards` signal that returns the card set for the current voting system
    - Subscribe to `session:config-updated` WebSocket event to update `_sessionConfig`
    - Subscribe to `auto:reveal-triggered` event to set `_countdownActive`
    - Extract session config from `session:state` event data (now `GameSessionState`)
    - Expose all new signals as readonly
    - _Requirements: 7.7, 7.8, 8.3, 8.4, 8.5, 9.3, 9.4, 9.5, 10.3, 14.2, 14.3_

  - [x] 8.3 Update `AuthService` with `returnTo` redirect support
    - Add `returnTo` parameter storage in `sessionStorage` during login flow
    - Add `getReturnTo()` method that reads and clears the stored returnTo path
    - Add `setReturnTo(path: string)` method
    - _Requirements: 4.2, 4.3_

  - [x] 8.4 Write unit tests for updated frontend services
    - Test WebSocketService connection URL includes sessionId when provided
    - Test SessionStateService session config signal updates on `session:config-updated`
    - Test SessionStateService permission computed signals for all permission modes
    - Test AuthService returnTo storage and retrieval
    - Update existing tests in `client/src/app/services/` as needed
    - _Requirements: 4.2, 4.3, 7.7, 8.3, 8.4, 9.3, 9.4, 14.2, 15.1, 15.2_

- [x] 9. Implement frontend routing and guards
  - [x] 9.1 Create `sessionAuthGuard` in `client/src/app/guards/session-auth.guard.ts`
    - Check if user is authenticated (same logic as existing `authGuard`)
    - If not authenticated, extract `sessionId` from route params and redirect to `/login?returnTo=/session/{sessionId}`
    - Store `returnTo` path via `AuthService.setReturnTo()`
    - _Requirements: 4.1, 4.2_

  - [x] 9.2 Update `client/src/app/app.routes.ts` with new routes
    - Add `/create-session` route with lazy-loaded `SessionCreatePageComponent`, guarded by `authGuard`
    - Add `/session/:sessionId` route with lazy-loaded `SessionPokerPageComponent`, guarded by `sessionAuthGuard`
    - Change existing `/poker` route to `redirectTo: 'create-session'`
    - Keep wildcard and root redirects
    - _Requirements: 1.4, 4.1, 4.4, 13.1, 13.4, 13.5_

  - [x] 9.3 Write property test for session link redirect (Property 11)
    - **Property 11: Unauthenticated session link redirect preserves session ID**
    - For any session ID, the redirect URL contains the original session ID as returnTo, and after login the user is redirected to `/session/{sessionId}`
    - Use `fc.stringMatching(/^[a-z0-9]{8}$/)` generator
    - Place test in `client/src/app/guards/session-auth.guard.spec.ts`
    - **Validates: Requirements 4.2**

  - [x] 9.4 Write unit tests for routing and guards
    - Test sessionAuthGuard redirects unauthenticated users with returnTo
    - Test sessionAuthGuard allows authenticated users through
    - Test route configuration resolves correctly for all new paths
    - _Requirements: 4.1, 4.2, 4.4, 13.4_

- [x] 10. Implement SessionCreatePageComponent
  - [x] 10.1 Create `client/src/app/components/session-create/session-create-page.component.ts`
    - Build form with all session configuration options:
      - Voting system dropdown (Fibonacci default, Modified Fibonacci, T-Shirt, Power of 2)
      - Reveal permission radio group (Moderator only default, All players, Select specific)
      - Issue permission radio group (Moderator only default, All players, Select specific)
      - Auto-reveal toggle (off by default)
      - Countdown animation toggle (off by default)
    - Use Angular Reactive Forms or template-driven forms
    - On submit, POST to `/api/sessions` with the configuration
    - On success, navigate to `/session/{sessionId}`
    - All form controls have labels, fieldsets group related options
    - Accessible: proper ARIA attributes, keyboard navigable
    - _Requirements: 1.1, 1.4, 7.1, 7.2, 8.1, 8.2, 9.1, 9.2, 10.1, 10.2, 11.1, 11.2, 13.1, 13.2, 13.3_

  - [x] 10.2 Write unit tests for SessionCreatePageComponent
    - Test form renders with all config options and correct defaults
    - Test form submission calls API and navigates on success
    - Test form validation
    - Test accessibility (labels, fieldsets, ARIA)
    - Place test in `client/src/app/components/session-create/session-create-page.component.spec.ts`
    - _Requirements: 7.1, 7.2, 8.1, 8.2, 9.1, 9.2, 10.1, 10.2, 11.1, 11.2, 13.1, 13.2, 13.3_

- [x] 11. Checkpoint — Verify session creation flow
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement QrCodeComponent and VotingTimerDisplay
  - [x] 12.1 Install `angularx-qrcode` dependency and create `client/src/app/components/qr-code/qr-code.component.ts`
    - Input: `url: string`
    - Use `angularx-qrcode` library to render QR code from the URL
    - Render at minimum 150×150 CSS pixels
    - Include `alt` text: "QR code for session link: {url}"
    - Reactive: regenerates when input URL changes
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 12.2 Create `client/src/app/components/voting-timer/voting-timer-display.component.ts`
    - Inputs: `startedAt: string | null`, `revealedAt: string | null`
    - Display elapsed time in `MM:SS` format
    - Update every second using `setInterval` while round is active
    - Stop when `revealedAt` is set, showing final elapsed time
    - Reset when both inputs are null (board cleared)
    - Clean up interval on destroy
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

  - [x] 12.3 Write unit tests for QrCodeComponent and VotingTimerDisplay
    - Test QrCodeComponent renders with correct URL, updates on change, minimum size, alt text
    - Test VotingTimerDisplay running timer, stops on reveal, resets on clear, MM:SS format
    - Place tests in respective component spec files
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 12.1, 12.2, 12.3, 12.5_

- [x] 13. Implement CountdownOverlay and SessionSettingsPanel
  - [x] 13.1 Create `client/src/app/components/countdown-overlay/countdown-overlay.component.ts`
    - Input: `enabled: boolean`
    - Output: `onComplete: EventEmitter<void>`
    - When triggered, display full-screen semi-transparent overlay with countdown 3, 2, 1
    - Each number displays for 1 second (total 3 seconds)
    - Respect `prefers-reduced-motion`: show static number changes without animation
    - Emit `onComplete` when countdown finishes
    - Countdown numbers announced via ARIA live region
    - _Requirements: 11.3, 11.4, 11.5, 11.6_

  - [x] 13.2 Create `client/src/app/components/session-settings/session-settings-panel.component.ts`
    - Display as collapsible panel within session page
    - Show current session configuration values
    - Allow moderator to update: voting system, permissions, auto-reveal, countdown
    - Warn when changing voting system during active round (toast notification)
    - Send PUT to `/api/sessions/{sessionId}/config` on change
    - Listen for `session:config-updated` WebSocket event to stay in sync
    - Only visible to moderators/session owner
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 13.3 Write unit tests for CountdownOverlay and SessionSettingsPanel
    - Test CountdownOverlay sequence (3, 2, 1), completion callback, reduced-motion behavior
    - Test SessionSettingsPanel displays current config, updates on change, warning on voting system change during active round
    - Place tests in respective component spec files
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 14.1, 14.2, 14.3, 14.4_

- [x] 14. Update existing frontend components for session support
  - [x] 14.1 Update `CardDeckComponent` for dynamic voting systems
    - Accept `votingSystem: VotingSystemType` input (or read from `SessionStateService.votingSystemCards`)
    - Replace hardcoded `ALL_CARDS` / `CARD_DISPLAYS` with dynamic card set from session configuration
    - Special cards (coffee, no-clue, break) always included regardless of voting system
    - Update color mapping to handle new card values (½, XS, S, M, L, XL, XXL, 4, 16, 20, 32, 40, 64, 100)
    - Regenerate `CARD_DISPLAYS` when voting system changes
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 14.3_

  - [x] 14.2 Update `StoryManagerComponent` for permission-based controls
    - Replace `isModerator()` check with `hasIssuePermission` signal from `SessionStateService` for story submission controls visibility
    - Replace moderator check for reveal button with `hasRevealPermission` signal from `SessionStateService`
    - Keep clear board as moderator-only (existing behavior)
    - _Requirements: 8.3, 8.4, 8.5, 9.3, 9.4, 9.5_

  - [x] 14.3 Update `LoginComponent` to handle `returnTo` redirect after login
    - After successful login, check `AuthService.getReturnTo()` for a stored redirect path
    - If returnTo exists, navigate to that path instead of the default route
    - If no returnTo, navigate to `/create-session` (updated default)
    - _Requirements: 4.2, 4.3, 13.1_

  - [x] 14.4 Write unit tests for updated components
    - Test CardDeckComponent renders correct cards for each voting system
    - Test CardDeckComponent always includes special cards
    - Test StoryManagerComponent shows/hides controls based on permissions
    - Test LoginComponent redirects to returnTo path after login
    - Update existing test files as needed
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 8.3, 8.4, 9.3, 9.4, 4.2, 4.3_

- [x] 15. Checkpoint — Verify updated components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Implement SessionPokerPageComponent and wire everything together
  - [x] 16.1 Create `client/src/app/components/session-poker-page/session-poker-page.component.ts`
    - Route: `/session/:sessionId` — read `sessionId` from route params
    - Connect WebSocket with both `token` and `sessionId` via updated `WebSocketService.connect(token, sessionId)`
    - Compose existing poker components: `CardDeckComponent`, `BoardComponent`, `StoryManagerComponent`, `MetricsComponent`, `SessionHistoryComponent`, `UserMenuComponent`
    - Add new components: `QrCodeComponent`, `SessionSettingsPanel`, `CountdownOverlay`, `VotingTimerDisplay`
    - Display session link with copy-to-clipboard button in header area
    - Show QR code in a collapsible panel
    - Pass session configuration to child components
    - Show countdown overlay when `countdownActive` signal is true, delay card reveal display until countdown completes
    - Show voting timer with `startedAt` and `revealedAt` from current round
    - Handle session-not-found error: display error message with link to create new session
    - Copy-to-clipboard shows confirmation toast
    - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.4, 11.3, 11.6, 12.1, 12.2, 12.3, 13.4_

  - [x] 16.2 Write property test for session link URL construction (Property 4)
    - **Property 4: Session link URL construction**
    - For any session ID and browser origin, the constructed URL equals `{origin}/session/{sessionId}`, and the session ID extracted from the path equals the original
    - Use `fc.record({ origin: fc.webUrl(), sessionId: fc.stringMatching(/^[a-z0-9]{8}$/) })` generator
    - Place test in `client/src/app/components/session-poker-page/session-poker-page.component.spec.ts`
    - **Validates: Requirements 2.1, 2.4**

  - [x] 16.3 Write unit tests for SessionPokerPageComponent
    - Test session ID extraction from route params
    - Test WebSocket connection includes session ID
    - Test session link display and copy-to-clipboard
    - Test QR code rendering with correct URL
    - Test countdown overlay integration
    - Test voting timer integration
    - Test session-not-found error display
    - Place test in `client/src/app/components/session-poker-page/session-poker-page.component.spec.ts`
    - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.4, 4.5, 11.3, 12.1, 12.2_

- [x] 17. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties from the design document (11 properties total)
- Unit tests validate specific examples and edge cases
- The existing `session-manager.ts` module-level code is preserved for backward compatibility but the new `GameSession` class replaces its usage in the WebSocket handler and routes
- All 16 requirements are covered across the implementation tasks
- All 11 correctness properties have dedicated property-based test sub-tasks
