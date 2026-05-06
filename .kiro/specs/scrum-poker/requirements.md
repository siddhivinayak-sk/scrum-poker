# Requirements Document

## Introduction

Scrum Poker (also known as Planning Poker) is a consensus-based estimation technique used by Agile teams to estimate the effort or complexity of user stories. This document defines the requirements for a web-based Scrum Poker application that enables distributed and co-located teams to conduct real-time estimation sessions. The application uses a Node.js backend and Angular frontend, packaged in Docker and deployed to Kubernetes. The core workflow follows standard Planning Poker conventions: a Moderator presents a story, all Participants simultaneously select estimation cards (hidden from others), the Moderator reveals all cards at once to prevent anchoring bias, the team reviews metrics and discusses outliers, and the Moderator then clears the board for the next story. A session history sidebar allows the Moderator to review past estimations at any time.

## Glossary

- **Application**: The Scrum Poker web application system as a whole
- **Auth_Service**: The backend service responsible for user authentication, session token management, and role assignment
- **Session_Manager**: The backend component that manages poker estimation sessions, including story lifecycle, card state, and participant tracking
- **Card_Deck**: The set of estimation cards displayed to each Participant, consisting of Fibonacci-like numeric values (0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89) and special cards (Coffee, No Clue, Break)
- **Moderator**: A user role with elevated privileges to manage estimation sessions, including adding stories, revealing cards, clearing the board, and managing session history
- **Participant**: A user role that can view stories and select estimation cards during a voting round
- **User**: Any person who accesses the Application, either as a Moderator or a Participant
- **Story**: A user story or work item presented by the Moderator for estimation by the team
- **Voting_Round**: A single estimation cycle for one Story, starting when the Moderator presents the Story and ending when cards are revealed
- **Card_Selection**: The act of a Participant choosing one card from the Card_Deck during a Voting_Round
- **Board**: The shared visual area displaying all Participant cards (face-down or face-up) during a Voting_Round
- **Metrics_Engine**: The component that calculates estimation statistics after cards are revealed, including average, mode, card value distribution, and consensus indicators
- **Session_History**: A vertical sidebar widget that stores all completed Voting_Round results for the current session, allowing the Moderator to review past estimations
- **Card_Flip_Animation**: The CSS/JavaScript animation that visually transitions a card from face-down (hidden) to face-up (revealed) state
- **Anonymous_User**: A User who accesses the Application without providing a registered username, identified by a display name only
- **Registered_User**: A User who logs in with a username credential
- **Theme**: The visual design system of the Application, including color palette, gradients, backgrounds, typography, and spacing that create a cohesive professional appearance
- **Card_Selection_Animation**: The CSS/JavaScript animation that visually elevates and highlights a card when a Participant selects it from the Card_Deck
- **User_Menu**: A dropdown menu accessible from a user avatar icon on the Scrum Poker page, providing options for role switching and logout
- **Board_Clear_Animation**: The CSS/JavaScript animation that visually transitions cards and vote indicators off the Board when the Moderator clears the board
- **Toast_Notification**: A temporary, non-blocking notification message displayed to the User to communicate success, warning, or error states
- **Special_Card_Label**: A descriptive text label displayed below or beside a special card icon to clarify the card meaning (Coffee for ☕, Unknown for ?, Break for ⏸)

## Requirements

### Requirement 1: User Authentication — Username Login

**User Story:** As a registered user, I want to log in with my username, so that I can be identified across sessions and tabs.

#### Acceptance Criteria

1. WHEN a User navigates to the login page, THE Auth_Service SHALL display a login form with a username input field and a submit button
2. WHEN a User submits a valid username, THE Auth_Service SHALL authenticate the User and redirect to the Scrum Poker page
3. WHEN a User submits an empty username, THE Auth_Service SHALL display a validation error message indicating that a username is required
4. THE Auth_Service SHALL assign the Participant role as the default role for newly authenticated Users

### Requirement 2: User Authentication — Anonymous Login

**User Story:** As a guest user, I want to join a session anonymously with a display name, so that I can participate without creating an account.

#### Acceptance Criteria

1. WHEN a User selects the anonymous login option, THE Auth_Service SHALL display a display name input field
2. WHEN a User submits a valid display name for anonymous login, THE Auth_Service SHALL create an Anonymous_User session and redirect to the Scrum Poker page
3. WHEN a User submits an empty display name for anonymous login, THE Auth_Service SHALL display a validation error message indicating that a display name is required
4. THE Auth_Service SHALL assign the Participant role as the default role for Anonymous_Users

### Requirement 3: Cross-Tab Session Persistence

**User Story:** As a logged-in user, I want my session to persist across browser tabs, so that I do not need to log in again when opening the application in a new tab.

#### Acceptance Criteria

1. WHILE a User has an active session, THE Auth_Service SHALL reuse the existing session when the Application is opened in a new browser tab
2. WHILE a User has an active session in another tab, THE Auth_Service SHALL bypass the login page and redirect directly to the Scrum Poker page
3. WHEN a User logs out in one tab, THE Auth_Service SHALL invalidate the session across all open tabs within 5 seconds

### Requirement 4: User Role Management

**User Story:** As a user, I want to switch between Moderator and Participant roles from the User_Menu, so that I can take on different responsibilities during a session.

#### Acceptance Criteria

1. THE Application SHALL provide a user profile section accessible from the User_Menu on the Scrum Poker page
2. WHEN a User opens the User_Menu, THE Application SHALL display the current role (Moderator or Participant) and an option to switch roles
3. WHEN a User changes their role to Moderator, THE Application SHALL immediately grant Moderator privileges to the User
4. WHEN a User changes their role to Participant, THE Application SHALL immediately revoke Moderator privileges from the User
5. WHEN a User changes their role, THE Application SHALL broadcast the role change to all connected Users within 2 seconds

### Requirement 5: Card Deck Display

**User Story:** As a participant, I want to see a set of estimation cards with Fibonacci-like values and special cards, so that I can select an appropriate estimate for each story.

#### Acceptance Criteria

1. WHEN a Voting_Round is active, THE Application SHALL display the Card_Deck containing numeric cards with values 0, 1, 2, 3, 5, 8, 13, 21, 34, 55, and 89
2. WHEN a Voting_Round is active, THE Application SHALL display special cards for Coffee, No Clue (?), and Break alongside the numeric cards
3. THE Application SHALL render each card in the Card_Deck as a distinct, tappable visual element with the card value clearly visible
4. WHILE no Voting_Round is active, THE Application SHALL display the Card_Deck in a disabled state

### Requirement 6: Participant Card Display on the Board

**User Story:** As a user, I want to see a card placeholder for each participant on the board, so that I know who has and has not voted.

#### Acceptance Criteria

1. WHILE a Voting_Round is active, THE Board SHALL display one card placeholder for each connected Participant
2. WHILE a Voting_Round is active and cards have not been revealed, THE Board SHALL display each Participant card in a face-down state showing only the Participant display name
3. WHEN a Participant makes a Card_Selection, THE Board SHALL update that Participant card placeholder to indicate a vote has been cast without revealing the selected value
4. THE Board SHALL display Participant cards in a consistent grid or row layout that accommodates varying numbers of Participants

### Requirement 7: Story Management by Moderator

**User Story:** As a moderator, I want to add a story description to start a voting round, so that participants know what they are estimating.

#### Acceptance Criteria

1. THE Application SHALL provide the Moderator with a text input area to enter a Story description
2. WHEN the Moderator submits a Story description, THE Session_Manager SHALL start a new Voting_Round and broadcast the Story description to all connected Users within 2 seconds
3. WHEN a new Voting_Round starts, THE Application SHALL display the Story description prominently above the Board
4. IF the Moderator submits an empty Story description, THEN THE Application SHALL display a validation error indicating that a Story description is required

### Requirement 8: Card Selection by Participants

**User Story:** As a participant, I want to select a card to provide my estimate for the current story, so that my vote is recorded.

#### Acceptance Criteria

1. WHEN a Participant selects a card from the Card_Deck during an active Voting_Round, THE Application SHALL record the Card_Selection and visually highlight the selected card
2. WHEN a Participant selects a different card after an initial selection, THE Application SHALL replace the previous Card_Selection with the new selection
3. WHILE a Voting_Round is active and cards have not been revealed, THE Application SHALL keep all Card_Selections hidden from other Users
4. THE Application SHALL transmit each Card_Selection to the Session_Manager within 1 second of selection

### Requirement 9: Card Reveal by Moderator

**User Story:** As a moderator, I want to reveal all participant cards simultaneously, so that the team can see everyone's estimates without anchoring bias.

#### Acceptance Criteria

1. THE Application SHALL provide the Moderator with a "Reveal Cards" button that is enabled only during an active Voting_Round
2. WHEN the Moderator presses the "Reveal Cards" button, THE Session_Manager SHALL broadcast a reveal event to all connected Users within 1 second
3. WHEN a reveal event is received, THE Board SHALL transition all Participant cards from face-down to face-up state, displaying the selected card value for each Participant
4. WHEN a reveal event is received and a Participant has not made a Card_Selection, THE Board SHALL display that Participant card as "No Vote"

### Requirement 10: Card Flip Animation

**User Story:** As a user, I want to see a smooth flip animation when cards are revealed, so that the reveal feels engaging and visually clear.

#### Acceptance Criteria

1. WHEN a reveal event is received, THE Application SHALL play a Card_Flip_Animation that visually rotates each card from face-down to face-up
2. THE Card_Flip_Animation SHALL complete within 600 milliseconds per card
3. THE Card_Flip_Animation SHALL use a 3D rotation effect along the vertical axis to simulate a physical card flip
4. WHEN a User has enabled reduced-motion preferences in their operating system, THE Application SHALL skip the Card_Flip_Animation and display card values immediately

### Requirement 11: Voting Metrics Calculation

**User Story:** As a moderator, I want to see estimation metrics after cards are revealed, so that I can facilitate discussion and identify consensus or outliers.

#### Acceptance Criteria

1. WHEN cards are revealed, THE Metrics_Engine SHALL calculate and display the average of all numeric Card_Selections (excluding special cards)
2. WHEN cards are revealed, THE Metrics_Engine SHALL calculate and display the count of each unique card value selected by Participants
3. WHEN cards are revealed, THE Metrics_Engine SHALL calculate and display the mode (most frequently selected value) of all numeric Card_Selections
4. WHEN cards are revealed, THE Metrics_Engine SHALL calculate and display the spread (difference between the highest and lowest numeric Card_Selections)
5. WHEN cards are revealed, THE Metrics_Engine SHALL identify and visually highlight outlier votes that differ from the mode by more than two Fibonacci steps
6. WHEN fewer than two Participants have made numeric Card_Selections, THE Metrics_Engine SHALL display a message indicating insufficient data for meaningful metrics

### Requirement 12: Board Reset by Moderator

**User Story:** As a moderator, I want to clear the board after a voting round, so that I can start estimating the next story.

#### Acceptance Criteria

1. THE Application SHALL provide the Moderator with a "Clear Board" button that is enabled only after cards have been revealed
2. WHEN the Moderator presses the "Clear Board" button, THE Session_Manager SHALL save the completed Voting_Round results to the Session_History
3. WHEN the Moderator presses the "Clear Board" button, THE Session_Manager SHALL reset all Card_Selections, clear the Story description, and return the Board to its initial state
4. WHEN the Board is reset, THE Application SHALL broadcast the reset event to all connected Users within 1 second

### Requirement 13: Session History Sidebar

**User Story:** As a moderator, I want to see a history of all estimated stories in a sidebar, so that I can review past results at any time during the session.

#### Acceptance Criteria

1. THE Application SHALL display a Session_History sidebar as a vertical bar-styled widget on the Scrum Poker page
2. THE Session_History sidebar SHALL list each completed Voting_Round with the Story description, final average estimate, and the mode value
3. WHEN a new Voting_Round is completed and saved, THE Session_History sidebar SHALL prepend the new entry to the top of the list within 1 second
4. WHEN the Moderator selects an entry in the Session_History sidebar, THE Application SHALL display the full voting details including individual Participant votes and all metrics for that Voting_Round
5. THE Session_History sidebar SHALL persist all entries for the duration of the current session

### Requirement 14: Session History Management

**User Story:** As a moderator, I want to clear the session history or keep it for the next session, so that I can manage estimation data between sessions.

#### Acceptance Criteria

1. THE Application SHALL provide the Moderator with a "Clear History" button within the Session_History sidebar
2. WHEN the Moderator presses the "Clear History" button, THE Application SHALL display a confirmation dialog before proceeding
3. WHEN the Moderator confirms the clear action, THE Session_Manager SHALL remove all entries from the Session_History
4. WHILE the Moderator does not clear the Session_History, THE Application SHALL retain all Session_History entries until the Moderator explicitly clears the history or the browser session ends

### Requirement 15: Real-Time Communication

**User Story:** As a user, I want all actions (card selections, reveals, board resets) to be reflected in real time for all participants, so that the estimation session feels synchronous.

#### Acceptance Criteria

1. THE Application SHALL use WebSocket connections to enable real-time bidirectional communication between the frontend and the backend
2. WHEN a User connects to a session, THE Session_Manager SHALL register the User and broadcast the updated participant list to all connected Users within 2 seconds
3. WHEN a User disconnects from a session, THE Session_Manager SHALL remove the User from the active participant list and broadcast the updated list to all connected Users within 5 seconds
4. IF a WebSocket connection is lost, THEN THE Application SHALL attempt to reconnect automatically with exponential backoff, starting at 1 second and capping at 30 seconds
5. WHEN a WebSocket reconnection succeeds, THE Application SHALL synchronize the current session state (active Story, Card_Selections, Board state) from the Session_Manager

### Requirement 16: Responsive Design

**User Story:** As a user, I want the application to render correctly on desktops, tablets, and mobile devices, so that I can participate in estimation sessions from any device.

#### Acceptance Criteria

1. THE Application SHALL render the Scrum Poker page correctly on viewport widths from 320px to 2560px
2. WHILE the viewport width is less than 768px, THE Application SHALL reflow the Card_Deck into a scrollable horizontal strip or a wrapped grid layout that fits the screen width
3. WHILE the viewport width is less than 768px, THE Application SHALL collapse the Session_History sidebar into an expandable overlay or bottom sheet
4. THE Application SHALL use touch-friendly tap targets with a minimum size of 44x44 CSS pixels for all interactive elements
5. THE Application SHALL render correctly on the latest versions of Chrome, Firefox, Safari, and Edge browsers

### Requirement 17: Docker Containerization

**User Story:** As a DevOps engineer, I want the application packaged in a Docker container, so that it can be deployed consistently across environments.

#### Acceptance Criteria

1. THE Application SHALL provide a Dockerfile that builds both the Node.js backend and the Angular frontend into a single container image
2. WHEN the Docker image is built, THE Application SHALL produce a container that serves the Angular frontend and runs the Node.js backend on a single configurable port
3. THE Application SHALL use a multi-stage Docker build to minimize the final image size
4. THE Application SHALL not include development dependencies, source maps, or test files in the final Docker image

### Requirement 18: Kubernetes Deployment

**User Story:** As a DevOps engineer, I want the application deployed to Kubernetes and exposed on port 80, so that it is accessible to users via a standard HTTP port.

#### Acceptance Criteria

1. THE Application SHALL provide Kubernetes manifest files for Deployment and Service resources
2. THE Kubernetes Service SHALL expose the Application on port 80 using a ClusterIP or LoadBalancer service type
3. THE Kubernetes Deployment SHALL define resource requests and limits for CPU and memory
4. THE Kubernetes Deployment SHALL configure a readiness probe and a liveness probe for the Application container

### Requirement 19: Accessibility Compliance

**User Story:** As a user with accessibility needs, I want the application to be usable with assistive technologies, so that I can participate in estimation sessions regardless of ability.

#### Acceptance Criteria

1. THE Application SHALL provide ARIA labels for all interactive elements including cards, buttons, and form inputs
2. THE Application SHALL support full keyboard navigation, allowing Users to select cards, submit stories, and trigger actions using only the keyboard
3. WHEN a card state changes (selected, revealed, reset), THE Application SHALL announce the state change to screen readers using ARIA live regions
4. THE Application SHALL maintain a minimum color contrast ratio of 4.5:1 for all text content as defined by WCAG 2.1 Level AA


### Requirement 20: Professional Visual Design and Theme

**User Story:** As a user, I want the application to have a polished, colorful, and professional visual design, so that the experience feels modern and visually engaging rather than plain or monotonous.

#### Acceptance Criteria

1. THE Application SHALL apply a cohesive color Theme across all pages, including the login page, the Scrum Poker page, the Session_History sidebar, and all modal dialogs
2. THE Application SHALL render the Scrum Poker page with a visually rich background using a gradient, pattern, or background image that replaces the default plain white background
3. THE Application SHALL style all section containers (Card_Deck area, Board area, Metrics area, Story input area) with distinct background colors, rounded corners, and subtle shadow or border treatments to create visual separation
4. THE Application SHALL use a consistent color palette of at least three complementary colors for primary actions, secondary elements, and accent highlights throughout the interface
5. THE Application SHALL style all buttons with colored backgrounds, hover state transitions, and active state feedback that align with the Theme color palette
6. THE Application SHALL apply the Theme consistently to the login page, including styled input fields, a visually prominent submit button, and a branded header or logo area
7. WHEN a User has enabled reduced-motion preferences in their operating system, THE Application SHALL still apply the full color Theme and visual styling without motion-based effects

### Requirement 21: Card Styling and Visual States

**User Story:** As a participant, I want the estimation cards to look polished and visually distinct in both selected and unselected states, so that I can clearly see which card I have chosen.

#### Acceptance Criteria

1. THE Application SHALL render each unselected card in the Card_Deck with a colored border, a gradient or solid background fill, rounded corners, and a subtle shadow to create a three-dimensional appearance
2. THE Application SHALL render each selected card in the Card_Deck with a visually distinct style including a different background color or gradient, a prominent border highlight, and an elevated shadow compared to unselected cards
3. THE Application SHALL apply a color-coding scheme to numeric cards where lower values use cooler tones (blues, greens) and higher values use warmer tones (oranges, reds) to provide a visual scale indicator
4. THE Application SHALL render special cards (Coffee, No Clue, Break) with unique accent colors that distinguish the special cards from numeric cards
5. WHEN a User hovers over an unselected card, THE Application SHALL display a hover effect including a slight elevation change and border color shift within 100 milliseconds
6. THE Application SHALL maintain a minimum color contrast ratio of 4.5:1 between card text and card background for all card states (unselected, selected, hovered, disabled)

### Requirement 22: Card Selection Animation

**User Story:** As a participant, I want my selected card to animate upward prominently with a smooth effect, so that the selection feels responsive and visually clear.

#### Acceptance Criteria

1. WHEN a Participant selects a card from the Card_Deck, THE Application SHALL play a Card_Selection_Animation that translates the card upward by at least 20 pixels from its resting position
2. THE Card_Selection_Animation SHALL complete within 300 milliseconds using an ease-out timing function
3. WHEN a Participant selects a different card, THE Application SHALL animate the previously selected card back to its resting position and animate the newly selected card upward simultaneously
4. THE Card_Selection_Animation SHALL include a scale increase of at least 5 percent to emphasize the selected card
5. WHEN a User has enabled reduced-motion preferences in their operating system, THE Application SHALL skip the Card_Selection_Animation and apply the selected visual state immediately without motion

### Requirement 23: User Menu with Avatar and Logout

**User Story:** As a user, I want to access role switching and logout from a compact user menu behind an avatar icon, so that the interface is clean and the controls are organized.

#### Acceptance Criteria

1. THE Application SHALL display a User avatar icon in the header area of the Scrum Poker page, showing the first letter of the User display name inside a colored circle
2. WHEN a User clicks the User avatar icon, THE Application SHALL display a User_Menu dropdown containing the User display name, the current role label, a role switch option, and a logout option
3. WHEN a User clicks outside the User_Menu or presses the Escape key, THE Application SHALL close the User_Menu dropdown
4. WHEN a User selects the role switch option from the User_Menu, THE Application SHALL toggle the User role between Moderator and Participant and broadcast the change to all connected Users within 2 seconds
5. WHEN a User selects the logout option from the User_Menu, THE Auth_Service SHALL invalidate the session and redirect the User to the login page
6. THE User_Menu SHALL be accessible via keyboard navigation, allowing Users to open the menu with Enter or Space, navigate options with arrow keys, and select an option with Enter
7. THE Application SHALL provide ARIA labels for the User avatar button and all User_Menu options to support screen reader Users

### Requirement 24: Board Clear Animation

**User Story:** As a user, I want to see a smooth animation when the board is cleared, so that the transition between voting rounds feels polished rather than abrupt.

#### Acceptance Criteria

1. WHEN the Moderator clears the Board, THE Application SHALL play a Board_Clear_Animation that transitions all revealed cards and vote indicators off the Board before resetting to the initial state
2. THE Board_Clear_Animation SHALL animate each card with a fade-out and downward slide effect over a duration of 400 milliseconds
3. THE Board_Clear_Animation SHALL stagger the animation start time for each card by 50 milliseconds to create a sequential sweep effect across the Board
4. WHEN the Board_Clear_Animation completes, THE Application SHALL display the Board in its initial empty state ready for the next Voting_Round
5. WHEN a User has enabled reduced-motion preferences in their operating system, THE Application SHALL skip the Board_Clear_Animation and reset the Board to its initial state immediately

### Requirement 25: User-Facing Error Notifications

**User Story:** As a user, I want to see clear error messages when something goes wrong, so that I understand what happened and can take corrective action.

#### Acceptance Criteria

1. WHEN a WebSocket connection fails or is lost, THE Application SHALL display a Toast_Notification with a descriptive error message indicating the connection issue and the reconnection status
2. WHEN a Card_Selection transmission fails, THE Application SHALL display a Toast_Notification informing the Participant that the vote was not recorded and suggesting a retry
3. WHEN an authentication request fails (login or session validation), THE Application SHALL display a Toast_Notification with a descriptive error message indicating the authentication failure reason
4. WHEN the Session_Manager returns an error event for an unauthorized action, THE Application SHALL display a Toast_Notification informing the User that the action is not permitted for the current role
5. THE Application SHALL display each Toast_Notification for 5 seconds before automatically dismissing the notification, with an option for the User to dismiss the notification manually before the timeout
6. THE Application SHALL position Toast_Notifications in a fixed location (top-right corner of the viewport) and stack multiple notifications vertically with a maximum of 3 visible notifications at one time
7. THE Application SHALL style error Toast_Notifications with a red accent color, warning Toast_Notifications with an amber accent color, and informational Toast_Notifications with a blue accent color
8. THE Application SHALL provide ARIA live region announcements for each Toast_Notification so that screen reader Users are informed of error and status messages

### Requirement 26: Special Card Labels

**User Story:** As a participant, I want to see descriptive text labels on the special cards, so that I understand what each special card icon means without guessing.

#### Acceptance Criteria

1. THE Application SHALL display the text label "Coffee" below or beside the ☕ icon on the Coffee special card
2. THE Application SHALL display the text label "Unknown" below or beside the ? icon on the No Clue special card
3. THE Application SHALL display the text label "Break" below or beside the ⏸ icon on the Break special card
4. THE Application SHALL render each Special_Card_Label in a font size that is readable but smaller than the card icon to maintain visual hierarchy
5. THE Application SHALL include the Special_Card_Label text in the ARIA label for each special card to support screen reader Users
