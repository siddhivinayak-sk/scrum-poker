# Requirements Document

## Introduction

This document specifies the requirements for adding a Sprint Retrospective Board feature to the existing Scrum Poker application. The Retrospective Board enables agile teams to collaboratively reflect on their sprints using customizable column-based boards with cards, voting, and comments. The feature reuses the existing user model (moderator creates, participants join via link) and technical infrastructure (Angular 21, Node.js/Express, WebSocket, in-memory storage).

## Glossary

- **Retrospective_Board**: A collaborative digital board consisting of columns and cards used by a team to reflect on a sprint
- **Moderator**: The user who creates and manages a retrospective session, controlling board settings, card reveal, voting, and session lifecycle
- **Participant**: A team member who joins a retrospective session to add cards, vote, and comment
- **Card**: A rectangular UI element within a column containing a text input, vote count, comments, and optional emoji/GIF
- **Column**: A vertical section of the board representing a retrospective aspect (e.g., "Went well", "To improve")
- **Template**: A predefined set of column names that defines the initial structure of a retrospective board
- **Session_Link**: A shareable URL that allows participants to join a specific retrospective board
- **Vote**: A positive endorsement a participant can give to a card, limited by the max votes per user setting
- **Board_Configuration**: The set of advanced settings controlling board behavior (card visibility, voting, password, etc.)
- **Lobby**: The application's landing page where users choose between creating a Scrum Poker session or a Retrospective Board
- **RetroSession_Registry**: The in-memory registry that stores and manages active retrospective board sessions
- **CSV_Export**: A comma-separated values file containing all board data (columns, cards, votes, comments) for external use

## Requirements

### Requirement 1: Lobby Integration

**User Story:** As a user, I want to see a "Create Retrospective Board" option in the lobby alongside the existing Scrum Poker tile, so that I can choose which activity to start.

#### Acceptance Criteria

1. THE Lobby SHALL display a "Create Retrospective Board" tile alongside the existing "Start New Game" tile
2. WHEN a user clicks the "Create Retrospective Board" tile, THE Lobby SHALL navigate the user to the retrospective board creation page
3. THE Lobby SHALL preserve all existing Scrum Poker functionality without modification

---

### Requirement 2: Retrospective Board Creation

**User Story:** As a moderator, I want to create a retrospective board with a name, vote limit, and template selection, so that I can set up a structured retrospective session for my team.

#### Acceptance Criteria

1. THE Board_Creation_Page SHALL require a board name input field that accepts non-empty text
2. THE Board_Creation_Page SHALL provide a max votes per user input field with a default value of 6 and accepting positive integers only
3. THE Board_Creation_Page SHALL provide a template selection dropdown containing at least 10 predefined templates
4. WHEN the moderator submits valid creation parameters, THE System SHALL create a new Retrospective_Board and navigate the moderator to the board view
5. IF the board name field is empty, THEN THE Board_Creation_Page SHALL display a validation error and prevent submission

---

### Requirement 3: Template Selection

**User Story:** As a moderator, I want to choose from a variety of retrospective templates, so that I can pick the format that best suits my team's needs.

#### Acceptance Criteria

1. THE Template_Selector SHALL include the following templates:
   - "Went well, To improve, Action items" (columns: Went Well, To Improve, Action Items)
   - "What went well?, What didn't go so well?, What have I learned?, What still puzzles me?" (columns: Went Well, Didn't Go Well, Learned, Still Puzzles Me)
   - "Start, Stop, Continue" (columns: Start, Stop, Continue)
   - "Mad, Sad, Glad" (columns: Mad, Sad, Glad)
   - "Liked, Learned, Lacked, Longed for" (4Ls) (columns: Liked, Learned, Lacked, Longed For)
   - "Keep, Add, Less, More" (KALM) (columns: Keep, Add, Less, More)
   - "Sailboat" (columns: Wind, Anchor, Rocks, Island)
   - "Starfish" (columns: Keep Doing, More Of, Less Of, Stop Doing, Start Doing)
   - "Plus/Delta" (columns: Plus, Delta)
   - "Hot Air Balloon" (columns: Hot Air, Sandbags, Storm Clouds)
   - "DAKI" (columns: Drop, Add, Keep, Improve)
   - "Rose, Bud, Thorn" (columns: Rose, Bud, Thorn)
   - "Lean Coffee" (columns: To Discuss, Discussing, Discussed)
   - "Speed Car" (columns: Engine, Parachute, Abyss)
   - "Three Little Pigs" (columns: House of Straw, House of Sticks, House of Bricks)
   - "Mountain Climber" (columns: Summit, Cliff, Backpack, Base Camp)
   - "Traffic Light" (columns: Green, Amber, Red)
   - "Weather Forecast" (columns: Sunny, Cloudy, Rainy, Stormy)
   - "The Good, The Bad, The Ugly" (columns: The Good, The Bad, The Ugly)
   - "Energy Levels" (columns: High Energy, Neutral, Low Energy)
   - "Thumbs Up, Thumbs Down, New Ideas, Recognition" (columns: 👍 Thumbs Up, 👎 Thumbs Down, 💡 New Ideas, 🏆 Recognition)
   - "Happy, Meh, Sad" (columns: Happy, Meh, Sad)
   - "Hope, Worry, Risk, Mitigation" (columns: Hope, Worry, Risk, Mitigation)
   - "Scrum Values" (columns: Courage, Focus, Commitment, Respect, Openness)
   - "WWW" (columns: Worked, Kinda Worked, Didn't Work)
2. WHEN a template is selected, THE Board_Creation_Page SHALL display a preview of the column names defined by that template
3. THE Template_Selector SHALL set the first template as the default selection

---

### Requirement 4: Advanced Board Configuration

**User Story:** As a moderator, I want to configure advanced settings for my retrospective board, so that I can control how participants interact with the board.

#### Acceptance Criteria

1. THE Board_Configuration SHALL provide a "Hide cards initially" toggle (default: off) that controls whether cards are hidden until the moderator reveals them
2. THE Board_Configuration SHALL provide a "Disable voting initially" toggle (default: off) that controls whether voting is disabled until the moderator enables it
3. THE Board_Configuration SHALL provide a "Hide vote count on cards" toggle (default: off) that controls whether vote counts are visible on cards
4. THE Board_Configuration SHALL provide a "One vote per card" toggle (default: off) that limits each participant to a single vote per card
5. THE Board_Configuration SHALL provide a "Show card author" toggle (default: off) that controls whether the author name is displayed on cards
6. THE Board_Configuration SHALL provide a "Secure board with password" toggle (default: off) with a password input field that appears when enabled
7. THE Board_Configuration SHALL provide an "Enable GIF/emoji" toggle (default: on) that controls whether GIF and emoji features are available on cards
8. THE Board_Configuration SHALL provide a "Column layout" toggle (default: vertical) that switches between vertical columns (side-by-side) and horizontal rows (stacked top-to-bottom)

---

### Requirement 5: Session Link Sharing

**User Story:** As a moderator, I want to copy and share a session link after creating a board, so that participants can join my retrospective.

#### Acceptance Criteria

1. WHEN a Retrospective_Board is created, THE System SHALL generate a unique Session_Link
2. THE Board_View SHALL display a "Copy Link" button that copies the Session_Link to the clipboard
3. WHEN a participant opens a Session_Link, THE System SHALL prompt the participant for a display name before joining
4. IF the board is password-protected, THEN THE System SHALL require the correct password before granting access to the participant

---

### Requirement 6: Participant Authentication

**User Story:** As a participant, I want to join a retrospective board by entering my display name, so that my contributions are attributed to me.

#### Acceptance Criteria

1. WHEN a participant navigates to a Session_Link, THE System SHALL display a login form requesting a display name
2. THE System SHALL enforce case-insensitive display name uniqueness within a single retrospective session
3. WHEN a participant submits a valid display name, THE System SHALL issue a JWT token and grant access to the board
4. THE System SHALL reuse the existing authentication flow used by Scrum Poker sessions

---

### Requirement 7: Board Layout and Columns

**User Story:** As a participant, I want to see the retrospective board with columns based on the selected template, so that I can add cards to the appropriate sections.

#### Acceptance Criteria

1. THE Board_View SHALL display columns based on the selected template with column headers matching the template names
2. THE Board_View SHALL display a context-setting input box at the top of the board for the moderator to describe the sprint context
3. WHEN a participant or moderator adds a new column, THE Board_View SHALL append the column to the board
4. WHEN a participant or moderator removes a column, THE Board_View SHALL remove the column and all its cards from the board
5. THE Board_View SHALL support reordering columns via drag-and-drop
6. THE Board_View SHALL use a compact design with small font sizes to fit the board on a single screen without scrolling
7. WHEN the "Column layout" configuration is set to vertical (default), THE Board_View SHALL display columns side-by-side in a horizontal row
8. WHEN the "Column layout" configuration is set to horizontal, THE Board_View SHALL display columns stacked top-to-bottom as rows
9. THE moderator SHALL be able to toggle the column layout at any time during the session, and the change SHALL be broadcast to all participants in real time

---

### Requirement 8: Card Management

**User Story:** As a participant, I want to add, edit, and organize cards on the board, so that I can share my thoughts during the retrospective.

#### Acceptance Criteria

1. WHEN a participant clicks "Add Card" in a column, THE Board_View SHALL create a new Card with an editable text input field
2. THE Card SHALL support editing its text content at any time before the board is marked as completed
3. WHEN a participant or moderator removes a Card, THE System SHALL delete the Card from the column and broadcast the change to all participants
4. THE Card owner (author) and the moderator SHALL be able to remove a Card at any time before the board is marked as completed
5. THE Card SHALL display a vote button and the current vote count (unless vote count is hidden by configuration)
6. THE Card SHALL display a comment section where participants can add multiple comments
7. WHERE the "Enable GIF/emoji" configuration is active, THE Card SHALL provide emoji and GIF insertion capabilities
8. WHEN a participant drags a Card within the same column, THE Board_View SHALL reorder the Card to the new position
9. WHEN a participant drags a Card to a different column, THE Board_View SHALL move the Card to the target column

---

### Requirement 9: Voting System

**User Story:** As a participant, I want to vote on cards, so that I can indicate which topics are most important to discuss.

#### Acceptance Criteria

1. WHEN a participant clicks the vote button on a Card, THE System SHALL increment the vote count for that Card and decrement the participant's remaining votes
2. WHILE a participant has zero remaining votes, THE System SHALL disable all vote buttons for that participant
3. IF the "One vote per card" configuration is active, THEN THE System SHALL limit each participant to one vote per Card
4. IF the "Disable voting initially" configuration is active, THEN THE System SHALL prevent all voting until the moderator enables voting
5. WHEN the moderator enables voting, THE System SHALL activate vote buttons for all participants
6. THE Board_View SHALL display the participant's remaining vote count

---

### Requirement 10: Card Visibility and Reveal

**User Story:** As a moderator, I want to control when cards are visible to all participants, so that I can prevent bias during the card-writing phase.

#### Acceptance Criteria

1. WHILE the "Hide cards initially" configuration is active AND cards have not been revealed, THE Board_View SHALL show each participant only their own cards
2. WHEN the moderator triggers card reveal, THE Board_View SHALL make all cards visible to all participants
3. WHILE cards are hidden, THE Board_View SHALL display a card count per column without showing card content to other participants

---

### Requirement 11: Moderator Controls

**User Story:** As a moderator, I want to manage the retrospective workflow including revealing cards, enabling voting, and completing the session, so that I can guide the team through a structured retrospective.

#### Acceptance Criteria

1. THE Moderator_Controls SHALL provide a "Reveal Cards" button that makes all hidden cards visible to all participants
2. THE Moderator_Controls SHALL provide an "Enable Voting" button that activates voting for all participants
3. THE Moderator_Controls SHALL provide a "Complete Retrospective" button that locks the board and prevents further edits
4. WHEN the moderator marks the retrospective as completed, THE System SHALL disable all card editing, voting, column changes, and card movement
5. THE Moderator_Controls SHALL provide the ability to move cards between columns
6. THE Moderator_Controls SHALL provide the ability to rearrange cards within columns

---

### Requirement 12: Real-Time Collaboration

**User Story:** As a participant, I want to see changes made by other participants in real time, so that the retrospective feels collaborative and interactive.

#### Acceptance Criteria

1. WHEN a participant adds, edits, or removes a Card, THE System SHALL broadcast the change to all connected participants within 500ms
2. WHEN a participant votes on a Card, THE System SHALL broadcast the updated vote count to all connected participants
3. WHEN a participant adds a comment to a Card, THE System SHALL broadcast the new comment to all connected participants
4. WHEN a column is added, removed, or reordered, THE System SHALL broadcast the change to all connected participants
5. THE System SHALL use WebSocket connections for real-time communication, following the same pattern as the existing Scrum Poker feature
6. WHEN a participant reconnects after a connection drop, THE System SHALL restore the full board state

---

### Requirement 13: Data Export

**User Story:** As a moderator, I want to export the retrospective board data as CSV, so that I can share results with stakeholders or archive them.

#### Acceptance Criteria

1. THE Moderator_Controls SHALL provide an "Export CSV" button
2. WHEN the moderator clicks "Export CSV", THE System SHALL generate a CSV file containing all columns, cards, vote counts, and comments
3. THE CSV_Export SHALL include column name, card text, vote count, author (if shown), and comments for each card

---

### Requirement 14: Import from CSV

**User Story:** As a moderator, I want to import cards from a CSV file, so that I can pre-populate the board with items from previous retrospectives or external sources.

#### Acceptance Criteria

1. THE Moderator_Controls SHALL provide an "Import CSV" button
2. WHEN the moderator uploads a valid CSV file, THE System SHALL create cards in the appropriate columns based on the CSV data
3. IF the CSV file contains invalid or malformed data, THEN THE System SHALL display an error message describing the issue and reject the import

---

### Requirement 15: In-Memory Session Storage

**User Story:** As a system operator, I want retrospective sessions stored in memory with the same lifecycle as poker sessions, so that the system remains simple and stateless.

#### Acceptance Criteria

1. THE RetroSession_Registry SHALL store all retrospective board sessions in memory
2. THE RetroSession_Registry SHALL support multiple concurrent retrospective sessions isolated from each other
3. WHEN a retrospective session has zero participants AND has been inactive for 30 minutes, THE RetroSession_Registry SHALL remove the session from memory
4. THE RetroSession_Registry SHALL operate independently from the existing poker SessionRegistry

---

### Requirement 16: Board Password Protection

**User Story:** As a moderator, I want to secure my retrospective board with a password, so that only authorized team members can access it.

#### Acceptance Criteria

1. WHERE the "Secure board with password" configuration is active, THE System SHALL require participants to enter the correct password before joining
2. IF a participant enters an incorrect password, THEN THE System SHALL deny access and display an error message
3. THE System SHALL store the board password in memory alongside the session data

---

### Requirement 17: Card Author Display

**User Story:** As a participant, I want to optionally see who authored each card, so that I can ask follow-up questions to the right person.

#### Acceptance Criteria

1. WHERE the "Show card author" configuration is active, THE Card SHALL display the author's display name
2. WHERE the "Show card author" configuration is inactive, THE Card SHALL hide the author's display name from all participants

---

### Requirement 18: Context Setting

**User Story:** As a moderator, I want to set a context description at the top of the board, so that participants understand what sprint or topic the retrospective covers.

#### Acceptance Criteria

1. THE Board_View SHALL display a context input field at the top of the board
2. WHEN the moderator enters or updates the context text, THE System SHALL broadcast the updated context to all participants in real time
3. THE context field SHALL be editable only by the moderator

---

### Requirement 19: Column Management

**User Story:** As a participant or moderator, I want to add, remove, and reorder columns at any time, so that the board structure can evolve during the retrospective.

#### Acceptance Criteria

1. WHEN a user adds a new column with a non-empty name, THE System SHALL append the column to the board and broadcast the change
2. WHEN a user removes a column, THE System SHALL remove the column and all associated cards, then broadcast the change
3. WHEN a user reorders columns via drag-and-drop, THE System SHALL update the column order and broadcast the change
4. WHILE the retrospective is marked as completed, THE System SHALL prevent all column modifications

---

### Requirement 20: Compact Visual Design

**User Story:** As a participant, I want the board to use a compact design, so that all columns and cards fit on a single screen without scrolling.

#### Acceptance Criteria

1. THE Board_View SHALL use compact font sizes and minimal padding to maximize content density
2. THE Board_View SHALL display all columns in a single horizontal row that fits within the viewport width
3. THE Card SHALL use a compact layout with minimal vertical spacing between elements
4. WHILE the number of columns exceeds the viewport width, THE Board_View SHALL provide horizontal scrolling for the column area

---

### Requirement 21: Icon-Only Buttons with Tooltips

**User Story:** As a participant, I want buttons to use icons instead of text labels, so that the board remains compact, and I want tooltips on hover so I can understand what each button does.

#### Acceptance Criteria

1. ALL action buttons on the Board_View (add card, delete card, vote, comment, move, export, import, reveal, enable voting, complete, copy link, settings) SHALL use icon-only representations without text labels
2. EVERY icon-only button SHALL include a `title` attribute that displays a descriptive tooltip on mouse hover explaining the button's action
3. EVERY icon-only button SHALL include an `aria-label` attribute matching the tooltip text for screen reader accessibility
4. THE icon-only buttons SHALL maintain a minimum tap target size of 32x32 pixels for usability
5. THE Moderator_Controls toolbar SHALL use a horizontal icon bar layout to minimize vertical space usage

---

### Requirement 22: Board Screenshot Capture

**User Story:** As a participant or moderator, I want to capture a screenshot of the board, so that I can share it in chat applications or save it for reference.

#### Acceptance Criteria

1. THE Board_View SHALL provide a screenshot capture icon button in the toolbar
2. WHEN the user clicks the screenshot button, THE System SHALL render the entire board (including all columns and cards, even those outside the visible viewport) as a PNG image
3. AFTER capturing the screenshot, THE System SHALL copy the image to the clipboard so the user can paste it directly into chat applications
4. THE System SHALL display a toast notification confirming the screenshot was copied to clipboard
5. IF clipboard image copy is not supported by the browser, THEN THE System SHALL trigger a file download of the PNG image instead
6. THE screenshot capture SHALL include all visible board content: context, column headers, cards, vote counts, and comments
