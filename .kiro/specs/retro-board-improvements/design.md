# Design Document: Retro Board Improvements

## Overview

This design document covers eight improvements to the existing retrospective board feature. The changes span two layers:

1. **Bug fixes** (Requirements 1–2): The CSV Export and Import buttons are broken due to missing error handling in the client-side service and incorrect response expectations. The server endpoints already work correctly; the fixes are entirely client-side in `RetroExportService` and `RetroToolbarComponent`.

2. **Feature addition** (Requirement 3): A card merge operation via drag-and-drop, requiring a new merge confirmation popup, a new WebSocket event (`retro:card:merge`), and server-side merge logic in `RetroSession`.

3. **UX enhancements** (Requirements 4–8): Auto-focus on new cards, visual differentiation for own cards, increased textarea size, reduced button padding, and wider columns. These are CSS/template changes plus a small amount of state tracking for auto-focus and owner highlight.

### Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Merge is client-confirmed, server-executed | The popup is local UX; the server applies the merge atomically and broadcasts to all participants, keeping consistency across clients. |
| Owner highlight tracked via a local `Set<string>` signal | No server involvement needed; only the creating user sees the highlight. On page refresh the set clears naturally, matching the requirement. |
| Auto-focus triggered by comparing broadcast `authorId` to local user ID | Avoids adding a new WebSocket event; the existing `retro:card:added` payload already contains the `card.authorId`. |
| CSS-only changes for Requirements 6–8 | No logic changes needed; straightforward style property updates in the component's inline styles. |
| Use `fast-check` for property-based tests on CSV round-trip and merge logic | Already in use in the project. Validates correctness across many inputs for pure logic. |

---

## Architecture

```mermaid
flowchart TB
    subgraph Client ["Angular Client"]
        TB[RetroToolbarComponent]
        ES[RetroExportService]
        BP[RetroBoardPageComponent]
        COL[RetroColumnComponent]
        CARD[RetroCardComponent]
        MP[MergePopupComponent]
        RS[RetroStateService]
        WS[RetroWebSocketService]
    end

    subgraph Server ["Node.js Server"]
        RR[retro-routes.ts]
        RH[retro-handler.ts]
        RSESS[RetroSession]
    end

    TB -->|exportCSV / importCSV| ES
    ES -->|HTTP GET/POST| RR
    RR -->|export/import| RSESS

    COL -->|card drop on card| MP
    MP -->|confirm merge| WS
    WS -->|retro:card:merge| RH
    RH -->|mergeCards()| RSESS
    RSESS -->|broadcast| RH
    RH -->|retro:card:merged| WS
    WS -->|state update| RS
    RS --> COL
    RS --> CARD
```

---

## Components and Interfaces

### Modified Components

| Component | Changes |
|-----------|---------|
| `RetroExportService` | Add proper error toast notifications with server error messages; ensure `importCSV` triggers state refresh after success |
| `RetroToolbarComponent` | Surface specific error messages from the server in toast notifications for export/import failures |
| `RetroCardComponent` | Increase textarea `min-height` to 4.5em, font-size to 0.85rem, rows to 4; reduce action button padding to 0.025rem and gap to 0.15rem; add `[class.owner-highlight]` binding; implement `afterNextRender` auto-focus when card is owned by current user |
| `RetroColumnComponent` | Increase width from 240px to 300px; add drop-on-card detection (distinguish card-on-card from card-on-column); show `MergePopupComponent` when card-on-card drop detected |
| `RetroStateService` | Add `lastAddedCardId` signal to track the most recently added card by current user; handle new `retro:card:merged` event |
| `RetroWebSocketService` | Add `sendCardMerge(sourceCardId, targetCardId)` method |

### New Component

| Component | Purpose |
|-----------|---------|
| `MergePopupComponent` | Standalone confirmation dialog with `role="alertdialog"` and `aria-label="Confirm card merge"`. Inputs: source card text, target card text. Outputs: `confirmed` and `cancelled` EventEmitters. |

### Server Changes

| File | Changes |
|------|---------|
| `retro-session.ts` | Add `mergeCards(sourceCardId, targetCardId, userId)` method: combines text with separator, sums votes, concatenates comments, removes source card |
| `retro-handler.ts` | Add `handleCardMerge` function handling the `retro:card:merge` event; broadcasts `retro:card:merged` with the updated target card data and removed source card ID |

---

## Data Models

### WebSocket Messages (new)

```typescript
// Client → Server
interface CardMergeRequest {
  event: 'retro:card:merge';
  data: {
    sourceCardId: string;  // card being dragged
    targetCardId: string;  // card receiving the drop
  };
}

// Server → All Clients
interface CardMergedBroadcast {
  event: 'retro:card:merged';
  data: {
    targetCard: RetroCard;     // updated target card with merged text/votes/comments
    removedCardId: string;     // source card ID to remove from local state
    removedFromColumnId: string; // column the source card was in
  };
}
```

### Merge Text Format

```
<target card original text>
--------
<source card text>
```

### Owner Highlight State (client-only)

```typescript
// In RetroStateService
private readonly _ownNewCardIds = signal<Set<string>>(new Set());

// Updated when 'retro:card:added' fires and card.authorId === currentUserId
```

### Auto-Focus State (client-only)

```typescript
// In RetroStateService
readonly lastAddedOwnCardId = signal<string | null>(null);
// Set when receiving card:added for own card, cleared after focus is applied
```

---


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: CSV Export/Import Round-Trip

*For any* valid `RetroBoard` state containing arbitrary columns, cards (with arbitrary text including special characters, commas, quotes, newlines), vote counts, author names, and comments, exporting to CSV via `exportCSV()` and then importing that CSV via `importCSV()` into an empty board with matching column names SHALL produce cards whose "Column", "Card Text", "Votes", "Author", and "Comments" fields match the original board data.

**Validates: Requirements 1.5, 2.6**

### Property 2: Merge Operation Correctness

*For any* two cards (source and target) in any board state that is not completed, performing a merge SHALL produce a target card whose text equals the original target text followed by the separator `"--------"` followed by the source card text, AND the source card SHALL no longer exist in any column of the board.

**Validates: Requirements 3.3, 3.4**

### Property 3: Cancel Merge Is a No-Op

*For any* board state and any pair of cards selected for merge, if the user cancels the merge operation, the board state (all columns, all cards, all card texts, votes, and comments) SHALL remain identical to the state before the merge was initiated.

**Validates: Requirements 3.5**

### Property 4: Completed Board Prevents Merge

*For any* board state where `isCompleted` is true, and for any pair of card IDs, attempting a merge operation SHALL be rejected (throw an error), and the board state SHALL remain unchanged.

**Validates: Requirements 3.7**

---

## Error Handling

| Scenario | Handler | Behavior |
|----------|---------|----------|
| Export HTTP error (401, 403, 404, 500) | `RetroToolbarComponent.onExportCSV()` | Catch error, show toast with message from response body or generic "Failed to export CSV" |
| Import HTTP error with `INVALID_CSV` code | `RetroToolbarComponent.onFileSelected()` | Show toast with the server-provided `message` field |
| Import file read failure | `RetroExportService.readFileAsText()` | Reject with error; toolbar shows "Failed to read file" toast |
| Merge attempted on completed board | `RetroSession.mergeCards()` server-side | Throw `"Board is completed"` error; handler sends WebSocket error back to client |
| Merge with invalid card ID | `RetroSession.mergeCards()` server-side | Throw `"Card not found"` error; handler sends WebSocket error back to client |
| WebSocket disconnected during merge | Client-side | Merge popup is dismissed; reconnection logic handles state sync on reconnect |

---

## Testing Strategy

### Unit Tests (Vitest — Client)

| Area | Tests |
|------|-------|
| `RetroExportService` | Verify HTTP calls, headers, download trigger, error paths |
| `MergePopupComponent` | Render with inputs, verify ARIA attributes, confirm/cancel emissions |
| `RetroCardComponent` | Auto-focus behavior (own card vs. other user), owner-highlight class binding, updated CSS values |
| `RetroColumnComponent` | Card-on-card drop detection vs. card-on-column, merge popup shown/hidden, 300px width |
| `RetroStateService` | Handle `retro:card:merged` event, track `ownNewCardIds`, `lastAddedOwnCardId` |

### Unit Tests (Jest — Server)

| Area | Tests |
|------|-------|
| `RetroSession.mergeCards()` | Combines text, sums votes, merges comments, removes source, rejects on completed board, rejects invalid IDs |
| `RetroSession.exportCSV()` | Correct headers, field escaping, one row per card |
| `RetroSession.importCSV()` | Header validation, card creation with defaults, error on missing columns |
| `retro-handler.ts` | `handleCardMerge` dispatches correctly, broadcasts merged state |

### Property-Based Tests (fast-check)

Property-based tests use `fast-check` (already a project dependency) with a minimum of 100 iterations per property.

| Property | Test File | Tag |
|----------|-----------|-----|
| Property 1: CSV round-trip | `server/src/services/__tests__/retro-session.property.spec.ts` | `Feature: retro-board-improvements, Property 1: CSV export/import round-trip preserves board data` |
| Property 2: Merge correctness | `server/src/services/__tests__/retro-session.property.spec.ts` | `Feature: retro-board-improvements, Property 2: Merge produces combined text and removes source card` |
| Property 3: Cancel is no-op | `client/src/app/components/retro-board/__tests__/merge.property.spec.ts` | `Feature: retro-board-improvements, Property 3: Cancel merge leaves board state unchanged` |
| Property 4: Completed board blocks merge | `server/src/services/__tests__/retro-session.property.spec.ts` | `Feature: retro-board-improvements, Property 4: Completed board rejects all merge attempts` |

### Integration / Smoke Tests

| Area | Tests |
|------|-------|
| Export endpoint | HTTP test calling `/api/retro/sessions/:id/export`, verify Content-Type and Content-Disposition headers |
| Import endpoint | HTTP test posting valid/invalid CSV, verify 200/400 responses |
| Merge WebSocket flow | Connect two clients, perform merge from one, verify both receive `retro:card:merged` |

### Accessibility Verification

- `MergePopupComponent`: Verify `role="alertdialog"`, `aria-label`, focus trap, keyboard dismiss (Escape key)
- Action buttons: Verify `min-width: 24px` / `min-height: 24px` maintained after padding reduction
- Owner highlight color: Verify contrast ratio ≥ 4.5:1 against text color `#1a1a2e`
