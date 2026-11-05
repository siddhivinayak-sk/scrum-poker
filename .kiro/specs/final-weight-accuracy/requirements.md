# Requirements Document

## Introduction

Final Weight and Estimation Accuracy is an optional Scrum Poker feature. When it is on, the moderator picks the final weight for a story at the end of each voting round. The app compares every voter's card with that weight and shows who was closest and who was furthest, in a light and friendly tone. The feature is off by default and adds no behaviour to sessions that leave it off (release 0.0.10).

The feature reuses patterns from `vote-reveal-fun-callouts` (setting, REST guard, copy store) and `session-chat` (WS event naming, release edits). This document was cross-checked against the code: `game-session.ts`, `handler.ts`, `routes/sessions.ts`, `session-state.service.ts`, `facilitator-flow`, `story-manager`, `issue-list-panel`, `session-poker-page`, `shared/types.ts` and `shared/estimate-export.ts`.

## Glossary

- **Final_Weight_Setting**: the optional boolean `finalWeightEnabled` in `SessionConfiguration`. An absent key means off.
- **Round_Completion_Action**: any action that ends a revealed round: Clear, Next (`issue:select`), submitting a new story (`story:submit`) while a revealed round exists, and End Session.
- **Weight_Moderator**: a participant whose session role is `moderator`. This is the same check the server uses for `board:clear`. The session owner is a Weight_Moderator only if their role is `moderator`.
- **Final_Weight_Dialog**: the popup listing candidate final weights, shown only to a Weight_Moderator.
- **Candidate_Options**: the ordered list of card values offered in the dialog.
- **Final_Weight**: the `ExtendedCardValue` the moderator chose. `0`, `½` and `XL` are all valid. Code must test `!== undefined`, never truthiness.
- **Final_Weight_Record**: `{ value, votingSystem, showFunniest }`, stored on the round and copied to the history entry. `votingSystem` is the session system when the weight was set.
- **Scoring_Ladder**: the ordered card list used for Distance. For numeric systems it is `CARD_LADDERS[system]`; for t-shirt it is `VOTING_SYSTEMS['t-shirt']` (XS to XXL).
- **Distance**: the number of ladder steps between a voter's card and the Final_Weight.
- **Scorable_Vote**: a `ParticipantVote` whose `cardValue` is on the Scoring_Ladder. Special cards (coffee, no-clue, break) and null votes are not scorable.
- **Accuracy_Result**: the per-round outcome: closest voters, furthest voters, Distance per voter.
- **Result_Balloon**: the popup shown to everyone with the Accuracy_Result.
- **Header_Icon**: the icon button in the top horizontal panel of the poker page.
- **Roast_Copy**: the funny, non-offensive text lines used for the furthest voter.
- **Gate_Service**: the client `FinalWeightGateService`, whose `guard(action)` method wraps every Round_Completion_Action entry point.

## Requirements

### Requirement 1: Optional setting, off by default

**User Story:** As a moderator, I want to turn the feature on only when my team wants it, so that existing sessions stay the same.

#### Acceptance Criteria

1. THE `SessionConfiguration` SHALL include an optional boolean `finalWeightEnabled`, and `DEFAULT_SESSION_CONFIG` SHALL remain unchanged (an absent key means off) so that existing tests that compare configs keep passing.
2. WHEN `resolveFinalWeightEnabled(value)` is called, THE shared helper SHALL return `true` only for the boolean `true` and `false` for any other value (missing, null, string, number).
3. WHEN the incoming config contains the key `finalWeightEnabled`, THE `SessionRegistry.createSession` SHALL store `resolveFinalWeightEnabled(value)`.
4. WHILE the incoming config lacks the key `finalWeightEnabled`, THE `SessionRegistry.createSession` SHALL leave the key absent so that it reads as `false`.
5. WHEN a session was created before 0.0.10 or by an older client, THE session SHALL behave exactly as before.
6. WHILE the Final_Weight_Setting is off, THE client SHALL hide the Header_Icon, the Final_Weight_Dialog and the Result_Balloon.
7. IF `finalweight:submit` is received WHILE the Final_Weight_Setting is off, THEN THE server SHALL reject it with code `FEATURE_DISABLED`.

### Requirement 2: Enable at board creation

**User Story:** As a moderator, I want to enable the feature when I create a board, so that my team can use it from the first round.

#### Acceptance Criteria

1. THE create-board page SHALL show a toggle "Ask for final weight after each round" under "Additional Options", unchecked by default, with a one-line hint.
2. WHEN the board is created, THE create-board page SHALL include `finalWeightEnabled` with the toggle value in the request config.
3. THE create-board page SHALL keep the existing toggles and their defaults unchanged.

### Requirement 3: Change from board settings

**User Story:** As a moderator or session owner, I want to change the setting during a session, so that the team can start or stop using the feature at any time.

#### Acceptance Criteria

1. THE board settings panel SHALL show the same toggle under "Additional Options", bound to the current config value (an absent key reads as off).
2. THE server SHALL allow the same users who can change `autoReveal` (the owner and moderators, through `PUT /api/sessions/:id/config`) to change the toggle, and the toggle SHALL NOT be owner-only as `funCallouts` is.
3. IF a request sets `finalWeightEnabled` to a non-boolean value, THEN THE server SHALL reject it with status 400 and body `{ error: 'INVALID_SETTING', setting: 'finalWeightEnabled' }`, with no state change and no broadcast.
4. WHEN the value changes, THE server SHALL broadcast `session:config-updated` as it does for other settings, and all clients SHALL update at once.
5. WHEN the setting is turned off, THE client SHALL close the dialog and the balloon and hide the Header_Icon, and THE server SHALL keep stored final weights in history.
6. WHEN the setting is turned on while a round is already revealed, THE client SHALL open the dialog on the next Round_Completion_Action.
7. WHEN the voting system is changed in settings, THE server SHALL keep the stored `votingSystem` of existing Final_Weight_Records, and results SHALL not change (see Requirement 6).

### Requirement 4: Trigger points

**User Story:** As a moderator, I want to be asked for the final weight when a revealed round ends, so that I can record the team's decision without extra steps.

#### Acceptance Criteria

1. WHILE the setting is on, the current user is a Weight_Moderator and the round is `revealed`, WHEN a Round_Completion_Action starts, THE client SHALL open the Final_Weight_Dialog before it sends the original request.
2. THE client SHALL route all six entry points through the single Gate_Service method `guard(action)`, so that none is missed and the off path is one check. The entry points are:
   - facilitator-flow: `clearAndNext` (Clear)
   - facilitator-flow: `nextIssue` (the three Next buttons)
   - story-manager: `clearBoard` (Clear)
   - story-manager: story submit (`story:submit`)
   - issue-list-panel: `selectIssue`
   - session-poker-page: `confirmEndSession` (End Session)
3. WHEN End Session is chosen, THE client SHALL keep the existing "Are you sure" confirmation first.
4. WHEN the End Session confirmation is accepted, THE client SHALL open the dialog, send `finalweight:submit`, send `board:clear`, wait for `board:cleared` (or an `error`, or a 3 second timeout), and only then call the REST delete, so that the delete cannot overtake the archive.
5. IF the clear fails or times out (for example the owner is not a Weight_Moderator), THEN THE client SHALL still call the REST delete, as it does today.
6. WHEN a session is ended, THE system SHALL record the weight and archive the round, and THE system SHALL NOT show a balloon to other participants or export automatically, because deleting a session removes it with its history and the server does not broadcast on delete. The moderator can use the existing Export before ending.
7. WHEN the moderator confirms or skips, THE client SHALL send the original request unchanged.
8. WHILE the round is idle or voting, THE client SHALL NOT open the dialog.
9. WHEN Re-Vote is used, THE client SHALL NOT open the dialog, because the round is discarded and not saved.
10. WHILE the current user is not a Weight_Moderator, THE client SHALL NOT open the dialog.
11. WHEN a user with only issue permission (Next, story submit) who is not a Weight_Moderator performs the action, THE system SHALL complete the action exactly as today and save the round without a Final_Weight.
12. WHILE the dialog is open, IF the round stops being revealed (another moderator cleared or re-voted), THEN THE client SHALL close the dialog as Skip and continue the original action.
13. WHEN the moderator picks "Skip", THE server SHALL save the round without a new Final_Weight, and a weight set earlier on the same round (from the Header_Icon) SHALL stay unchanged.
14. WHEN the moderator closes the dialog with Esc or Cancel, THE client SHALL cancel the original action and the round SHALL stay revealed.
15. WHEN a round completes by another path (another user's Next or story submit, or auto-save), THE server SHALL save the round without a Final_Weight and SHALL NOT block any existing action waiting for a weight.
16. WHEN two moderators submit for the same round, THE server SHALL apply the last valid `finalweight:submit` and broadcast every accepted change.

### Requirement 5: Candidate options

**User Story:** As a moderator, I want helpful suggestions of final weights, so that I can pick the right value quickly.

#### Acceptance Criteria

1. THE shared pure function `buildFinalWeightOptions(votes, votingSystem)` SHALL build the Candidate_Options.
2. THE function SHALL include every distinct Scorable_Vote value from the round, ordered by Scoring_Ladder position.
3. THE function SHALL add suggestions and tag each option with a reason: `voted`, `most-voted` (the mode; ties tag all tied values), `nearest-average` (the ladder card nearest to the average of scorable votes; ties pick the higher card) and `between` (ladder cards between the lowest and highest vote that nobody picked, limited to 3).
4. THE dialog SHALL show every option as a card button with reason badges, and SHALL mark one option as suggested without pre-selecting it.
5. THE dialog SHALL offer "Show all cards" to pick any value on the Scoring_Ladder (excluding special cards).
6. WHEN there are no scorable votes (all special cards, or no votes), THE dialog SHALL show the full ladder with a note that no accuracy result can be produced, and the moderator SHALL still be able to pick a weight or "Skip".
7. THE function SHALL be deterministic, SHALL produce no duplicates, and SHALL treat `0` as a normal card.

### Requirement 6: Distance and accuracy

**User Story:** As a team member, I want a fair measure of how close each vote was to the final weight, so that the comparison is meaningful.

#### Acceptance Criteria

1. THE system SHALL compute Distance as `abs(index(vote) - index(finalWeight))` on the Scoring_Ladder, using the existing `ladderIndexOf` semantics.
2. WHERE the voting system is t-shirt (empty `CARD_LADDERS` entry), THE system SHALL use `VOTING_SYSTEMS['t-shirt']` as the Scoring_Ladder, for scoring only, without changing card rendering or `CARD_LADDERS`.
3. IF the submitted value is not on the Scoring_Ladder of the session system, THEN THE server SHALL reject it with `INVALID_FINAL_WEIGHT`.
4. THE functions `computeAccuracy` and `buildFinalWeightOptions` SHALL be total and never throw.
5. IF a vote or weight is not on the ladder, THEN THE functions SHALL treat it as not scorable and return `comparable: false`.
6. THE system SHALL define the closest voters as all scorable voters with the minimum Distance, and the furthest voters as all scorable voters with the maximum Distance.
7. WHEN the maximum Distance is greater than the minimum Distance, THE system SHALL produce a furthest result, and otherwise SHALL produce none.
8. IF fewer than 2 scorable voters voted, THEN THE system SHALL make no comparison, and THE balloon SHALL show only the weight and a neutral line.
9. WHEN `computeAccuracy(votes, finalWeightRecord)` is called, THE function SHALL return per-voter Distance, closest ids, furthest ids, `allExact` (every scorable voter equals the weight) and `comparable`.
10. THE system SHALL NOT score participants with a null `cardValue`; there is no observer role in the app.
11. THE system SHALL read votes from `ParticipantVote.cardValue`, built exactly as `clearBoard()` builds them (current participants only), so that a voter who left before the clear is absent from both the live result and the restored result.
12. THE system SHALL choose the Scoring_Ladder from the `votingSystem` stored in the Final_Weight_Record, never from the current setting.

### Requirement 7: Result balloon for everyone

**User Story:** As a participant, I want to see the accuracy result after the moderator sets the final weight, so that I learn how my estimate compared.

#### Acceptance Criteria

1. WHEN the server accepts a Final_Weight, THE server SHALL broadcast `finalweight:set` to all participants, carrying the Accuracy_Result computed on the server.
2. THE Result_Balloon SHALL show the Final_Weight, the closest voter(s) with their card and a friendly line, and the furthest voter(s) per Requirement 9.
3. THE Result_Balloon SHALL close by button, by Esc and by auto-dismiss after 20 seconds, and SHALL pause the timer on hover and focus.
4. THE Result_Balloon SHALL use `role="status"` with `aria-live="polite"` and SHALL NOT steal focus.
5. WHEN a `finalweight:set` arrives with a distinct `(roundId, value, showFunniest)`, THE client SHALL pop up the balloon, and a corrected weight SHALL replace the visible balloon.
6. WHEN identical repeated data arrives, THE client SHALL NOT pop up the balloon again.
7. WHERE `prefers-reduced-motion` is set, THE Result_Balloon SHALL appear without animation.
8. WHEN a participant joins or reloads, THE client SHALL make the latest result available through the Header_Icon and SHALL NOT pop up the balloon again.
9. THE Result_Balloon position SHALL not overlap the chat launcher (bottom-left), the vote callout layer or the moderator note balloon, and SHALL be checked against `board-overlay-layout.service` and those components.

### Requirement 8: Header icon

**User Story:** As a participant, I want an icon in the header, so that I can set or revisit the final weight and result at any time.

#### Acceptance Criteria

1. WHILE the setting is on, THE top header panel SHALL show a Header_Icon button with an accessible name ("Final weight and accuracy") and a tooltip.
2. WHILE the current user is a Weight_Moderator and the round is revealed, WHEN the Header_Icon is activated, THE client SHALL open the dialog in edit mode for the current round, preselecting the current weight if one exists.
3. WHILE the dialog is in edit mode, WHEN the moderator confirms, THE client SHALL NOT trigger any Round_Completion_Action.
4. WHILE the current user is a Weight_Moderator, there is no revealed round and a newest history entry exists, WHEN the Header_Icon is activated, THE client SHALL open the dialog in edit mode for that entry so that the weight can be set or corrected after Clear.
5. WHILE a result exists, WHEN any participant (all roles) activates the Header_Icon, THE client SHALL re-open the Result_Balloon with the latest Accuracy_Result.
6. WHILE there is nothing to show, THE Header_Icon SHALL be disabled with a tooltip that says why.
7. THE Header_Icon SHALL be keyboard operable, SHALL have a visible focus ring, and SHALL NOT shift the existing header buttons on narrow screens.

### Requirement 9: Funny, safe presentation

**User Story:** As a team member, I want the result to be playful and kind, so that the retro-style fun never feels like criticism of a person.

#### Acceptance Criteria

1. THE Roast_Copy for the furthest voter SHALL be playful and about the guess, never about the person, with no insults and no body, gender, nationality or intelligence jokes.
2. THE Result_Balloon SHALL give the closest voter a positive title (for example "Sharpshooter", "Crystal Ball") and the furthest voter a gentle title (for example "Bold Explorer", "Wildcard", "Dreamer of Other Sprints").
3. THE system SHALL choose the copy from a fixed pool per Distance band (`near` 1 step, `mid` 2 to 3 steps, `far` 4 or more steps), picked deterministically from `roundId`, with `{name}` and `{card}` placeholders.
4. WHEN `allExact` is true, THE Result_Balloon SHALL celebrate the team ("Hive mind!") and show no furthest voter.
5. WHEN there is a tie, THE Result_Balloon SHALL list all tied names (up to 3, then "and N more").
6. THE furthest block SHALL carry a "Just for fun" label.
7. WHEN the moderator unchecks "Show the funniest guess" in the dialog (default checked), THE Result_Balloon SHALL hide the furthest block, THE server SHALL store the choice in the Final_Weight_Record, and the choice SHALL apply to everyone. The roast is on by default and can be hidden per round by the moderator.
8. THE copy pool SHALL be a typed constant in `shared/final-weight-copy.ts`, English only, with at least 5 lines per band for both closest and furthest.
9. THE client SHALL render text as plain text, never as HTML, with names escaped by Angular.

### Requirement 10: Session standings (accuracy metric)

**User Story:** As a team member, I want to see how accurate each voter has been across the session, so that the team can see estimation trends.

#### Acceptance Criteria

1. THE server SHALL keep each HistoryEntry's `finalWeight` record so that accuracy metrics are derived from history.
2. THE balloon and the dialog SHALL offer an expandable "Session standings" list built by pure `computeStandings(history)`.
3. THE `computeStandings` function SHALL return, for each voter, the rounds scored and the average Distance, sorted ascending (best first), and SHALL score each entry with its own stored `votingSystem`.
4. WHILE a voter has fewer than 2 scored rounds, THE standings SHALL show "warming up" for that voter and rank the voter after the others.
5. THE standings SHALL NOT use the furthest label for the last-place voter.
6. THE `computeStandings` function SHALL ignore history entries with no Final_Weight_Record and non-comparable entries.

### Requirement 11: Server protocol and security

**User Story:** As a maintainer, I want a validated and authorized protocol, so that only moderators can set weights and clients cannot forge results.

#### Acceptance Criteria

1. WHEN a Weight_Moderator sends `finalweight:submit` with `{ roundId, value, showFunniest? }`, THE server SHALL reply on success by broadcasting `finalweight:set` `{ roundId, record, result }` to all participants.
2. IF the sender is not a Weight_Moderator (same check as `board:clear`), THEN THE server SHALL reply with `error` code `UNAUTHORIZED`.
3. THE server SHALL validate the payload shape: `roundId` a non-empty string, `value` a string or number, and `showFunniest` a boolean or absent.
4. THE server SHALL validate that the setting is on, that `roundId` matches the REVEALED current round or the newest history entry, and that `value` is a member of the Scoring_Ladder by strict equality (so `0` is accepted).
5. IF validation fails, THEN THE server SHALL reply with `FEATURE_DISABLED`, `ROUND_NOT_FOUND` or `INVALID_FINAL_WEIGHT` as applicable.
6. THE server SHALL mutate state only through new `GameSession` methods and SHALL NOT trust any Distance or result sent by the client.
7. WHEN `board:cleared` is sent, THE payload SHALL contain the history entry including `finalWeight` when set.
8. THE new fields SHALL be optional and omitted when unset, so that old clients and existing payload assertions are unaffected.
9. WHEN a `finalweight:set` with the same `roundId` arrives, THE client SHALL treat the submit as complete.
10. IF an `error` with code `UNAUTHORIZED`, `FEATURE_DISABLED` or `INVALID_FINAL_WEIGHT` arrives, or a 5 second timeout elapses, THEN THE dialog SHALL stay open with an inline message and offer Retry, Skip and Cancel.
11. IF an `error` with code `ROUND_NOT_FOUND` arrives, THEN THE client SHALL treat it as Skip.
12. THE new event names SHALL be exported constants in `shared/types.ts` and documented in the README event list (project conventions).

### Requirement 12: Display, issues and export

**User Story:** As a moderator, I want final weights shown in history, on issues and in the export, so that the recorded decisions are visible and reusable.

#### Acceptance Criteria

1. WHILE the setting is on, THE session history list SHALL show the Final_Weight next to each entry that has one.
2. WHEN at least one history entry has a Final_Weight (`!== undefined`), THE estimate export (`GET /api/sessions/:id/export`, built from history by `shared/estimate-export.ts`) SHALL append a `Final Weight` column as the LAST summary column, and rows of entries without a weight SHALL carry `-` in that column.
3. THE export SHALL keep the existing `SUMMARY_HEADER` constant and column order unchanged.
4. WHEN no history entry has a weight, THE export output SHALL be byte-identical to today.
5. THE `IssueItem` SHALL include an optional `finalWeight` (value only).
6. WHEN a Final_Weight is set for a round that belongs to an issue, THE server SHALL copy the value to that issue and broadcast `issue:list-updated`.
7. THE server SHALL find the issue by the existing rule used for `markIssueEstimated` (status `estimating` and title equals the story) for the current round, or by `historyEntryId` for the newest history entry.
8. WHEN the weight is corrected, THE server SHALL update the issue again.
9. WHEN a revealed round is re-voted, THE server SHALL remove the `finalWeight` it had copied to the matching `estimating` issue, because the round and its weight are discarded.
10. WHEN a Final_Weight is present on an issue, THE issue list SHALL show it beside the issue. The export reads history, so it needs no separate issue data.
11. WHILE the setting is off, THE `IssueItem` and the export SHALL be unchanged.

### Requirement 13: No regression

**User Story:** As a maintainer, I want existing behaviour to stay intact, so that teams that do not use the feature are not affected.

#### Acceptance Criteria

1. WHILE the setting is off, THE existing server and client test suites SHALL pass unchanged.
2. BEFORE the first code change, THE developer SHALL record a baseline run of both suites.
3. THE developer SHALL check specifically the tests that assert exact config, `board:cleared`, `HistoryEntry`, `IssueItem` or export shapes (for example `poker-events-nonregression`, `sessions-funcallouts`, `no-regression`, export property tests).
4. WHILE the setting is off, THE facilitator buttons Clear, Next, Re-Vote and Reveal, story submit, issue select, End Session, vote callouts, chat and history SHALL behave as before.
5. THE system SHALL NOT remove any existing event payload field or change its type.
6. THE feature SHALL NOT modify the retro feature.
7. THE feature SHALL add no npm dependency.
8. WHILE the setting is on, THE existing vote callouts and notes SHALL continue to work.

### Requirement 14: Accessibility and UX

**User Story:** As a user of assistive technology or a mobile device, I want the dialog to be accessible and responsive, so that I can use the feature fully.

#### Acceptance Criteria

1. THE Final_Weight_Dialog SHALL use `role="dialog"`, `aria-modal="true"` and a labelled title.
2. WHEN the dialog opens, THE client SHALL move focus into it and trap focus inside it.
3. WHEN the dialog closes, THE client SHALL return focus to the trigger.
4. WHEN Esc is pressed in the dialog, THE client SHALL cancel it.
5. THE option buttons SHALL be a `radiogroup`-style control operable by arrow keys, with the selected state exposed via `aria-checked`.
6. THE feature SHALL take colours from existing CSS custom properties and meet contrast requirements in light and dark themes.
7. THE dialog SHALL work on mobile widths.

### Requirement 15: Documentation and release 0.0.10

**User Story:** As a maintainer, I want documentation and release metadata updated, so that the 0.0.10 release is consistent and discoverable.

#### Acceptance Criteria

1. THE `README.md` SHALL describe the feature (setting, dialog, balloon, icon, standings, funny presentation), the new WS events and REST validation, and a How to Use step.
2. THE `helm/scrum-poker/Chart.yaml` SHALL have `version: 0.0.10` and `appVersion: "0.0.10"`.
3. THE `helm/scrum-poker/README.md` and `README.md` SHALL replace every `0.0.9` release reference with `0.0.10` (Helm `--version`, image tag examples).
4. THE `client/package.json` and `server/package.json` SHALL stay unchanged, because they do not track the release line.
5. THE task list SHALL NOT create the git commit or tag; that remains with the maintainer per `release-versioning.instructions.md`.
