# Implementation Plan: Retro Board Improvements

## Overview

This plan implements eight improvements to the retrospective board: fixing CSV export/import (Requirements 1–2), adding card merge via drag-and-drop (Requirement 3), implementing auto-focus and owner highlight (Requirements 4–5), and CSS/UX enhancements (Requirements 6–8). Tasks are ordered to build foundation first (bug fixes, CSS), then add new features (merge), and finally wire everything together.

## Tasks

- [x] 1. Fix CSV Export and Import
  - [x] 1.1 Fix RetroExportService export method
    - Update `exportCSV()` to properly handle the HTTP GET response as text
    - Add error handling that extracts the error message from the server response
    - Trigger browser file download with filename `retrospective-<sessionId>.csv` and MIME type `text/csv`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Fix RetroExportService import method
    - Update `importCSV()` to read file as text and POST to the import endpoint
    - Add error handling for `INVALID_CSV` error code displaying server-provided message
    - Add error handling for file read failures showing "Failed to read file" toast
    - Refresh board state after successful import
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 1.3 Update RetroToolbarComponent error handling
    - Surface specific error messages from the server in toast notifications for both export and import failures
    - Ensure the toolbar catches errors from the service and delegates to `ToastService`
    - _Requirements: 1.3, 2.3, 2.4_

  - [x] 1.4 Write unit tests for RetroExportService
    - Test successful export triggers download with correct filename and MIME type
    - Test export error handling shows toast with server error message
    - Test successful import refreshes board state
    - Test import error with `INVALID_CSV` code shows server message in toast
    - Test file read failure shows generic error toast
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4_

- [x] 2. Implement CSS/UX Enhancements (Requirements 6–8)
  - [x] 2.1 Increase card textarea size in RetroCardComponent
    - Update textarea `min-height` to `4.5em` (from 2.8em)
    - Update textarea `font-size` to `0.85rem` (from 0.8rem)
    - Update textarea `rows` attribute to `4` (from 3)
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 2.2 Reduce action button padding in RetroCardComponent
    - Update action button padding to `0.025rem` (from 0.05rem)
    - Update action button gap to `0.15rem` (from 0.2rem)
    - Ensure minimum tap target size of 24x24 pixels is maintained via `min-width`/`min-height`
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 2.3 Increase column width in RetroColumnComponent
    - Update column `min-width` and default `width` to `300px` (from 240px)
    - Ensure horizontal scrolling is preserved when columns exceed viewport width
    - Verify the width applies to both vertical and horizontal layout modes
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 3. Checkpoint - Verify bug fixes and CSS changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Card Auto-Focus and Owner Highlight
  - [x] 4.1 Add owner tracking state to RetroStateService
    - Add `_ownNewCardIds` signal (`Set<string>`) to track cards created by the current user
    - Add `lastAddedOwnCardId` signal to track most recently added own card for auto-focus
    - Update the `retro:card:added` event handler to compare `card.authorId` with current user ID and update signals accordingly
    - _Requirements: 4.1, 4.2, 5.1, 5.3_

  - [x] 4.2 Implement auto-focus in RetroCardComponent
    - Use `afterNextRender` to auto-focus the textarea when the card ID matches `lastAddedOwnCardId`
    - Place the cursor at the beginning of the textarea
    - Clear `lastAddedOwnCardId` after focus is applied
    - Ensure focus only triggers for own cards, not cards from other users
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 4.3 Implement owner highlight in RetroCardComponent
    - Add `[class.owner-highlight]` binding that checks if the card ID is in `_ownNewCardIds`
    - Add CSS styles for the `.owner-highlight` class with a distinct background color different from default `#e8ecf0`
    - Ensure the highlight color meets WCAG AA contrast ratio (≥ 4.5:1) against text color `#1a1a2e`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.4 Write unit tests for auto-focus and owner highlight
    - Test auto-focus triggers for own cards within 100ms of rendering
    - Test auto-focus does NOT trigger for cards added by other users
    - Test owner-highlight class is applied for own cards
    - Test owner-highlight class is NOT applied for other users' cards
    - _Requirements: 4.1, 4.2, 5.1, 5.3_

- [x] 5. Implement Card Merge Feature - Server Side
  - [x] 5.1 Add `mergeCards()` method to RetroSession
    - Implement `mergeCards(sourceCardId, targetCardId, userId)` in `server/src/services/retro-session.ts`
    - Combine target text + separator `"--------"` + source text
    - Sum votes from both cards
    - Concatenate comments from both cards
    - Remove source card from its column
    - Reject merge with error if board `isCompleted` is true
    - Reject merge with error if either card ID is not found
    - _Requirements: 3.3, 3.4, 3.6, 3.7_

  - [x] 5.2 Add `handleCardMerge` to retro-handler
    - Add handler for `retro:card:merge` WebSocket event in `server/src/websocket/retro-handler.ts`
    - Call `RetroSession.mergeCards()` with source/target card IDs and user ID
    - Broadcast `retro:card:merged` event to all connected clients with updated target card data and removed source card ID
    - Handle errors (completed board, invalid card ID) by sending WebSocket error back to the requesting client
    - _Requirements: 3.6, 3.7_

  - [x] 5.3 Write property test for CSV round-trip (Property 1)
    - **Property 1: CSV Export/Import Round-Trip**
    - Generate arbitrary RetroBoard states with columns, cards containing special characters, commas, quotes, newlines
    - Export to CSV, import into empty board with matching columns, verify all fields match
    - Test file: `server/src/services/__tests__/retro-session.property.spec.ts`
    - **Validates: Requirements 1.5, 2.6**

  - [x] 5.4 Write property test for merge correctness (Property 2)
    - **Property 2: Merge Operation Correctness**
    - Generate arbitrary pairs of cards on non-completed boards
    - Verify merged text = target text + separator + source text
    - Verify source card no longer exists in any column
    - Test file: `server/src/services/__tests__/retro-session.property.spec.ts`
    - **Validates: Requirements 3.3, 3.4**

  - [x] 5.5 Write property test for completed board blocks merge (Property 4)
    - **Property 4: Completed Board Prevents Merge**
    - Generate arbitrary completed board states and card ID pairs
    - Verify merge throws an error and board state is unchanged
    - Test file: `server/src/services/__tests__/retro-session.property.spec.ts`
    - **Validates: Requirements 3.7**

  - [x] 5.6 Write unit tests for RetroSession.mergeCards()
    - Test merge combines text with separator
    - Test merge sums votes from both cards
    - Test merge concatenates comments
    - Test merge removes source card from column
    - Test merge rejects on completed board
    - Test merge rejects with invalid card ID
    - _Requirements: 3.3, 3.4, 3.7_

- [x] 6. Checkpoint - Verify server-side merge logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement Card Merge Feature - Client Side
  - [x] 7.1 Add `sendCardMerge` method to RetroWebSocketService
    - Add method `sendCardMerge(sourceCardId: string, targetCardId: string)` that sends the `retro:card:merge` event
    - _Requirements: 3.6_

  - [x] 7.2 Handle `retro:card:merged` event in RetroStateService
    - Listen for `retro:card:merged` broadcast
    - Update the target card in local state with merged data
    - Remove the source card from local state using `removedCardId` and `removedFromColumnId`
    - _Requirements: 3.4, 3.6_

  - [x] 7.3 Create MergePopupComponent
    - Create `client/src/app/components/retro-board/merge-popup.component.ts` as a standalone component
    - Add inputs for source card text and target card text
    - Add `confirmed` and `cancelled` output EventEmitters
    - Add "Merge" and "Cancel" buttons
    - Add `role="alertdialog"` and `aria-label="Confirm card merge"` attributes
    - Implement focus trap and keyboard dismiss (Escape key)
    - _Requirements: 3.1, 3.2, 3.5, 3.8_

  - [x] 7.4 Add card-on-card drop detection to RetroColumnComponent
    - Modify existing drop handler to distinguish card-on-card drop from card-on-column drop
    - When a card-on-card drop is detected, show the `MergePopupComponent` instead of moving the card
    - On merge confirmed, call `RetroWebSocketService.sendCardMerge()`
    - On merge cancelled, dismiss the popup and leave cards unchanged
    - Prevent merge operations when the board is marked as completed
    - _Requirements: 3.1, 3.5, 3.7_

  - [x] 7.5 Write property test for cancel merge no-op (Property 3)
    - **Property 3: Cancel Merge Is a No-Op**
    - Generate arbitrary board states and card pairs
    - Simulate initiating and cancelling a merge
    - Verify board state is identical before and after
    - Test file: `client/src/app/components/retro-board/__tests__/merge.property.spec.ts`
    - **Validates: Requirements 3.5**

  - [x] 7.6 Write unit tests for MergePopupComponent
    - Test renders with source and target card text
    - Test ARIA attributes are present (`role="alertdialog"`, `aria-label`)
    - Test "Merge" button emits `confirmed` event
    - Test "Cancel" button emits `cancelled` event
    - Test Escape key dismisses the dialog
    - _Requirements: 3.2, 3.5, 3.8_

  - [x] 7.7 Write unit tests for RetroColumnComponent merge detection
    - Test card-on-card drop shows merge popup
    - Test card-on-column drop does NOT show merge popup (moves card normally)
    - Test merge is prevented on completed board
    - _Requirements: 3.1, 3.5, 3.7_

- [x] 8. Integration and Wiring
  - [x] 8.1 Wire all components together in RetroBoardPageComponent
    - Ensure `MergePopupComponent` is imported in `RetroColumnComponent`
    - Ensure `RetroStateService` provides `ownNewCardIds` and `lastAddedOwnCardId` to card components
    - Verify the full flow: drag card → drop on card → popup → confirm → server merge → broadcast → state update
    - _Requirements: 3.1, 3.3, 3.4, 3.6, 4.1, 5.1_

  - [x] 8.2 Write integration tests for merge WebSocket flow
    - Test end-to-end: client sends merge → server processes → broadcast received by all clients
    - Verify both clients see the merged card and source card removed
    - _Requirements: 3.6_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check` (existing project dependency)
- Unit tests validate specific examples and edge cases
- Server tests use Jest; client tests use Vitest
- All components are Angular standalone components with `inject()` + Signals pattern

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "2.2", "2.3"] },
    { "id": 1, "tasks": ["1.3", "1.4", "4.1", "5.1"] },
    { "id": 2, "tasks": ["4.2", "4.3", "5.2", "5.3", "5.4", "5.5", "5.6"] },
    { "id": 3, "tasks": ["4.4", "7.1", "7.2"] },
    { "id": 4, "tasks": ["7.3", "7.4"] },
    { "id": 5, "tasks": ["7.5", "7.6", "7.7"] },
    { "id": 6, "tasks": ["8.1"] },
    { "id": 7, "tasks": ["8.2"] }
  ]
}
```
