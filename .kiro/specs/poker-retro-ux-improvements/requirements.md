# Requirements Document

## Introduction

This document specifies user experience and functional improvements across three areas of the existing application: the Scrum Poker estimation session, the Retrospective Board, and behaviour shared by both pages.

The Scrum Poker improvements add an export of completed estimates with per-user votes and statistics, make long issue titles fully readable, and contain the selected-card elevation animation inside its container.

The Retrospective Board improvements fix card text rendering in captured screenshots, make long card text readable from its first line, introduce a fluid card height configuration option that is enabled by default, refine the board layout and visual design, surface retrospective sessions on the home page, add a moderator-only end-session control, and reduce the toolbar height.

The shared improvements replace the current flood of connection-loss notifications with a single compact connection status indicator that blocks interaction while the connection is unhealthy, and show the logged-in user on the home page consistently with the other pages.

Every change in this document is additive or corrective. No existing visual or functional behaviour is removed or altered beyond what an acceptance criterion states explicitly.

## Glossary

### Shared terms

- **System**: The complete application, comprising the Angular client, the Express server, and the shared type module.
- **Shared_Types**: The single source of truth type module at `shared/types.ts`, imported by both client and server.
- **Lobby_Page**: The home page displayed after login, implemented by `LobbyComponent` and routed at `/lobby`.
- **User_Control**: The avatar button with its dropdown that displays the authenticated user's display name and role and offers the logout action.
- **Connection_State**: The connection lifecycle value exposed by a WebSocket service, one of `connected`, `reconnecting`, or `disconnected`.
- **Connection_Status_Indicator**: A compact horizontal element in a session page top panel that renders the current Connection_State.
- **Interaction_Blocker**: The mechanism that prevents activation of session controls while Connection_State is not `connected`.
- **Connection_Loss_Episode**: The interval that starts when Connection_State leaves `connected` and ends when Connection_State returns to `connected` or the Give_Up_Threshold is reached.
- **Give_Up_Threshold**: Ten consecutive failed reconnection attempts, after which restoring the connection is treated as no longer feasible.
- **Liveness_Probe**: A server-initiated WebSocket ping used to detect a connection that has stopped responding.
- **Notification**: A transient message rendered by `ToastService` through `ToastComponent`.
- **Design_Token**: A CSS custom property already defined by the application theme, such as `--color-primary`, `--surface-board`, `--shadow-md`, or `--text-primary`.
- **Spacing_Scale**: The set of spacing values that are whole multiples of 4 pixels.

### Scrum Poker terms

- **Poker_Session_Page**: The estimation session page implemented by `SessionPokerPageComponent` and routed at `/session/:sessionId`.
- **Game_Session**: The server-side per-session state machine implemented by the `GameSession` class.
- **Completed_Estimate**: One `HistoryEntry` produced when a voting round is cleared, containing the story description, the per-participant votes, and the computed voting metrics.
- **Voting_Metrics**: The `VotingMetrics` record computed by the metrics engine, containing `average`, `mode`, `spread`, `distribution`, `outliers`, `numericVoteCount`, and `insufficientData`.
- **Estimate_Export_Endpoint**: The server endpoint that returns the export document for a poker session.
- **Estimate_Export_Service**: The Angular service that requests the export document and triggers the browser file download.
- **Export_Document**: The comma separated values document returned by the Estimate_Export_Endpoint.
- **Summary_Row**: One row of the Export_Document describing a single Completed_Estimate and its statistics.
- **Vote_Row**: One row of the Export_Document describing a single participant's card value within a single Completed_Estimate.
- **Issue_List_Panel**: The sidebar panel implemented by `IssueListPanelComponent` that lists `IssueItem` entries.
- **Issue_Title**: The `title` field of an `IssueItem` as rendered inside the Issue_List_Panel.
- **Card_Deck**: The estimation card row implemented by `CardDeckComponent`.
- **Selection_Elevation**: The upward vertical displacement applied to the selected estimation card.

### Retrospective terms

- **Retro_Board_Page**: The retrospective board page implemented by `RetroBoardPageComponent` and routed at `/retro/:sessionId`.
- **Retro_Session**: The server-side per-session state machine implemented by the `RetroSession` class.
- **Retro_Session_Registry**: The singleton registry of active retrospective sessions implemented by `RetroSessionRegistry`.
- **Retro_Toolbar**: The board action bar implemented by `RetroToolbarComponent`, including the embedded feelings strip.
- **Sprint_Context_Row**: The context row of the Retro_Board_Page that renders the sprint name, the sprint dates, and the remaining sprint context text, rendered below the Retro_Toolbar.
- **Column_Container**: The scrollable region of the Retro_Board_Page that holds every Retro_Column.
- **Retro_Column**: A board column implemented by `RetroColumnComponent`.
- **Retro_Card**: A board card implemented by `RetroCardComponent`, containing an editable text area, author line, action row, and comment section.
- **Card_Text_Area**: The editable text element inside a Retro_Card that holds the card text.
- **Fluid_Card_Height**: The configuration option that sizes the Card_Text_Area to the height required by its text content.
- **Fluid_Height_Minimum**: Three text lines.
- **Fluid_Height_Maximum**: Twelve text lines.
- **Fixed_Card_Height**: Four text lines, the Card_Text_Area height used before this feature.
- **Retro_Screenshot_Service**: The service that captures the board as a PNG image, implemented by `RetroScreenshotService`.
- **Retro_Sessions_Endpoint**: The server endpoint that returns the retrospective sessions owned by the authenticated user.
- **Retro_End_Session_Endpoint**: The server endpoint that ends a retrospective session.
- **Retro_Session_Summary**: The record describing one retrospective session in the response of the Retro_Sessions_Endpoint.
- **Retro_Session_List**: The Lobby_Page list that displays Retro_Session_Summary entries.
- **Retro_Moderator**: A user who is the owner of a Retro_Session or who holds the `moderator` role among its participants, as determined by the existing moderator rule.

---

## Requirements

### Requirement 1: Export Completed Poker Estimates

**User Story:** As a session owner, I want to export every story that has a completed estimate together with each participant's vote and the computed statistics, so that I can share estimation outcomes with people outside the session.

#### Acceptance Criteria

1. WHERE the current user is the owner of the Game_Session, THE Poker_Session_Page SHALL display an export control in the session header with the accessible name `Export estimates` and a target size of at least 32 pixels by 32 pixels.
2. WHERE the current user is not the owner of the Game_Session, THE Poker_Session_Page SHALL render the session header without any control whose accessible name is `Export estimates`.
3. WHILE the Game_Session holds zero Completed_Estimate records, THE Poker_Session_Page SHALL render the export control in the disabled state, so that pointer activation and keyboard activation of that control send no request to the Estimate_Export_Endpoint.
4. WHILE no export request sent by the Estimate_Export_Service is awaiting a response, WHEN the session owner activates the export control, THE Estimate_Export_Service SHALL send exactly one GET request to `/api/sessions/:sessionId/export` carrying the stored authentication token in the `Authorization` header.
5. WHEN the Estimate_Export_Endpoint receives a request whose authenticated user identifier equals the Game_Session owner identifier, THE Estimate_Export_Endpoint SHALL respond within 5 seconds with status 200, header `Content-Type: text/csv`, and header `Content-Disposition` containing `attachment`, for a Game_Session holding up to 200 Completed_Estimate records of up to 50 participants each.
6. IF the Estimate_Export_Endpoint receives a request without a valid authentication token, THEN THE Estimate_Export_Endpoint SHALL respond with status 401 and body field `error` set to `UNAUTHORIZED`.
7. IF the Estimate_Export_Endpoint receives a request whose authenticated user identifier differs from the Game_Session owner identifier, THEN THE Estimate_Export_Endpoint SHALL respond with status 403 and body field `error` set to `FORBIDDEN`.
8. IF the Estimate_Export_Endpoint receives a request for a session identifier that the session registry does not hold, THEN THE Estimate_Export_Endpoint SHALL respond with status 404 and body field `error` set to `SESSION_NOT_FOUND`.
9. THE Export_Document SHALL contain exactly one Summary_Row for each Completed_Estimate held by the Game_Session, ordered by the `completedAt` value ascending, preserving the order in which the Game_Session holds records that carry equal `completedAt` values.
10. THE Summary_Row SHALL contain, in this order, the story description, the count of participants recorded for the round, the count of numeric votes, the average, the mode, the spread, the vote distribution rendered as one entry per distinct card value received with each entry pairing the card value and its vote count ordered by the card value sequence defined in Shared_Types for the session voting system, the count of outliers, the voting duration formatted as `MM:SS` with two zero-padded digits for each part and with the minute part holding the total elapsed minutes when the duration reaches 60 minutes or the single character `-` when the Completed_Estimate holds no recorded voting duration, and the completion timestamp in ISO 8601 format.
11. THE Export_Document SHALL contain exactly one Vote_Row for each participant recorded in each Completed_Estimate, containing, in this order, the Completed_Estimate story description, the participant display name, and the participant card value.
12. WHERE a participant recorded in a Completed_Estimate holds a null card value, THE Vote_Row SHALL render the card value as `No Vote`.
13. THE Summary_Row average field SHALL equal the Voting_Metrics `average` value of the same Completed_Estimate rounded half up to exactly one decimal place, using a full stop as the decimal separator.
14. THE Summary_Row mode, spread, distribution, and outlier count fields SHALL equal the corresponding Voting_Metrics values of the same Completed_Estimate.
15. WHERE the Voting_Metrics of a Completed_Estimate hold `insufficientData` set to true, THE Summary_Row SHALL render the average, mode, and spread fields as the single character `-`.
16. THE Estimate_Export_Endpoint SHALL quote any field value that contains a comma, a double quote character, or a line break, and SHALL escape an embedded double quote character by doubling it, so that a parser conforming to RFC 4180 recovers each original field value unchanged.
17. WHEN the Estimate_Export_Service receives a response with status 200, THE Estimate_Export_Service SHALL trigger exactly one browser file download named `scrum-poker-<sessionId>.csv` with MIME type `text/csv`, whose content equals the received response body unchanged.
18. IF the Estimate_Export_Service receives a response with a status other than 200, or receives no response within 30 seconds of sending the request, THEN THE Estimate_Export_Service SHALL display exactly one Notification of type `error` describing the export failure, SHALL trigger no file download, and SHALL leave the Poker_Session_Page content unchanged.
19. THE Estimate_Export_Endpoint SHALL leave the Game_Session state unchanged, so that two consecutive export requests return identical Export_Document content.
20. THE Export_Document SHALL place the Vote_Row records of a Completed_Estimate immediately after the Summary_Row of that same Completed_Estimate, ordered by participant display name ascending.
21. THE Export_Document SHALL precede the first Summary_Row with one header row naming the Summary_Row fields in the order stated in acceptance criterion 10, and SHALL precede the Vote_Row records of each Completed_Estimate with one header row naming the Vote_Row fields in the order stated in acceptance criterion 11.
22. WHILE the Game_Session holds one or more Completed_Estimate records and no export request sent by the Estimate_Export_Service is awaiting a response, THE Poker_Session_Page SHALL render the export control in the enabled state.

---

### Requirement 2: Readable Long Issue Titles

**User Story:** As a participant, I want to read the full title of every issue in the issue list, so that I know which story is being estimated.

#### Acceptance Criteria

1. THE Issue_List_Panel SHALL render each Issue_Title across at most two text lines at every viewport width from 360 pixels through 1920 pixels.
2. THE Issue_List_Panel SHALL expose the complete Issue_Title, with every character of the stored value and with no truncation indicator added, as the `title` attribute and as the accessible name of the Issue_Title element, for Issue_Title lengths from 1 through 500 characters.
3. THE Issue_List_Panel SHALL keep its own `scrollWidth` equal to or less than its `clientWidth` for Issue_Title lengths from 1 through 500 characters, for counts of Issue_Item entries from 0 through 200, and for viewport widths from 360 pixels through 1920 pixels.
4. THE Issue_List_Panel SHALL render the status marker, the Issue_Title, and any action button of a single list entry without overlapping bounding boxes, for viewport widths from 360 pixels through 1920 pixels.
5. IF an Issue_Title contains no whitespace character and requires more width than the Issue_Title element provides, THEN THE Issue_List_Panel SHALL break the Issue_Title within the word so that no part of the Issue_Title extends beyond the `clientWidth` of the Issue_List_Panel.
6. THE Issue_List_Panel SHALL render the Issue_Title at a computed font size of at least 12 pixels for viewport widths from 360 pixels through 1920 pixels.
7. THE Issue_List_Panel SHALL keep the existing drag handling, status markers, estimate action, resume action, add action, and bulk import action available with their existing accessible names.
8. IF an Issue_Title requires more than two text lines at the current width of the Issue_Title element, THEN THE Issue_List_Panel SHALL render a trailing ellipsis as the last visible characters of the second text line.
9. IF an Issue_Title fits within two text lines at the current width of the Issue_Title element, THEN THE Issue_List_Panel SHALL render the Issue_Title with no ellipsis appended.
10. IF the stored Issue_Title is an empty string or contains only whitespace characters, THEN THE Issue_List_Panel SHALL render a non-empty placeholder text in the Issue_Title element, SHALL use that placeholder text as the accessible name of the Issue_Title element, and SHALL keep the Issue_Item entry selectable by its existing actions.
11. THE Issue_List_Panel SHALL allocate the remaining inline width of a list entry to the Issue_Title after the status marker and the action button have been laid out, so that the Issue_Title element `clientWidth` is greater than 0 pixels for viewport widths from 360 pixels through 1920 pixels.
12. THE Issue_List_Panel SHALL render each list entry with its left edge at or inside the left edge of the Issue_List_Panel content area.
13. THE Issue_List_Panel SHALL render the action button of a list entry at a fixed inline size that does not change with the Issue_Title length, so that the action buttons of all list entries share one common left edge.

---

### Requirement 3: Contained Card Selection Elevation

**User Story:** As a participant, I want the selected estimation card to lift visibly without crossing the top edge of the card area, so that the selection stays readable and the layout stays intact.

#### Acceptance Criteria

1. WHEN a participant selects an estimation card, THE Card_Deck SHALL apply a Selection_Elevation of at least 8 pixels and at most 12 pixels to the selected card, and SHALL reach that displacement within 300 milliseconds of the selection.
2. WHILE an estimation card is selected, THE Card_Deck SHALL keep the top edge of the transformed border box of the selected card at or below the top edge of the Card_Deck container border box, measured in viewport coordinates with a tolerance of 0 pixels.
3. WHILE a non-selected estimation card is hovered or holds keyboard focus, THE Card_Deck SHALL keep the top edge of the transformed border box of that card, and of its focus indicator, at or below the top edge of the Card_Deck container border box.
4. THE Card_Deck SHALL apply a selected card scale factor of at least 1.00 and at most 1.10, and SHALL reserve vertical space above the card row that is at least equal to the Selection_Elevation plus half of the product of the card height and the quantity of the scale factor minus 1.
5. THE Card_Deck SHALL satisfy the containment requirement of acceptance criterion 2 and the reserved space requirement of acceptance criterion 4 for the first card, any middle card, and the last card of the row, for any voting system card set defined in Shared_Types holding 2 through 20 cards, and for viewport widths from 360 pixels through 1920 pixels.
6. WHILE the Card_Deck renders as a horizontally scrollable strip, THE Card_Deck SHALL render the elevated selected card without vertical clipping and SHALL keep its own `scrollHeight` equal to or less than its `clientHeight`.
7. WHEN a participant selects an estimation card while a different estimation card is selected, THE Card_Deck SHALL return the previously selected card to a Selection_Elevation of 0 pixels and a scale factor of 1.00, so that exactly one card carries a non-zero Selection_Elevation at any time.
8. WHEN the current voting round leaves the `voting` status or the board is cleared, THE Card_Deck SHALL return every card to a Selection_Elevation of 0 pixels and a scale factor of 1.00.
9. WHILE the user agent reports a reduced motion preference, THE Card_Deck SHALL apply the Selection_Elevation with a transition duration of 0 milliseconds and SHALL produce the same selected card position and scale factor as it produces without that preference.
10. THE Card_Deck SHALL keep the existing selected card border width, background gradient, shadow, focus indicator, disabled state, `aria-pressed` state, and selection announcement text.

---

### Requirement 4: Card Text Inside Card Boundaries in Captured Screenshots

**User Story:** As a moderator, I want captured board screenshots to show each card's text inside that card, so that I can share a readable record of the retrospective.

#### Acceptance Criteria

1. WHEN a user activates the screenshot action of the Retro_Toolbar, THE Retro_Screenshot_Service SHALL produce a PNG image within 10 seconds in which, for every Retro_Card, each rendered text glyph lies inside the bounding box of that same Retro_Card, with no glyph extending beyond any edge of that bounding box by more than 1 pixel.
2. THE Retro_Screenshot_Service SHALL include the complete text of every Retro_Card held by the board at the moment the capture starts, including text that the Card_Text_Area clips or scrolls in the live board and including Retro_Card entries that lie outside the visible scroll area of the Column_Container, for up to 10 Retro_Column entries holding up to 100 Retro_Card entries each.
3. WHEN a board capture ends, whether it produced a PNG image or not, THE Retro_Screenshot_Service SHALL restore the board element count, the element attribute values, the computed styles, and the vertical scroll offsets of the Column_Container and of every Card_Text_Area to the values they held immediately before the capture started.
4. IF a board capture does not produce a PNG image, THEN THE Retro_Screenshot_Service SHALL display exactly one Notification of type `error` stating that the capture failed, SHALL write nothing to the clipboard, and SHALL trigger no file download.
5. WHEN a board capture produces a PNG image and the clipboard write of that image succeeds, THE Retro_Screenshot_Service SHALL display exactly one Notification stating that the screenshot was copied, and SHALL trigger no file download.
6. IF a board capture produces a PNG image and the clipboard write is unavailable or fails, THEN THE Retro_Screenshot_Service SHALL trigger exactly one PNG file download containing that image.
7. THE Retro_Screenshot_Service SHALL satisfy acceptance criteria 1 and 2 for both the `vertical` and the `horizontal` value of the column layout configuration, for both values of Fluid_Card_Height, for a board that holds zero Retro_Card entries, and for viewport widths from 360 pixels through 1920 pixels.
8. IF a board capture has not produced a PNG image within 10 seconds of the user activating the screenshot action, THEN THE Retro_Screenshot_Service SHALL end that capture and SHALL treat it as a capture that does not produce a PNG image.
9. WHEN the Retro_Screenshot_Service triggers a PNG file download, THE Retro_Screenshot_Service SHALL display exactly one Notification stating that the screenshot was downloaded.
10. WHILE a board capture is in progress, THE Retro_Screenshot_Service SHALL render the screenshot action in the disabled state and SHALL start no additional capture.
11. THE Retro_Screenshot_Service SHALL render the text of each Retro_Card in the produced image wrapped onto as many lines as the Retro_Card width requires, so that no rendered line of card text is wider than the content width of its Retro_Card.
12. THE Retro_Screenshot_Service SHALL render the text of each Retro_Card in the produced image at the same font family, font size, line height, and text colour that the live board renders for that Retro_Card.
13. THE Retro_Screenshot_Service SHALL render each Retro_Card in the produced image at a height that contains its wrapped text, so that no Retro_Card in the produced image renders text that its own bounding box clips.

---

### Requirement 5: Long Card Text Readable From Its First Line

**User Story:** As a participant, I want a card with long text to show that text from the beginning, so that I can read the thought without scrolling back up.

#### Acceptance Criteria

1. WHILE a Card_Text_Area does not hold keyboard focus, THE Retro_Card SHALL keep the vertical scroll offset of that Card_Text_Area at 0 pixels, both where the text requires at most the number of lines the Card_Text_Area displays and where the text requires more lines than the Card_Text_Area displays.
2. WHEN the text of a Retro_Card changes through a WebSocket update and the Card_Text_Area of that Retro_Card does not hold keyboard focus, THE Retro_Card SHALL render the first line of the updated text as the topmost visible line within 100 milliseconds of applying the update.
3. WHERE the text of a Retro_Card requires more lines than the Card_Text_Area displays, THE Retro_Card SHALL render the Card_Text_Area with a vertical scroll range whose lowest offset is 0 pixels and whose highest offset shows the last line of the text, and SHALL set the vertical scroll offset to 0 pixels when the Card_Text_Area is first rendered.
4. WHEN keyboard focus moves away from a Card_Text_Area, THE Retro_Card SHALL set the vertical scroll offset of that Card_Text_Area to 0 pixels within 100 milliseconds of the focus loss and SHALL leave the text of that Retro_Card unchanged by the scroll reset.
5. THE Retro_Card SHALL satisfy acceptance criteria 1 through 4 for text lengths from 0 through 2,000 characters, for text containing consecutive line breaks, for text containing a single word wider than the Card_Text_Area, and for both values of Fluid_Card_Height.
6. WHEN keyboard focus moves away from a Card_Text_Area whose text differs from the text last received for that Retro_Card, THE Retro_Card SHALL send a card edit event carrying the current Card_Text_Area text.
7. WHEN a user presses the Enter key without the Shift modifier inside a Card_Text_Area, THE Retro_Card SHALL commit the edit and release keyboard focus from that Card_Text_Area.
8. WHILE a Card_Text_Area holds keyboard focus, THE Retro_Card SHALL change the vertical scroll offset of that Card_Text_Area only in response to user caret movement, user text entry, or user scrolling input.
9. IF a WebSocket text update for a Retro_Card arrives while the Card_Text_Area of that Retro_Card holds keyboard focus, THEN THE Retro_Card SHALL leave the vertical scroll offset, the caret position, and the uncommitted text of that Card_Text_Area unchanged.
10. WHEN a Retro_Card is first rendered, THE Retro_Card SHALL place the scroll thumb of the Card_Text_Area at the start of its scroll track.
11. THE Retro_Card SHALL render the vertical scrollbar of the Card_Text_Area within the Card_Text_Area bounding box, without overlapping the author line, the action row, or the comment section of that Retro_Card.

---

### Requirement 6: Fluid Card Height Configuration

**User Story:** As a moderator, I want retrospective cards to size themselves to their text by default, so that the board shows complete thoughts without wasted space.

#### Acceptance Criteria

1. THE Shared_Types module SHALL define an optional boolean field named `fluidCardHeight` on the retrospective configuration record, so that a configuration record that omits the field remains a valid record.
2. WHEN a Retro_Session is created, THE Retro_Session SHALL set `fluidCardHeight` to the value carried by the creation request where that carried value is of boolean type, and to true where the creation request omits the field or carries a value that is not of boolean type.
3. WHERE a configuration record received by the client omits `fluidCardHeight` or carries a `fluidCardHeight` value that is not of boolean type, THE Retro_Card SHALL treat `fluidCardHeight` as true.
4. WHERE `fluidCardHeight` is true, THE Retro_Card SHALL set the Card_Text_Area height to the height occupied by the rendered text lines of its text at the current Card_Text_Area width, clamped to no less than the Fluid_Height_Minimum and no more than the Fluid_Height_Maximum, and SHALL use the Fluid_Height_Minimum where the text is empty or occupies fewer lines than the Fluid_Height_Minimum.
5. WHERE `fluidCardHeight` is true and the text of a Retro_Card requires more lines than the Fluid_Height_Maximum, THE Retro_Card SHALL render the Fluid_Height_Maximum number of lines, SHALL provide vertical scrolling of the Card_Text_Area starting from its first line, and SHALL keep every line beyond the Fluid_Height_Maximum reachable through that scrolling.
6. WHERE `fluidCardHeight` is false, THE Retro_Card SHALL set the Card_Text_Area height to the Fixed_Card_Height for every text length, and SHALL provide vertical scrolling of the Card_Text_Area starting from its first line where its text requires more lines than the Fixed_Card_Height.
7. WHEN the text of a Retro_Card changes or the width of its Card_Text_Area changes, THE Retro_Card SHALL recompute the Card_Text_Area height for the new text and the new width within 200 milliseconds of that change.
8. THE Retro_Card SHALL produce a Card_Text_Area height for a given text and a given width that is equal on every recomputation for that same text and width.
9. GIVEN two texts where the first text is a prefix of the second text, THE Retro_Card SHALL produce a Card_Text_Area height for the first text that is less than or equal to the Card_Text_Area height for the second text at the same width.
10. WHERE the current user is a Retro_Moderator, THE Retro_Toolbar SHALL present in the board settings dialog a `fluidCardHeight` control that reflects the `fluidCardHeight` value currently stored for that Retro_Session at the moment the dialog opens.
11. WHEN a Retro_Moderator changes the `fluidCardHeight` control to a boolean value that differs from the stored value, THE Retro_Session SHALL store the new value and SHALL broadcast the updated configuration record to every connected participant of that session, including the requesting Retro_Moderator, within 1 second of receiving the change.
12. WHILE `fluidCardHeight` is true, THE Retro_Column SHALL compute a drop index from the bounding boxes of the rendered cards, so that a card dropped above the vertical midpoint of a rendered card receives the index of that card, a card dropped at or below the vertical midpoint of a rendered card receives the index following that card, and a card dropped into a Retro_Column holding zero cards receives index 0.
13. WHILE `fluidCardHeight` is true, THE Retro_Column SHALL keep the existing card drag start, drag over, drop indicator, card move, card merge, and column reorder behaviour available.
14. THE Retro_Card SHALL satisfy acceptance criteria 4, 5, and 6 for both the `vertical` and the `horizontal` value of the column layout configuration.
15. WHERE the current user is not a Retro_Moderator, THE Retro_Toolbar SHALL render the board settings dialog without a `fluidCardHeight` control.
16. WHEN the client receives a configuration record whose `fluidCardHeight` value differs from the value currently applied, THE Retro_Board_Page SHALL apply the height rule stated for the received value to every rendered Retro_Card within 500 milliseconds and without a page reload.
17. IF a configuration update that changes `fluidCardHeight` is received from a participant who is not a Retro_Moderator of that Retro_Session, or carries a `fluidCardHeight` value that is not of boolean type, THEN THE Retro_Session SHALL leave the stored `fluidCardHeight` unchanged, SHALL send no configuration broadcast for that update, and SHALL return to the requesting participant an error indication identifying the rejected update.

---

### Requirement 7: Refined Retrospective Board Layout and Visual Design

**User Story:** As a participant, I want the retrospective board to look finished and consistent with the rest of the application, so that I can present it to my team and to stakeholders.

#### Acceptance Criteria

1. THE Retro_Board_Page SHALL render every computed margin, padding, row gap, and column gap of the header, the Retro_Toolbar, the context region, the Column_Container, the Retro_Column, and the Retro_Card as either 0 pixels or a value of the Spacing_Scale, for viewport widths from 360 pixels through 1920 pixels.
2. THE Retro_Board_Page SHALL express the background colour, the border colour, the text colour, and the shadow of the header, the Retro_Toolbar, the context region, the Retro_Column, and the Retro_Card as references to a Design_Token, and SHALL declare no literal colour value for those properties.
3. THE Retro_Board_Page SHALL render every visible text element that holds non-empty text content at a computed font size of at least 12 pixels, for viewport widths from 360 pixels through 1920 pixels.
4. THE Retro_Board_Page SHALL render every visible text element that holds non-empty text content at a contrast ratio of at least 4.5 to 1 between its computed text colour and the background colour of the nearest ancestor element whose background colour is not fully transparent.
5. THE Retro_Board_Page SHALL render every interactive control that is visible at a bounding box of at least 32 pixels in width and at least 32 pixels in height, including the control padding, for viewport widths from 360 pixels through 1920 pixels.
6. THE Retro_Column SHALL render its name, card count, add action, and delete action on a single row with non-overlapping bounding boxes and with that row holding a `scrollWidth` equal to or less than its `clientWidth`, for viewport widths from 360 pixels through 1920 pixels.
7. WHERE a Retro_Column name requires more width than the name element provides, THE Retro_Column SHALL render the name on a single line ending with an ellipsis and SHALL expose the complete name both as the `title` attribute and as the accessible name of the name element.
8. WHILE the viewport width is 768 pixels or above, THE Retro_Board_Page SHALL keep the sum of the rendered heights of the header row, the Retro_Toolbar row, and the context row at or below 160 pixels, for viewport widths from 768 pixels through 1920 pixels.
9. THE Retro_Board_Page SHALL keep every control that exists before the layout change, together with its icon, its `title` attribute, its `aria-label` attribute, and its disabled condition, and SHALL keep each enabled control activatable by pointer and by keyboard.
10. THE Retro_Board_Page SHALL keep the existing column orientation, column order, card order, card drag and drop behaviour, column reorder behaviour, and scroll direction for both the `vertical` and the `horizontal` value of the column layout configuration.
11. WHILE the user agent reports a reduced motion preference, THE Retro_Board_Page SHALL render every element with a computed transition duration of 0 seconds and a computed animation duration of 0 seconds, and SHALL apply each visual state change in its final state immediately.
12. THE Retro_Board_Page SHALL keep its own `scrollWidth` equal to or less than its `clientWidth` for viewport widths from 360 pixels through 1920 pixels, for any count of Retro_Column entries and any count of Retro_Card entries, and SHALL confine horizontal overflow to horizontal scrolling of the Column_Container.
13. WHILE the viewport width is below 768 pixels, THE Retro_Board_Page SHALL wrap the header row, the Retro_Toolbar row, and the context row onto additional rows with non-overlapping bounding boxes and SHALL keep the sum of the rendered heights of those rows at or below 240 pixels, for viewport widths from 360 pixels through 767 pixels.
14. WHEN an interactive control of the Retro_Board_Page receives keyboard focus, THE Retro_Board_Page SHALL render a focus indicator on that control at a contrast ratio of at least 3 to 1 against the background colour adjacent to the indicator.
15. THE Column_Container SHALL occupy the full inline width of the Retro_Board_Page content area, so that the Retro_Board_Page renders no unused horizontal region to the right of the last Retro_Column at viewport widths from 768 pixels through 1920 pixels.
16. WHEN the Column_Container is in the vertical layout THE Retro_Column SHALL render at the block size of the Column_Container, SHALL scroll its Retro_Card list within the column when those entries exceed the available block size, and SHALL keep its header row rendered at every scroll position; and WHEN the Column_Container is in the horizontal layout THE Retro_Column SHALL render at a block size that contains its Retro_Card entries and grows with the count of those entries, with the Column_Container providing the scroll.
17. THE Sprint_Context_Row SHALL render its complete text content without vertical clipping, so that the block size of the Sprint_Context_Row is at least the line height of its text content plus its block padding.
18. THE Retro_Card SHALL render its text with the author line, the vote count, the comment count, the feeling marker, and the delete action inside the Retro_Card bounding box, with non-overlapping bounding boxes, for Retro_Card text lengths from 0 through 2,000 characters.

---

### Requirement 8: Retrospective Sessions on the Home Page

**User Story:** As a logged-in user, I want my retrospective boards listed on the home page, so that I can return to a board the same way I return to a poker session.

#### Acceptance Criteria

1. THE Retro_Sessions_Endpoint SHALL accept GET requests at `/api/retro/sessions/mine` carrying the authentication token in the `Authorization` header.
2. WHEN the Retro_Sessions_Endpoint receives a request with a valid authentication token, THE Retro_Sessions_Endpoint SHALL respond with status 200 and a body field `sessions` holding exactly one Retro_Session_Summary for each Retro_Session held by the Retro_Session_Registry whose owner identifier equals the authenticated user identifier, without limiting the count of entries.
3. WHEN the Retro_Sessions_Endpoint receives a request with a valid authentication token and the Retro_Session_Registry holds no Retro_Session whose owner identifier equals the authenticated user identifier, THE Retro_Sessions_Endpoint SHALL respond with status 200 and body field `sessions` set to an array of zero entries.
4. THE Retro_Sessions_Endpoint SHALL order the `sessions` array by the `lastActivityAt` value descending, and SHALL order entries holding equal `lastActivityAt` values by the creation timestamp descending.
5. IF the Retro_Sessions_Endpoint receives a request without an authentication token, or with a token that fails verification, or with an expired token, THEN THE Retro_Sessions_Endpoint SHALL respond with status 401 and body field `error` set to `UNAUTHORIZED`.
6. THE Retro_Session_Summary SHALL contain the session identifier, the board name, the creation timestamp in ISO 8601 format, the last activity timestamp in ISO 8601 format, the participant count as a non-negative integer, the card count as a non-negative integer, and the board completion state as a boolean that is true when the Retro_Session is completed.
7. THE Retro_Sessions_Endpoint SHALL respond with a `sessions` array that holds only Retro_Session entries, and SHALL exclude every Game_Session.
8. THE Retro_Sessions_Endpoint SHALL leave the Retro_Session_Registry and every Retro_Session state unchanged, so that two consecutive requests with the same valid authentication token return the same `sessions` entries.
9. WHEN the Lobby_Page loads for an authenticated user, THE Lobby_Page SHALL send one request to the Retro_Sessions_Endpoint carrying the stored authentication token in the `Authorization` header.
10. WHEN the Lobby_Page receives a response with status 200 holding one or more Retro_Session_Summary entries, THE Lobby_Page SHALL render one Retro_Session_List entry for each returned Retro_Session_Summary, in the order the response returned them.
11. WHILE the request to the Retro_Sessions_Endpoint is pending, THE Lobby_Page SHALL render a loading indicator in place of the Retro_Session_List and SHALL render the existing poker session list.
12. THE Retro_Session_List SHALL carry a visible heading and an accessible name whose text differs from the visible heading and the accessible name of the existing poker session list, and SHALL associate that heading with the Retro_Session_List programmatically.
13. THE Retro_Session_List SHALL display the board name, the session identifier, the creation timestamp, and the last activity timestamp for each entry.
14. WHERE a board name requires more width than the board name element of a Retro_Session_List entry provides, THE Retro_Session_List SHALL append an ellipsis and expose the complete board name as the `title` attribute and as the accessible name of that element.
15. THE Retro_Session_List SHALL render each entry as a control that receives keyboard focus in document order and that activates by pointer activation and by keyboard activation.
16. WHEN a user activates a Retro_Session_List entry, THE Lobby_Page SHALL navigate to the route `/retro/:sessionId` using the session identifier of that entry.
17. WHILE the Retro_Sessions_Endpoint returns zero sessions, THE Lobby_Page SHALL render the page without the Retro_Session_List.
18. IF the Retro_Sessions_Endpoint responds with status 401, THEN THE Lobby_Page SHALL render the page without the Retro_Session_List and without a load failure message.
19. IF the Retro_Sessions_Endpoint responds with a status other than 200 and other than 401, THEN THE Lobby_Page SHALL display a load failure message in place of the Retro_Session_List.
20. IF the Lobby_Page receives no response from the Retro_Sessions_Endpoint within 10 seconds of sending the request, or the request fails without a response, THEN THE Lobby_Page SHALL stop the loading indicator and display a load failure message in place of the Retro_Session_List.
21. IF the Lobby_Page displays a load failure message in place of the Retro_Session_List, THEN THE Lobby_Page SHALL continue to render the existing poker session list and the existing lobby actions in their enabled state.
22. THE Lobby_Page SHALL keep the existing start new game action, create retrospective board action, join existing session action, and poker session list with their existing accessible names and behaviour.

---

### Requirement 9: End Retrospective Session From the Board

**User Story:** As a retrospective moderator, I want to end the session from the board header, so that the board stops accepting changes and participants know the retrospective is over.

#### Acceptance Criteria

1. WHERE the current user is a Retro_Moderator, THE Retro_Board_Page SHALL display an end-session control in the board header with the accessible name `End session`.
2. WHERE the current user is not a Retro_Moderator, THE Retro_Board_Page SHALL render the board header without an end-session control.
3. WHEN a Retro_Moderator activates the end-session control, THE Retro_Board_Page SHALL display a confirmation dialog with the role `alertdialog`, exactly one confirm action, exactly one cancel action, and initial keyboard focus on the cancel action, while leaving the Retro_Session state unchanged.
4. WHEN a Retro_Moderator activates the cancel action of the confirmation dialog, THE Retro_Board_Page SHALL dismiss the dialog, return keyboard focus to the end-session control, and leave the Retro_Session unchanged.
5. WHEN a Retro_Moderator activates the confirm action of the confirmation dialog, THE Retro_Board_Page SHALL send exactly one DELETE request to `/api/retro/sessions/:sessionId` carrying the stored authentication token in the `Authorization` header.
6. WHILE a DELETE request to `/api/retro/sessions/:sessionId` is awaiting a response, THE Retro_Board_Page SHALL present the confirm action and the end-session control in a disabled state so that repeated activation sends no additional DELETE request.
7. WHEN the Retro_End_Session_Endpoint receives a request whose authenticated user identifier equals the Retro_Session owner identifier, THE Retro_End_Session_Endpoint SHALL remove the Retro_Session from the Retro_Session_Registry and respond with status 200.
8. WHEN the Retro_End_Session_Endpoint removes a Retro_Session, THE System SHALL send the event `retro:session:ended` to every connected participant of that session, including the Retro_Moderator, and close those connections within 2 seconds of the removal.
9. IF the Retro_End_Session_Endpoint receives a request without a valid authentication token, THEN THE Retro_End_Session_Endpoint SHALL respond with status 401 and leave the Retro_Session in the Retro_Session_Registry, regardless of whether the Retro_Session_Registry holds the requested session identifier.
10. IF the Retro_End_Session_Endpoint receives a request with a valid authentication token for a session identifier that the Retro_Session_Registry holds, and the authenticated user identifier differs from the Retro_Session owner identifier, THEN THE Retro_End_Session_Endpoint SHALL respond with status 403 and leave the Retro_Session, its cards, and its votes unchanged in the Retro_Session_Registry.
11. IF the Retro_End_Session_Endpoint receives a request with a valid authentication token for a session identifier that the Retro_Session_Registry does not hold, THEN THE Retro_End_Session_Endpoint SHALL respond with status 404 and leave every other Retro_Session in the Retro_Session_Registry unchanged.
12. WHEN a participant receives the event `retro:session:ended`, THE Retro_Board_Page SHALL navigate to `/lobby` without requiring further user input and display exactly one Notification stating that the moderator ended the session, keeping that Notification visible for at least 5 seconds or until the user dismisses it.
13. IF the Retro_Board_Page receives an error response or receives no response within 10 seconds after sending a DELETE request to `/api/retro/sessions/:sessionId`, THEN THE Retro_Board_Page SHALL dismiss the confirmation dialog, re-enable the end-session control, remain on the board with the displayed cards and votes unchanged, and display exactly one Notification indicating that ending the session failed.
14. IF a Retro WebSocket message arrives for a session identifier that the Retro_Session_Registry no longer holds, THEN THE System SHALL apply no change to any Retro_Session and close that connection.
15. THE Retro_End_Session_Endpoint SHALL leave every Game_Session in the poker session registry unchanged.
16. THE Retro_Board_Page SHALL keep the existing back to lobby action, copy link action, votes remaining display, session identifier display, and user control with their existing accessible names.

---

### Requirement 10: Compact Retrospective Toolbar

**User Story:** As a participant, I want the board action bar to use little vertical space, so that more of the screen shows cards.

#### Acceptance Criteria

1. WHILE the viewport width is from 768 pixels through 1920 pixels, THE Retro_Toolbar SHALL render its outer bounding box, including padding and borders, at a height of at most 40 pixels, for every combination of controls that the current user's role and the current board state make visible.
2. WHILE the viewport width is from 360 pixels through 767 pixels, THE Retro_Toolbar SHALL wrap its controls onto at most three rows and SHALL render each row bounding box, including padding and borders, at a height of at most 40 pixels.
3. THE Retro_Toolbar SHALL render every toolbar button at a bounding box of at least 32 pixels by 32 pixels, for viewport widths from 360 pixels through 1920 pixels.
4. THE Retro_Toolbar SHALL render the embedded feelings strip inside a toolbar row whose bounding box height satisfies the limit stated in acceptance criteria 1 and 2.
5. THE Retro_Toolbar SHALL keep the reveal cards action, enable voting action, complete retrospective action, export action, import action, screenshot action, add column action, board settings action, and feelings strip with their existing icons, `title` attributes, `aria-label` attributes, visibility conditions, and disabled conditions.
6. THE Retro_Toolbar SHALL render every text element at a contrast ratio of at least 4.5 to 1 against its own background colour and at a computed font size of at least 12 pixels.
7. THE Retro_Toolbar SHALL render the bounding boxes of its buttons and of the embedded feelings strip without overlap, for viewport widths from 360 pixels through 1920 pixels.
8. IF the visible controls of the Retro_Toolbar, including the feelings strip entries, require more width than the Retro_Toolbar provides, THEN THE Retro_Toolbar SHALL provide horizontal scrolling within its own bounding box and SHALL keep the Retro_Board_Page `scrollWidth` equal to or less than its `clientWidth`.
9. THE Retro_Toolbar SHALL keep every visible control reachable by sequential keyboard navigation and activatable by keyboard, for viewport widths from 360 pixels through 1920 pixels and for both the single-row and the wrapped layout.
10. THE Retro_Toolbar SHALL render the feelings strip at a block size of at most 32 pixels and SHALL render no empty bordered region whose inline size exceeds the combined inline size of the feeling controls it contains.
11. WHILE the viewport width is from 768 pixels through 1920 pixels, THE Retro_Toolbar and the Sprint_Context_Row together SHALL render at a combined block size of at most 72 pixels.

---

### Requirement 11: Connection Status Indicator and Interaction Blocking

**User Story:** As a participant, I want a small status box that shows whether the live connection is healthy, so that a brief connection drop does not bury the screen in messages and I do not act on stale data.

#### Acceptance Criteria

1. THE Poker_Session_Page SHALL display a Connection_Status_Indicator in its header from its first render onward, including before the first WebSocket connection has been established, during which Connection_State is `reconnecting`.
2. THE Retro_Board_Page SHALL display a Connection_Status_Indicator in its header from its first render onward, including before the first WebSocket connection has been established, during which Connection_State is `reconnecting`.
3. THE Connection_Status_Indicator SHALL render with a rendered width of at least 1.5 times its rendered height and a rendered height of at most 32 pixels.
4. WHILE Connection_State is `connected`, THE Connection_Status_Indicator SHALL render with the healthy green fill colour taken from a Design_Token and expose the text `Connected` as its `title` attribute and as its accessible name, reaching that rendering within 500 milliseconds of Connection_State becoming `connected`.
5. WHILE Connection_State is `reconnecting`, THE Connection_Status_Indicator SHALL render with the fault red fill colour taken from a Design_Token and expose the text `Trying to restore connection` as its `title` attribute and as its accessible name, reaching that rendering within 500 milliseconds of Connection_State becoming `reconnecting`.
6. WHILE Connection_State is `disconnected`, THE Connection_Status_Indicator SHALL render with the fault red fill colour taken from a Design_Token and expose the text `Disconnected` as its `title` attribute and as its accessible name, reaching that rendering within 500 milliseconds of Connection_State becoming `disconnected`.
7. THE Connection_Status_Indicator SHALL render a visible text label alongside the fill colour, whose text is identical to the `title` text required for the current Connection_State by acceptance criteria 4 through 6, so that the Connection_State is conveyed through a channel in addition to colour.
8. THE Connection_Status_Indicator SHALL render at a contrast ratio of at least 3 to 1 between its fill colour and the header background colour, and at a contrast ratio of at least 4.5 to 1 between its visible text label and its own fill colour.
9. WHILE Connection_State is `reconnecting` or `disconnected`, THE Interaction_Blocker SHALL prevent pointer activation and keyboard activation of every control inside the session page, except the Connection_Status_Indicator, the back to lobby action, and the logout action of the User_Control.
10. WHEN Connection_State leaves `connected`, THE Interaction_Blocker SHALL begin preventing activation of the controls named in acceptance criterion 9 within 500 milliseconds, and SHALL expose those blocked controls as unavailable to assistive technology.
11. WHILE Connection_State is `reconnecting` or `disconnected`, THE Interaction_Blocker SHALL expose a status message with `aria-live` set to `polite` stating that interaction is paused until the connection is restored.
12. WHILE Connection_State is `reconnecting` or `disconnected`, THE Interaction_Blocker SHALL keep the session content visible, SHALL permit scrolling of the session page, and SHALL retain without modification any text already entered in session input fields.
13. WHEN Connection_State transitions to `connected`, THE Interaction_Blocker SHALL restore pointer activation and keyboard activation for every control it had blocked within 500 milliseconds, and SHALL remove the status message required by acceptance criterion 11.
14. WHILE Connection_State is `reconnecting`, THE WebSocket services SHALL convey the connection loss through the Connection_Status_Indicator alone and SHALL display zero Notifications about the connection loss.
15. THE WebSocket services SHALL display at most one Notification per Connection_Loss_Episode, SHALL display that Notification only when the reconnection attempt count reaches the Give_Up_Threshold, and SHALL therefore display zero Notifications for any Connection_Loss_Episode that ends with Connection_State returning to `connected` before the Give_Up_Threshold is reached, irrespective of the number of failed attempts in that episode.
16. WHEN the reconnection attempt count reaches the Give_Up_Threshold, THE WebSocket services SHALL display exactly one Notification of type `error` stating that the connection could not be restored.
17. THE WebSocket services SHALL keep the existing close code handling, in which close code 4009 reports a duplicate display name, close code 4010 reports removal by the moderator, and close code 4004 reports a missing retrospective session.
18. IF a connection closes with close code 4009, 4010, or 4004, THEN THE WebSocket services SHALL display exactly one Notification reporting the corresponding cause, SHALL set Connection_State to `disconnected`, and SHALL make no reconnection attempt for that closure.
19. THE WebSocket services SHALL keep the existing reconnection delay rule of `min(2^attempt * 1000, 30000)` milliseconds.
20. WHILE a WebSocket connection is open, THE System SHALL send a Liveness_Probe to that connection every 30 seconds, with a tolerance of plus or minus 5 seconds per interval.
21. IF a connection does not respond to two consecutive Liveness_Probe messages, each within 30 seconds of that probe being sent, THEN THE System SHALL close that connection, remove the corresponding participant from the session, and send the updated session state to the remaining connections of that session.
22. THE Liveness_Probe mechanism SHALL apply to the poker WebSocket server and to the retrospective WebSocket server independently, so that a closed connection on one server leaves connections on the other server open.
23. WHEN the reconnection attempt count reaches the Give_Up_Threshold, THE WebSocket services SHALL set Connection_State to `disconnected` and SHALL make no further reconnection attempt for that Connection_Loss_Episode.
24. WHEN Connection_State is set to `disconnected` because the Give_Up_Threshold was reached, THE System SHALL navigate to the login page within 2 seconds.
25. WHEN Connection_State transitions to `connected`, THE WebSocket services SHALL reset the reconnection attempt count to zero, so that the next Connection_Loss_Episode counts attempts from zero.
26. THE WebSocket services SHALL display no Notification whose text reports a connection loss and no Notification whose text reports a reconnection attempt number.
27. WHEN Connection_State leaves `connected`, THE WebSocket services SHALL dismiss every Notification currently displayed whose text reports a connection loss or a reconnection attempt.

---

### Requirement 12: Logged-In User on the Home Page

**User Story:** As a logged-in user, I want to see who is signed in on the home page, so that the home page matches the poker and retrospective pages.

#### Acceptance Criteria

1. WHILE a stored authentication token and a stored user record are both present, THE Lobby_Page SHALL display a User_Control in the Lobby_Page header as the last element of the header row, with the right edge of the User_Control at or inside the right edge of the header content area, for viewport widths from 360 pixels through 1920 pixels.
2. THE Lobby_Page SHALL render the User_Control with the avatar button, the avatar initial, the dropdown structure, and the accessible names used by the User_Control on the Poker_Session_Page, namely the avatar button accessible name `User menu for <display name>`, `aria-haspopup` set to `true` on the avatar button, `aria-expanded` on the avatar button set to the open state of the dropdown, the role `menu` with accessible name `User menu` on the dropdown, and the accessible name `Logout` on the logout action.
3. THE User_Control SHALL render the avatar initial as the uppercase form of the first non-whitespace character of the authenticated user display name, for any display name holding at least one non-whitespace character.
4. WHERE the Lobby_Page hosts the User_Control, THE User_Control SHALL present the authenticated user display name and role in the dropdown, SHALL present the logout action as the only action item, SHALL omit the role switch action, and SHALL keep the display name inside the dropdown bounding box by appending an ellipsis when the display name requires more width than the dropdown provides.
5. WHEN a user activates the logout action from the Lobby_Page User_Control, THE System SHALL clear the stored authentication token and the stored user record before navigating to the login page, and SHALL complete that navigation within 1000 milliseconds of the activation, so that a subsequent load of the Lobby_Page route resolves to the login page.
6. WHILE no stored authentication token is present or no stored user record is present, THE Lobby_Page SHALL render the page without a User_Control and SHALL keep every remaining Lobby_Page element rendered.
7. WHILE the dropdown is open, WHEN a user activates a pointer target outside the User_Control or activates the avatar button, THE Lobby_Page User_Control SHALL close the dropdown, set `aria-expanded` to `false`, and leave the stored authentication token and the stored user record unchanged.
8. WHILE the dropdown is open, WHEN a user presses the Escape key, THE Lobby_Page User_Control SHALL close the dropdown and move keyboard focus to the avatar button.
9. WHILE the dropdown is closed, WHEN a user activates the avatar button of the Lobby_Page User_Control, THE Lobby_Page User_Control SHALL open the dropdown, set `aria-expanded` to `true`, and move keyboard focus to the logout action.
10. IF the authenticated user display name holds no non-whitespace character, THEN THE Lobby_Page SHALL render the avatar button without initial text, SHALL keep the avatar button activatable at a target size of at least 32 pixels by 32 pixels, and SHALL keep the dropdown and the logout action reachable by pointer and by keyboard.

---

### Requirement 13: Preservation of Existing Behaviour

**User Story:** As a team using the application today, I want every current capability to keep working exactly as it does now, so that these improvements carry no regression cost.

#### Acceptance Criteria

1. THE System SHALL accept every WebSocket event name that the poker handler and the retrospective handler accept before this feature, so that an event sent under its existing name produces its existing observable effect.
2. THE System SHALL emit every WebSocket event payload field that exists before this feature with its existing field name, value type, and meaning.
3. WHERE this feature introduces a new WebSocket event or a new WebSocket payload field, THE System SHALL introduce it as an addition whose name differs from every event name and payload field name that exists before this feature.
4. IF a received WebSocket event payload omits a payload field that this feature introduces, THEN THE System SHALL apply the default value defined for that field and SHALL complete the handling of that event with its existing observable effect.
5. THE System SHALL serve every REST route that exists before this feature at its existing path, with its existing HTTP method, and accepting its existing request shape.
6. WHEN the System receives a REST request that is valid before this feature, THE System SHALL respond with the status code, the response field names, and the response field value types that it returns before this feature.
7. THE System SHALL keep every existing accessible name and every existing `aria` attribute on the Lobby_Page, the Poker_Session_Page, the Issue_List_Panel, the Card_Deck, the Retro_Board_Page, the Retro_Toolbar, the Retro_Column, and the Retro_Card.
8. THE System SHALL keep every existing keyboard interaction of the components listed in acceptance criterion 7, comprising the existing focus order, the existing key bindings, and the existing visible focus indication.
9. THE System SHALL keep the retrospective concerns and the poker concerns isolated, so that the Retro_Session_Registry, the retrospective WebSocket handler, the retrospective routes, the Retro_Sessions_Endpoint, and the Retro_End_Session_Endpoint hold no import reference to and perform no call into the poker session registry, the poker WebSocket handler, or the poker routes.
10. WHERE a Retro_Session was created before this feature and its stored configuration omits `fluidCardHeight`, THE Retro_Session SHALL report `fluidCardHeight` as true in the configuration it broadcasts to connected participants.
11. WHERE a Retro_Session was created before this feature and its stored configuration omits `fluidCardHeight`, THE Retro_Card SHALL render that session with the behaviour defined for `fluidCardHeight` set to true.
12. WHEN the System receives a GET request at `/api/health`, THE System SHALL respond with status 200 for every configured base path value, including an empty base path.
13. THE System SHALL resolve the client routes and the REST routes under the configured base path prefix as they resolve before this feature, for every configured base path value including an empty base path.
14. WHEN the System receives a WebSocket upgrade request, THE System SHALL route an upgrade whose path identifies the retrospective feature to the retrospective WebSocket server and every other upgrade to the poker WebSocket server, for every configured base path value.
15. THE System SHALL keep the existing stored authentication token key and the existing stored user record key on the client, so that a user authenticated before this feature remains authenticated after it without entering credentials again.

---

### Requirement 14: Automated Verification Coverage

**User Story:** As a maintainer, I want automated tests for every behaviour in this document, so that a future change that breaks one of them fails the build.

#### Acceptance Criteria

1. THE repository SHALL contain at least one automated test asserting each acceptance criterion of Requirements 1 through 13 that is observable from the client code, the server code, or the shared code, where observable means assertable through an exported function result, a rendered document element or its computed style, a REST response, a WebSocket message, or a stored session state value.
2. THE repository SHALL identify, in the name of each automated test added for this feature, the requirement number and the acceptance criterion number that the test asserts, so that the count of covered criteria is derivable from the test names alone.
3. WHERE an acceptance criterion of Requirements 1 through 13 is not observable as defined in acceptance criterion 1, THE repository SHALL record that criterion number together with the reason it is not observable, so that every criterion of Requirements 1 through 13 is either covered by a named test or recorded as not observable.
4. WHEN the command `npm test` runs in the `server` directory, THE server tests and the shared tests SHALL execute under the existing Jest configuration, report zero failing tests, report zero skipped or disabled tests, and complete within 600 seconds.
5. WHEN the command `npm test` runs in the `client` directory, THE client tests SHALL execute under the existing Vitest configuration, report zero failing tests, report zero skipped or disabled tests, and complete within 600 seconds.
6. IF any automated test fails during the command `npm test` in the `server` directory or in the `client` directory, THEN THE command SHALL terminate with a non-zero exit status and report the name of each failing test.
7. THE client component tests SHALL use the existing testing library for Angular components, and SHALL assert component behaviour through the rendered document and the exposed accessible names rather than through component private members.
8. THE test suite SHALL contain property-based tests for the Export_Document field escaping round trip, in which quoting a field value and then parsing it recovers the original field value, exercising at least 100 generated field values of length 0 through 1,000 characters drawn from a character set that includes the comma, the double quote character, and the line break.
9. THE test suite SHALL contain property-based tests for the Summary_Row statistics, in which the exported average, mode, spread, distribution, and outlier count equal the Voting_Metrics values computed for the same selections, exercising at least 100 generated selection sets covering 1 through 50 participants over the card values defined in Shared_Types.
10. THE test suite SHALL contain property-based tests for the Summary_Row statistics of Completed_Estimate records whose Voting_Metrics hold `insufficientData` set to true, in which the average, mode, and spread fields equal the single character `-`.
11. THE test suite SHALL contain property-based tests for the Card_Text_Area height function, covering the idempotence rule of Requirement 6 acceptance criterion 8 and the monotonicity rule of Requirement 6 acceptance criterion 9, exercising at least 100 generated texts of length 0 through 5,000 characters, including texts containing line breaks, at element widths from 200 pixels through 1,200 pixels.
12. THE test suite SHALL contain property-based tests for the Connection_State transition rules, in which the Connection_Status_Indicator colour is the healthy colour exactly when Connection_State is `connected`, and interaction is permitted exactly when Connection_State is `connected`, exercising at least 100 generated transition sequences of length 1 through 50 over the values `connected`, `reconnecting`, and `disconnected`.
13. THE test suite SHALL contain property-based tests for the Notification count rule of Requirement 11 acceptance criterion 15, in which any sequence of connection drop and reconnection events that ends in restoration before the Give_Up_Threshold produces zero Notifications, exercising at least 100 generated sequences holding 1 through 9 reconnection attempts per Connection_Loss_Episode.
14. THE test suite SHALL contain property-based tests for the Issue_List_Panel overflow invariant of Requirement 2 acceptance criterion 3, exercising at least 100 generated panel states covering Issue_Title lengths of 0 through 500 characters, including titles without any whitespace character, Issue_Item counts of 0 through 200, and viewport widths from 360 pixels through 1920 pixels.
15. THE test suite SHALL contain property-based tests for the Card_Deck containment invariant of Requirement 3 acceptance criterion 2, exercising at least 100 generated states covering every card position of each voting system card set defined in Shared_Types and viewport widths from 360 pixels through 1920 pixels.
16. THE test suite SHALL contain property-based tests for the session list separation rule of Requirement 8 acceptance criterion 7, in which the Retro_Sessions_Endpoint response excludes every Game_Session identifier, exercising at least 100 generated registry states holding 0 through 50 Retro_Session entries and 0 through 50 Game_Session entries.
17. IF a property-based test finds a generated input that violates its asserted property, THEN THE test runner SHALL report that input value and the generation seed, and the enclosing `npm test` command SHALL terminate with a non-zero exit status.
18. THE existing automated test suite SHALL pass without modification to its existing assertions, so that every assertion present in the test files before this feature remains present and unchanged after this feature.
