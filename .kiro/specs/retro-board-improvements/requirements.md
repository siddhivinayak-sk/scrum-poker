# Requirements Document

## Introduction

This document specifies requirements for improvements to the existing Retrospective Board feature in the Scrum Poker application. The improvements address four areas: fixing broken CSV export/import functionality, adding a card merge feature via drag-and-drop, improving the card creation experience with auto-focus and visual differentiation, and enhancing card design for better space utilization. All changes build upon the existing Angular 21 + Node.js/Express retrospective board implementation.

## Glossary

- **Retrospective_Board**: The existing collaborative digital board with columns and cards used by a team to reflect on a sprint
- **Card**: A rectangular UI element within a column containing text input, vote count, comments, and optional emoji
- **Export_Service**: The Angular service (`RetroExportService`) responsible for calling the export REST endpoint and triggering CSV file downloads
- **Import_Service**: The import functionality within `RetroExportService` that reads CSV files and posts data to the import REST endpoint
- **Merge_Popup**: A custom confirmation dialog that appears when a user drops one card onto another card, asking whether to merge the two cards
- **Source_Card**: The card being dragged during a merge operation
- **Target_Card**: The card that receives the drop during a merge operation
- **Merged_Text**: The combined text content of two cards joined by a separator line ("--------")
- **Auto_Focus**: The behavior where a newly created card's textarea automatically receives keyboard focus
- **Owner_Highlight**: A temporary visual differentiation (background color) applied to a card that was just added by the current user

## Requirements

### Requirement 1: CSV Export Fix

**User Story:** As a moderator, I want the Export CSV button to successfully download a CSV file, so that I can share retrospective results with stakeholders.

#### Acceptance Criteria

1. WHEN the moderator clicks the "Export CSV" button, THE Export_Service SHALL send an authenticated GET request to `/api/retro/sessions/:sessionId/export`
2. WHEN the server returns a successful response with CSV text, THE Export_Service SHALL trigger a browser file download with the filename `retrospective-<sessionId>.csv` and MIME type `text/csv`
3. IF the server returns an error response, THEN THE Export_Service SHALL display an error toast notification describing the failure
4. THE server export endpoint SHALL return a response with `Content-Type: text/csv` and `Content-Disposition: attachment` headers
5. THE exported CSV SHALL contain headers "Column", "Card Text", "Votes", "Author", "Comments" and one row per card with accurate data from the board

---

### Requirement 2: CSV Import Fix

**User Story:** As a moderator, I want the Import CSV button to successfully upload cards from a CSV file, so that I can pre-populate the board with items from external sources.

#### Acceptance Criteria

1. WHEN the moderator selects a valid CSV file via the import file picker, THE Import_Service SHALL read the file content as text and send an authenticated POST request to `/api/retro/sessions/:sessionId/import` with the CSV data in the request body
2. WHEN the server returns a successful response, THE Import_Service SHALL refresh the board state to reflect the newly imported cards
3. IF the server returns an error response with code `INVALID_CSV`, THEN THE Import_Service SHALL display an error toast notification with the server-provided error message
4. IF the file reading fails, THEN THE Import_Service SHALL display an error toast notification indicating the file could not be read
5. THE server import endpoint SHALL validate that the CSV contains required "Column" and "Card Text" headers before processing rows
6. THE server import endpoint SHALL create cards in the matching columns with author name "Imported" and zero votes

---

### Requirement 3: Card Merge via Drag-and-Drop

**User Story:** As a participant, I want to drag one card and drop it onto another card to merge their text content, so that I can consolidate duplicate or related thoughts during the retrospective.

#### Acceptance Criteria

1. WHEN a user drops a Source_Card onto a Target_Card within the same column or a different column, THE Retrospective_Board SHALL display a Merge_Popup confirmation dialog
2. THE Merge_Popup SHALL display a message asking the user to confirm the merge operation and provide "Merge" and "Cancel" buttons
3. WHEN the user clicks "Merge" on the Merge_Popup, THE System SHALL update the Target_Card text to contain the Target_Card original text followed by a separator line "--------" followed by the Source_Card text
4. WHEN the user clicks "Merge" on the Merge_Popup, THE System SHALL remove the Source_Card from the board
5. WHEN the user clicks "Cancel" on the Merge_Popup, THE System SHALL dismiss the dialog and leave both cards unchanged in their original positions
6. THE merge operation SHALL broadcast the resulting card edit and card removal to all connected participants via WebSocket
7. WHILE the Retrospective_Board is marked as completed, THE System SHALL prevent all merge operations
8. THE Merge_Popup SHALL be accessible with a role of `alertdialog` and appropriate `aria-label` attributes

---

### Requirement 4: Card Auto-Focus on Creation

**User Story:** As a participant, I want the textarea of a newly added card to automatically receive focus, so that I can start typing immediately without needing to click the card.

#### Acceptance Criteria

1. WHEN a new card is added by the current user, THE Card textarea SHALL automatically receive keyboard focus within 100ms of rendering
2. WHEN a card is added by a different user (received via WebSocket broadcast), THE Card textarea SHALL NOT receive automatic focus
3. THE auto-focus behavior SHALL place the cursor at the beginning of the textarea, ready for text entry

---

### Requirement 5: New Card Visual Differentiation

**User Story:** As a participant, I want newly added cards to have a visually distinct background color when I add them, so that I can easily identify my new cards among cards added simultaneously by other participants.

#### Acceptance Criteria

1. WHEN a new card is added by the current user, THE Card SHALL render with a distinct background color different from the default card background (#e8ecf0)
2. THE Owner_Highlight background color SHALL remain applied for the lifetime of the card or until the page is refreshed
3. WHEN a card is added by a different user, THE Card SHALL render with the default background color
4. THE Owner_Highlight color SHALL maintain sufficient contrast ratio (minimum 4.5:1) with the card text color for WCAG AA compliance

---

### Requirement 6: Increased Card Text Area Size

**User Story:** As a participant, I want the card text area to be larger, so that I can write longer thoughts without the text feeling cramped.

#### Acceptance Criteria

1. THE Card textarea SHALL have a minimum height of 4.5em (increased from the current 2.8em minimum)
2. THE Card textarea SHALL have a font size of 0.85rem (increased from the current 0.8rem)
3. THE Card textarea SHALL display a minimum of 4 visible rows of text (increased from the current 3 rows)

---

### Requirement 7: Reduced Action Button Padding

**User Story:** As a participant, I want the card action buttons (vote, comment, emoji, delete) to use less space, so that more vertical space is available for text content.

#### Acceptance Criteria

1. THE Card action buttons (vote, comment, emoji, delete) SHALL use a maximum padding of 0.025rem (reduced from the current 0.05rem)
2. THE Card action buttons SHALL maintain a minimum tap target size of 24x24 pixels for usability
3. THE gap between action buttons SHALL be a maximum of 0.15rem (reduced from the current 0.2rem)

---

### Requirement 8: Increased Column Width

**User Story:** As a participant, I want the columns to be wider, so that cards have more horizontal space for text content.

#### Acceptance Criteria

1. THE RetroColumn component SHALL have a minimum width of 300px (increased from the current 240px)
2. THE RetroColumn component SHALL have a default width of 300px (increased from the current 240px)
3. WHILE the number of columns exceeds the viewport width at the increased column size, THE Board_View SHALL provide horizontal scrolling for the column area
4. THE increased column width SHALL apply equally to both vertical and horizontal layout modes

