# Requirements Document

## Introduction

This document defines the requirements for extending the existing Scrum Poker application from a single-team model to a multi-team session architecture. Currently, the application uses a single in-memory SessionManager instance shared by all connected users. This feature introduces isolated game sessions, each identified by a unique session ID, so that multiple teams can run estimation sessions in parallel on the same application instance. A moderator creates a session and shares a link (or QR code) with participants, who join the correct session automatically after login. Additionally, moderators gain advanced configuration options when creating a session, including voting system selection, card reveal permissions, issue management permissions, auto-reveal behavior, and countdown animation settings.

## Glossary

- **Application**: The Scrum Poker web application system as a whole
- **Session_Registry**: The backend component responsible for creating, storing, retrieving, and deleting Game_Sessions, replacing the current single-instance SessionManager pattern
- **Game_Session**: An isolated estimation session created by a Moderator, identified by a unique Session_ID, containing its own participants, voting rounds, history, and configuration
- **Session_ID**: A unique, URL-safe identifier generated for each Game_Session (e.g., a UUID or short alphanumeric code)
- **Session_Link**: A shareable URL containing the Session_ID as a path parameter (e.g., `/session/{sessionId}`) that directs users to a specific Game_Session
- **Session_QR_Code**: A QR code image encoding the full Session_Link URL, displayed to the Moderator for convenient sharing
- **Moderator**: A user role with elevated privileges to create and configure Game_Sessions, manage estimation rounds, reveal cards, and clear the board
- **Participant**: A user role that joins an existing Game_Session via a Session_Link and participates in estimation rounds
- **Voting_System**: A configurable set of card values used for estimation within a Game_Session
- **Fibonacci_System**: A Voting_System with card values 0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89
- **Modified_Fibonacci_System**: A Voting_System with card values 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100
- **T_Shirt_System**: A Voting_System with card values XS, S, M, L, XL, XXL
- **Power_Of_2_System**: A Voting_System with card values 0, 1, 2, 4, 8, 16, 32, 64
- **Session_Configuration**: The set of configurable options for a Game_Session, including Voting_System, reveal permissions, issue management permissions, auto-reveal, and countdown settings
- **Reveal_Permission**: A configuration option that determines who can trigger card reveal — moderator only, all players, or a selected subset of participants
- **Issue_Permission**: A configuration option that determines who can add or edit stories — moderator only, all players, or a selected subset of participants
- **Auto_Reveal**: A configuration option that, when enabled, automatically reveals cards when all participants in the Game_Session have completed voting
- **Countdown_Animation**: A visual countdown displayed before cards are revealed, providing a brief anticipation period
- **Voting_Timer**: A timer that tracks and displays the total time taken to complete voting on each story from round start to reveal
- **Auth_Service**: The backend service responsible for user authentication, session token management, and role assignment
- **WebSocket_Handler**: The backend component that manages WebSocket connections, routes events to the correct Game_Session, and broadcasts state changes within session scope

## Requirements

### Requirement 1: Game Session Creation

**User Story:** As a moderator, I want to create a new game session, so that my team has an isolated space to run estimation rounds without interfering with other teams.

#### Acceptance Criteria

1. WHEN a Moderator selects the option to create a new Game_Session, THE Session_Registry SHALL generate a unique Session_ID and create a new Game_Session associated with that Session_ID
2. THE Session_Registry SHALL ensure each generated Session_ID is unique across all active Game_Sessions
3. WHEN a Game_Session is created, THE Session_Registry SHALL assign the creating Moderator as the owner of the Game_Session
4. WHEN a Game_Session is created, THE Application SHALL redirect the Moderator to the Game_Session page at the path `/session/{sessionId}`
5. THE Session_Registry SHALL store each Game_Session in memory with its own isolated participant list, voting round state, history, and configuration

### Requirement 2: Shareable Session Link

**User Story:** As a moderator, I want to get a shareable link for my game session, so that I can invite participants to join my specific session.

#### Acceptance Criteria

1. WHEN a Game_Session is created, THE Application SHALL generate a Session_Link in the format `/session/{sessionId}` using the generated Session_ID as the path parameter
2. WHEN a Moderator views the Game_Session page, THE Application SHALL display the full Session_Link URL and provide a copy-to-clipboard button
3. WHEN a Moderator clicks the copy-to-clipboard button, THE Application SHALL copy the full Session_Link URL to the system clipboard and display a confirmation Toast_Notification
4. THE Application SHALL construct the full Session_Link URL using the current browser origin combined with the `/session/{sessionId}` path

### Requirement 3: QR Code Generation

**User Story:** As a moderator, I want a QR code for the session URL, so that participants in the same room can quickly join by scanning it with their phones.

#### Acceptance Criteria

1. WHEN a Game_Session is created, THE Application SHALL generate a Session_QR_Code encoding the full Session_Link URL
2. WHEN a Moderator views the Game_Session page, THE Application SHALL display the Session_QR_Code in a visible area alongside the Session_Link
3. THE Application SHALL render the Session_QR_Code at a minimum size of 150x150 CSS pixels to ensure scannability
4. WHEN the Session_Link URL changes (e.g., due to origin change), THE Application SHALL regenerate the Session_QR_Code to reflect the updated URL
5. THE Application SHALL provide an accessible text alternative for the Session_QR_Code that describes its purpose and includes the Session_Link URL

### Requirement 4: Participant Login via Session Link

**User Story:** As a participant, I want to click a shared session link and be placed into the correct game session after logging in, so that I do not have to manually find or enter a session code.

#### Acceptance Criteria

1. WHEN a User navigates to a Session_Link URL (`/session/{sessionId}`), THE Application SHALL check whether the User has an active authenticated session
2. WHILE a User does not have an active authenticated session and navigates to a Session_Link, THE Application SHALL redirect the User to the login page while preserving the Session_ID
3. WHEN a User completes login after being redirected from a Session_Link, THE Application SHALL automatically redirect the User to the Game_Session page for the preserved Session_ID
4. WHILE a User has an active authenticated session and navigates to a Session_Link, THE Application SHALL place the User directly into the Game_Session identified by the Session_ID
5. IF a User navigates to a Session_Link with a Session_ID that does not correspond to an active Game_Session, THEN THE Application SHALL display an error message indicating the session does not exist or has ended

### Requirement 5: Session Isolation

**User Story:** As a user, I want my team's session to be completely isolated from other teams' sessions, so that our votes, stories, and participants do not leak across sessions.

#### Acceptance Criteria

1. THE Session_Registry SHALL maintain each Game_Session with an independent participant list that is not shared with other Game_Sessions
2. THE Session_Registry SHALL maintain each Game_Session with an independent voting round state, so that starting, voting, revealing, and clearing in one Game_Session does not affect other Game_Sessions
3. THE Session_Registry SHALL maintain each Game_Session with an independent session history that is not visible to users in other Game_Sessions
4. THE WebSocket_Handler SHALL route all WebSocket events (card selections, reveals, board clears, participant joins/leaves) only to clients connected to the same Game_Session
5. WHEN a User is connected to a Game_Session, THE WebSocket_Handler SHALL broadcast events from that Game_Session only to participants within that same Game_Session

### Requirement 6: Parallel Session Support

**User Story:** As an organization, I want multiple teams to run estimation sessions simultaneously on the same application instance, so that we do not need separate deployments for each team.

#### Acceptance Criteria

1. THE Session_Registry SHALL support creating and maintaining multiple active Game_Sessions concurrently
2. WHILE multiple Game_Sessions are active, THE Application SHALL process events for each Game_Session independently without blocking or delaying events in other Game_Sessions
3. WHILE multiple Game_Sessions are active, THE Session_Registry SHALL allocate separate in-memory state for each Game_Session to prevent cross-session data corruption

### Requirement 7: Voting System Selection

**User Story:** As a moderator, I want to choose a voting system when creating or configuring a session, so that my team can use the estimation scale that best fits our workflow.

#### Acceptance Criteria

1. WHEN a Moderator creates a new Game_Session, THE Application SHALL display a Voting_System selection with the following options: Fibonacci_System, Modified_Fibonacci_System, T_Shirt_System, and Power_Of_2_System
2. THE Application SHALL use the Fibonacci_System as the default Voting_System when no selection is made
3. WHEN a Moderator selects the Fibonacci_System, THE Game_Session SHALL use card values 0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89
4. WHEN a Moderator selects the Modified_Fibonacci_System, THE Game_Session SHALL use card values 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100
5. WHEN a Moderator selects the T_Shirt_System, THE Game_Session SHALL use card values XS, S, M, L, XL, XXL
6. WHEN a Moderator selects the Power_Of_2_System, THE Game_Session SHALL use card values 0, 1, 2, 4, 8, 16, 32, 64
7. WHEN a Voting_System is selected, THE Application SHALL display only the card values belonging to the selected Voting_System in the Card_Deck (plus any applicable special cards)
8. THE Session_Configuration SHALL store the selected Voting_System and apply it consistently for all voting rounds within the Game_Session

### Requirement 8: Card Reveal Permission Configuration

**User Story:** As a moderator, I want to configure who can reveal cards, so that I can control the reveal process based on my team's preferences.

#### Acceptance Criteria

1. WHEN a Moderator creates or configures a Game_Session, THE Application SHALL display a Reveal_Permission setting with options: "Moderator only", "All players", and "Select specific participants"
2. THE Application SHALL use "Moderator only" as the default Reveal_Permission
3. WHILE the Reveal_Permission is set to "Moderator only", THE Application SHALL enable the "Reveal Cards" button only for users with the Moderator role
4. WHILE the Reveal_Permission is set to "All players", THE Application SHALL enable the "Reveal Cards" button for all participants in the Game_Session
5. WHILE the Reveal_Permission is set to "Select specific participants", THE Application SHALL enable the "Reveal Cards" button only for the Moderator and the specifically selected participants
6. WHEN a Moderator selects "Select specific participants", THE Application SHALL display a list of current participants with checkboxes to grant reveal permission

### Requirement 9: Issue Management Permission Configuration

**User Story:** As a moderator, I want to configure who can add and edit stories, so that I can allow team members to contribute stories or restrict it to moderators.

#### Acceptance Criteria

1. WHEN a Moderator creates or configures a Game_Session, THE Application SHALL display an Issue_Permission setting with options: "Moderator only", "All players", and "Select specific participants"
2. THE Application SHALL use "Moderator only" as the default Issue_Permission
3. WHILE the Issue_Permission is set to "Moderator only", THE Application SHALL enable story submission controls only for users with the Moderator role
4. WHILE the Issue_Permission is set to "All players", THE Application SHALL enable story submission controls for all participants in the Game_Session
5. WHILE the Issue_Permission is set to "Select specific participants", THE Application SHALL enable story submission controls only for the Moderator and the specifically selected participants
6. WHEN a Moderator selects "Select specific participants", THE Application SHALL display a list of current participants with checkboxes to grant issue management permission

### Requirement 10: Auto-Reveal Configuration

**User Story:** As a moderator, I want to enable automatic card reveal when all participants have voted, so that the team does not have to wait for a manual reveal action.

#### Acceptance Criteria

1. WHEN a Moderator creates or configures a Game_Session, THE Application SHALL display an Auto_Reveal toggle option
2. THE Application SHALL disable Auto_Reveal by default
3. WHILE Auto_Reveal is enabled and all participants in the Game_Session have submitted a Card_Selection for the current voting round, THE Session_Registry SHALL automatically trigger a card reveal event within 2 seconds of the last vote
4. WHILE Auto_Reveal is enabled, THE Application SHALL still allow manual card reveal via the "Reveal Cards" button before all participants have voted
5. WHILE Auto_Reveal is disabled, THE Application SHALL require manual card reveal via the "Reveal Cards" button regardless of how many participants have voted

### Requirement 11: Countdown Animation Before Reveal

**User Story:** As a user, I want to see a countdown animation before cards are revealed, so that there is a brief moment of anticipation and all participants are prepared for the reveal.

#### Acceptance Criteria

1. WHEN a Moderator creates or configures a Game_Session, THE Application SHALL display a Countdown_Animation toggle option
2. THE Application SHALL disable Countdown_Animation by default
3. WHILE Countdown_Animation is enabled and a card reveal is triggered, THE Application SHALL display a visible countdown (e.g., 3, 2, 1) before revealing the cards
4. THE Countdown_Animation SHALL complete within 3 seconds before the card reveal occurs
5. WHEN a User has enabled reduced-motion preferences in their operating system, THE Application SHALL display the countdown as static number changes without motion effects
6. WHILE Countdown_Animation is disabled, THE Application SHALL reveal cards immediately upon the reveal trigger without a countdown

### Requirement 12: Voting Timer Display

**User Story:** As a moderator, I want to see how long each voting round takes, so that I can track estimation efficiency and identify stories that need more discussion.

#### Acceptance Criteria

1. WHEN a new voting round starts in a Game_Session, THE Application SHALL start a Voting_Timer that tracks elapsed time from the round start
2. WHILE a voting round is active, THE Application SHALL display the Voting_Timer as a running clock visible to all participants in the Game_Session
3. WHEN cards are revealed, THE Application SHALL stop the Voting_Timer and display the total elapsed voting time
4. WHEN the board is cleared, THE Application SHALL include the total voting time in the history entry for the completed round
5. THE Application SHALL display the Voting_Timer in a human-readable format (minutes and seconds)

### Requirement 13: Session Creation Page and Navigation

**User Story:** As a user, I want a clear entry point to create or join sessions, so that I can navigate the multi-session application easily.

#### Acceptance Criteria

1. WHEN a Moderator logs in without a Session_Link, THE Application SHALL display a session creation page with options to create a new Game_Session
2. THE Application SHALL provide a session creation form that includes all Session_Configuration options (Voting_System, Reveal_Permission, Issue_Permission, Auto_Reveal, Countdown_Animation)
3. WHEN a Moderator submits the session creation form, THE Application SHALL create the Game_Session with the specified configuration and redirect to the Game_Session page
4. THE Application SHALL add a route at `/session/{sessionId}` that loads the Game_Session page for the specified Session_ID
5. IF a User navigates to the root path without an active session context, THEN THE Application SHALL redirect to the login page

### Requirement 14: Session Configuration Persistence and Updates

**User Story:** As a moderator, I want to update session configuration during an active session, so that I can adjust settings based on team feedback without creating a new session.

#### Acceptance Criteria

1. WHEN a Moderator opens the session settings within an active Game_Session, THE Application SHALL display the current Session_Configuration values
2. WHEN a Moderator updates a Session_Configuration option, THE Session_Registry SHALL apply the change to the Game_Session and broadcast the updated configuration to all connected participants within 2 seconds
3. WHEN the Voting_System is changed during an active Game_Session, THE Application SHALL update the Card_Deck for all participants to reflect the new Voting_System
4. IF a Moderator changes the Voting_System while a voting round is active, THEN THE Application SHALL display a warning indicating that changing the Voting_System during an active round may invalidate existing votes
5. THE Session_Registry SHALL store all Session_Configuration changes in the Game_Session state for the duration of the session

### Requirement 15: WebSocket Session Routing

**User Story:** As a developer, I want WebSocket connections to be routed to the correct game session, so that real-time events are scoped to the appropriate session.

#### Acceptance Criteria

1. WHEN a User establishes a WebSocket connection, THE WebSocket_Handler SHALL associate the connection with the Game_Session identified by the Session_ID provided during connection
2. THE WebSocket_Handler SHALL include the Session_ID as a parameter in the WebSocket connection handshake (e.g., as a query parameter)
3. IF a WebSocket connection specifies a Session_ID that does not correspond to an active Game_Session, THEN THE WebSocket_Handler SHALL reject the connection with an appropriate error code
4. WHEN a WebSocket event is received, THE WebSocket_Handler SHALL route the event to the Session_Registry for processing within the scope of the associated Game_Session
5. WHEN the Session_Registry broadcasts an event, THE WebSocket_Handler SHALL deliver the event only to WebSocket connections associated with the same Game_Session

### Requirement 16: Session Lifecycle Management

**User Story:** As a system administrator, I want inactive sessions to be cleaned up automatically, so that the application does not accumulate stale sessions in memory.

#### Acceptance Criteria

1. WHEN all participants disconnect from a Game_Session and no participants reconnect within 30 minutes, THE Session_Registry SHALL mark the Game_Session as inactive
2. WHEN a Game_Session is marked as inactive, THE Session_Registry SHALL remove the Game_Session and its associated state from memory
3. IF a User attempts to join a Game_Session that has been removed, THEN THE Application SHALL display an error message indicating the session has ended
4. THE Session_Registry SHALL log the creation and removal of Game_Sessions for operational monitoring

