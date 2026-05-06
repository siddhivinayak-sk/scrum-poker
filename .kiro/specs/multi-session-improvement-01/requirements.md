# Requirements Document

## Introduction

This document defines the requirements for a set of improvements and new features to the existing Scrum Poker multi-session application. The improvements span moderator controls (user removal), session integrity (duplicate username prevention), UX enhancements (reveal animation, advanced settings grouping), workflow features (issue/story list management, re-vote capability, consensus indicators, facilitator flow control, session resume), and reliability fixes (WebSocket reconnection, participant list accuracy, timer correctness, permission broadcast).

The application already supports multi-session architecture with isolated game sessions, configurable voting systems, auto-reveal, countdown animation, and a voting timer. This spec focuses on genuinely new functionality and verified correctness of existing behavior.

## Glossary

- **Application**: The Scrum Poker web application system as a whole
- **Moderator**: A user with the moderator role who owns or administers a Game_Session
- **Participant**: A user who has joined a Game_Session to participate in estimation
- **Game_Session**: An isolated estimation session identified by a unique session ID, containing participants, rounds, history, and configuration
- **Session_Registry**: The backend component responsible for managing Game_Session instances
- **WebSocket_Handler**: The backend component managing WebSocket connections and routing events within session scope
- **Display_Name**: The user-visible name chosen during login or anonymous join, used to identify participants on the board
- **Voting_Board**: The UI area displaying participant cards (face-down during voting, face-up after reveal)
- **Reveal_Action**: The act of flipping all cards to show selections, triggered manually or via auto-reveal
- **Stars_Animation**: A celebratory visual effect (stars/confetti shower) displayed when cards are revealed
- **Issue_List**: An ordered collection of stories/issues to be estimated in a session, managed in a sidebar panel
- **Re_Vote**: The action of restarting a voting round on the same story after cards have been revealed
- **Consensus_Indicator**: A visual indicator showing whether participants agree on an estimate or have divergent votes
- **Facilitator_Flow**: A structured workflow guiding the moderator through present → vote → reveal → discuss → next steps
- **Session_History_Resume**: The ability to return to a previously active session and continue estimation
- **Advanced_Settings**: A collapsible section in the session creation and settings forms grouping non-essential configuration options
- **Session_Configuration**: The set of configurable options for a Game_Session including voting system, permissions, auto-reveal, and countdown settings

## Requirements

### Requirement 1: Moderator User Removal

**User Story:** As a moderator, I want to remove a participant from my session, so that I can manage disruptive users or clean up stale connections without ending the session.

#### Acceptance Criteria

1. WHILE a Moderator views the participant list in a Game_Session, THE Application SHALL display a remove button next to each Participant who is not the Moderator themselves
2. WHEN a Moderator clicks the remove button for a Participant, THE WebSocket_Handler SHALL disconnect the target Participant from the Game_Session and remove them from the participant list
3. WHEN a Participant is removed by a Moderator, THE Application SHALL broadcast an updated participant list to all remaining participants in the Game_Session within 1 second
4. WHEN a Participant is removed by a Moderator, THE Application SHALL display a notification to the removed Participant indicating they have been removed from the session
5. THE Application SHALL NOT display a remove button for the Moderator's own entry in the participant list
6. IF a removed Participant had an active card selection in the current voting round, THEN THE Game_Session SHALL discard that selection from the round

### Requirement 2: Duplicate Display Name Prevention

**User Story:** As a user, I want the system to prevent duplicate display names within a session, so that I can clearly identify who voted what without confusion.

#### Acceptance Criteria

1. WHEN a user attempts to join a Game_Session with a Display_Name that matches an existing Participant's Display_Name in that session (case-insensitive comparison), THE WebSocket_Handler SHALL reject the connection with an error message indicating the name is already taken
2. WHEN a WebSocket connection is rejected due to a duplicate Display_Name, THE Application SHALL display an error message to the user indicating the chosen name is already in use in that session
3. THE WebSocket_Handler SHALL perform Display_Name uniqueness validation after successful token authentication and before adding the user to the Game_Session participant list
4. WHEN a Participant leaves a Game_Session, THE Game_Session SHALL release their Display_Name so that a new user may join with that same name
5. THE Application SHALL perform case-insensitive comparison when checking Display_Name uniqueness (e.g., "Alice" and "alice" are considered duplicates)

### Requirement 3: Timer Stops on Reveal

**User Story:** As a user, I want the voting timer to stop immediately when cards are revealed, so that the displayed time accurately reflects the voting duration.

#### Acceptance Criteria

1. WHEN the Reveal_Action is triggered (manually or via auto-reveal), THE Application SHALL stop the voting timer immediately upon receiving the cards:revealed event
2. WHEN cards are revealed, THE Application SHALL display the final elapsed voting time as a static value (no longer ticking)
3. THE Game_Session SHALL compute the voting duration as the difference between the round's revealedAt timestamp and startedAt timestamp, and this value SHALL match the timer display
4. WHEN the Reveal_Action is triggered via auto-reveal with countdown animation enabled, THE Application SHALL stop the timer at the moment the cards:revealed event is processed, not at the start of the countdown

### Requirement 4: Stars Shower Animation on Reveal

**User Story:** As a user, I want to see a celebratory stars/confetti animation when cards are revealed, so that the reveal moment feels engaging and fun.

#### Acceptance Criteria

1. WHEN the Reveal_Action is triggered and cards become visible on the Voting_Board, THE Application SHALL display a Stars_Animation effect overlaying the board area
2. THE Stars_Animation SHALL complete within 3 seconds and then fade out without blocking user interaction
3. WHEN a user has enabled reduced-motion preferences in their operating system, THE Application SHALL skip the Stars_Animation entirely
4. THE Stars_Animation SHALL be rendered using CSS animations or a lightweight canvas approach that does not degrade page performance (no frame drops below 30fps on mid-range devices)
5. THE Application SHALL not display the Stars_Animation when the board is cleared, only on card reveal

### Requirement 5: Auto-Reveal Toggle Visibility

**User Story:** As a moderator, I want the auto-reveal toggle to be clearly visible and accessible during an active session, so that I can quickly enable or disable it without navigating deep into settings.

#### Acceptance Criteria

1. WHILE a Game_Session is active, THE Application SHALL display the current auto-reveal status (enabled/disabled) in the session settings panel
2. WHEN a Moderator toggles the auto-reveal setting, THE Application SHALL immediately apply the change and broadcast the updated configuration to all participants
3. WHILE auto-reveal is enabled and all Participants have submitted a card selection, THE Game_Session SHALL trigger the Reveal_Action automatically
4. THE Application SHALL display a visual indicator (e.g., badge or icon) near the voting area showing whether auto-reveal is currently active

### Requirement 6: Advanced Settings Grouping

**User Story:** As a moderator, I want non-essential settings grouped into a collapsible "Advanced" section, so that the session creation form is simpler by default while still providing full configurability.

#### Acceptance Criteria

1. WHEN a Moderator views the session creation form, THE Application SHALL display only the game name (story description) and voting system selection as primary visible fields
2. THE Application SHALL group the following settings into an Advanced_Settings section: reveal permission, issue permission, auto-reveal toggle, and countdown animation toggle
3. THE Application SHALL hide the Advanced_Settings section by default (collapsed state)
4. WHEN a Moderator clicks the "Advanced" toggle button, THE Application SHALL expand the Advanced_Settings section to reveal all grouped settings
5. WHEN the Advanced_Settings section is expanded and the Moderator clicks the toggle button again, THE Application SHALL collapse the section
6. THE Application SHALL apply the same Advanced_Settings grouping in the in-session settings panel (session-settings-panel component)
7. THE Advanced_Settings toggle button SHALL include an aria-expanded attribute reflecting the current state for accessibility

### Requirement 7: Issue/Story List Management

**User Story:** As a moderator, I want to manage a list of stories/issues in a sidebar, so that I can plan the estimation session in advance and track which stories have been estimated.

#### Acceptance Criteria

1. THE Application SHALL display an Issue_List panel as a sidebar (or collapsible panel on mobile) within the Game_Session page
2. WHEN a user with issue permission adds a story to the Issue_List, THE Application SHALL append the story to the list and broadcast the update to all session participants
3. THE Application SHALL allow importing multiple stories at once by pasting a newline-separated list of story titles
4. WHEN a Moderator drags an issue in the Issue_List, THE Application SHALL reorder the list and broadcast the new order to all participants
5. THE Application SHALL visually distinguish estimated stories (those with a completed voting round in history) from stories not yet estimated
6. WHEN a Moderator selects a story from the Issue_List for estimation, THE Application SHALL start a new voting round with that story's description
7. THE Issue_List SHALL persist for the duration of the Game_Session and be included in the session state sent on reconnect

### Requirement 8: Re-Vote Capability

**User Story:** As a moderator, I want to trigger a re-vote on the current story after cards are revealed, so that the team can re-estimate when initial votes diverge significantly.

#### Acceptance Criteria

1. WHILE cards are revealed for the current round, THE Application SHALL display a "Re-Vote" button visible to users with reveal permission
2. WHEN a user with reveal permission clicks the "Re-Vote" button, THE Game_Session SHALL start a new voting round with the same story description as the current revealed round
3. WHEN a Re_Vote is triggered, THE Application SHALL clear all current selections and reset the board to the voting state
4. WHEN a Re_Vote is triggered, THE Application SHALL NOT save the previous round to history (the re-vote replaces the previous attempt)
5. THE Application SHALL broadcast the new round to all participants in the Game_Session when a Re_Vote is triggered

### Requirement 9: Consensus Indicator

**User Story:** As a user, I want to see at a glance whether the team agrees on an estimate, so that I can quickly identify stories that need discussion.

#### Acceptance Criteria

1. WHILE cards are revealed, THE Application SHALL display a Consensus_Indicator showing the level of agreement among participants
2. WHEN all participants who voted selected the same card value, THE Consensus_Indicator SHALL display a "Full Agreement" state (e.g., green checkmark or similar icon)
3. WHEN the spread metric (difference between highest and lowest numeric votes) exceeds 5 story points (or 2 positions for non-numeric systems), THE Consensus_Indicator SHALL display a "High Divergence" state (e.g., warning icon)
4. WHEN the spread is between 0 (exclusive) and the high-divergence threshold, THE Consensus_Indicator SHALL display a "Partial Agreement" state
5. THE Consensus_Indicator SHALL be displayed alongside the voting metrics after card reveal

### Requirement 10: Facilitator Flow Control

**User Story:** As a moderator, I want a guided workflow that helps me move through the estimation process (present → vote → reveal → discuss → next), so that sessions run smoothly without me having to remember each step.

#### Acceptance Criteria

1. WHILE a Game_Session is active and no voting round is in progress, THE Application SHALL display a prompt to the Moderator to select or enter the next story for estimation
2. WHILE a voting round is in the "voting" state, THE Application SHALL display the current vote count and a "Reveal Cards" action to the Moderator (subject to reveal permission)
3. WHILE cards are revealed, THE Application SHALL display action options to the Moderator: "Re-Vote", "Clear & Next Story", and optionally "Add Discussion Note"
4. WHEN the Moderator selects "Clear & Next Story", THE Application SHALL clear the board, save the round to history, and prompt for the next story
5. THE Application SHALL display a progress indicator showing how many stories from the Issue_List have been estimated versus total stories

### Requirement 11: Session History with Resume

**User Story:** As a moderator, I want to resume a previously active session, so that I can continue estimation across multiple meetings without losing progress.

#### Acceptance Criteria

1. THE Application SHALL display a list of the user's previously created sessions (that have not been cleaned up) on the lobby or session creation page
2. WHEN a Moderator selects a previous session from the list, THE Application SHALL navigate to that Game_Session page and reconnect via WebSocket
3. THE Game_Session SHALL retain its full state (Issue_List, history, configuration) as long as it has not been cleaned up by the inactive session cleanup process
4. THE Application SHALL display the session's creation date, number of completed rounds, and last activity timestamp in the session list
5. IF a Moderator attempts to resume a session that has been cleaned up, THEN THE Application SHALL display a message indicating the session has expired

### Requirement 12: WebSocket Reconnection State Restoration

**User Story:** As a user, I want my session state to be fully restored when my WebSocket connection drops and reconnects, so that I do not lose context during network interruptions.

#### Acceptance Criteria

1. WHEN a WebSocket connection is re-established after a disconnection, THE WebSocket_Handler SHALL send the full Game_Session state (participants, current round, selections, history, configuration) to the reconnecting client
2. WHEN a client receives the session:state event on reconnect, THE Application SHALL restore all UI state including the participant list, current round status, card selections (if revealed), voting timer position, and session configuration
3. IF a voting round was started while the user was disconnected, THEN THE Application SHALL display the active round with correct timer elapsed time upon reconnect
4. THE Application SHALL attempt automatic WebSocket reconnection with exponential backoff (starting at 1 second, maximum 30 seconds) when a connection drops unexpectedly

### Requirement 13: Participant List Accuracy on Join/Leave

**User Story:** As a user, I want the participant list to always reflect who is currently in the session, so that I know who is voting and can trust the auto-reveal trigger.

#### Acceptance Criteria

1. WHEN a Participant joins a Game_Session, THE WebSocket_Handler SHALL broadcast the updated participant list to all connected clients within 1 second
2. WHEN a Participant's last WebSocket connection closes (all tabs/connections for that user are gone), THE WebSocket_Handler SHALL remove the Participant from the Game_Session and broadcast the updated list within 1 second
3. WHILE a user has multiple WebSocket connections to the same Game_Session (e.g., multiple tabs), THE WebSocket_Handler SHALL keep the user in the participant list until all connections are closed
4. WHEN the participant list changes, THE Application SHALL update the displayed participant count and board cards immediately

### Requirement 14: Timer Accuracy Across Time Zones

**User Story:** As a user in any time zone, I want the voting timer to display accurate elapsed time, so that the timer is consistent regardless of where participants are located.

#### Acceptance Criteria

1. THE Game_Session SHALL store round startedAt and revealedAt timestamps in UTC (ISO 8601 format with Z suffix)
2. THE Application SHALL compute elapsed voting time by comparing the server-provided startedAt timestamp against the client's current time (both converted to UTC milliseconds)
3. WHEN cards are revealed, THE Application SHALL display the final duration computed from the server-provided revealedAt minus startedAt, not from the client-side timer
4. THE Application SHALL not rely on client-side clock accuracy for the final displayed duration; the server-computed votingDurationMs SHALL be the authoritative value

### Requirement 15: Permission Change Broadcast

**User Story:** As a participant, I want to immediately see updated permissions when the moderator changes session settings, so that I can use newly granted capabilities without refreshing.

#### Acceptance Criteria

1. WHEN a Moderator updates the Session_Configuration (reveal permission, issue permission, or any other setting), THE WebSocket_Handler SHALL broadcast the session:config-updated event to all connected participants within 2 seconds
2. WHEN a client receives a session:config-updated event, THE Application SHALL re-evaluate the current user's permissions and update the UI (show/hide reveal button, story submission controls) immediately
3. WHEN the permission mode changes from "moderator-only" to "all-players", THE Application SHALL enable the relevant controls for all participants without requiring a page refresh
4. WHEN the permission mode changes to "select-specific", THE Application SHALL enable controls only for the Moderator and the specified allowed user IDs
