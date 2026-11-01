# Implementation Plan: Session Chat

## Overview

This plan implements design.md in TypeScript, bottom-up and test-driven. It starts with the shared contract and validator, moves on to the server chat state and handlers, then the server and client transport hardening (Requirements 23 and 25), the client chat state, the presentation helpers, the bottom-left overlay layout, the Deferred chat chunk and its loader, and the launcher and host mounted on both board pages. It ends with integration tests, the build-output check and the `0.0.9` release edits (Requirement 26).

Conventions used by every task:

- Shared names come from `shared/types.ts` and `shared/chat-text.ts`, imported on the client through `@shared/types` and `@shared/chat-text` (R13.11).
- Server tests are Jest under `server/src/**/__tests__/` and `shared/__tests__/`. Client tests are Vitest with `@testing-library/angular` and `fast-check`. Both run once with `npm test` and never in watch mode (R22.6).
- Every property test runs at least 100 cases and carries the tag comment `// Feature: session-chat, Property N: <title>` (design, Testing Strategy).
- No new npm script, dependency or `package.json` change anywhere in the feature (C14, R26.7).

## Tasks

- [x] 1. Shared chat contract and Chat_Validator
  - [x] 1.1 Add the chat, transport and panel-loader contract to `shared/types.ts`
    - Add the constants `CHAT_MESSAGE_MAX_LENGTH`, `CHAT_RAW_TEXT_MAX_LENGTH`, `CHAT_HISTORY_LIMIT`, `CHAT_RATE_LIMIT_COUNT`, `CHAT_RATE_LIMIT_WINDOW_MS`, `CHAT_ACK_TIMEOUT_MS`, `CHAT_DEDUP_PER_AUTHOR`, `WS_MAX_PAYLOAD_BYTES`, `WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT`, `CHAT_PANEL_LOAD_RETRY_DELAYS_MS` (frozen read-only array) and `CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS` with the values of the Assumptions table
    - Add the eight poker and retro chat event-name constants, `BoardKind`, `CHAT_EVENTS`, `ChatMessage`, `ChatRejection` and the four payload types exactly as in design "shared/types.ts additions"
    - Implement `isCanonicalUuid` (8-4-4-4-12 hex, any version, any case) and `isChatMessage` (seven fields, safe-integer `seq >= 1`, non-empty `authorId`, `sentAt` regex plus `toISOString()` round trip, extra fields ignored)
    - Leave `GameSessionState` and `RetroSessionState` unchanged
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9, 13.10, 5.14, 20.12, 23.4_

  - [x] 1.2 Write property test for `isChatMessage`
    - **Property 1: `isChatMessage` accepts exactly well-formed messages**
    - **Validates: Requirements 13.7, 5.14**
    - File `shared/__tests__/chat-message.property.spec.ts`; build `sentAt` from `fc.date` between 2000 and 2099 with `noInvalidDate: true`; mutate one field at a time to an out-of-constraint value

  - [x] 1.3 Write property test for the chat payload JSON round trip
    - **Property 2: Chat payload JSON round trip**
    - **Validates: Requirements 13.8, 13.9**
    - Same file as 1.2; cover single messages and `ChatHistoryPayload` arrays

  - [x] 1.4 Implement the Chat_Validator in `shared/chat-text.ts`
    - Export `ChatTextResult`, `validateChatText(value: unknown)` and `normaliseChatText(raw: string)`
    - Run the checks in design order: non-string → `CHAT_INVALID`; raw length above 2,000 → `CHAT_TOO_LONG` without normalising; normalise (`\r\n?` → `\n`, remove Disallowed_Characters, trim U+0009, U+000A, U+FEFF, U+2028, U+2029 and `\p{Zs}` with two index loops, not an anchored regex); empty → `CHAT_EMPTY`; above 500 → `CHAT_TOO_LONG`
    - No clock reads, no global state, no input mutation
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8_

  - [x] 1.5 Write unit tests for the Chat_Validator
    - File `shared/__tests__/chat-text.spec.ts`: `CHAT_INVALID` for a number, `CHAT_EMPTY` for `" \u0001\t"`, 500 code units accepted and 501 rejected, 2,001 raw rejected and 2,000 raw normalised, interior tabs and consecutive line feeds kept
    - _Requirements: 22.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 1.6 Write property test for the Chat_Validator against a reference model
    - **Property 3: Chat_Validator agrees with the reference specification**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.8**
    - File `shared/__tests__/chat-text.property.spec.ts`; generators mix non-strings, strings near 500 and 2,000 code units, whitespace-only and Disallowed_Character-only strings, `\r\n`, lone `\r`, bidi controls, Zs spaces and lone surrogates

  - [x] 1.7 Write property test for normalisation idempotence
    - **Property 4: Normalisation is idempotent**
    - **Validates: Requirements 14.7**
    - Same file as 1.6

- [x] 2. Server chat state (`ChatRoom`) inside each session object
  - [x] 2.1 Implement `ChatBuffer`, `ChatDedupRecord` and `ChatRateLimiter` in `server/src/services/chat-room.ts`
    - `Clock` type; `ChatBuffer` as a fixed 200-slot ring buffer with `push` (returns the evicted message), O(1) `getBySeq`, `toArray` (ascending seq, fresh array) and `size`
    - `ChatDedupRecord` as `Map<authorId, Map<clientMessageId, seq>>`, lower-casing `clientMessageId`, evicting only that author's oldest entry at 50
    - `ChatRateLimiter` with injected clock: `check` drops times with `now - t >= windowMs` and returns `retryAfterMs = clamp(t_oldest + windowMs - now, 1, windowMs)`; `record` stores `clock()`; role is never read
    - _Requirements: 16.4, 17.1, 17.2, 17.3, 17.7, 17.9, 18.1, 18.2, 20.2_

  - [x] 2.2 Implement the `ChatRoom` class with `prepare` and `commit`
    - Constructor options `clock`, `idFactory`, `onAccepted`; fields `nextSeq = 1`, `lastSentAtMs = -Infinity`
    - `prepare` checks dedup first (buffered seq → `replay` with the stored message unchanged; evicted seq → `rejected CHAT_DUPLICATE`; another author's id → continue), then the rate limit, then builds the message with `sentAt = max(clock(), lastSentAtMs)` and returns `accepted` with a `commit` closure; nothing is mutated before `commit()`
    - `commit()` runs buffer push, `nextSeq++`, `lastSentAtMs`, dedup record, rate-limit record and `onAccepted(atMs)` with no throwing call between the first and last mutation; `history()` returns the buffer array
    - _Requirements: 16.1, 16.2, 16.3, 16.5, 16.6, 16.7, 16.11, 17.4, 18.2, 18.3, 20.7_

  - [x] 2.3 Give `GameSession` and `RetroSession` a `chat: ChatRoom`
    - Add `readonly chat: ChatRoom` and an optional `options?: { chatClock?: Clock }` constructor parameter in `server/src/services/game-session.ts` and `server/src/services/retro-session.ts`, so `SessionRegistry`, `RetroSessionRegistry` and existing tests compile unchanged
    - `onAccepted` sets `lastActivityAt = new Date(atMs).toISOString()` (do not reuse `touch()`)
    - Do not touch `chat` from `history:clear`, `board:clear` or `retro:board:complete` code paths; add no module-level chat state
    - _Requirements: 17.5, 18.6, 18.7, 18.8, 18.9, 18.10, 15.6_

  - [x] 2.4 Write unit tests for `ChatRoom`, the buffer, the dedup record and the rate limiter
    - File `server/src/services/__tests__/chat-room.spec.ts`: 200 accepts fill the buffer and the 201st evicts seq 1; the 51st id of one author evicts that author's first; 5 sends in 5,000 ms accepted, the 6th rejected with the exact `retryAfterMs`, a send after it accepted, another author unaffected, all with the injected clock and no real waiting; a new session starts empty with next seq 1; `lastActivityAt` set on accept only
    - _Requirements: 22.1, 22.7, 18.6, 18.10_

  - [x] 2.5 Write property test for contiguous Sequence_Numbers and non-decreasing `sentAt`
    - **Property 10: Sequence numbers are contiguous and `sentAt` never decreases**
    - **Validates: Requirements 16.1, 16.2**
    - File `server/src/services/__tests__/chat-room.property.spec.ts`; the generated clock may move backwards

  - [x] 2.6 Write property test for the Chat_Buffer list model
    - **Property 11: The Chat_Buffer matches a list model**
    - **Validates: Requirements 18.1, 18.2, 18.3, 20.2**
    - Same file as 2.5

  - [x] 2.7 Write property test for the dedup model
    - **Property 12: Duplicate sends match the dedup model**
    - **Validates: Requirements 16.4, 16.5, 16.6, 16.7, 16.11, 17.4**
    - Same file as 2.5; include case-flipped UUID variants

  - [x] 2.8 Write property test for the rate-limit invariant
    - **Property 13: The rate limiter allows at most five per window**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.6, 17.8, 17.9**
    - Same file as 2.5

  - [x] 2.9 Write property test for rate-limit isolation
    - **Property 14: Rate limits are isolated per author and session**
    - **Validates: Requirements 17.10**
    - Same file as 2.5; use several `ChatRoom` instances standing for poker and retro sessions

- [x] 3. Chat send decision and the poker and retro chat handlers
  - [x] 3.1 Implement `server/src/websocket/chat-send.ts`
    - `evaluateChatSend(raw, ctx)` applying the R14.11 order: non-array object → session match (`CHAT_SESSION_MISMATCH`) → `isCanonicalUuid(clientMessageId)` → `validateChatText(text)` → `room.prepare` (dedup, then rate limit); never read author fields from the payload
    - `CHAT_REJECTION_MESSAGES` with the six fixed texts from design; rejection payload echoes `clientMessageId` when it is a string, else `''`; `retryAfterMs` only for `CHAT_RATE_LIMITED`
    - `formatChatLogLine(fields: ChatLogFields)` with only the whitelisted keys
    - Import neither handler nor any poker module, so the `isolation.spec.ts` import scan keeps passing
    - _Requirements: 13.5, 14.9, 14.10, 14.11, 14.12, 14.13, 14.15, 15.1, 15.2, 19.1, 19.2, 19.6_

  - [x] 3.2 Write property test for client-server text parity
    - **Property 5: Client and server reach the same text verdict**
    - **Validates: Requirements 14.14**
    - File `server/src/websocket/__tests__/chat-send.property.spec.ts`

  - [x] 3.3 Add poker chat routing to `server/src/websocket/handler.ts`
    - Pass the raw `message.data` for `CHAT_MESSAGE_SEND` only and keep `message.data || {}` for every other event (C1)
    - Add the `CHAT_MESSAGE_SEND` case after the existing session lookup, outside the permission switch; retro chat names keep reaching `default` → `UNKNOWN_EVENT`
    - `handleChatSend`: return silently unless the socket is still registered in `sessionClients` for the user; wrap the rest in its own `try/catch` that logs only `formatChatLogLine({ …, errorName })` and sends nothing; send `rejected` and `replay` to the sender only; for `accepted`, build the frame string, call `commit()`, then send to every `OPEN` socket of the session, each send in its own `try/catch`
    - Send `chat:history` with `session.chat.history()` to the new socket right after the existing `participant:joined` broadcast (C9)
    - Export `getRegisteredPokerSessionId(ws)` for the server error log
    - _Requirements: 1.12, 1.13, 15.3, 15.5, 15.6, 15.7, 15.8, 15.9, 15.12, 15.13, 16.5, 18.4, 18.8, 18.14, 19.1, 19.6, 20.6, 20.7, 23.15_

  - [x] 3.4 Add retro chat routing to `server/src/websocket/retro-handler.ts`
    - Same structure as 3.3 for `RETRO_CHAT_MESSAGE_SEND`, using `RetroSessionRegistry`, `retroSessionClients` and the retro event names only; not in the moderator-only list; poker chat names reach `UNKNOWN_EVENT`
    - Missing session follows the existing `retro:error` `NOT_FOUND` + close 4004 path; chat exceptions never reach the outer `catch` that sends `retro:error`
    - Send `retro:chat:history` after the existing `retro:participant:joined` broadcast; export `getRegisteredRetroSessionId(ws)`
    - Keep accepting chat after `retro:board:complete`
    - _Requirements: 1.12, 1.13, 15.4, 15.5, 15.6, 15.7, 15.8, 15.12, 16.5, 18.5, 18.9, 18.14, 19.1, 19.6, 20.6, 20.7, 23.15_

  - [x] 3.5 Write property test for check order and side-effect-free rejection
    - **Property 7: The first failing check decides, and a rejection changes nothing**
    - **Validates: Requirements 14.9, 14.10, 14.11, 14.12, 14.15, 15.2, 15.8, 1.12, 16.3, 18.10**
    - Same file as 3.2; drive rooms owned by real `GameSession` and `RetroSession` instances so `lastActivityAt` is checked; vary role, permission modes, round state, retro phase and `isCompleted`

  - [x] 3.6 Write property test for server-side authorship
    - **Property 8: Authorship comes only from the connection**
    - **Validates: Requirements 15.1**
    - Same file as 3.2

  - [x] 3.7 Write unit tests for the Poker_Chat_Handler
    - File `server/src/websocket/__tests__/handler.chat.spec.ts` with mock sockets: accepted send broadcast to every socket; each of the six codes sent to the sender only with nothing stored; multi-failure payload answered with the first failing check; `null` payload → `CHAT_INVALID`; `SESSION_NOT_FOUND` path; retro names → `UNKNOWN_EVENT`; unregistered socket dropped; removed participant's messages kept in history and no later broadcast to them; history after `participant:joined`, empty for a new session; `history:clear`, `board:clear`, `story:submit`, `cards:reveal`, `round:revote`, `issue:select` and `participant:remove` leave chat unchanged; a throwing `idFactory` leaves state unchanged and the socket open; existing message indexes in `handler.spec.ts` unchanged
    - _Requirements: 22.8, 1.13, 15.3, 15.7, 15.9, 15.12, 15.13, 18.4, 18.6, 18.8, 20.6, 20.7_

  - [x] 3.8 Write unit tests for the Retro_Chat_Handler
    - File `server/src/websocket/__tests__/retro-handler.chat.spec.ts`: the retro counterparts of 3.7, plus `NOT_FOUND` + 4004, `retro:cards:reveal`, `retro:voting:enable` and `retro:board:complete` leaving chat unchanged, and sends accepted after completion
    - _Requirements: 22.8, 1.13, 15.4, 15.7, 18.5, 18.9, 20.7_

  - [x] 3.9 Write property test for session isolation through both handlers
    - **Property 9: Sessions are isolated**
    - **Validates: Requirements 15.10, 15.5**
    - File `server/src/websocket/__tests__/chat-isolation.property.spec.ts`; mock sockets through both handlers across two or more sessions of each Board_Kind

  - [x] 3.10 Write property test for chat log privacy
    - **Property 36: Chat logs carry only permitted fields**
    - **Validates: Requirements 19.1, 19.2, 19.6, 23.2**
    - Same file as 3.2; spy on `console.*`, inject exceptions with arbitrary messages, and assert no text, author name, payload value, JWT or exception message appears

- [x] 4. Checkpoint - server chat core
  - Run `cd server && npm test` once (no watch). Ensure all tests pass, ask the user if questions arise.

- [x] 5. Server WebSocket transport hardening
  - [x] 5.1 Harden `server/src/server.ts`
    - Export `redactUpgradeUrl(url)` (text before the first `?`, `''` for `undefined`), `createUpgradeHandler(options)` and `attachSocketErrorLog(ws, boardKind, lookupSessionId, log)` as in design
    - Create both servers with `{ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES }`, changing no other option
    - Log exactly one `WebSocket upgrade request: ${redactUpgradeUrl(request.url)}` per upgrade; keep the existing `PUBLIC_PATH` / `PRESERVE_PATH` routing rule and pass the unmodified request on
    - Inside each `handleUpgrade` callback, call `attachSocketErrorLog` before `emit('connection', …)`; it stores the error `code` and writes at most one line `WebSocket error: kind=… [session=…] [code=…] close=…` on `close`, with the session ID only from `getRegisteredPokerSessionId` / `getRegisteredRetroSessionId`
    - Wire the module-level instance from env as today; add no environment variable, Helm value or Dockerfile change
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.15, 21.4_

  - [x] 5.2 Write unit tests for the Upgrade_Log_Line
    - File `server/src/__tests__/upgrade-log.spec.ts`: poker and `/retro` paths, with and without `BASE_PATH` and `PRESERVE_PATH=true`, valid, invalid, expired and missing tokens and a 4001 close; exactly one line per request; no JWT, `token=` or `?` in captured console output; same server and full URL as before
    - _Requirements: 22.10, 23.1, 23.2, 23.3_

  - [x] 5.3 Write property test for upgrade log redaction and routing
    - **Property 35: Upgrade logging is redacted and routing is unchanged**
    - **Validates: Requirements 23.1, 23.2, 23.3**
    - File `server/src/__tests__/upgrade-log.property.spec.ts`; build handlers with explicit options against stub `WebSocketServer`s

  - [x] 5.4 Create the localhost WebSocket integration harness and write the payload-limit test
    - Harness `server/src/__tests__/integration/ws-harness.ts`: `http.Server` on port 0, both `WebSocketServer`s with `maxPayload`, `createUpgradeHandler`, the real handlers and real tokens from `auth-service`; torn down after each test
    - Test `server/src/__tests__/integration/ws-payload-limit.spec.ts` for both servers: exactly 1,048,576 bytes reaches the handler; 1,048,577 bytes as one frame and as fragments closes with 1009, runs no handler, changes no state, broadcasts nothing, triggers the normal leave broadcast, logs only the permitted fields, raises no `uncaughtException`, and leaves a second connection of the same user open and receiving
    - _Requirements: 22.11, 23.5, 23.6, 23.7, 23.8, 23.9_

  - [x] 5.5 Write the largest-legitimate-frame integration test
    - File `server/src/__tests__/integration/ws-bulk-import.spec.ts` using the harness of 5.4: an `issue:add` with 200 titles of 500 three-byte characters is accepted and `issue:list-updated` is broadcast
    - _Requirements: 22.12, 23.6_

- [x] 6. Client WebSocket transport hardening
  - [x] 6.1 Implement `client/src/app/services/frame-guard.ts`
    - Pure `utf8ByteLength(json)` using `TextEncoder` and `exceedsFrameLimit(json)` against `WS_MAX_PAYLOAD_BYTES`
    - _Requirements: 23.10_

  - [x] 6.2 Extend `client/src/app/services/connection-episode.ts` with the consecutive 1009 count
    - Add `consecutiveTooLarge` and `haltedTooLarge` to `EpisodeState` and `initialEpisodeState`, and the effect `{ kind: 'toast-payload-too-large' }`
    - Implement the changed transition rows of design: 1009 below the limit continues the episode with the existing backoff and no notification; reaching 3 ends it `disconnected` with one notification and no navigation or reconnect; while halted, any close does nothing; any other close code and `manual-disconnect` reset the count; `open` keeps it
    - Keep reserved codes 4009, 4010, 4004, the give-up threshold of 10 and `navigate-login` unchanged
    - _Requirements: 23.11, 23.12, 23.13, 23.14_

  - [x] 6.3 Write example tests for the 1009 rules of the Connection_Episode_Reducer
    - File `client/src/app/services/connection-episode.spec.ts`: 1009 below the limit; three 1009 closes with `open` between each pair; the sequence 1009, 1006, 1009, 1009 not ending the episode; reset on `connect()` (initial state) and on manual disconnect; unchanged 4009, 4010, 4004 and give-up behaviour
    - _Requirements: 22.13, 23.11, 23.12, 23.13_

  - [x] 6.4 Write property test for bounded reconnection
    - **Property 33: Reconnection is bounded on repeated oversized-frame closes**
    - **Validates: Requirements 23.11, 23.12, 23.13, 23.14**
    - Extend `client/src/app/services/connection-episode.property.spec.ts`; generate at least 100 sequences mixing 1009, 1006, 1000, reserved codes, `open`, `attempt` and `manual-disconnect`

  - [x] 6.5 Add the Current_Socket guard, `connectionGeneration` and the frame guard to `WebSocketService`
    - Replace `this.ws` with `current: SocketRecord | null` (`socket`, `closeEmitted`, `closeCalled`) and a private `retire(record)` that calls `close()` at most once and never on a closed socket
    - `openConnection()` retires the old record, creates and assigns the new one, and starts each handler with `if (record !== this.current)`; stale `onopen` retires the socket and dispatches nothing; stale `onmessage` returns before parsing; stale `onclose` only sets `closeEmitted`; stale `onerror` does nothing
    - Current `onopen` increments the `connectionGeneration` signal before dispatching `open`; current `onclose` sets `closeEmitted` and keeps the record (remove `this.ws = null`); `disconnect()` retires the current record, sets it to `null`, cancels the reconnect timer and dispatches exactly one `manual-disconnect`
    - `send(event, data): boolean`: `false` unless the Current_Socket is `OPEN`; serialise once; above `WS_MAX_PAYLOAD_BYTES` show the untagged toast "This change is too large to send.", log nothing and return `false`; `true` after `socket.send`
    - Run the new `toast-payload-too-large` effect as an error toast with the R23.12 text and the `connection` tag
    - _Requirements: 23.10, 23.12, 23.16, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.10_

  - [x] 6.6 Apply the same changes to `RetroWebSocketService`
    - Same structure as 6.5 in `client/src/app/services/retro-websocket.service.ts`; `handleSessionEnded` now runs only for `retro:session:ended` of the Current_Socket; the `sendX` helpers keep their `void` signatures
    - _Requirements: 23.10, 23.12, 23.16, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.10_

  - [x] 6.7 Keep the bulk-import text when the frame is rejected
    - In `IssueListPanelComponent.bulkImport()`, clear `bulkText` and close the Bulk_Import_Panel only when `send()` returns `true`
    - _Requirements: 23.16_

  - [x] 6.8 Write unit tests for the `WebSocketService` stale-socket and frame-guard behaviour
    - File `client/src/app/services/websocket.service.stale-socket.spec.ts`; extend the existing `MockWebSocket` pattern with `emitOpen`, `emitMessage`, `emitClose`, `emitError` and a `closeCalls` counter
    - Cover every R22.17 service case (second `connect()` then old `close` with 1000, 1006 and 1009; `disconnect()` then `connect()`; stale `message`, `open` and `close`; `disconnect()` cancelling a reconnect with one `manual-disconnect`; `send()` results; generation rules) and the frame-guard cases (exactly 1 MiB sent, 1 MiB + 1 rejected, one toast per call, socket open, state and 1009 count unchanged); existing close-code, give-up and navigation specs keep passing
    - _Requirements: 22.13, 22.17, 23.10, 25.1, 25.2, 25.3, 25.4, 25.5, 25.7, 25.10_

  - [x] 6.9 Write unit tests for the `RetroWebSocketService` stale-socket and frame-guard behaviour
    - File `client/src/app/services/retro-websocket.service.stale-socket.spec.ts`: the cases of 6.8 for the retro service, plus a stale `retro:session:ended` reaching no subscriber and a poker event leaving the retro generation unchanged
    - _Requirements: 22.13, 22.17, 23.10, 25.4, 25.7, 25.10_

  - [x] 6.10 Write property test for the frame guard
    - **Property 34: The frame guard sends exactly the frames that fit**
    - **Validates: Requirements 23.10**
    - File `client/src/app/services/frame-guard.property.spec.ts`; include multi-byte, emoji and lone-surrogate strings and check both services' `send()`

  - [x] 6.11 Write property test for the stale-socket invariant
    - **Property 37: Stale-socket events change nothing**
    - **Validates: Requirements 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.10**
    - File `client/src/app/services/websocket-stale-socket.property.spec.ts`, one `describe` per service with a shared command generator that addresses sockets by creation index; run each sequence twice (as generated and with stale events removed) under fake timers and compare the logs; check the live-socket count after each step

  - [x] 6.12 Write unit tests for bulk-import text preservation
    - In `client/src/app/components/issue-list-panel/issue-list-panel.component.spec.ts`: `send()` returning `false` keeps Bulk_Import_Text and the panel open; returning `true` clears both
    - _Requirements: 22.16, 23.16_

- [x] 7. Checkpoint - transport hardening
  - Run `cd server && npm test` and `cd client && npm test` once each (no watch). Ensure all tests pass, ask the user if questions arise.

- [x] 8. Client chat state
  - [x] 8.1 Implement `client/src/app/services/chat-transport.ts`
    - `ChatTransport` interface and `CHAT_TRANSPORT` token as in design
    - `PokerChatTransport` over `WebSocketService`, `SessionStateService.participants` and `AuthService.getCurrentUser()`; `RetroChatTransport` over `RetroWebSocketService`, `RetroStateService.participants` and `RetroStateService.currentUserId`
    - Re-expose `connectionState`, `connectionGeneration` and the `on<T>()` streams of `CHAT_EVENTS[kind]` as `unknown`; add no `BehaviorSubject` and no presence event
    - _Requirements: 1.1, 1.2, 10.4, 10.5, 15.6, 19.5, 20.5_

  - [x] 8.2 Implement `client/src/app/services/chat-read-marker.ts`
    - Key `scrum-poker-chat-read:<boardKind>:<sessionId>`; parse only `/^[1-9]\d*$/` safe integers, anything else is "no Read_Marker"; serialise as a decimal string
    - Wrap every `sessionStorage` access in `try/catch` and fall back to memory with no error shown; write nothing to `localStorage`
    - _Requirements: 2.10, 2.11, 2.12, 19.3, 19.7_

  - [x] 8.3 Implement the pure `reduceChat` reducer in `client/src/app/services/chat-store.ts`
    - `ChatState`, `OutboxEntry`, `ChatEntry`, `ChatAction` and `ChatEffect` as in design Data Models
    - Actions `reset`, `connection`, `send`, `added`, `history(raw, generation)`, `rejected`, `ackTimeout`, `retry`, `discard`, `markRead`, `historyTimeout` with the state changes and effects of the design table: union-by-id merge keeping the 200 highest seqs; outbox replacement by own `clientMessageId`; connected-time-only ack accounting; the generation gate (first history: merge, no resend; higher generation: merge, replace, resend each remaining `pending` once with a fresh timer, keep `failed`; equal or lower: unchanged, no effects); `CHAT_DUPLICATE` → `sent` with the local first-send time; other codes → `failed` with the rejection text; `CHAT_RATE_LIMITED` always sets `rateLimitUntil`; `announce('Message not sent.')` on a transition to `failed`
    - Selectors `entries` (confirmed by seq, then outbox in send order) and `unreadCount` (non-own confirmed with seq above the Read_Marker)
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 2.8, 5.1, 5.13, 5.14, 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9, 8.12, 9.3, 9.4, 9.5, 9.6, 9.7, 11.18, 13.12, 13.13, 16.8, 16.9, 16.10, 16.12, 18.11, 18.12, 18.13, 25.9, 25.11, 25.12_

  - [x] 8.4 Implement the page-scoped `ChatStore` service in `client/src/app/services/chat-store.service.ts`
    - `@Injectable()` (not root); read-only signals from the reducer, the writable UI signals of design (`panelState`, `draft`, `caret`, `scroll`, `newIndicatorCount`, `presenceOpen`, `everOpened`) and the intents `sendDraft`, `retry`, `discard`
    - Subscribe to `added$`, `history$` and `rejected$` with `takeUntilDestroyed`, dispatching `history` with `untracked(transport.connectionGeneration)`; dispatch `connection` from an effect on `connectionState`; start the 10,000 ms history timeout on the first `connected`
    - Execute effects through an injectable `CHAT_TIMERS` token (`now`, `setTimeout`, `clearTimeout`) and the read-marker wrapper; `sendDraft` uses `crypto.randomUUID()`, sends the Normalised_Text and clears draft and caret; `sendable` is `validateChatText(draft).ok && connected`
    - Read_Marker effect while `open`, document visible and at least one confirmed message; `unreadIncreaseCount` bumps on each increase of `unreadCount`; `newIndicatorCount` follows R6.2, R6.8 and R6.9 including while not `open`
    - Write no message or Draft text to console or storage
    - _Requirements: 2.4, 2.12, 3.10, 3.13, 5.13, 6.2, 6.8, 6.9, 7.6, 7.11, 15.11, 18.11, 19.3, 20.5, 20.16, 25.9_

  - [x] 8.5 Write property test for merge confluence
    - **Property 15: Merging confirmed messages is confluent**
    - **Validates: Requirements 16.8, 16.9, 18.12**
    - File `client/src/app/services/chat-store.property.spec.ts`

  - [x] 8.6 Write property test for Chat_History idempotence
    - **Property 16: Applying the same Chat_History twice equals applying it once**
    - **Validates: Requirements 16.10**
    - Same file as 8.5

  - [x] 8.7 Write property test for the outbox delivery state machine
    - **Property 17: Outbox entries follow the delivery state machine**
    - **Validates: Requirements 5.1, 8.1, 8.2, 8.3, 8.4, 8.7, 8.8, 8.12, 16.12**
    - Same file as 8.5

  - [x] 8.8 Write property test for the reconnect merge
    - **Property 18: Reconnect merge resends each pending message once**
    - **Validates: Requirements 9.4, 9.5, 9.6, 9.7**
    - Same file as 8.5

  - [x] 8.9 Write property test for connected-time acknowledgement
    - **Property 19: The acknowledgement timer counts only connected time**
    - **Validates: Requirements 8.5, 9.3**
    - Same file as 8.5

  - [x] 8.10 Write property test for the Unread_Count definition
    - **Property 20: The Unread_Count matches its definition**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7, 2.8**
    - Same file as 8.5

  - [x] 8.11 Write property test for malformed inbound events
    - **Property 21: Malformed inbound events change nothing they should not**
    - **Validates: Requirements 5.14, 13.12, 13.13**
    - Same file as 8.5

  - [x] 8.12 Write property test for Read_Marker storage
    - **Property 22: Read_Marker storage round trip**
    - **Validates: Requirements 2.10, 2.11**
    - Same file as 8.5

  - [x] 8.13 Write property test for the generation gate
    - **Property 38: The generation gate decides how each Chat_History is applied**
    - **Validates: Requirements 9.4, 18.13, 25.9, 25.11, 25.12**
    - Same file as 8.5; interleave repeated, increasing and decreasing generations with `reset` actions

  - [x] 8.14 Write property test for the New_Messages_Indicator count
    - **Property 30: The New_Messages_Indicator counts what arrived out of view**
    - **Validates: Requirements 6.2, 6.8**
    - Same file as 8.5; drive the `ChatStore` service with a fake transport and generated scroll and Panel_State changes

  - [x] 8.15 Write example tests for the `ChatStore` service
    - File `client/src/app/services/chat-store.service.spec.ts` with a fake transport, a writable `connectionGeneration` signal and fake timers: `pending → sent`, `pending → failed` after 10,000 ms of connected time, `failed → pending` on Retry, the reconnect merge example of R9.4–R9.7; the R22.17 generation cases (first history with no resend, higher generation resending exactly once, equal or lower ignored, behaviour after `reset`); throwing `sessionStorage` keeps working in memory; only the Read_Marker key is written; console and storage spies see no message text on send, reject and timeout
    - _Requirements: 22.3, 22.17, 2.12, 19.3, 19.7, 25.9, 25.11, 25.12_

- [x] 9. Pure presentation helpers
  - [x] 9.1 Implement `client/src/app/components/chat/chat-format.ts`
    - `avatarInitials`, `avatarColorIndex` (FNV-1a mod 8), `AVATAR_PALETTE` (the eight colours of design), `formatChatTime`, `badgeText`, `launcherLabel`, `unreadDescription`, `indicatorText`, `onlineLabel`, `presenceEntries`, `clampPaste`, `rateLimitSeconds`
    - _Requirements: 2.1, 2.2, 2.3, 2.9, 5.3, 5.4, 5.5, 6.7, 7.9, 7.12, 8.9, 10.1, 10.3, 10.6, 11.2, 11.3_

  - [x] 9.2 Write property test for count texts
    - **Property 23: Count texts follow their formats**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.9, 6.7, 7.9, 8.9, 11.2**
    - File `client/src/app/components/chat/chat-format.property.spec.ts`

  - [x] 9.3 Write property test for timestamps
    - **Property 24: Timestamps follow the two display forms**
    - **Validates: Requirements 5.5**
    - Same file as 9.2

  - [x] 9.4 Write property test for avatars
    - **Property 25: Avatars are deterministic**
    - **Validates: Requirements 5.3**
    - Same file as 9.2

  - [x] 9.5 Write property test for presence derivation
    - **Property 26: Presence is derived from the participant list**
    - **Validates: Requirements 10.1, 10.3, 10.6**
    - Same file as 9.2

  - [x] 9.6 Write property test for paste clamping
    - **Property 27: Paste never overfills the draft**
    - **Validates: Requirements 7.12**
    - Same file as 9.2

  - [x] 9.7 Implement `reduceAttention` in `client/src/app/components/chat/chat-attention.ts`
    - Pure state machine over `unreadIncrease`, `panelState`, `visibility`, `reducedMotion` and `tick(now)`: start or restart on an Unread_Increase while `closed`/`minimized`, visible and not reduced motion; remember a pending start while hidden and start once on becoming visible; stop at start + 3,600 ms, on `open`, at Unread_Count 0 or when reduced motion turns on; never restart on `closed` ↔ `minimized`; expose `attentionRun` and Unread_Ring visibility
    - _Requirements: 2.13, 24.1, 24.2, 24.4, 24.6, 24.7, 24.10, 24.12_

  - [x] 9.8 Write property test for the attention state machine
    - **Property 32: The attention animation follows the Unread_Increase rules**
    - **Validates: Requirements 2.13, 24.1, 24.2, 24.4, 24.6, 24.7, 24.10, 24.12**
    - File `client/src/app/components/chat/chat-attention.property.spec.ts`

- [x] 10. Bottom-left overlay arrangement on the poker board
  - [x] 10.1 Implement the pure geometry module `client/src/app/services/board-overlay-layout.ts`
    - Functions for the Bottom_Left_Base_Offset, balloon bottom, balloon maximum height, balloon hidden (< 64 px) and the rectangles of the launcher (with 7 px ring extent), open panel, minimized header, Chat_Load_Error_Notice, Vote_Callout_Layer and balloon stack for a given viewport, narrow flag, Panel_State, notice flag and measured sizes
    - _Requirements: 4.2, 12.3, 12.4, 12.9, 12.11, 12.12, 20.14_

  - [x] 10.2 Write property test for non-overlapping overlays
    - **Property 31: Overlays never overlap**
    - **Validates: Requirements 4.2, 12.4, 12.9, 12.11, 12.12, 20.14**
    - File `client/src/app/services/board-overlay-layout.property.spec.ts`

  - [x] 10.3 Implement `BoardOverlayLayoutService` in `client/src/app/services/board-overlay-layout.service.ts`
    - `providedIn: 'root'`; signals `viewport` (undebounced `resize`), `headerBottomPx`, `chatDockTopPx`, `calloutLayerHeightPx`, `baseOffsetPx`, `balloonBottomPx`, `balloonMaxHeightPx`, `balloonHidden` computed from 10.1
    - `trackHeader` and `trackCalloutLayer` with `ResizeObserver` and `DestroyRef` cleanup, keeping defaults with no error when `ResizeObserver` is undefined; `setChatDockTop`
    - _Requirements: 12.4, 12.11, 12.12_

  - [x] 10.4 Move the Vote_Callout_Layer to the bottom-left and mirror the far entrance
    - `VoteCalloutLayerComponent`: `left: 16px` instead of `right: 16px`, `align-items: flex-start`, narrow rule without `left/right: 16px` and with `max-width: calc(100vw - 88px)`, keeping `max-height: 45vh; overflow-y: auto`, z-index 900, `isolation` and `pointer-events`; `bottomPx = max(baseOffsetPx, inset > 0 ? inset + 16 : 16)`, `null` when 16; call `trackCalloutLayer`
    - `NearAverageCalloutComponent`: narrow `max-width: calc(100vw - 88px)`
    - `vote-callout.keyframes.scss`: `callout-slide-in` 0% `translateX(calc(-100% - var(--callout-edge-gap))) rotate(-9deg)`, mirrored 65% overshoot, 100% `translateX(0) rotate(0deg)`; duration, easing, other keyframes and reduced-motion rules unchanged
    - _Requirements: 12.3, 12.12, 12.13_

  - [x] 10.5 Stack the Moderator_Note_Balloon above the callout layer
    - `ModeratorNoteBalloonComponent`: bind `bottom` and `max-height` to `balloonBottomPx` and `balloonMaxHeightPx`, narrow `max-width: calc(100vw - 88px)`, render only while `!balloonHidden()`; keep z-index 905 and keep `_balloons` and their timers untouched while hidden; keep `moderator-note-balloon.component.spec.ts` passing
    - _Requirements: 12.4, 12.11, 12.12_

  - [x] 10.6 Replace the R20.8 assertions in `vote-callout.stylesheet.spec.ts`
    - Replace only the listed assertions: layer `left: 16px`, `bottom` equal to the Bottom_Left_Base_Offset, no `right`, `align-items: flex-start`, `gap: 8px`, narrow `max-width: calc(100vw - 88px)` for the layer and the near-average panel; far entrance 0% frame `translateX(calc(-<n>% - var(--callout-edge-gap)))` with n ≥ 100 and a rotation magnitude of 6–15 degrees, 100% frame `translateX(0)` with rotation 0
    - Keep every other assertion of the suite unchanged
    - _Requirements: 20.8, 22.20, 12.3, 12.13_

  - [x] 10.7 Write stylesheet scan and geometry tests for the bottom-left arrangement
    - File `client/src/app/services/board-overlay-layout.spec.ts`: stylesheet scans of the R12.3 and R12.4 declarations of the layer, the near-average panel and the balloon stack using `declared-css.ts`; geometry at widths 320, 767, 768 and 1280 and heights 400 and 900 in every Panel_State, including the 1 px narrow gap between `100vw - 72px` and `100vw - 71px`
    - _Requirements: 22.15, 12.3, 12.4, 12.9_

- [x] 11. Checkpoint - client state, helpers and layout
  - Run `cd client && npm test` once (no watch). Ensure all tests pass, ask the user if questions arise.

- [x] 12. Chat_Panel implementation (Deferred chat chunk)
  - [x] 12.1 Add the global chat styles
    - Add the token `--chat-bubble-other: #edf2f7` to `client/src/styles.scss`; create `client/src/app/components/chat/chat.keyframes.scss` with the `chat-pulse` keyframes (`transform` and `opacity` only) and import it once from `styles.scss`; use no `color-mix()`
    - _Requirements: 12.1, 12.7, 12.8, 24.1, 24.3, 5.7_

  - [x] 12.2 Implement `ChatPanelHeaderComponent`
    - Title "Chat", `onlineLabel` text, Presence_List toggle "Show participants" with `aria-expanded`, "Minimize chat" and "Close chat" buttons; while minimized, one "Restore chat" button covering title and Unread_Count with `aria-describedby` to a visually hidden `unreadDescription` element while unread > 0, plus the 10 px `aria-hidden` Unread_Dot; 44 × 44 px targets and the chat focus ring
    - _Requirements: 2.9, 3.4, 3.5, 3.6, 10.1, 10.2, 11.3, 11.11, 24.8, 24.9_

  - [x] 12.3 Implement `ChatMessageListComponent`
    - `role="log"`, `aria-label="Chat messages"`, `aria-live="polite"`, `aria-relevant="additions"`, `tabindex="0"`, `aria-busy` while a history is applied; `@for` over `store.entries()` tracked by `key`
    - Rows in DOM order author ("You" for own), `<time datetime>` with `formatChatTime` or "Sending…" / "Not sent", then text via interpolation with `white-space: pre-wrap; overflow-wrap: anywhere`; `aria-hidden` avatar with palette colour; own and other bubble alignment and colours; Retry ("Retry sending message", disabled while offline) and Discard ("Discard message") on failed rows
    - Empty, loading and timed-out texts; manual scroll anchoring with `overflow-anchor: none` and `afterRenderEffect`; scroll to end when At_Bottom (48 px) and on own send, single jump under reduced motion; sticky New_Messages_Indicator `<button>` with `indicatorText`, which scrolls to the end, resets the count and focuses the composer; writes `store.scroll` on every scroll
    - _Requirements: 4.8, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 8.6, 8.10, 8.11, 9.1, 9.9, 11.8, 11.9, 11.15, 11.17, 19.4, 20.3_

  - [x] 12.4 Implement `ChatComposerComponent`
    - `<textarea aria-label="Message" maxlength="500" rows="1">` with auto-grow up to 5 lines via `scrollHeight`; `paste` handler using `clampPaste`; send button "Send message" disabled while not sendable
    - Enter without Shift and not composing (`isComposing` false and `keyCode !== 229`) prevents default and sends only if sendable; Shift+Enter keeps the default line break; focus stays in or returns to the text area after send
    - Counter from 400 code units; rate-limit text with a 1 s update; `aria-describedby` only to shown elements; draft and caret written to `ChatStore` on every input; text area editable while offline
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 8.9, 9.2, 9.10, 11.10, 11.11, 3.10_

  - [x] 12.5 Implement `ChatPresenceListComponent`
    - Render `presenceEntries(participants, me)` as plain text with visible "(you)" and "Moderator"; visibility from `store.presenceOpen`, hidden at first and kept across Panel_State changes; keep the last list while offline
    - _Requirements: 10.3, 10.4, 10.6, 10.7, 10.8_

  - [x] 12.6 Implement the `ChatPanelComponent` shell
    - `<section id="chat-panel-<kind>" role="dialog" aria-label="Session chat" [attr.aria-modal]>` with `aria-modal` true only on a narrow viewport while `open`; z-index 920; tokens `--surface-board`, `--text-primary`, `--shadow-lg`
    - Wide open, narrow open (`inset: 0`, `100dvh`, `visualViewport` resize/scroll adjustment, plain layout without `visualViewport`) and minimized layouts from design; header clearance from `BoardOverlayLayoutService.headerBottomPx`; `matchMedia('(max-width: 767px)')` switch without remounting
    - One `role="status"` region while `open` holding offline text, rate-limit text or the last announcement; offline text "Chat is offline until the connection is restored." above the composer
    - `transform`/`opacity` transitions of 150 ms, none under reduced motion; focus to the composer on entering `open` and to Restore on `open → minimized`; narrow focus trap with the exception for page dialogs, menus and the countdown overlay; Escape closes when not composing; restore Draft, caret and scroll on reopen
    - Import only the modules permitted by design ("Files", R20.4 precondition)
    - _Requirements: 3.1, 3.2, 3.7, 3.8, 3.9, 3.11, 3.12, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 4.9, 4.11, 9.1, 9.10, 11.3, 11.4, 11.5, 11.6, 11.14, 11.16, 11.18, 12.1, 12.2, 12.7, 12.10, 21.7_

  - [x] 12.7 Write property test for plain-text rendering
    - **Property 29: Message content renders as plain text**
    - **Validates: Requirements 5.8**
    - File `client/src/app/components/chat/chat-message-list.property.spec.ts`

  - [x] 12.8 Write property test for sendability
    - **Property 6: Sendability depends only on the validator and the connection**
    - **Validates: Requirements 7.6, 1.11**
    - File `client/src/app/components/chat/chat-composer.property.spec.ts`

  - [x] 12.9 Write property test for sent payloads
    - **Property 28: Sent payloads carry normalised text and fresh ids**
    - **Validates: Requirements 7.11**
    - Same file as 12.8

  - [x] 12.10 Write unit tests for the message list
    - File `client/src/app/components/chat/chat-message-list.component.spec.ts`: the `<script>` / `<img onerror>` literal-rendering example; empty, loading and timed-out texts; DOM node identity kept across an add and an eviction; scroll anchoring with stubbed `scrollTop` / `scrollHeight`; indicator activation focusing the composer; log role and name
    - _Requirements: 22.3, 22.4, 5.10, 5.11, 5.13, 6.1, 6.2, 6.4, 11.8, 20.3_

  - [x] 12.11 Write unit tests for the composer
    - File `client/src/app/components/chat/chat-composer.component.spec.ts`: Enter sends, Shift+Enter inserts a line break, Enter during composition (`isComposing` and `keyCode 229`) sends nothing, disabled button while not sendable, `maxlength`, offline editing, label "Message" and name "Send message"
    - _Requirements: 22.3, 7.2, 7.3, 7.4, 7.7, 7.8, 9.2, 11.10_

  - [x] 12.12 Write unit tests for the panel shell and header
    - File `client/src/app/components/chat/chat-panel.component.spec.ts`: Panel_State transitions of R3.4–R3.7 including Escape during composition; focus targets; dialog role and names; `aria-modal` per mode and the narrow focus trap with the dialog exception; status region present before any text; Draft, caret and scroll restored on reopen; Presence_List toggle hidden by default and kept across states
    - _Requirements: 22.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.12, 10.2, 10.7, 11.3, 11.4, 11.5, 11.6, 11.18, 12.10_

- [x] 13. Panel_Chunk_Loader and the Chat_Load_Error_Notice
  - [x] 13.1 Implement `client/src/app/services/chunk-url.ts`
    - `CHUNK_SPECIFIER_PATTERN`, `readChunkSpecifier`, `resolveChunkUrl` (returns `null` on any failure) and `withRetryParam` (`?` or `&`, keeps the fragment)
    - _Requirements: 20.13, 20.18_

  - [x] 13.2 Write property test for Chunk_URL resolution
    - **Property 40: The Chunk_URL is resolved from the importer's source**
    - **Validates: Requirements 20.13, 20.18**
    - File `client/src/app/services/chunk-url.property.spec.ts`

  - [x] 13.3 Create `client/src/app/components/chat/chat-panel-importer.ts`
    - `importChatPanel` as the only `import('./chat-panel.component')` of the panel, and `CHAT_PANEL_IMPORTER_BASE_URL = import.meta.url`
    - _Requirements: 20.4, 20.13_

  - [x] 13.4 Implement `PanelChunkLoader` in `client/src/app/services/panel-chunk-loader.ts`
    - `providedIn: 'root'` with `PANEL_CHUNK_LOADER_DEPS` (importer, base URL, `importUrl` wrapper using `import(/* @vite-ignore */ url)`, timers, `requestIdle` or `null` where `requestIdleCallback` is undefined)
    - Signals `panelClass`, `busy`, `errorShown`, the `opened` observable and `prefetchWhenIdle`, `requestOpen`, `dismissError` with the rules of design: per-attempt timeout race, retries after the delays of `CHAT_PANEL_LOAD_RETRY_DELAYS_MS`, at most 4 attempts, Cache_Busted_Import after any failure in the document with a document-wide `retry` counter, fallback to the unchanged importer when the specifier cannot be read, late success used, late success after exhaustion hides the notice without opening (C15), prefetch adoption, silent failed prefetch, no attempt after success
    - _Requirements: 20.4, 20.10, 20.11, 20.12, 20.13, 20.14, 20.15, 20.16, 20.17, 20.18_

  - [x] 13.5 Write property test for the loader retry schedule
    - **Property 39: The Panel_Chunk_Loader follows its retry schedule**
    - **Validates: Requirements 20.10, 20.11, 20.13, 20.14, 20.15, 20.17**
    - File `client/src/app/services/panel-chunk-loader.property.spec.ts`; deferred-promise `vi.fn` importers settled at generated times under fake timers, compared with a reference scheduler

  - [x] 13.6 Implement `ChatLoadErrorNoticeComponent`
    - Fixed at the minimized-header position, z-index 920, `--surface-board` and `--shadow-lg`; `<p role="alert">Chat could not be loaded.</p>`, native "Try again" (calls `requestOpen()`) and "Dismiss" (calls `dismissError()` and asks the host to focus the launcher) buttons with 44 × 44 px targets and the chat focus ring
    - _Requirements: 20.14, 11.11, 12.12_

- [x] 14. Chat launcher, chat host and mounting on both boards
  - [x] 14.1 Implement `ChatLauncherComponent`
    - Native `<button type="button">` with `aria-controls="chat-panel-<kind>"`, `aria-expanded` true only while `open`, name from `launcherLabel`, `aria-busy="true"` and "Loading chat…" while `loader.busy()`
    - Fixed `right: 16px; bottom: 16px`, 56 px (48 px narrow) circle, z-index 910, `--gradient-primary` and `--text-on-primary`; hidden on a narrow viewport while `open`
    - `aria-hidden` Unread_Badge with `badgeText` on `--status-fault`; Unread_Ring as two 2 px box-shadow bands while unread > 0 and not `open`; two-tone `:focus-visible` ring within 7 px (C11)
    - Attention pulse span (`aria-hidden`, `pointer-events: none`, `chat-pulse 1200ms ease-out 0ms 3 both`) re-keyed by `attentionRun` from `reduceAttention`, removed on stop and not rendered under reduced motion; a 3,600 ms timer ends a run
    - _Requirements: 1.4, 1.6, 1.7, 2.1, 2.2, 2.3, 2.13, 4.4, 11.1, 11.2, 11.11, 11.12, 12.1, 12.2, 12.7, 20.11, 20.16, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.9, 24.10, 24.11, 24.12_

  - [x] 14.2 Implement `ChatHostComponent`
    - Providers `ChatStore` and `CHAT_TRANSPORT` chosen by the `boardKind` attribute through `HostAttributeToken`; `sessionId` input with an effect dispatching `reset` on change; `prefetchWhenIdle()` once
    - Render the launcher, the error notice while `loader.errorShown()`, and the panel through `*ngComponentOutlet` while `panelState !== 'closed'` and the panel class is loaded
    - `toggleFromLauncher()`: nothing while busy, `requestOpen()` while not loaded, otherwise the R1.6 / R1.7 toggle; subscribe to `loader.opened` to set `open`; Panel_State starts `closed` and is never read from storage
    - Narrow scroll lock that records and restores scroll position and `overflow`; focus return to the launcher on close and on Dismiss; publish the minimized header or notice top to `setChatDockTop` on a narrow viewport
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 3.3, 4.10, 9.8, 11.7, 12.12, 18.11, 20.11, 20.14, 20.16, 20.17_

  - [x] 14.3 Mount the chat on `SessionPokerPageComponent`
    - Add `<app-chat-host boardKind="poker" [sessionId]="sessionId()" />` inside the session-found `@else` branch as a sibling after `.session-poker-page`, outside every Interaction_Blocker wrapper (D9)
    - Call `BoardOverlayLayoutService.trackHeader` on the page header
    - Add `padding-bottom: 88px` to `.session-poker-page__board-area`, `.session-poker-page__sidebar--desktop`, `.session-poker-page__sidebar-overlay` and, below 768 px, `.session-poker-page`
    - Keep existing page specs (including "layer is the last child of `.session-poker-page`") passing
    - _Requirements: 1.1, 1.3, 1.5, 1.9, 12.5, 12.6, 4.2_

  - [x] 14.4 Mount the chat on `RetroBoardPageComponent`
    - Add `<app-chat-host boardKind="retro" [sessionId]="sessionId()" />` after `.retro-board`, outside every Interaction_Blocker wrapper; call `trackHeader`; add the literal `padding-bottom: 88px` to `.retro-board__columns` (C10)
    - Keep `retro-layout.property.spec.ts` and other retro specs passing
    - _Requirements: 1.2, 1.5, 1.9, 12.5, 12.6, 4.2_

  - [x] 14.5 Write unit tests for the launcher and the attention indication
    - File `client/src/app/components/chat/chat-launcher.component.spec.ts`: badge hidden at 0 and `1`, `99`, `99+` at 1, 99 and 100; `aria-controls`, `aria-expanded` and names; toggle rules on wide and narrow; the R22.14 controlled-clock scenarios; stylesheet scans for `transform`/`opacity`-only keyframes, `animation-iteration-count: 3`, `animation-duration: 1200ms` and the two 2 px bands; contrast test of the R24.5 pairs from `styles.scss` values
    - _Requirements: 22.3, 22.14, 1.6, 1.7, 2.1, 2.2, 2.3, 4.4, 11.1, 11.2, 24.1, 24.2, 24.4, 24.5, 24.7, 24.10, 24.12_

  - [x] 14.6 Write unit tests for the loader, launcher busy state and error notice
    - File `client/src/app/services/panel-chunk-loader.spec.ts` with an injected importer, `importUrl` and fake timers: every R22.18 case (N = 1–3 failures then success, exact retry delays, 4 failures with notice and "Try again" success, unique `retry` values across sequences, 10,000 ms timeout, silent failed prefetch then cache-busted activation, no extra attempt on a second activation, "Dismiss" focus return, messages received during and after a failed sequence shown once the panel opens), no busy state after success, the R20.18 fallback, and the notice role, names, 44 px targets and z-index 920
    - _Requirements: 22.18, 20.10, 20.11, 20.13, 20.14, 20.15, 20.16, 20.17, 20.18_

  - [x] 14.7 Write unit tests for the host and page wiring
    - File `client/src/app/components/chat/chat-host.component.spec.ts`: launcher not inside `[inert]` while disconnected; no chat in the "Session Not Found" branch, including a switch while `open`; chat removed on page destroy; Panel_State `closed` on render; `reset` on `sessionId` change; scroll-clearance scan for `padding-bottom: 88px` on each listed container; token scan (every chat colour a `var(--…)` except the avatar palette) and contrast tests for palette, bubbles, badge, placeholder, focus ring and Unread_Dot
    - _Requirements: 1.3, 1.5, 1.8, 1.9, 5.4, 5.7, 11.11, 11.12, 12.1, 12.5, 18.11, 24.8_

- [x] 15. Checkpoint - chat UI end to end
  - Run `cd server && npm test` and `cd client && npm test` once each (no watch). Ensure all tests pass, ask the user if questions arise.

- [x] 16. Integration, performance and static checks
  - [x] 16.1 Write the cross-session isolation integration test
    - File `server/src/__tests__/integration/chat-isolation.spec.ts` using the harness of 5.4 (create it if it is missing): two poker and two retro sessions with one message each; every connection gets exactly its session's messages within `CHAT_ACK_TIMEOUT_MS` and nothing else during a further 500 ms
    - _Requirements: 22.5, 15.5, 15.10_

  - [x] 16.2 Write the fan-out and board-latency integration tests
    - File `server/src/__tests__/integration/chat-fanout.spec.ts`: 50 connections to one session of each kind, 20 consecutive messages from distinct authors each reach all 50 within 500 ms; with all 50 sending at the rate limit, a vote or retro card broadcast reaches all within 500 ms
    - _Requirements: 22.9, 20.1, 20.9_

  - [x] 16.3 Write the base-path integration test
    - File `server/src/__tests__/integration/chat-base-path.spec.ts`: the three `BASE_PATH` / `PRESERVE_PATH` configurations, one message per Board_Kind delivered to every connection, history on connect, poker and retro buffers kept separate, unchanged connection URLs
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [x] 16.4 Write the static source scan test
    - File `server/src/__tests__/chat-static-scan.spec.ts`: no second definition of chat names, constants or `isChatMessage` under `server/src` or `client/src`; no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `[innerHTML]`, `[outerHTML]` or `bypassSecurityTrust` in chat files; no `HttpClient` or `new WebSocket` in chat files; no `BehaviorSubject` in chat files
    - _Requirements: 13.11, 19.4, 19.5, 20.5_

- [x] 17. Build-output check for the Deferred chat chunk
  - [x] 17.1 Write `client/scripts/check-chat-chunk.mjs`
    - Node built-ins only; read `dist/client/stats.json` and `dist/client/browser/`; find the Deferred chat chunk, the importer chunk and both board page chunks by input base name; assert the readable specifier (same `CHUNK_SPECIFIER_PATTERN` source) resolves to the Deferred chat chunk and the file exists; assert the chunk is outside the initial closure (cross-checked against `index.html`); assert every static import of the chunk lies in `loaded(poker) ∩ loaded(retro)`; exit non-zero with a message naming the failed condition
    - Run `npx ng build --stats-json` then `node scripts/check-chat-chunk.mjs` in `client/`, and fix any `anyComponentStyle` warning for chat components, any new `initial` budget warning or any failed condition in code (do not add an npm script)
    - _Requirements: 22.19, 20.4, 12.8_

  - [x] 17.2 Write the specifier-pattern parity test
    - File `client/src/app/services/chunk-specifier-parity.spec.ts`: read `client/scripts/check-chat-chunk.mjs` as text and assert it contains `CHUNK_SPECIFIER_PATTERN.source`
    - _Requirements: 22.19, 20.13_

- [x] 18. Checkpoint - full feature
  - Run `cd server && npm test` and `cd client && npm test` once each (no watch), then the build-output check of 17.1. Ensure all tests pass, ask the user if questions arise.

- [x] 19. Release 0.0.9
  - [x] 19.1 Bump `helm/scrum-poker/Chart.yaml`
    - `version: 0.0.9` unquoted and `appVersion: "0.0.9"` quoted; every other line and comment unchanged
    - _Requirements: 26.1, 26.2, 26.10_

  - [x] 19.2 Update `helm/scrum-poker/README.md`
    - Replace all 17 occurrences of `0.0.8` with `0.0.9` at the lines listed in design "Release / Edits", changing only those five characters and keeping the `helm search` column alignment, the image name `siddhivinayaksk/scrum-pocker` and the chart name `scrum-poker`
    - _Requirements: 26.3, 26.4, 26.6, 26.8_

  - [x] 19.3 Update the root `README.md`
    - Replace all 7 occurrences of `0.0.8` with `0.0.9` (docker pull, three `helm install`, `helm template`, `--set image.tag=`, `tag: "..."`); leave `client/package.json`, `server/package.json`, `.github/workflows/*.yml`, `tests/helm/*.test.ts` and `helm/scrum-poker/values.yaml` unchanged
    - _Requirements: 26.5, 26.6, 26.7, 26.8_

  - [x] 19.4 Run the release checks on the release tree
    - `git grep -n "0\.0\.8" -- helm/scrum-poker/Chart.yaml helm/scrum-poker/README.md README.md` returns nothing; `cd tests/helm && npm ci && npm run test:helm`; `helm lint helm/scrum-poker`; `bash tests/helm-smoke.test.sh`; edit nothing under `tests/helm/`, and fix any failure outside it
    - _Requirements: 26.6, 26.9, 26.11_

- [x] 20. Final checkpoint - release ready
  - Run `cd server && npm test`, `cd client && npm test` and the release checks of 19.4 once more. Ensure all tests pass, ask the user if questions arise. Tagging `v0.0.9` and publishing the release stay with the maintainer.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Task 10.6 is required because the existing `vote-callout.stylesheet.spec.ts` would fail without it (R20.8).
- Each task references requirement criteria for traceability; each property test task references one design Correctness Property (1–40), and each property appears in exactly one task.
- Several property tasks share one test file as listed in the design's Testing Strategy table; the dependency graph puts those tasks in different waves.
- Integration tests use only localhost sockets and no external service (R22.6). R11.13 (200% text size) and the browser check of R4.7 are manual and have no task.
- The whole feature and the version edits of task 19 belong in one Release_Commit (R26.10); the maintainer tags it `v0.0.9`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.1", "6.1", "6.2", "8.2", "9.1", "9.7", "10.1", "12.1", "13.1"] },
    { "id": 2, "tasks": ["1.3", "1.5", "1.6", "2.2", "6.3", "6.4", "6.5", "6.6", "8.3", "9.2", "9.8", "10.2", "10.3", "13.2"] },
    { "id": 3, "tasks": ["1.7", "2.3", "2.4", "2.5", "3.1", "6.7", "6.8", "6.9", "6.10", "6.11", "8.1", "8.5", "9.3", "10.4", "10.5"] },
    { "id": 4, "tasks": ["2.6", "3.2", "3.3", "3.4", "6.12", "8.4", "8.6", "9.4", "10.6", "10.7"] },
    { "id": 5, "tasks": ["2.7", "3.6", "3.7", "3.8", "3.9", "5.1", "8.7", "8.15", "9.5", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 6, "tasks": ["2.8", "3.5", "5.2", "5.3", "5.4", "8.8", "9.6", "12.6", "12.7", "12.8", "12.10", "12.11"] },
    { "id": 7, "tasks": ["2.9", "3.10", "5.5", "8.9", "12.9", "12.12", "13.3"] },
    { "id": 8, "tasks": ["8.10", "13.4", "16.1", "16.2", "16.3"] },
    { "id": 9, "tasks": ["8.11", "13.5", "13.6", "14.1"] },
    { "id": 10, "tasks": ["8.12", "14.2"] },
    { "id": 11, "tasks": ["8.13", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 12, "tasks": ["8.14", "14.7", "16.4", "17.1"] },
    { "id": 13, "tasks": ["17.2"] },
    { "id": 14, "tasks": ["19.1", "19.2", "19.3"] },
    { "id": 15, "tasks": ["19.4"] }
  ]
}
```
