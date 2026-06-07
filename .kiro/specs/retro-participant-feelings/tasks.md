# Implementation Plan: Retro Participant Feelings

## Overview

This plan implements the "Participant Feelings" feature for the retrospective board. The implementation proceeds bottom-up: shared types first, then server-side state and WebSocket handling, followed by client-side service and components, and finally integration into the existing retro toolbar.

## Tasks

- [x] 1. Define shared types and constants
  - [x] 1.1 Add FeelingCategory type, constants, and configuration extensions to `shared/types.ts`
    - Add `FeelingCategory` union type with all 10 categories
    - Add `ALL_FEELING_CATEGORIES` array constant
    - Add `FEELING_EMOJI_MAP` record mapping categories to emoji strings
    - Add `DEFAULT_ALLOWED_FEELINGS` constant (`['Happy', 'Sad', 'No_Feeling']`)
    - Extend `RetroConfiguration` interface with `allowedFeelings: FeelingCategory[]`
    - Extend `RetroSessionState` interface with `feelings: Record<string, FeelingCategory | null>`
    - Add WebSocket event type constants for `retro:feeling:select` and `retro:feeling:updated`
    - _Requirements: 1.1, 1.2, 1.7, 2.2, 4.1_

- [x] 2. Implement server-side feelings logic
  - [x] 2.1 Extend `RetroSession` class with feelings state management
    - Add private `feelings: Map<string, FeelingCategory | null>` field
    - Implement `setFeeling(userId, category)` — validate category is in `allowedFeelings` and board is not completed
    - Implement `getFeeling(userId)` and `getFeelingsMap()` methods
    - Implement `clearFeelingForCategory(category)` — returns affected userIds
    - Update `removeParticipant` to also remove feeling entry
    - Update `getSessionState` to include feelings map in returned state
    - Update `updateConfig` to clear feelings for removed categories and return affected userIds
    - Apply `DEFAULT_ALLOWED_FEELINGS` when creating new sessions
    - _Requirements: 1.1, 1.2, 1.6, 1.7, 3.1, 3.5, 3.7, 4.1, 4.4_

  - [x] 2.2 Write unit tests for `RetroSession` feelings methods (Jest)
    - Test `setFeeling` stores valid feeling
    - Test `setFeeling` rejects category not in `allowedFeelings`
    - Test `setFeeling` rejects when board is completed
    - Test `removeParticipant` clears feeling entry
    - Test `updateConfig` clears feelings for removed categories
    - Test `getSessionState` includes complete feelings map
    - Test default `allowedFeelings` applied on new session
    - _Requirements: 1.1, 1.6, 3.1, 3.5, 3.7, 4.1, 4.4, 7.4_

  - [x] 2.3 Add feelings WebSocket event handling to `retro-handler.ts`
    - Handle `retro:feeling:select` event: validate user, check board not completed, validate category in `allowedFeelings` or null
    - On valid selection: call `RetroSession.setFeeling()`, broadcast `retro:feeling:updated` to all session clients
    - On config update removing categories: call `clearFeelingForCategory()` for each removed category, broadcast individual `retro:feeling:updated` with null for each affected user
    - On participant disconnect: broadcast `retro:feeling:updated` with null for disconnected user
    - Return appropriate error codes (`BOARD_COMPLETED`, `INVALID_FEELING`, `UNAUTHORIZED`, `INVALID_MESSAGE`)
    - _Requirements: 1.5, 1.6, 1.8, 3.1, 3.2, 3.3, 3.5, 3.7, 4.2, 4.4, 7.5_

  - [x] 2.4 Write unit tests for retro-handler feelings events (Jest)
    - Test `retro:feeling:select` routes correctly and broadcasts
    - Test rejection of feeling selection on completed board
    - Test rejection of invalid/disallowed feeling category
    - Test non-moderator config update rejected
    - Test config update clearing affected participants' feelings
    - Test disconnect broadcasts null feeling
    - _Requirements: 1.8, 3.5, 3.7, 4.2, 4.4, 7.4, 7.5_

- [x] 3. Checkpoint - Server implementation verified
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement client-side feelings service
  - [x] 4.1 Create `FeelingsService` in `client/src/app/services/feelings.service.ts`
    - Injectable with `providedIn: 'root'`, use `inject()` pattern
    - Maintain `feelings` signal: `Signal<Record<string, FeelingCategory | null>>`
    - Maintain `myFeeling` computed signal based on current user ID
    - Subscribe to `retro:feeling:updated` events from `RetroWebSocketService`
    - Implement `selectFeeling(category: FeelingCategory | null)` method sending `retro:feeling:select`
    - Handle connection state: don't update local state if send fails
    - Initialize feelings from session state on join/reconnect
    - _Requirements: 3.1, 3.2, 3.3, 3.8, 4.1, 4.3, 4.5_

  - [x] 4.2 Write unit tests for `FeelingsService` (Vitest)
    - Test `selectFeeling` sends correct WebSocket message
    - Test `myFeeling` computed signal reflects current user's feeling
    - Test feelings signal updates on `retro:feeling:updated` event
    - Test initialization from session state
    - Test local state not updated on connection failure
    - _Requirements: 3.1, 3.8, 4.3, 4.5, 7.4_

  - [x] 4.3 Write property tests for feelings selection logic (Vitest + fast-check)
    - **Property 5: Valid feeling selection updates state and broadcasts**
    - **Validates: Requirements 3.1, 3.2, 3.6, 4.1, 4.2**
    - **Property 6: Toggle deselection**
    - **Validates: Requirements 3.3**
    - **Property 7: Disallowed feeling rejection**
    - **Validates: Requirements 3.7**
    - **Property 8: Board completion prevents feeling changes**
    - **Validates: Requirements 3.5**

- [x] 5. Implement Feelings Strip component
  - [x] 5.1 Create `FeelingsStripComponent` in `client/src/app/components/feelings-strip/`
    - Standalone Angular component with selector `app-feelings-strip`
    - Read `allowedFeelings` from `RetroStateService` configuration
    - Read current user's feeling from `FeelingsService.myFeeling`
    - Render golden/yellow bordered container with "Your feeling" label
    - Display emoji buttons in `allowedFeelings` order using `FEELING_EMOJI_MAP`
    - Highlight currently selected emoji with distinct visual indicator
    - Show tooltip on hover with category name
    - Disable emoji buttons when board is completed
    - Call `FeelingsService.selectFeeling()` on click
    - Show summary icon for moderators only (opens `FeelingsSummaryPopupComponent`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.3, 3.5, 3.6, 5.1_

  - [x] 5.2 Write unit tests for `FeelingsStripComponent` (Vitest)
    - Test renders "Your feeling" label and golden border container
    - Test displays correct emojis for `allowedFeelings`
    - Test highlights selected emoji
    - Test emoji buttons disabled when board completed
    - Test summary icon visible only for moderators
    - Test click calls `selectFeeling` with correct category
    - Test tooltip displays category name
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 3.5, 5.1, 7.4_

  - [x] 5.3 Write property tests for feelings strip display (Vitest + fast-check)
    - **Property 3: Feelings strip displays exactly allowedFeelings in order**
    - **Validates: Requirements 2.2, 2.5**
    - **Property 4: Selected feeling is highlighted**
    - **Validates: Requirements 2.6**
    - **Property 12: Summary icon visibility matches moderator status**
    - **Validates: Requirements 5.1**

- [x] 6. Implement Feelings Summary Popup component
  - [x] 6.1 Create `FeelingsSummaryPopupComponent` in `client/src/app/components/feelings-summary-popup/`
    - Standalone Angular component with selector `app-feelings-summary-popup`
    - Accept `open` input signal and emit `closed` output
    - Modal dialog listing all participants with their feeling emoji and category name
    - Display "No feeling" for participants with null selection
    - Sort participants in case-insensitive alphabetical order by display name
    - Live-update from `FeelingsService.feelings` signal while open
    - Include "Screenshot" button using existing `RetroScreenshotService` pattern
    - Screenshot captures popup content as PNG, downloads as `feelings-summary-YYYY-MM-DD.png`
    - Show loading state during screenshot capture, re-enable on completion or failure
    - Display error toast on screenshot failure
    - Close on backdrop click or close button, return focus to summary icon
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Write unit tests for `FeelingsSummaryPopupComponent` (Vitest)
    - Test renders participant list with feeling emojis
    - Test displays "No feeling" for null selections
    - Test participants sorted alphabetically case-insensitive
    - Test screenshot button triggers capture
    - Test loading state during capture
    - Test error handling on screenshot failure
    - Test close on backdrop click and close button
    - _Requirements: 5.2, 5.4, 5.5, 5.6, 6.1, 6.2, 6.4, 6.5, 7.4_

  - [x] 6.3 Write property test for popup sorting (Vitest + fast-check)
    - **Property 13: Popup displays participants in case-insensitive alphabetical order**
    - **Validates: Requirements 5.4, 5.5**

- [x] 7. Checkpoint - Components implemented and tested
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Integrate feelings into board settings and toolbar
  - [x] 8.1 Extend retro settings panel with feelings configuration UI
    - Add "Feelings" section to existing settings dialog in `retro-toolbar.component.ts`
    - Display 10 checkboxes for each `FeelingCategory` with emoji + name labels
    - Derive checked state from current `allowedFeelings` configuration
    - Enforce minimum-one constraint (disable last remaining checked checkbox)
    - Send updated `allowedFeelings` via existing `sendConfigUpdate()` method on change
    - _Requirements: 1.3, 1.4, 1.5, 1.8_

  - [x] 8.2 Write unit tests for settings panel feelings section (Vitest)
    - Test renders all 10 category checkboxes
    - Test checked state matches current `allowedFeelings`
    - Test toggling sends config update
    - Test last checkbox cannot be unchecked (minimum-one enforcement)
    - _Requirements: 1.3, 1.4, 1.5, 7.4_

  - [x] 8.3 Write property tests for configuration bounds (Vitest + fast-check)
    - **Property 1: allowedFeelings bounds enforcement**
    - **Validates: Requirements 1.1, 1.4**
    - **Property 2: Non-moderator configuration rejection**
    - **Validates: Requirements 1.8**
    - **Property 9: Removing a feeling from allowed clears affected participants**
    - **Validates: Requirements 1.6, 2.7**

  - [x] 8.4 Integrate `FeelingsStripComponent` into `retro-toolbar.component.ts`
    - Import and add `<app-feelings-strip>` to the toolbar template on the right side
    - Ensure strip renders regardless of retro template chosen
    - Verify no modifications to existing toolbar elements
    - _Requirements: 2.1, 2.4, 7.1, 7.2_

- [x] 9. Handle synchronization and edge cases
  - [x] 9.1 Implement reconnection and state sync logic
    - Ensure `RetroSession.getSessionState()` returns feelings map for new/reconnecting participants
    - Initialize `FeelingsService` feelings signal from session state on join
    - Handle graceful degradation: missing `allowedFeelings` defaults to `DEFAULT_ALLOWED_FEELINGS`, missing `feelings` treated as empty `{}`
    - Handle unknown feeling categories in map by ignoring on client
    - _Requirements: 4.3, 4.5_

  - [x] 9.2 Write property test for new joiner state sync (Vitest + fast-check)
    - **Property 11: New joiner receives full feelings map**
    - **Validates: Requirements 4.3, 4.5**
    - **Property 10: Disconnect removes participant feeling**
    - **Validates: Requirements 4.4**

- [x] 10. Final checkpoint - Full integration verified
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — no language selection needed
- Server tests use Jest; client tests use Vitest + fast-check for property-based tests
- The `@shared/types` path alias is used for imports on the client side
- Existing `RetroScreenshotService` and `RetroWebSocketService` patterns are reused

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.2", "4.3"] },
    { "id": 3, "tasks": ["2.4", "5.1", "6.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "6.2", "6.3"] },
    { "id": 5, "tasks": ["8.1", "8.4", "9.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "9.2"] }
  ]
}
```
