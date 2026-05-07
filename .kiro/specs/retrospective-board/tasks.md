# Implementation Plan: Retrospective Board

## Overview

This plan implements the Retrospective Board feature following the existing project architecture: shared types in `shared/types.ts`, backend services in `server/src/services/`, REST routes in `server/src/routes/`, WebSocket handler in `server/src/websocket/`, and Angular 21 standalone components with signals in `client/src/app/`. Each task builds incrementally, starting with shared types and ending with full integration wiring.

## Tasks

- [x] 1. Define shared types and template registry
  - [x] 1.1 Add retro types to shared/types.ts
    - Add `RetroConfiguration`, `RetroTemplate`, `RetroBoard`, `RetroColumn`, `RetroCard`, `RetroComment`, `RetroSessionState` interfaces
    - Add `columnLayout` type literal `'vertical' | 'horizontal'`
    - Reuse existing `User` interface
    - _Requirements: 2.1, 2.2, 3.1, 4.1–4.8, 7.1, 8.1, 8.5, 8.6_

  - [x] 1.2 Create retro-templates.ts with all 25 templates
    - Create `server/src/services/retro-templates.ts`
    - Define all 25 `RetroTemplate` entries with id, name, and columns array
    - Export `getTemplateById(id)` and `getDefaultTemplate()` helper functions
    - Also export `RETRO_TEMPLATES` array for frontend consumption
    - _Requirements: 3.1, 3.3_

  - [x] 1.3 Write property test for template-to-columns mapping
    - **Property 3: Template-to-columns mapping**
    - Verify that for any template in the registry, creating a board produces columns matching the template definition
    - **Validates: Requirements 3.2, 7.1**

  - [x] 1.4 Write unit tests for template registry
    - Test all 25 templates are present
    - Test `getTemplateById` returns correct template
    - Test `getDefaultTemplate` returns first template
    - Test each template has non-empty columns array
    - _Requirements: 3.1_

- [x] 2. Implement RetroSession class
  - [x] 2.1 Create RetroSession class with constructor and state management
    - Create `server/src/services/retro-session.ts`
    - Implement constructor accepting sessionId, ownerId, and RetroConfiguration
    - Initialize board state from template (columns from template, empty cards)
    - Implement `getSessionState()` and `getVisibleState(userId)` methods
    - _Requirements: 2.4, 7.1, 10.1, 10.3_

  - [x] 2.2 Implement participant management methods
    - Implement `addParticipant(user)`, `removeParticipant(userId)`, `getParticipants()`, `getParticipantCount()`
    - Implement `hasDisplayName(displayName)` with case-insensitive comparison
    - Initialize votes remaining for new participants based on `maxVotesPerUser`
    - _Requirements: 6.2, 6.3_

  - [x] 2.3 Implement column operations
    - Implement `addColumn(name)` — validate non-empty, append with new UUID and order
    - Implement `removeColumn(columnId)` — remove column and all its cards
    - Implement `reorderColumns(orderedIds)` — update order based on array position
    - Implement `renameColumn(columnId, name)` — update column name
    - Reject all column operations when board is completed
    - _Requirements: 7.3, 7.4, 7.5, 19.1, 19.2, 19.3, 19.4_

  - [x] 2.4 Implement card operations
    - Implement `addCard(columnId, text, authorId, authorName)` — create card with UUID, order, timestamp
    - Implement `editCard(cardId, text, userId)` — validate author or moderator, reject if completed
    - Implement `removeCard(cardId, userId)` — validate author or moderator, reject if completed
    - Implement `moveCard(cardId, targetColumnId, targetIndex)` — move between/within columns
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.8, 8.9, 11.4_

  - [x] 2.5 Implement voting system
    - Implement `voteCard(cardId, userId)` — increment votes, decrement remaining, enforce limits
    - Implement `unvoteCard(cardId, userId)` — reverse a vote
    - Implement `getVotesRemaining(userId)` — return remaining vote count
    - Enforce `oneVotePerCard` configuration
    - Enforce `disableVotingInitially` — reject votes when voting disabled
    - Reject votes when remaining votes equals 0
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 2.6 Implement comment operations
    - Implement `addComment(cardId, text, authorId, authorName)` — create comment with UUID and timestamp
    - Implement `removeComment(cardId, commentId, userId)` — validate author or moderator
    - Reject comment operations when board is completed
    - _Requirements: 8.6, 11.4_

  - [x] 2.7 Implement moderator controls
    - Implement `revealCards()` — set `cardsRevealed = true`
    - Implement `enableVoting()` — set `votingEnabled = true`
    - Implement `completeBoard()` — set `isCompleted = true`, lock all modifications
    - Implement `updateContext(text)` — validate moderator-only, update context string
    - Implement `updateConfig(partial)` — merge partial config into current config
    - _Requirements: 10.2, 11.1, 11.2, 11.3, 11.4, 18.1, 18.2, 18.3_

  - [x] 2.8 Implement CSV export and import
    - Implement `exportCSV()` — generate CSV with column name, card text, vote count, author, comments
    - Implement `importCSV(csvData)` — parse CSV, validate structure, create cards in matching columns
    - Throw descriptive error for malformed CSV input
    - _Requirements: 13.2, 13.3, 14.2, 14.3_

  - [x] 2.9 Write property tests for RetroSession core logic
    - **Property 1: Board name validation** — Validates: Requirements 2.1, 2.5
    - **Property 2: Max votes validation** — Validates: Requirements 2.2
    - **Property 4: Configuration toggle isolation** — Validates: Requirements 4.1–4.8
    - **Property 7: Display name case-insensitive uniqueness** — Validates: Requirements 6.2
    - **Property 8: Column addition** — Validates: Requirements 7.3, 19.1
    - **Property 9: Column removal cascades to cards** — Validates: Requirements 7.4, 19.2
    - **Property 10: Column reorder preserves cards** — Validates: Requirements 7.5, 19.3
    - **Property 11: Card addition** — Validates: Requirements 8.1
    - **Property 12: Card edit updates text** — Validates: Requirements 8.2
    - **Property 13: Card removal permissions** — Validates: Requirements 8.3, 8.4
    - **Property 14: Card move between columns** — Validates: Requirements 8.8, 8.9
    - **Property 15: Voting mechanics** — Validates: Requirements 9.1, 9.2, 9.3
    - **Property 16: Disabled voting prevents all votes** — Validates: Requirements 9.4
    - **Property 17: Card visibility when hidden** — Validates: Requirements 10.1, 10.3
    - **Property 18: Card reveal makes all visible** — Validates: Requirements 10.2
    - **Property 19: Completed board rejects modifications** — Validates: Requirements 11.4, 19.4
    - **Property 26: Context editable only by moderator** — Validates: Requirements 18.3

  - [x] 2.10 Write unit tests for RetroSession
    - Test session creation with valid configuration
    - Test card CRUD operations with edge cases
    - Test voting edge cases (zero remaining, one-vote-per-card)
    - Test moderator workflow (reveal → enable voting → complete)
    - Test CSV export format and import parsing
    - _Requirements: 2.4, 8.1–8.9, 9.1–9.6, 10.1–10.3, 11.1–11.4, 13.2, 14.2, 14.3_

- [x] 3. Implement RetroSessionRegistry
  - [x] 3.1 Create RetroSessionRegistry class
    - Create `server/src/services/retro-session-registry.ts`
    - Implement `createSession(ownerId, config)` — generate unique session ID, instantiate RetroSession
    - Implement `getSession(sessionId)` — retrieve session by ID
    - Implement `removeSession(sessionId)` — delete session from registry
    - Implement `hasSession(sessionId)` — check existence
    - Implement cleanup interval (30 minutes inactive + 0 participants)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [x] 3.2 Write property tests for RetroSessionRegistry
    - **Property 5: Session ID uniqueness** — Validates: Requirements 5.1
    - **Property 24: Session isolation** — Validates: Requirements 15.2
    - **Property 25: Inactive session cleanup** — Validates: Requirements 15.3

  - [x] 3.3 Write unit tests for RetroSessionRegistry
    - Test session creation and retrieval
    - Test multiple concurrent sessions
    - Test cleanup of inactive sessions
    - Test session independence from poker SessionRegistry
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

- [x] 4. Checkpoint - Ensure all backend service tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement REST API routes
  - [x] 5.1 Create retro-routes.ts with all endpoints
    - Create `server/src/routes/retro-routes.ts`
    - Implement `POST /api/retro/sessions` — validate config, create session, return sessionId
    - Implement `GET /api/retro/sessions/:sessionId` — return session info (requires auth)
    - Implement `GET /api/retro/sessions/:sessionId/exists` — check existence (no auth)
    - Implement `POST /api/retro/sessions/:sessionId/verify-password` — verify board password
    - Implement `GET /api/retro/sessions/:sessionId/export` — export CSV (moderator only)
    - Implement `POST /api/retro/sessions/:sessionId/import` — import CSV (moderator only)
    - _Requirements: 2.4, 5.1, 5.4, 13.1, 13.2, 14.1, 14.2, 14.3, 16.1, 16.2_

  - [x] 5.2 Register retro routes in server.ts
    - Import and mount retro routes at `/api/retro` prefix in `server/src/server.ts`
    - Ensure existing poker routes remain unchanged
    - _Requirements: 1.3_

  - [x] 5.3 Write unit tests for retro REST routes
    - Test session creation with valid/invalid config
    - Test session exists endpoint
    - Test password verification (correct/incorrect)
    - Test CSV export endpoint
    - Test CSV import with valid/invalid data
    - **Property 6: Password authentication** — Validates: Requirements 5.4, 16.1, 16.2
    - **Property 23: Invalid CSV rejection** — Validates: Requirements 14.3
    - _Requirements: 2.4, 5.1, 13.2, 14.2, 14.3, 16.1, 16.2_

- [x] 6. Implement WebSocket handler for retro sessions
  - [x] 6.1 Create retro-handler.ts
    - Create `server/src/websocket/retro-handler.ts`
    - Implement `handleRetroWebSocket(ws, request)` — authenticate via JWT token query param
    - Route incoming messages to appropriate RetroSession methods based on event type
    - Broadcast state changes to all connected participants in the session
    - Handle participant join/leave lifecycle
    - Implement `getVisibleState` filtering for hidden cards
    - Send full `retro:session:state` on connect/reconnect
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 6.2 Mount WebSocket handler on /retro path
    - Update `server/src/server.ts` to handle WebSocket upgrade on `/retro` path
    - Keep existing poker WebSocket handler on its current path unchanged
    - _Requirements: 12.5, 1.3_

  - [x] 6.3 Write unit tests for retro WebSocket handler
    - Test event routing for all client→server events
    - Test broadcast to all participants on state changes
    - Test error responses for unauthorized actions
    - Test reconnection state restoration
    - **Property 20: Reconnect restores full board state** — Validates: Requirements 12.6
    - _Requirements: 12.1–12.6_

- [x] 7. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement frontend services
  - [x] 8.1 Create RetroWebSocketService
    - Create `client/src/app/services/retro-websocket.service.ts`
    - Implement WebSocket connection management for retro sessions (connect, disconnect, reconnect)
    - Follow same pattern as existing `websocket.service.ts`
    - Expose observable/signal streams for incoming events
    - Implement methods to send all client→server events
    - _Requirements: 12.5, 12.6_

  - [x] 8.2 Create RetroStateService
    - Create `client/src/app/services/retro-state.service.ts`
    - Implement reactive state management using Angular signals
    - Store full `RetroSessionState` as signal
    - Provide computed signals for: columns, cards by column, votes remaining, is moderator, is completed
    - Handle incoming WebSocket events to update state
    - _Requirements: 12.1–12.6_

  - [x] 8.3 Create RetroExportService
    - Create `client/src/app/services/retro-export.service.ts`
    - Implement `exportCSV()` — call REST export endpoint, trigger file download
    - Implement `importCSV(file)` — read file, call REST import endpoint, handle errors
    - _Requirements: 13.1, 13.2, 14.1, 14.2, 14.3_

  - [x] 8.4 Create RetroScreenshotService
    - Create `client/src/app/services/retro-screenshot.service.ts`
    - Implement screenshot capture using html2canvas library
    - Capture entire board including off-screen content
    - Copy PNG to clipboard via Clipboard API
    - Fallback to file download if clipboard not supported
    - Show toast notification on success
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_

  - [x] 8.5 Write unit tests for frontend services
    - Test RetroWebSocketService connection lifecycle
    - Test RetroStateService signal updates on events
    - Test RetroExportService CSV download trigger
    - Test RetroScreenshotService clipboard/download fallback
    - _Requirements: 12.5, 12.6, 13.1, 14.1, 22.3, 22.5_

- [x] 9. Implement frontend components - Board creation flow
  - [x] 9.1 Create RetroCreatePageComponent
    - Create `client/src/app/components/retro-create/retro-create-page.component.ts`
    - Implement board name input with non-empty validation
    - Implement max votes input with positive integer validation (default: 6)
    - Implement template selection dropdown with all 25 templates
    - Implement advanced configuration toggles (all 8 settings from Requirement 4)
    - Implement password input field (shown when password toggle enabled)
    - On submit: call POST /api/retro/sessions, navigate to board view
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1–4.8_

  - [x] 9.2 Create TemplatePreviewComponent
    - Create `client/src/app/components/retro-create/template-preview.component.ts`
    - Display column names for the currently selected template
    - Update preview when template selection changes
    - _Requirements: 3.2, 3.3_

  - [x] 9.3 Create RetroLoginComponent
    - Create `client/src/app/components/retro-login/retro-login.component.ts`
    - Implement display name input form
    - Implement optional password input (shown for password-protected boards)
    - Call existing auth service for JWT token generation
    - Navigate to board view on successful authentication
    - _Requirements: 5.3, 5.4, 6.1, 6.3, 6.4, 16.1, 16.2_

  - [x] 9.4 Write unit tests for creation flow components
    - Test form validation (empty name, invalid votes)
    - Test template selection and preview update
    - Test password field visibility toggle
    - Test successful submission and navigation
    - Test login with correct/incorrect password
    - _Requirements: 2.1, 2.2, 2.5, 3.2, 5.4, 6.1, 16.1, 16.2_

- [x] 10. Implement frontend components - Board view
  - [x] 10.1 Create RetroBoardPageComponent
    - Create `client/src/app/components/retro-board/retro-board-page.component.ts`
    - Connect to RetroWebSocketService on init, disconnect on destroy
    - Display context input at top (editable by moderator only)
    - Render columns using RetroColumnComponent
    - Support vertical (side-by-side) and horizontal (stacked) column layouts
    - Display participant's remaining vote count
    - Use compact design with small fonts and minimal padding
    - Implement horizontal scrolling when columns exceed viewport
    - _Requirements: 7.1, 7.2, 7.6, 7.7, 7.8, 7.9, 9.6, 18.1, 18.2, 20.1, 20.2, 20.4_

  - [x] 10.2 Create RetroColumnComponent
    - Create `client/src/app/components/retro-board/retro-column.component.ts`
    - Display column header with name
    - Render cards using RetroCardComponent
    - Provide "Add Card" icon button
    - Support drag-and-drop for card reordering within column
    - Support drag-and-drop for card movement between columns
    - Support column drag-and-drop reordering
    - Show card count when cards are hidden
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 8.1, 8.8, 8.9, 10.3_

  - [x] 10.3 Create RetroCardComponent
    - Create `client/src/app/components/retro-board/retro-card.component.ts`
    - Display editable text content
    - Display vote button and vote count (respect hideVoteCount config)
    - Display comment section with add/remove capability
    - Display author name (when showCardAuthor config active)
    - Support emoji/GIF insertion (when enableGifEmoji config active)
    - Show delete button for card author and moderator only
    - Respect card visibility rules (show only own cards when hidden)
    - Use compact layout with minimal spacing
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 10.1, 17.1, 17.2, 20.3_

  - [x] 10.4 Create RetroToolbarComponent
    - Create `client/src/app/components/retro-board/retro-toolbar.component.ts`
    - Implement icon-only buttons with title and aria-label attributes
    - Moderator buttons: Reveal Cards, Enable Voting, Complete Retrospective
    - Shared buttons: Copy Link, Export CSV, Import CSV, Screenshot, Add Column
    - Use horizontal icon bar layout
    - Ensure minimum 32x32px tap targets
    - Disable moderator actions when board is completed
    - _Requirements: 5.2, 11.1, 11.2, 11.3, 13.1, 14.1, 21.1, 21.2, 21.3, 21.4, 21.5, 22.1_

  - [x] 10.5 Write property test for icon button accessibility
    - **Property 27: Icon buttons have accessibility attributes**
    - Verify all icon-only buttons have non-empty `title` and `aria-label` attributes with matching text
    - **Validates: Requirements 21.2, 21.3**

  - [x] 10.6 Write unit tests for board view components
    - Test board layout rendering (vertical/horizontal)
    - Test column rendering with cards
    - Test card display with various config combinations
    - Test toolbar button visibility based on role
    - Test drag-and-drop card movement
    - Test context field moderator-only editing
    - _Requirements: 7.1, 7.7, 7.8, 8.1, 8.5, 10.1, 11.1, 18.3, 20.1_

- [x] 11. Checkpoint - Ensure all frontend component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Lobby integration and routing
  - [x] 12.1 Update LobbyComponent with retro tile
    - Add "Create Retrospective Board" tile alongside existing "Start New Game" tile
    - Navigate to `/retro/create` on click
    - Preserve all existing poker functionality
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 12.2 Add retro routes to app.routes.ts
    - Add route `retro/create` → `RetroCreatePageComponent`
    - Add route `retro/:sessionId` → `RetroBoardPageComponent`
    - Add route `retro/:sessionId/login` → `RetroLoginComponent`
    - Use lazy loading with `loadComponent`
    - _Requirements: 1.2, 2.4, 5.3, 6.1_

  - [x] 12.3 Write unit tests for lobby integration
    - Test retro tile is displayed
    - Test navigation to retro create page
    - Test existing poker tile still works
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 13. Integration wiring and end-to-end validation
  - [x] 13.1 Wire Copy Link functionality
    - Implement clipboard copy of session URL in toolbar
    - Show toast notification on successful copy
    - _Requirements: 5.1, 5.2_

  - [x] 13.2 Wire CSV export/import through toolbar
    - Connect Export CSV button to RetroExportService.exportCSV()
    - Connect Import CSV button to file picker and RetroExportService.importCSV()
    - Display error toast on import failure
    - _Requirements: 13.1, 13.2, 14.1, 14.2, 14.3_

  - [x] 13.3 Wire screenshot capture through toolbar
    - Connect Screenshot button to RetroScreenshotService
    - Capture full board content including off-viewport columns
    - Show toast on success, fallback to download on clipboard failure
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_

  - [x] 13.4 Wire real-time column layout toggle
    - Connect moderator layout toggle to `retro:config:update` WebSocket event
    - Broadcast layout change to all participants
    - Update board rendering in real time
    - _Requirements: 7.9_

  - [x] 13.5 Write integration tests
    - Test full session lifecycle: create → join → add cards → vote → reveal → complete
    - Test multi-participant real-time collaboration
    - Test password-protected session join flow
    - Test CSV export/import round trip
    - **Property 21: CSV export completeness** — Validates: Requirements 13.2, 13.3
    - **Property 22: CSV import/export round trip** — Validates: Requirements 14.2
    - _Requirements: 2.4, 5.3, 12.1–12.6, 13.2, 14.2, 16.1_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at backend services, backend complete, frontend components, and full integration
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific examples and edge cases using Jest (server) and Vitest (client)
- The implementation reuses existing patterns: auth-service for JWT, WebSocket upgrade handling, Angular signals for state
- All new code is isolated from existing poker functionality to prevent regressions
