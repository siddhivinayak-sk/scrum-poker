# Requirements Document

## Introduction

This feature adds a "Participant Feelings" strip to the retrospective board toolbar. The feelings strip displays emoji icons on the right side of the board top bar, enclosed in a golden/yellow bordered container labelled "Your feeling". Participants express their current mood by selecting an emoji. The moderator configures which emoji categories are available via board settings. An additional moderator-only icon opens a popup showing all participants' feelings, with a screenshot capability for sharing.

## Glossary

- **Feelings_Strip**: A UI component displayed on the right side of the retro board toolbar, with a golden/yellow border, containing the label "Your feeling" and a row of selectable emoji icons.
- **Feeling_Emoji**: An individual emoji icon within the Feelings_Strip representing a specific mood category (e.g., 😊 for Happy, 😠 for Mad).
- **Feeling_Category**: A named mood classification mapped to a specific emoji. Available categories: Satisfaction, Frustration, Confidence, Confusion, Boredom, Happy, No_Feeling, Glad, Sad, Mad.
- **Participant_Feeling**: A record associating a participant's user ID with their selected Feeling_Category.
- **Feelings_Summary_Popup**: A dialog accessible only to the moderator that lists all participants and their currently selected feeling.
- **Retro_Board**: The existing retrospective board component where participants collaborate with cards, columns, and votes.
- **Moderator**: The user who created the retrospective session or has been assigned the moderator role.
- **Participant**: Any user connected to the retro session, including the moderator.
- **RetroConfiguration**: The existing shared configuration type for retrospective board settings, stored in `shared/types.ts`.

## Requirements

### Requirement 1: Feelings Configuration in Board Settings

**User Story:** As a moderator, I want to configure which feeling emojis are available on the board, so that I can tailor the mood options to fit my team's retrospective.

#### Acceptance Criteria

1. THE RetroConfiguration SHALL include an `allowedFeelings` property containing an ordered list of Feeling_Category identifiers with a minimum of 1 and a maximum of 10 entries.
2. WHEN a moderator creates a new retro board, THE System SHALL set the default `allowedFeelings` to `["Happy", "Sad", "No_Feeling"]`.
3. WHEN a moderator opens the board settings dialog, THE Settings_Panel SHALL display all ten Feeling_Category options (Satisfaction, Frustration, Confidence, Confusion, Boredom, Happy, No_Feeling, Glad, Sad, Mad) as toggleable checkboxes, with checkboxes checked for categories present in the current `allowedFeelings` and unchecked for those not present.
4. IF a moderator attempts to deselect the last remaining enabled Feeling_Category, THEN THE System SHALL prevent the deselection and keep the category enabled so that `allowedFeelings` always contains at least 1 entry.
5. WHEN a moderator toggles a Feeling_Category checkbox in settings, THE System SHALL broadcast the updated `allowedFeelings` configuration to all connected participants via WebSocket within 2 seconds.
6. WHEN a Feeling_Category is removed from `allowedFeelings` and a participant currently has that category selected as their feeling, THE System SHALL clear that participant's feeling selection and broadcast the change to all connected clients.
7. THE System SHALL persist the `allowedFeelings` value as part of the RetroConfiguration for the session lifetime.
8. IF a non-moderator participant attempts to modify the `allowedFeelings` configuration, THEN THE System SHALL reject the request and leave the configuration unchanged.

---

### Requirement 2: Feelings Strip Display

**User Story:** As a participant, I want to see a labelled feelings strip with emoji icons on the board toolbar, so that I can quickly identify and select my current mood.

#### Acceptance Criteria

1. THE Feelings_Strip SHALL render on the right side of the retro board toolbar, visually enclosed in a golden/yellow border with the label "Your feeling".
2. THE Feelings_Strip SHALL display only the Feeling_Emoji icons that correspond to the categories listed in the current `allowedFeelings` configuration, rendered in the same order as they appear in the `allowedFeelings` array.
3. WHEN a Feeling_Emoji is hovered, THE Feelings_Strip SHALL display a tooltip showing the Feeling_Category name (e.g., "Happy", "Sad").
4. THE Feelings_Strip SHALL render on the retro board regardless of the template chosen for the retrospective.
5. WHEN the `allowedFeelings` configuration is updated by the moderator, THE Feelings_Strip SHALL update its displayed emojis within 2 seconds without requiring a page refresh.
6. THE Feelings_Strip SHALL visually highlight the emoji that the current participant has selected as their feeling by applying a distinct visual indicator (e.g., border, background change, or scale) that differentiates it from unselected emojis.
7. IF the `allowedFeelings` configuration is updated and the current participant's selected feeling is no longer in the allowed list, THEN THE Feelings_Strip SHALL remove the highlight and the participant's selection SHALL be cleared.
8. IF the `allowedFeelings` configuration contains zero categories, THEN THE Feelings_Strip SHALL remain visible with the "Your feeling" label but display no emoji icons.

---

### Requirement 3: Participant Feeling Selection

**User Story:** As a participant, I want to select an emoji to express my feeling, so that my mood is shared with the team during the retrospective.

#### Acceptance Criteria

1. WHEN a participant clicks a Feeling_Emoji, THE System SHALL record the selected Feeling_Category as that participant's current feeling and broadcast the update to all connected clients via WebSocket within 2 seconds.
2. WHEN a participant clicks a different Feeling_Emoji, THE System SHALL replace their previous feeling selection with the new one and broadcast the update.
3. WHEN a participant clicks their currently selected Feeling_Emoji, THE System SHALL deselect it (set feeling to none) and broadcast the update.
4. WHILE the Retro_Board is not marked as completed, THE System SHALL allow participants to change their feeling selection without restriction.
5. WHEN the Retro_Board is marked as completed, THE System SHALL visually disable all Feeling_Emoji controls and reject any feeling selection requests on the server, preserving the last recorded feelings unchanged.
6. THE Moderator SHALL have the same ability to select and change a feeling as any other participant.
7. IF a participant submits a Feeling_Category that is not in the current `allowedFeelings` configuration, THEN THE System SHALL reject the selection, retain the participant's previous feeling unchanged, and not broadcast any update.
8. IF a feeling selection fails due to a lost WebSocket connection, THEN THE System SHALL not update the participant's local selection state and SHALL indicate that the selection was not saved.

---

### Requirement 4: Real-Time Feeling Synchronization

**User Story:** As a participant, I want my feeling selection to be visible to others in real time, so that the team mood is always current.

#### Acceptance Criteria

1. WHEN a participant selects or changes a Feeling_Emoji, THE Server SHALL store the Participant_Feeling in the retro session state.
2. WHEN a participant selects or changes a Feeling_Emoji, THE Server SHALL broadcast a `retro:feeling:updated` event containing the user ID and selected Feeling_Category (or null if deselected) to all other clients in the session within 2 seconds of receiving the selection.
3. WHEN a new participant joins an active session, THE Server SHALL include the current feelings map (all participants' Feeling_Category selections, keyed by user ID) in the session state sent to the new participant.
4. WHEN a participant disconnects from the session, THE Server SHALL remove their Participant_Feeling from the session state and broadcast a `retro:feeling:updated` event with the disconnected user's ID and a null Feeling_Category to all remaining clients in the session.
5. IF the WebSocket connection to the server is lost and re-established, THEN THE Server SHALL treat the reconnection as a new join and send the full current feelings map to the reconnected client.

---

### Requirement 5: Moderator Feelings Summary Popup

**User Story:** As a moderator, I want to view all participants' feelings in a popup, so that I can gauge the overall team mood during the retrospective.

#### Acceptance Criteria

1. IF the current user is a moderator, THEN THE Feelings_Strip SHALL display a summary icon that opens the Feelings_Summary_Popup; IF the current user is not a moderator, THEN THE Feelings_Strip SHALL NOT display the summary icon.
2. WHEN the moderator clicks the summary icon, THE Feelings_Summary_Popup SHALL open as a modal dialog listing all current participants along with their selected Feeling_Emoji and Feeling_Category name.
3. WHILE the Feelings_Summary_Popup is open, THE Popup SHALL update its displayed participant feelings upon receiving each `retro:feeling:updated` WebSocket event without requiring the moderator to close and reopen the popup.
4. IF a participant has not selected any feeling, THEN THE Feelings_Summary_Popup SHALL display "No feeling" next to that participant's name.
5. THE Feelings_Summary_Popup SHALL display participants in case-insensitive alphabetical order by display name.
6. WHEN the moderator clicks outside the Feelings_Summary_Popup or activates a close button within the dialog, THE Feelings_Summary_Popup SHALL close and return focus to the summary icon.

---

### Requirement 6: Screenshot of Feelings Summary

**User Story:** As a moderator, I want to take a screenshot of the feelings summary popup, so that I can share the team mood snapshot with stakeholders.

#### Acceptance Criteria

1. THE Feelings_Summary_Popup SHALL include a "Screenshot" button within the dialog.
2. WHEN the moderator clicks the Screenshot button, THE System SHALL capture the Feelings_Summary_Popup content as a PNG image and trigger a browser download with a filename in the format "feelings-summary-YYYY-MM-DD.png" where the date is the current date.
3. THE screenshot image SHALL contain all participant names and their corresponding feeling emojis as displayed in the popup at the time of capture.
4. WHILE the screenshot capture is in progress, THE System SHALL disable the Screenshot button and display a visual indicator that the capture is being processed.
5. IF the screenshot capture fails, THEN THE System SHALL re-enable the Screenshot button and display an error message indicating that the capture could not be completed.

---

### Requirement 7: Non-Regression and Code Quality

**User Story:** As a developer, I want the feelings feature to be well-tested and isolated, so that existing retrospective and scrum board features remain unaffected.

#### Acceptance Criteria

1. THE Feelings feature implementation SHALL not modify any existing scrum board component, service, or route.
2. THE Feelings feature implementation SHALL not modify existing retrospective card, column, voting, or comment logic.
3. THE CI/CD pipeline SHALL continue to pass all existing tests after the feelings feature is integrated.
4. THE unit test coverage for all new feelings-related code SHALL meet or exceed 90%.
5. THE new WebSocket events for feelings SHALL be handled independently and SHALL not interfere with existing retro event routing.
