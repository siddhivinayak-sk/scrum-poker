# Implementation Plan: Poker & Retro UX Improvements

## Overview

The plan implements the ten work streams of `design.md` in dependency order. The shared type and constant additions land first because the server and client work both import them. Next come the seven dependency-free pure modules (`shared/csv.ts`, `shared/estimate-export.ts`, `retro-card-height.ts`, `card-deck-geometry.ts`, `issue-title.ts`, `drop-index.ts`, `connection-episode.ts`), each immediately followed by the test task that exercises it — these are the units the property tests reach without a DOM or a socket, and they unblock almost everything else. Server work follows, then client work stream by stream, then the no-regression and verification-ledger tasks.

Language: **TypeScript**, as the design specifies throughout. Server tests run under Jest (`cd server && npm test`, `roots` includes `../shared`); client tests run under Vitest via `ng test` (`cd client && npm test`) with `@testing-library/angular` and `fast-check`. All new client components are standalone with explicit `imports`, state is held in Signals, shared code is imported through the `@shared/*` alias, and no `any` cast is introduced. Retro modules import no poker module and vice versa.

## Tasks

- [x] 1. Shared type and constant foundation
  - [x] 1.1 Extend `shared/types.ts` with the additive types and constants
    - Add optional `fluidCardHeight?: boolean` to `RetroConfiguration` so records omitting it stay valid
    - Add `resolveFluidCardHeight(value: unknown): boolean` returning the value when boolean and `true` otherwise
    - Add `RetroSessionSummary`, `RetroSessionsResponse`, `RETRO_SESSION_ENDED`, `RetroSessionEndedPayload`
    - Add `ConnectionState` type and the `CONNECTION_LABEL` record with the exact label strings
    - Leave every existing type, constant, `formatDuration`, and `getCardsForVotingSystem` untouched
    - _Requirements: R6.1, R8.6, R9.8, R11.4, R11.5, R11.6, R13.2, R13.3_

  - [x] 1.2 **Property test** — Property 10: fluidCardHeight default resolution
    - Create `shared/__tests__/fluid-card-height.property.spec.ts`
    - Pure unit exercised: `resolveFluidCardHeight`
    - Generators: `fc.oneof(fc.boolean(), fc.constant(undefined), fc.string(), fc.integer(), fc.constant(null), fc.object())`, `numRuns: 100`
    - _Requirements: R6.1, R6.3, R13.4_

- [x] 2. Pure CSV module (Stream 1)
  - [x] 2.1 Create `shared/csv.ts`
    - Implement `quoteCsvField`, `serializeCsvRow`, `serializeCsvDocument` (CRLF terminators), `parseCsv`
    - Quote on `,`, `"`, CR, LF; double embedded quote characters
    - Zero imports so the module is reachable from Jest via `roots` and from Vitest via `@shared/*`
    - Leave `RetroSession.parseCSV` untouched
    - _Requirements: R1.16_

  - [x] 2.2 **Property test** — Property 1: CSV field quoting round trip
    - Create `shared/__tests__/csv.property.spec.ts`
    - Pure units exercised: `quoteCsvField`, `serializeCsvRow`, `parseCsv`
    - 1–10 fields per row, values 0–1,000 characters drawn from a set including comma, double quote, CR, LF, spaces and unicode; `numRuns: 100`
    - Invariant: `parseCsv(serializeCsvRow(fields.map(quoteCsvField)))[0]` deep-equals `fields`
    - _Requirements: R1.16, R14.8_

  - [x] 2.3 Write example unit tests in `shared/__tests__/csv.spec.ts`
    - Quoting and parsing examples, CRLF row terminators, empty field, field that is only a quote character
    - _Requirements: R1.16, R14.1, R14.2_

- [x] 3. Pure estimate export module (Stream 1)
  - [x] 3.1 Create `shared/estimate-export.ts`
    - Implement `sortCompletedEstimates` as a stable sort on `(completedAt, storedIndex)` ascending over the newest-first `history` array
    - Implement `formatAverage` (half up to one decimal, `.` separator, `-` on `insufficientData`), `formatDistribution` (one `value=count` entry per distinct key, `; ` joined, ordered by `getCardsForVotingSystem`, unknown keys appended), `formatVotingDuration` (`-` when absent, otherwise `formatDuration`)
    - Implement `buildSummaryRow` (story, participant count, numeric vote count, average, mode, spread, distribution, `outliers.length`, duration, `completedAt`), `buildVoteRows` (display-name ascending, `No Vote` for a null card value), `buildEstimateExportRows`, `buildEstimateExportCsv`
    - Export `SUMMARY_HEADER`, `VOTE_HEADER`, `NO_VOTE_LABEL`, `NOT_AVAILABLE`; route every field through `quoteCsvField`
    - _Requirements: R1.9, R1.10, R1.11, R1.12, R1.13, R1.14, R1.15, R1.16, R1.20, R1.21_

  - [x] 3.2 **Property tests** — Properties 2, 3, 4 and 24
    - Create `shared/__tests__/estimate-export.property.spec.ts`
    - Property 2 (summary statistics equal computed metrics) exercising `buildSummaryRow` against `metrics-engine.calculate`, 1–50 participants over every voting system, `numRuns: 200`
    - Property 3 (insufficient data renders as `-` while distribution and outlier count keep their values) exercising `formatAverage`, `buildSummaryRow`
    - Property 4 (document shape and ordering: header counts and positions, tie-stable ascending `completedAt`, vote-block adjacency and ownership, name ordering, `No Vote`) exercising `sortCompletedEstimates`, `buildVoteRows`, `buildEstimateExportRows`, `numRuns: 200`
    - Property 24 (voting duration formatting) exercising `formatVotingDuration` and `formatDuration`
    - _Requirements: R1.9, R1.10, R1.11, R1.12, R1.13, R1.14, R1.15, R1.20, R1.21, R14.9, R14.10_

  - [x] 3.3 Write example unit tests in `shared/__tests__/estimate-export.spec.ts`
    - Exact column order and header text, the `-` branches, the `No Vote` branch, a 60-minute duration rendering as `60:00`
    - _Requirements: R1.10, R1.12, R1.15, R1.21, R14.1, R14.2_

- [x] 4. Pure card deck geometry module (Stream 3)
  - [x] 4.1 Create `client/src/app/components/card-deck/card-deck-geometry.ts`
    - Export `SELECTION_LIFT_PX = 10`, `SELECTION_SCALE = 1.04`, `DECK_PADDING_TOP_PX = 12`, the `DeckGeometry` interface
    - Implement `requiredHeadroomPx` as `liftPx + cardHeightPx * (scale - 1) / 2`, plus `selectedCardTopOffsetPx` and `isSelectionContained`
    - _Requirements: R3.1, R3.4_

  - [x] 4.2 **Property test** — Property 6: selected card stays inside the deck container
    - Create `client/src/app/components/card-deck/card-deck-geometry.property.spec.ts`
    - Pure units exercised: `selectedCardTopOffsetPx`, `requiredHeadroomPx`, `isSelectionContained`
    - Generators: card sets from `VOTING_SYSTEMS` extended with specials (2–20 cards), `cardIndex` in `[0, cardCount)`, card heights 56–96 px, viewport widths 360–1920 px; `numRuns: 100`
    - Invariant: `selectedCardTopOffsetPx(g) >= 0` and `requiredHeadroomPx(g) <= DECK_PADDING_TOP_PX`, asserted for the hover lift plus focus-ring allowance as well
    - _Requirements: R3.2, R3.3, R3.4, R3.5, R14.15_

- [x] 5. Pure issue title module (Stream 2)
  - [x] 5.1 Create `client/src/app/components/issue-list-panel/issue-title.ts`
    - Export `ISSUE_TITLE_PLACEHOLDER`, `issueTitleText` (placeholder for empty or whitespace-only titles), `issueTitleAccessibleName` (complete stored value, no truncation marker)
    - Implement `issueRowOverflows(model: IssueRowLayoutModel)` mirroring the CSS box model with `titleMinWidth: 0` and break-anywhere wrapping
    - _Requirements: R2.2, R2.5, R2.10_

  - [x] 5.2 **Property test** — Property 5: issue row never overflows its panel
    - Create `client/src/app/components/issue-list-panel/issue-title.property.spec.ts`
    - Pure units exercised: `issueRowOverflows`, `issueTitleText`, `issueTitleAccessibleName`
    - Generators: titles 0–500 characters including a no-whitespace variant and whitespace-only strings, 0–200 entries, viewport widths 360–1920 px; `numRuns: 100`
    - Invariant: no row overflows, the action slot offset is identical across rows, the accessible name equals the stored title exactly or the placeholder when blank
    - _Requirements: R2.2, R2.3, R2.5, R2.9, R2.10, R2.13, R14.14_

- [x] 6. Pure retro card height module (Stream 4)
  - [x] 6.1 Create `client/src/app/services/retro-card-height.ts`
    - Export `FLUID_MIN_LINES = 3`, `FLUID_MAX_LINES = 12`, `FIXED_LINES = 4`, the `WrapMetrics` and `HeightMetrics` interfaces
    - Implement `measureLineCount` as a single left-to-right greedy scan over `{ completedLines, usedWidth, pendingTokenWidth }` that honours explicit `\n`, hard-breaks oversized tokens, and only ever increments `completedLines`
    - Implement `clampLines`, `computeTextAreaHeightPx` (`clamp(lines) * lineHeight + padding`), `cardTextAreaHeightPx`
    - _Requirements: R6.4, R6.5, R6.6, R6.8, R6.9_

  - [x] 6.2 **Property tests** — Properties 7, 8 and 9
    - Create `client/src/app/services/retro-card-height.property.spec.ts`
    - Pure units exercised: `measureLineCount`, `clampLines`, `computeTextAreaHeightPx`, `cardTextAreaHeightPx`
    - Property 7 (idempotence: three successive evaluations are identical), Property 8 (prefix monotonicity), Property 9 (clamp follows the configured mode, `(3, 12)` fluid and `(4, 4)` fixed, independent of column layout)
    - Generators: texts 0–5,000 characters including explicit and consecutive line breaks and a token wider than the element, widths 200–1,200 px, both `fluid` values, both column layouts; `numRuns: 100`
    - _Requirements: R6.4, R6.5, R6.6, R6.8, R6.9, R6.14, R14.11_

- [x] 7. Pure drop index module (Stream 4)
  - [x] 7.1 Create `client/src/app/components/retro-board/drop-index.ts`
    - Export the `CardRect` interface, `computeDropIndex` (first card whose midpoint lies beyond the pointer, else `rects.length`, so an empty column yields 0) and `adjustDropIndexForSameColumn`
    - Extract the existing algorithm unchanged; introduce no card-height constant
    - _Requirements: R6.12_

  - [x] 7.2 **Property test** — Property 11: drop index from bounding-box midpoints
    - Create `client/src/app/components/retro-board/drop-index.property.spec.ts`
    - Pure units exercised: `computeDropIndex`, `adjustDropIndexForSameColumn`
    - Generators: 0–50 rects with sizes 10–400 laid end to end with gaps 0–16, pointer positions before, inside and after the strip; `numRuns: 100`
    - Invariant: the index equals the count of rects whose midpoint is at or before the pointer; a uniform size increase leaves the decision unchanged for a proportionally scaled pointer
    - _Requirements: R6.12_

- [x] 8. Pure connection episode reducer (Stream 9)
  - [x] 8.1 Create `client/src/app/services/connection-episode.ts`
    - Export `GIVE_UP_THRESHOLD = 10`, the `ConnectionEvent`, `EpisodeState` and `EpisodeEffect` types, `initialEpisodeState`
    - Implement `calculateBackoff` as `min(2^attempt * 1000, 30000)` and `reduceEpisode` per the design transition table: reserved close codes end the episode with one toast and no reconnect; an ordinary close yields `reconnecting` with a dismissal effect and a scheduled reconnect and no toast; an attempt reaching the threshold yields `disconnected`, one give-up toast and a login navigation; `open` resets the attempt count and emits a dismissal effect
    - No Angular and no socket imports
    - _Requirements: R11.14, R11.15, R11.16, R11.18, R11.19, R11.23, R11.25, R11.26, R11.27_

  - [x] 8.2 **Property tests** — Properties 18 and 19
    - Create `client/src/app/services/connection-episode.property.spec.ts`
    - Pure units exercised: `reduceEpisode`, `calculateBackoff`
    - Property 18 (zero notifications before the threshold, exactly one at it, no further reconnect after a crossing, attempt reset on every `open`, dismissal on every exit from `connected`, no message matching `/lost|attempt \d/i`): 100+ sequences of length 1–60 plus a dedicated generator for episodes holding 1–9 attempts that end with `open`
    - Property 19 (close codes 4009, 4010 and 4004 end the episode without reconnection; backoff equals the formula for attempts 0–20)
    - _Requirements: R11.14, R11.15, R11.16, R11.18, R11.19, R11.23, R11.25, R11.26, R11.27, R14.13_

- [x] 9. Checkpoint — pure units complete
  - Run `cd server && npm test` and `cd client && npm test`. Ensure all tests pass, ask the user if questions arise.

- [x] 10. Server: estimate export endpoint (Stream 1)
  - [x] 10.1 Add `GET /:sessionId/export` to `server/src/routes/sessions.ts`
    - Register the route before `GET /:sessionId` so it is not shadowed
    - Check order: authentication (401 `UNAUTHORIZED`), existence (404 `SESSION_NOT_FOUND`), ownership (403 `FORBIDDEN`)
    - On success read `getHistory()` and `config.votingSystem` only, call `buildEstimateExportCsv`, and respond 200 with `Content-Type: text/csv` and `Content-Disposition: attachment; filename="scrum-poker-<sessionId>.csv"`
    - _Requirements: R1.5, R1.6, R1.7, R1.8, R1.19, R13.5, R13.6_

  - [x] 10.2 Write `server/src/routes/__tests__/sessions-export.spec.ts`
    - Supertest cases for 401, 404, 403 and 200 with header assertions, and a 200-estimate / 50-participant session completing inside the 5-second budget
    - Include Property 23 (export endpoint is a pure read): two consecutive requests return byte-identical documents and a deep session snapshot is unchanged
    - _Requirements: R1.5, R1.6, R1.7, R1.8, R1.19_

- [x] 11. Server: retro session state and session listing (Streams 4, 7)
  - [x] 11.1 Extend `server/src/services/retro-session.ts`
    - Apply `resolveFluidCardHeight(config.fluidCardHeight)` in the constructor so the stored config is always normalised and `getSessionState()` always broadcasts a boolean
    - In `updateConfig`, delete a non-boolean `fluidCardHeight` from the partial before the merge and report the rejection to the caller
    - Add `getCardCount(): number` and `isBoardCompleted(): boolean` accessors over the private board
    - _Requirements: R6.2, R6.17, R8.6, R13.10_

  - [x] 11.2 Write `server/src/services/__tests__/retro-session-fluid-height.spec.ts`
    - Creation default for absent, boolean and non-boolean values; accepted moderator update; rejected non-boolean update leaving the stored value unchanged with no broadcast; a legacy config omitting the field broadcasting `true`
    - Also assert the handler replies `retro:error` with `INVALID_CONFIG` on a non-boolean update and `UNAUTHORIZED` for a non-moderator sender
    - _Requirements: R6.2, R6.11, R6.17, R13.10_

  - [x] 11.3 Add `getSessionsByOwner` to `server/src/services/retro-session-registry.ts` and `summariseRetroSessions` to `server/src/routes/retro-routes.ts`
    - `getSessionsByOwner(ownerId)` returns the owner's sessions with no limit
    - `summariseRetroSessions` maps sessions to `RetroSessionSummary` entries and orders them by `lastActivityAt` descending with ties broken by `createdAt` descending; it reads only retro modules
    - _Requirements: R8.2, R8.4, R8.6, R8.7, R13.9_

  - [x] 11.4 Add `GET /sessions/mine` to `server/src/routes/retro-routes.ts`
    - Register before `GET /sessions/:sessionId` so `mine` is never captured as a session id
    - 401 `UNAUTHORIZED` for a missing, unverifiable or expired token; otherwise 200 with `{ sessions }` from `summariseRetroSessions`, read only
    - _Requirements: R8.1, R8.2, R8.3, R8.4, R8.5, R8.7, R8.8, R13.5, R13.9_

  - [x] 11.5 **Property test** — Property 20: retro session list holds exactly the caller's retro sessions
    - Create `server/src/routes/__tests__/retro-sessions-mine.spec.ts`
    - Units exercised: `summariseRetroSessions`, `RetroSessionRegistry.getSessionsByOwner`, the route
    - Generators: 0–50 retro sessions and 0–50 game sessions across 1–5 owners with colliding timestamps, 0–20 cards and 0–10 participants per board, some boards completed; `numRuns: 200`
    - Invariant: the returned id set equals the owned retro id set, no poker id appears, ordering is non-increasing under the composite comparator, summaries are well formed, and two consecutive calls are deep-equal with the registry snapshot unchanged
    - Add example cases for the 401 and the zero-session responses
    - _Requirements: R8.2, R8.3, R8.4, R8.5, R8.6, R8.7, R8.8, R14.16_

- [x] 12. Server: end retro session (Stream 8)
  - [x] 12.1 Add `endRetroSession` and unknown-session closing to `server/src/websocket/retro-handler.ts`
    - Re-export `RETRO_SESSION_ENDED` from `@shared/types`; broadcast the event to every connected participant including the moderator **before** closing each socket with 1000, then delete the client map entry
    - In `handleRetroEvent`, when the registry no longer holds the session, send `retro:error` with `NOT_FOUND`, close with 4004, and mutate no session
    - Extract `removeRetroConnection(ws)` from the existing `'close'` handler for reuse by the liveness probe
    - _Requirements: R9.8, R9.14, R13.1, R13.9_

  - [x] 12.2 Add `DELETE /sessions/:sessionId` to `server/src/routes/retro-routes.ts`
    - Check order: 401 with no state change regardless of whether the id exists, then 404, then 403, then `removeSession` plus `endRetroSession` and a 200 response
    - Import only retro modules so no `GameSession` is touched
    - _Requirements: R9.7, R9.8, R9.9, R9.10, R9.11, R9.15, R13.5, R13.9_

  - [x] 12.3 **Property test** — Property 21: ending a retro session touches nothing else
    - Create `server/src/routes/__tests__/retro-end-session.spec.ts`
    - Units exercised: the retro `DELETE` route, `RetroSessionRegistry`
    - Generators: registry states as in Property 20, targets drawn from owned ids, foreign ids and fresh ids, token present/absent/invalid; `numRuns: 100`
    - Invariant: the status code matches the case and a deep snapshot of the non-target retro sessions and of the entire poker registry is unchanged; include the 200 happy path
    - _Requirements: R9.7, R9.9, R9.10, R9.11, R9.15_

  - [x] 12.4 **Property test** — Property 22: late retro WebSocket messages change nothing
    - Create `server/src/websocket/__tests__/retro-session-ended.spec.ts`
    - Units exercised: `retro-handler.ts`
    - Assert broadcast-then-close ordering so every participant receives `retro:session:ended` before its socket closes
    - Generators for Property 22: event names from the handler's routed names plus random strings, arbitrary payloads, against a session id the registry no longer holds; `numRuns: 100`
    - Invariant: the registry snapshot is unchanged and `ws.close` was called
    - _Requirements: R9.8, R9.14_

- [x] 13. Server: WebSocket liveness probe (Stream 9)
  - [x] 13.1 Create `server/src/websocket/liveness.ts`
    - Export `LIVENESS_INTERVAL_MS = 30_000`, `MAX_MISSED_PONGS = 2`, the `LivenessOptions` interface, `attachLivenessProbe(wss, options)` returning `{ stop() }`, and the pure `nextMissedCount(missed, pongSeen)`
    - Per connection, ping on each tick, increment the missed counter when no pong arrived since the previous tick and reset it when one did; at two missed pongs call `onDead(ws)` and close the socket
    - Import only `ws` so the module is neutral ground for both servers
    - _Requirements: R11.20, R11.21, R11.22, R13.9_

  - [x] 13.2 Wire the poker liveness probe
    - Expose `removePokerConnection(ws)` from `server/src/websocket/handler.ts`, extracted from the existing `'close'` handler, removing the participant from the poker registry and broadcasting the updated state to that session's remaining sockets
    - Attach one probe to the poker `wss` in `server/src/server.ts` with `onDead: ws => removePokerConnection(ws)`, leaving the `server.on('upgrade')` retro/poker split unchanged
    - _Requirements: R11.20, R11.21, R11.22, R13.14_

  - [x] 13.3 Wire the retro liveness probe independently
    - Attach a second, separate probe to `retroWss` in `server/src/server.ts` with `onDead: ws => removeRetroConnection(ws)` using the function extracted in task 12.1
    - The two probes share no state, so a closure on one server leaves the other server's sockets open
    - _Requirements: R11.20, R11.21, R11.22, R13.9, R13.14_

  - [x] 13.4 Write `server/src/websocket/__tests__/liveness.spec.ts`
    - Unit cases for `nextMissedCount`, 30-second ticks under fake timers with a ±5-second tolerance asserted as tick counts, participant removal and state broadcast on two missed pongs, and per-server independence across the poker and retro probes
    - _Requirements: R11.20, R11.21, R11.22_

- [x] 14. Checkpoint — server work complete
  - Run `cd server && npm test`. Ensure all tests pass, ask the user if questions arise.

- [x] 15. Client: poker estimate export (Stream 1)
  - [x] 15.1 Create `client/src/app/services/estimate-export.service.ts`
    - `providedIn: 'root'`, an `inFlight` readonly Signal, and `exportEstimates(sessionId)` that refuses to start while a request is pending
    - One `GET /api/sessions/:sessionId/export` with the stored token in `Authorization`, `timeout(30_000)`
    - On 200 download a `Blob([csvText], { type: 'text/csv' })` as `scrum-poker-<sessionId>.csv` with content equal to the response body; on any failure show exactly one `error` toast and trigger no download
    - _Requirements: R1.4, R1.17, R1.18_

  - [x] 15.2 Add an `ownerId` Signal to `client/src/app/services/session-state.service.ts`
    - Private `signal<string | null>(null)` exposed as a readonly Signal, fed from the existing `session:state` payload's `ownerId`
    - _Requirements: R1.1, R1.2_

  - [x] 15.3 Add the export control to `SessionPokerPageComponent`
    - Render the button only when `isOwner()`, with `aria-label` and `title` `Export estimates` and a declared `min-width`/`min-height` of 32 px
    - `exportDisabled = computed(() => history().length === 0 || exportService.inFlight())`; the click handler calls `exportEstimates`
    - _Requirements: R1.1, R1.2, R1.3, R1.22_

  - [x] 15.4 Write `client/src/app/services/estimate-export.service.spec.ts`
    - Exactly one request per activation, the `Authorization` header, the download filename and MIME type, blob content equal to the response body, the non-200 path and the 30-second timeout path each producing one error toast and no download
    - _Requirements: R1.4, R1.17, R1.18_

  - [x] 15.5 Write `client/src/app/components/session-poker-page/export-control.spec.ts`
    - Owner and non-owner rendering, the disabled state with zero completed estimates and while a request is in flight, the enabled state otherwise, and the declared 32 px target
    - _Requirements: R1.1, R1.2, R1.3, R1.22_

- [x] 16. Client: readable issue titles (Stream 2)
  - [x] 16.1 Modify `IssueListPanelComponent` template and styles
    - Replace `white-space: nowrap` on the title with the two-line clamp block (`-webkit-line-clamp: 2`, `-webkit-box-orient: vertical`, `overflow: hidden`), add `min-width: 0` and `overflow-wrap: anywhere`, set `font-size: 0.8125rem` and `line-height: 1.35`
    - Move the action button into an always-rendered fixed-width `span.issue-list-panel__item-action` (`flex: 0 0 5.5rem`) so every row's action shares one left edge; keep the status marker at `min-width: 1rem; flex: 0 0 auto`; keep `overflow: hidden` on the panel
    - Render `issueTitleText(...)` as the visible text and `issueTitleAccessibleName(...)` as both `title` and `aria-label`; keep drag handling, status markers, estimate, resume, add and bulk import actions with their existing accessible names
    - _Requirements: R2.1, R2.2, R2.4, R2.5, R2.6, R2.7, R2.8, R2.9, R2.10, R2.11, R2.12, R2.13, R13.7, R13.8_

  - [x] 16.2 Write `client/src/app/components/issue-list-panel/issue-list-panel.layout.spec.ts`
    - Assert the clamp, `min-width: 0`, `overflow-wrap`, action-slot width and font-size declarations, the rendered row structure, the `title`/`aria-label` pair, the placeholder row staying selectable, and that all pre-existing actions keep their accessible names
    - _Requirements: R2.1, R2.4, R2.6, R2.7, R2.8, R2.10, R2.11, R2.12_

- [x] 17. Client: contained card selection elevation (Stream 3)
  - [x] 17.1 Modify `CardDeckComponent`
    - Styles: `.card-deck { padding-top: 12px; padding-bottom: 8px }`, selected transform `translateY(-10px) scale(1.04)`, hover lift `-4px` for non-selected cards, a reduced-motion block zeroing the transition duration while keeping the same end state, and `padding-top: 12px; overflow-y: hidden` in the mobile media query
    - Convert `selectedCard` to a `signal<ExtendedCardValue | null>(null)` read by `isSelected()`, so at most one card carries a non-zero lift and the existing `round:started` / `board:cleared` subscriptions reset it
    - Keep the selected border width, background gradient, shadow, focus indicator, disabled state, `aria-pressed` and the live-region announcement unchanged
    - Import the constants from `card-deck-geometry.ts` so the declared values and the geometry functions cannot drift
    - _Requirements: R3.1, R3.4, R3.6, R3.7, R3.8, R3.9, R3.10, R13.7, R13.8_

  - [x] 17.2 Write `client/src/app/components/card-deck/card-deck.containment.spec.ts`
    - Assert the declared lift, scale and padding values against the geometry constants, the reduced-motion block, the single-elevated-card invariant across successive selections, the reset on round change and board clear, the mobile `overflow-y` declaration, and the preserved visual and ARIA attributes
    - _Requirements: R3.1, R3.6, R3.7, R3.8, R3.9, R3.10_

- [x] 18. Client: retro card sizing, text behaviour and drag index (Stream 4)
  - [x] 18.1 Bind the card text area height in `RetroCardComponent`
    - Replace `rows="4"` and `min-height: 4.5em` with `[style.height.px]="textAreaHeightPx()"`
    - Compute the line count from the rendered element inside an `afterRenderEffect` (`(scrollHeight - verticalPadding) / lineHeight`), falling back to `measureLineCount` when `scrollHeight` is 0, and feed it into `computeTextAreaHeightPx`
    - Derive `fluidCardHeight = computed(() => resolveFluidCardHeight(retroState.config()?.fluidCardHeight))`
    - Styles: `overflow-y: auto`, `scrollbar-gutter: stable`, `box-sizing: border-box`, `white-space: pre-wrap`, `overflow-wrap: anywhere`
    - _Requirements: R5.11, R6.3, R6.4, R6.5, R6.6, R6.7, R6.14, R13.11_

  - [x] 18.2 Implement the focus-aware scroll and value handling in `RetroCardComponent`
    - Add a `focused` Signal driven by `(focus)`/`(blur)`; in the render effect pin `scrollTop` to 0 whenever the element is not focused
    - Replace the unconditional `[value]` binding with a guarded write that skips while focused, so an inbound update leaves the scroll offset, caret and uncommitted text untouched
    - On blur set `focused` false and `scrollTop` 0 in the same turn without altering the text; keep the existing "send edit when text differs" behaviour and Enter-without-Shift commit plus blur
    - _Requirements: R5.1, R5.2, R5.3, R5.4, R5.6, R5.7, R5.8, R5.9, R5.10_

  - [x] 18.3 **Property tests** — Properties 14 and 15
    - Create `client/src/app/components/retro-board/retro-card.scroll.property.spec.ts` using `@testing-library/angular`
    - Property 14 (unfocused text area pinned to its first line on first render, after each inbound update and after focus loss, text unchanged by the reset): texts 0–2,000 characters including consecutive line breaks and an oversized token, 0–5 successive updates, both `fluidCardHeight` values
    - Property 15 (a focused text area is never written by the component; the blur edit carries exactly the text then present): 1–10 inbound texts, typed text 0–200 characters, caret within range
    - `numRuns: 100`
    - _Requirements: R5.1, R5.2, R5.3, R5.4, R5.5, R5.6, R5.8, R5.9, R5.10_

  - [x] 18.4 Write `client/src/app/components/retro-board/retro-card.sizing.spec.ts`
    - The height binding is present and recomputes within the change pass on a text change and on a width change; the scrollbar stays inside the text area box and does not overlap the author line, action row or comment section
    - _Requirements: R5.11, R6.7_

  - [x] 18.5 Add the `fluidCardHeight` toggle to the retro board settings dialog
    - One more `retro-settings__toggle` checkbox in `RetroToolbarComponent`, rendered only for moderators, reflecting the stored value at the moment the dialog opens and routing through the existing `onSettingChange` → `sendConfigUpdate({ fluidCardHeight })` → `retro:config:update` path
    - _Requirements: R6.10, R6.11, R6.15_

  - [x] 18.6 Write `client/src/app/components/retro-board/fluid-height-settings.spec.ts`
    - The control is present for a moderator and absent otherwise, reflects the stored value on open, sends the config update, and a received `retro:config:updated` broadcast re-applies the height rule to every rendered card without a page reload
    - _Requirements: R6.10, R6.11, R6.15, R6.16_

  - [x] 18.7 Delegate `RetroColumnComponent` drag handling to `drop-index.ts`
    - Replace the inline `getDropIndex` body and the drop-indicator calculation with calls to `computeDropIndex` and `adjustDropIndexForSameColumn`, reading each card's measured `start` and `size` at drag time
    - Keep drag start, drag over, drop indicator, card move, card merge and column reorder behaviour unchanged for both column layouts
    - _Requirements: R6.12, R6.13, R7.10_

  - [x] 18.8 Write `client/src/app/components/retro-board/retro-column.dnd.spec.ts`
    - Preserved drag start, drag over, drop indicator, move, merge and column reorder behaviour with non-uniform card heights and for both column layouts
    - _Requirements: R6.13, R7.10_

- [x] 19. Checkpoint — retro card and poker surfaces complete
  - Run `cd client && npm test`. Ensure all tests pass, ask the user if questions arise.

- [x] 20. Client: screenshot capture fidelity (Stream 5)
  - [x] 20.1 Create `client/src/app/services/retro-capture-mode.ts`
    - Export the `Mutation` and `CaptureModeHandle` interfaces, `enterCaptureMode(root)` and the pure `captureTextStyle(computed, heightPx)`
    - For each card text area: copy font family, font size, line height, colour, padding and width, insert a sibling static `<div class="retro-card__text retro-card__text--capture">` carrying the full value as `textContent` with `white-space: pre-wrap`, `overflow-wrap: anywhere`, `overflow: visible` and a height from `measureLineCount` × line height + padding, then hide the textarea
    - Unclip `.retro-board__columns`, `.retro-column__cards` and `.retro-card__text` by recording `overflow`, `maxHeight`, `height`, `scrollTop`, `scrollLeft` and setting visible overflow with auto heights; mark the root `data-retro-capture="true"`
    - Record one undo closure per mutation and replay them in reverse on `restore()`
    - _Requirements: R4.1, R4.2, R4.3, R4.11, R4.12, R4.13_

  - [x] 20.2 Rework `RetroScreenshotService.captureBoard`
    - Add a `capturing` readonly Signal and return immediately while a capture is in progress; bind the toolbar screenshot button to it as `disabled`
    - Enter capture mode, render with a 10-second `withTimeout`, then clipboard-first with a PNG download fallback, emitting exactly one notification per outcome (copied, downloaded, or failed with nothing written to the clipboard and no download)
    - Restore the capture-mode handle in `finally` so success, failure and timeout all leave the board untouched
    - _Requirements: R4.1, R4.3, R4.4, R4.5, R4.6, R4.7, R4.8, R4.9, R4.10_

  - [x] 20.3 **Property tests** — Properties 12 and 13
    - Create `client/src/app/services/retro-capture-mode.property.spec.ts`
    - Property 12 (capture mode is restored exactly): 0–10 columns holding 0–100 cards, texts 0–2,000 characters, both column layouts, both `fluidCardHeight` values, outcomes `success | throw | timeout`, scroll offsets seeded non-zero; a structural snapshot before equals the snapshot after `restore()`
    - Property 13 (clone carries the complete text with the live typography): every clone's `textContent` equals the card text, `captureTextStyle` reproduces the four declarations, and the clone height is at least `measureLineCount(text, width) × lineHeight + padding` at card content widths 160–400 px
    - Units exercised: `retro-capture-mode.ts`, `retro-card-height.ts`, `RetroScreenshotService`; `numRuns: 100`
    - _Requirements: R4.2, R4.3, R4.7, R4.11, R4.12, R4.13_

  - [x] 20.4 Write `client/src/app/services/retro-screenshot.service.spec.ts`
    - Clipboard success, clipboard-unavailable fallback with a download, renderer failure, the 10-second timeout, the disabled-while-capturing guard, and exactly one notification per outcome
    - _Requirements: R4.1, R4.4, R4.5, R4.6, R4.8, R4.9, R4.10_

- [x] 21. Client: retro board layout and compact toolbar (Streams 6, 10 support)
  - [x] 21.1 Create `client/src/app/testing/contrast.ts`
    - Promote the existing inline `wcagContrastRatio` implementation from `card-deck.component.property.spec.ts` into a shared helper and re-use it from that spec
    - _Requirements: R7.4, R7.14, R10.6, R11.8_

  - [x] 21.2 Apply the layout and token edits to `RetroBoardPageComponent` styles
    - Replace the `rem` paddings, margins and gaps with the 4-px-scale values from the design table; replace the literal colours on the context input and display with `--color-primary-light`, `--surface-board` and `--text-primary`
    - Make the context display a block with `pre-wrap` and `padding: 8px 12px; line-height: 1.4; font-size: 0.75rem` so it renders its full text without clipping
    - Add `width: 100%; align-items: flex-start` to the column containers, `overflow-x: hidden` on the page so horizontal overflow is confined to the column container, the sub-768 px header wrap media query, a `:focus-visible` outline rule, and one reduced-motion block zeroing transition and animation durations for all descendants
    - Keep every existing control with its icon, `title`, `aria-label` and disabled condition, and keep column orientation, order, card order, drag and drop and scroll direction for both layouts
    - _Requirements: R7.1, R7.2, R7.3, R7.4, R7.8, R7.9, R7.10, R7.11, R7.12, R7.13, R7.14, R7.15, R7.17, R10.11_

  - [x] 21.3 Apply the layout and token edits to `RetroColumnComponent` styles
    - `:host { align-self: flex-start }` and `height: auto; min-height: 0` replacing `height: 100%`; `.retro-column__cards { flex: 0 1 auto; overflow-y: auto }`
    - Header row `flex-wrap: nowrap` with a single-line ellipsis name carrying `[title]` and `[attr.aria-label]`, and count, add and delete controls at `min-width/min-height: 32px`
    - Replace the hard-coded colours with `--surface-board`, `--color-primary-light`, `--surface-card-deck`, `--text-primary`, `--text-secondary`
    - _Requirements: R7.1, R7.2, R7.3, R7.5, R7.6, R7.7, R7.16_

  - [x] 21.4 Apply the layout and token edits to `RetroCardComponent` styles
    - Replace the literal colours with the token references, raise the author line, vote count and comment font-size floors to `0.75rem`, set action buttons to `min-width/min-height: 32px`, move paddings onto the 4-px scale
    - `display: flex; flex-direction: column` so text, author line, action row and comment section stack without overlap at any text length
    - _Requirements: R7.1, R7.2, R7.3, R7.5, R7.18_

  - [x] 21.5 Compact `RetroToolbarComponent` and the embedded feelings strip
    - Toolbar: `gap: 4px; padding: 4px 8px; max-height: 40px; overflow-x: auto; overflow-y: hidden; flex-wrap: nowrap`, token background and border, and a sub-768 px block with `max-height: 120px; flex-wrap: wrap; row-gap: 0`
    - Buttons `32px × 32px`; `FeelingsStripComponent` pulled into the toolbar row at `height: 32px; padding: 0 4px; gap: 4px` with `flex: 0 0 auto` and 32 px controls, label at `0.75rem` on `--surface-card-deck`
    - Keep the reveal, enable voting, complete, export, import, screenshot, add column, board settings actions and the strip with their existing icons, `title`, `aria-label`, visibility and disabled conditions, the `role="toolbar"` and the natural tab order
    - _Requirements: R10.1, R10.2, R10.3, R10.4, R10.5, R10.6, R10.7, R10.8, R10.9, R10.10, R10.11_

  - [x] 21.6 **Property test** — Property 27: declared style invariants of the retro surfaces
    - Create `client/src/app/components/retro-board/retro-layout.property.spec.ts`
    - Units exercised: the parsed `styles` declaration lists of the board page, column, card and toolbar components plus `client/src/app/testing/contrast.ts`
    - Generators: `fc.constantFrom(...declarations)` and `fc.constantFrom(...tokenPairs)` driven through the runner; `numRuns: 100`
    - Invariant: every margin, padding and gap resolves to 0 or a multiple of 4 px; every background, border, text colour and shadow is a token reference with no literal colour; every visible-text font size is at least 12 px; every interactive control declares at least 32 × 32 px; every (text token, surface token) pair reaches 4.5:1 and every (focus outline, adjacent surface) and (status fill, chip surface) pair reaches 3:1
    - _Requirements: R7.1, R7.2, R7.3, R7.4, R7.5, R7.14, R10.3, R10.6, R11.8_

  - [x] 21.7 Write `client/src/app/components/retro-board/retro-layout.spec.ts`
    - Column header row structure and name ellipsis with the full name exposed, the summed declared row-height maxima for both the desktop and the wrapped mobile layout, preserved controls and their attributes, the reduced-motion block, overflow confinement, the context row block size, and card composition at 0 and 2,000 characters
    - _Requirements: R7.6, R7.7, R7.8, R7.9, R7.10, R7.11, R7.12, R7.13, R7.15, R7.16, R7.17, R7.18_

  - [x] 21.8 Write `client/src/app/components/retro-board/retro-toolbar.compact.spec.ts`
    - The declared 40 px row maximum, the mobile wrap to at most three rows, the strip rendered inside the toolbar row, the preserved control matrix, keyboard reach for every visible control, the no-empty-bordered-region rule, and the combined 72 px toolbar-plus-context budget
    - _Requirements: R10.1, R10.2, R10.4, R10.5, R10.7, R10.8, R10.9, R10.10, R10.11_

- [x] 22. Client: retro sessions on the lobby and the lobby user control (Stream 7)
  - [x] 22.1 Create `RetroResumeListComponent`
    - Standalone with explicit `imports: [CommonModule]`, Signals only (`sessions`, `loading`, `loadFailed`)
    - One `GET /api/retro/sessions/mine` on init with the stored token and `timeout(10_000)`; a `role="status"` loading indicator in place of the list while pending
    - Entries as `<button>` elements in response order showing board name, session id, creation and last-activity timestamps, navigating to `/retro/:sessionId` on activation; board name single-line ellipsis with the full name as `title` and `aria-label`
    - Heading `Your Retrospective Boards` associated through `aria-labelledby`, distinct from the poker list's heading and accessible name
    - Zero entries and a 401 render nothing with no message; any other status and the timeout render a `role="alert"` failure message
    - _Requirements: R8.9, R8.10, R8.11, R8.12, R8.13, R8.14, R8.15, R8.16, R8.17, R8.18, R8.19, R8.20_

  - [x] 22.2 Add the two optional inputs to `UserMenuComponent`
    - `user = input<User | null>(null)` with an `effectiveUser` computed falling back to `SessionStateService.currentUser`, and `showRoleSwitch = input<boolean>(true)` wrapping the role-switch button in an `@if`
    - Make `MENU_ITEM_COUNT` a computed (`showRoleSwitch() ? 2 : 1`) so arrow-key clamping stays correct
    - Harden `getAvatarLetter` to the uppercased first non-whitespace character, returning `''` when none exists while keeping the button target and the dropdown reachable; add ellipsis containment to the dropdown name
    - Defaults reproduce today's poker-page behaviour exactly
    - _Requirements: R12.2, R12.3, R12.4, R12.10, R13.7, R13.8_

  - [x] 22.3 Add the lobby header and wire both lists in `LobbyComponent`
    - A `lobby-header` row with `justify-content: flex-end` rendering `<app-user-menu [user]="user" [showRoleSwitch]="false" />` as its last element when `authUser()` resolves
    - `authUser = computed(...)` requiring both the stored token and the stored user record; logout clears storage before navigating to the login page
    - Render `RetroResumeListComponent` alongside the existing poker list, keeping the start new game, create retrospective board, join existing session actions and the poker list with their current accessible names and behaviour
    - _Requirements: R8.21, R8.22, R12.1, R12.5, R12.6_

  - [x] 22.4 **Property test** — Property 26: retro session list entries render and navigate
    - Create `client/src/app/components/retro-resume-list/retro-resume-list.property.spec.ts`
    - Unit exercised: `RetroResumeListComponent` through the rendered document
    - Generators: 1–30 summaries with board names 1–300 characters and generated ids; `numRuns: 100`
    - Invariant: entry count and order match the response, all four values appear in each entry, `title === ariaLabel === boardName`, activation dispatches `['/retro', sessionId]`
    - _Requirements: R8.10, R8.13, R8.14, R8.16_

  - [x] 22.5 Write `client/src/app/components/retro-resume-list/retro-resume-list.spec.ts`
    - Request with the stored token, loading state, empty response, 401, other error statuses, the 10-second timeout, heading association and accessible-name distinctness, and keyboard focus order
    - _Requirements: R8.9, R8.11, R8.12, R8.15, R8.17, R8.18, R8.19, R8.20, R8.21_

  - [x] 22.6 **Property test** — Property 25: lobby user control structure and avatar initial
    - Create `client/src/app/components/lobby/lobby-user-menu.property.spec.ts`
    - Unit exercised: `UserMenuComponent` hosted on the lobby
    - Generators: display names 1–200 characters including leading and trailing whitespace, unicode, emoji and combining marks, plus a whitespace-only generator; `numRuns: 100`
    - Invariant: avatar accessible name `User menu for <display name>`, `aria-haspopup="true"`, `aria-expanded` tracking the open state, a `menu` named `User menu`, a single `Logout` item, no role-switch item, and the uppercased first non-whitespace character as the initial; a whitespace-only name renders no initial while the dropdown and logout stay reachable
    - _Requirements: R12.2, R12.3, R12.10_

  - [x] 22.7 Write `client/src/app/components/lobby/lobby-user-menu.spec.ts`
    - Placement as the last header element with its right edge inside the content area, dropdown content without the role switch, logout ordering, open/close by avatar activation and outside click, Escape returning focus to the avatar, the missing-token and missing-user-record cases, and the preserved lobby actions
    - _Requirements: R8.22, R12.1, R12.4, R12.5, R12.6, R12.7, R12.8, R12.9_

- [x] 23. Client: end retro session from the board (Stream 8)
  - [x] 23.1 Add the end-session control and confirmation dialog to `RetroBoardPageComponent`
    - Moderator-only button with `aria-label` and `title` `End session`, disabled while a request is in flight
    - `role="alertdialog"` with exactly one confirm and one cancel action and initial focus on cancel; cancel dismisses and returns focus to the control leaving session state unchanged
    - Confirm guards on `endInFlight()`, sends exactly one `DELETE /api/retro/sessions/:sessionId` with the stored token and a 10-second timeout; on error or timeout it dismisses the dialog, re-enables the control, leaves the board unchanged and shows exactly one error toast
    - On `retro:session:ended` show one notification lasting at least 5 seconds and navigate to `/lobby`; keep back to lobby, copy link, votes remaining, session id and the user control with their accessible names
    - _Requirements: R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R9.12, R9.13, R9.16_

  - [x] 23.2 Handle `retro:session:ended` inside `RetroWebSocketService`
    - Subscribe internally, set the manual-disconnect flag and `disconnected`, and suppress the 4004 and close-code notifications for that socket so the page's single notification is the only one shown
    - _Requirements: R9.12, R11.17, R11.18_

  - [x] 23.3 Write `client/src/app/components/retro-board/end-session.spec.ts`
    - Control visibility for moderator and non-moderator, the alertdialog structure and initial focus, focus return on cancel, exactly one DELETE on confirm, the in-flight disabled state, the failure and timeout paths, the event-driven notification and navigation, and the preserved header controls
    - _Requirements: R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R9.12, R9.13, R9.16_

- [x] 24. Client: connection status indicator and interaction blocking (Stream 9)
  - [x] 24.1 Extend `ToastService`
    - Add an optional `ToastOptions` third parameter (`durationMs`, `tag`) and `dismissByTag(tag)`, leaving every existing two-argument call site and its tests unaffected
    - _Requirements: R9.12, R11.27, R13.6_

  - [x] 24.2 Create `ConnectionStatusComponent` and the status tokens
    - Standalone, `imports: [CommonModule]`, `state = input.required<ConnectionState>()`, `label` and `healthy` computeds driven by `CONNECTION_LABEL`
    - Render a `role="status"` chip with `[title]`, `[attr.aria-label]` and a visible label whose text equals the title text, a dot, 24 px height and an inline label so width stays at least 1.5 × height
    - Add `--status-chip-bg`, `--status-connected`, `--status-fault` and `--text-on-status` to `client/src/styles.scss` and paint the chip on the neutral chip surface inside the header
    - _Requirements: R11.3, R11.4, R11.5, R11.6, R11.7, R11.8_

  - [x] 24.3 Route `WebSocketService` decisions through the episode reducer
    - Feed `open`, `close`, `attempt` and `manual-disconnect` events into `reduceEpisode` and execute the returned effects (schedule reconnect, dismiss tagged connection toasts, give-up toast, navigate to login, close-code toast)
    - Remove the per-drop and per-attempt toasts; tag the remaining connection toasts `'connection'`; keep `connect`, `disconnect`, `send`, `on`, `connectionState`, the initial `'disconnected'` value, the close-code branches and the exported backoff helper; set `reconnecting` at the start of `openConnection()`
    - _Requirements: R11.14, R11.15, R11.16, R11.17, R11.18, R11.19, R11.23, R11.24, R11.25, R11.26, R11.27_

  - [x] 24.4 Route `RetroWebSocketService` decisions through the same reducer
    - Identical effect execution in the separate retro class, with no import of the poker service, keeping its public surface, its initial state value and its close-code branches
    - _Requirements: R11.14, R11.15, R11.16, R11.17, R11.18, R11.19, R11.23, R11.24, R11.25, R11.26, R11.27, R13.9_

  - [x] 24.5 Add the indicator and the interaction blocker to `SessionPokerPageComponent`
    - Render `<app-connection-status [state]="displayedConnectionState()" />` in the header with `connectAttempted` flipping after the `/exists` check so the indicator reads `reconnecting` from the first render
    - Wrap all session controls in a `div.interaction-blocker` inside the scroll container with `[attr.inert]` and `[attr.aria-disabled]` bound to `blocked()`; keep the header, the back-to-lobby action and the user menu logout outside the wrapper
    - Render the `role="status"` `aria-live="polite"` paused-interaction message outside the wrapper while blocked
    - _Requirements: R11.1, R11.9, R11.10, R11.11, R11.12, R11.13_

  - [x] 24.6 Add the indicator and the interaction blocker to `RetroBoardPageComponent`
    - Same structure with `connectAttempted` flipping in `ngOnInit`, the wrapper inside the column scroll container, and the end-session, back-to-lobby and logout controls kept outside it
    - _Requirements: R11.2, R11.9, R11.10, R11.11, R11.12, R11.13_

  - [x] 24.7 **Property test** — Property 16: indicator maps state to colour and label totally
    - Create `client/src/app/components/connection-status/connection-status.property.spec.ts`
    - Unit exercised: `ConnectionStatusComponent` with the `CONNECTION_LABEL` mapping
    - Generators: state sequences of length 1–50 over the three values; `numRuns: 100`
    - Invariant: `healthy === (state === 'connected')` and `title === ariaLabel === labelText === CONNECTION_LABEL[state]` after every state
    - _Requirements: R11.4, R11.5, R11.6, R11.7, R14.12_

  - [x] 24.8 **Property test** — Property 17: interaction is permitted exactly when connected
    - Create `client/src/app/components/connection-status/interaction-blocking.property.spec.ts`
    - Units exercised: the `blocked` computed on `SessionPokerPageComponent` and `RetroBoardPageComponent`
    - Generators: state sequences of length 1–50, typed text 0–200 characters; `numRuns: 100`
    - Invariant: the wrapper carries `inert` and `aria-disabled` exactly when not connected, the status message is present exactly then, the indicator, back-to-lobby and logout stay outside the wrapper and activatable, content stays visible, the scroll container is never the inert element, and typed input text is unchanged
    - _Requirements: R11.9, R11.10, R11.11, R11.12, R11.13, R14.12_

  - [x] 24.9 Write `client/src/app/services/websocket.service.connection.spec.ts`
    - Reserved close codes 4009, 4010 and 4004 each producing exactly one notification with no reconnection attempt, the give-up navigation within 2 seconds, and zero toasts for every episode that ends below the threshold
    - _Requirements: R11.17, R11.18, R11.24_

  - [x] 24.10 Write `client/src/app/services/retro-websocket.service.connection.spec.ts`
    - The same cases for the retro service plus the `retro:session:ended` suppression so only the page's notification is shown
    - _Requirements: R9.12, R11.17, R11.18, R11.24_

  - [x] 24.11 Update the two existing WebSocket service specs for the documented R13.18 exception
    - In `client/src/app/services/websocket.service.spec.ts` and `client/src/app/services/retro-websocket.service.spec.ts`, replace the cases asserting `'Connection lost. Attempting to reconnect...'` and `` `Reconnecting... (attempt 1)` `` with their R11 counterparts: zero toasts below the give-up threshold and exactly one at it
    - Change nothing else in either file; this is the single documented conflict the design records against R13.18 and it is logged in the coverage ledger in task 25.2
    - _Requirements: R11.14, R11.26, R13.18_

- [x] 25. No-regression verification and coverage ledger (Stream 10)
  - [x] 25.1 **Property test** — Property 28: pre-existing names and routes survive
    - Create `server/src/__tests__/isolation.spec.ts`
    - Units exercised: both WebSocket handlers, the route tables, static import scanning of the retro modules
    - Generators: `fc.constantFrom(...)` over the enumerated pre-change event names, the route table and the retro module file list; `numRuns: 100`
    - Invariant: every pre-existing event name still routes without `UNKNOWN_EVENT`, every pre-existing route still resolves at its path and method, and no retro module's import specifiers reference a poker module
    - Add the complementary client-side assertion that the pre-existing accessible names on the eight listed components are still present
    - _Requirements: R13.1, R13.2, R13.5, R13.7, R13.9_

  - [x] 25.2 Write the verification coverage ledger `docs/verification-coverage.md`
    - One row per acceptance criterion of R1 through R13 naming the test that asserts it, with the requirement and criterion numbers embedded in every added test name so the covered count is derivable from names alone
    - Record the not-observable criteria with their reasons: R4.1 per-glyph rasterised position (covered indirectly by Properties 12 and 13), R7.8, R7.13, R10.1, R10.2 and R10.11 rendered row heights (declared maxima summed instead), the R11.20 ±5-second tolerance (asserted as tick counts under fake timers), and the R13.18 conflict with R11.14 and R11.26 including the two superseded test cases and the rationale
    - _Requirements: R14.1, R14.2, R14.3, R13.18_

  - [x] 25.3 Run the full suites and fix every regression
    - Run `cd server && npm test` and `cd client && npm test`; both must report zero failing and zero skipped or disabled tests and complete within the 600-second budget, exiting non-zero with the failing test names on any failure
    - Fix any regression in existing assertions, leaving every pre-existing assertion other than the two documented in task 24.11 unchanged
    - _Requirements: R13.1, R13.2, R13.5, R13.6, R13.7, R13.8, R13.9, R13.12, R13.13, R13.14, R13.15, R14.4, R14.5, R14.6, R14.17, R14.18_

- [x] 26. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **No task is marked optional.** R14.1 through R14.18 mandate automated coverage for every observable criterion, the eight named property families, and a green suite in both packages, so every test task here is required work rather than an MVP nicety.
- **Property tasks are labelled `**Property test**`** and each names the design property number and the pure unit it exercises. The eight required families map as follows: R14.8 → task 2.2 (Property 1, `quoteCsvField`/`parseCsv`); R14.9 → task 3.2 (Property 2, `buildSummaryRow` vs `calculate`); R14.10 → task 3.2 (Property 3, `formatAverage`); R14.11 → task 6.2 (Properties 7, 8, 9, `measureLineCount`/`computeTextAreaHeightPx`); R14.12 → tasks 24.7 and 24.8 (Properties 16, 17); R14.13 → task 8.2 (Property 18, `reduceEpisode`); R14.14 → task 5.2 (Property 5, `issueRowOverflows`); R14.15 → task 4.2 (Property 6, `selectedCardTopOffsetPx`/`requiredHeadroomPx`); R14.16 → task 11.5 (Property 20, `summariseRetroSessions`).
- **The client test runner performs no layout**, so geometric, overflow, spacing and contrast criteria are asserted through the extracted pure functions and style-declaration text, never through `getBoundingClientRect` or computed styles.
- **Liveness probes are wired separately** in tasks 13.2 and 13.3 because R11.22 requires the poker and retro probes to share no state.
- **Task 24.11 is the single documented departure from R13.18**, recorded in the ledger written by task 25.2.
- Checkpoints at tasks 9, 14, 19 and 26 validate incrementally; each runs the real suites rather than inspecting output by hand.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1", "6.1", "7.1", "8.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "3.1", "4.2", "5.2", "6.2", "7.2", "8.2"] },
    { "id": 2, "tasks": ["3.2", "3.3", "10.1", "11.1", "13.1"] },
    { "id": 3, "tasks": ["10.2", "11.2", "11.3", "12.1", "15.1", "15.2"] },
    { "id": 4, "tasks": ["11.4", "12.4", "13.2", "16.1", "17.1"] },
    { "id": 5, "tasks": ["11.5", "12.2", "13.3", "16.2", "17.2", "18.1"] },
    { "id": 6, "tasks": ["12.3", "13.4", "15.3", "18.2", "18.5", "18.7", "20.1", "21.1"] },
    { "id": 7, "tasks": ["15.4", "15.5", "18.3", "18.4", "18.6", "18.8", "20.2", "21.3", "22.1", "22.2"] },
    { "id": 8, "tasks": ["20.3", "20.4", "21.2", "21.4", "21.5", "22.3", "22.4", "22.6", "24.1"] },
    { "id": 9, "tasks": ["21.6", "21.7", "21.8", "22.5", "22.7", "23.1", "24.2", "24.3"] },
    { "id": 10, "tasks": ["23.2", "23.3", "24.5", "24.7"] },
    { "id": 11, "tasks": ["24.4", "24.6", "24.9", "25.1"] },
    { "id": 12, "tasks": ["24.8", "24.10", "24.11", "25.2"] },
    { "id": 13, "tasks": ["25.3"] }
  ]
}
```
