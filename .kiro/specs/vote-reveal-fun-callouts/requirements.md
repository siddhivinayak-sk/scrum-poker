# Requirements Document

## Introduction

When cards are revealed in a Scrum Poker session, the board currently shows a metrics panel (average, mode, spread, distribution, outlier count) and a consensus indicator. Both are factual and neutral. Nothing in the current reveal moment turns the result into a shared, light-hearted team moment, and nothing invites the person who voted differently from the group to explain their reasoning.

This feature adds two playful, heavily animated, non-blocking floating callouts that appear on reveal and leave with a comic exit when the next story starts:

1. A **Near_Average_Callout** shown to viewers who hold the reveal permission. It celebrates, by name, the participants whose vote landed closest to the computed average. It frames closeness as a fun club to be in, never as a ranking that exposes who was furthest away.
2. A **Far_From_Average_Prompt** shown privately to a participant whose own vote landed far from the average. It asks, in a warm and curious tone, whether they would like to say or add something, and lets them attach a short note to the round.

The emotional design goal set by the request is explicit: nobody may be made to feel disappointed, exposed, or ranked. Humour, motion, tone, and emotional safety are therefore treated as first-class, testable requirements in this document, not as taste notes.

Three technical realities shape the requirements below:

- The existing `VotingMetrics.outliers` field classifies voters by **index distance from the mode**, and its lookup table only covered the plain Fibonacci ladder, so it was silently inert for `power-of-2`, `modified-fibonacci`, and `t-shirt`. Requirements 14 and 15 repair that field so it is computed against the Card_Ladder of the active voting system and works across every deck. This feature still specifies its own Proximity_Classifier because `outliers` answers a different question than the callouts do: `outliers` measures distance from the **mode**, bucketed in whole ladder steps, to flag divergent voters in the metrics panel, whereas the callouts measure distance from the **average**, on a continuous ladder position, to decide whose vote to name as agreeing. Two separate functions keep each panel truthful about the quantity it displays. At the user's request, the two confirmed metrics-engine defects described below are now in scope for this spec rather than deferred: non-number card values corrupting `average`, `mode`, and `spread` (Requirement 14), and outlier detection being inert outside the plain Fibonacci deck (Requirement 15).
- `average`, `selections`, and `metrics` already reach every client in the `cards:revealed` and `session:state` payloads, so the classification can be derived client-side without new broadcast traffic. Only the optional participant note needs a new WebSocket event.
- Angular has deprecated the `@angular/animations` DSL and now directs teams to native CSS animations and the enter/leave primitives, which are lighter and hardware-accelerated ([Migrating to Native CSS Animations](https://angular.dev/guide/animations/migration), [Legacy Animations overview](https://angular.dev/guide/legacy-animations), [Angular's new enter/leave animation API](https://briantree.se/angulars-new-enter-leave-animation-api/)). The motion requirements below are therefore expressed in terms of compositor-friendly CSS properties. Accessibility requirements follow the `prefers-reduced-motion` guidance that non-essential motion should be removed, reduced, or replaced with a short fade, keeping only motion that explains a state change ([MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion), [MDN media queries for accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Using_for_accessibility), [Design accessible animation and movement](https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/), [prefers-reduced-motion and CSS animation performance](https://www.wpfsharp.com/courses/css/transitions-animation/motion-accessibility-prefers-reduced-motion-performance)). Content from these sources was rephrased for compliance with licensing restrictions.

This feature affects the Scrum Poker board only. The retrospective board, its registry, its handler, and its routes stay untouched.

## Glossary

- **System**: The Scrum Poker application as a whole, spanning the Angular client and the Node.js/Express server.
- **Poker_Session**: A single active poker game session, identified by a session ID and held in the server `SessionRegistry`.
- **Participant**: Any user connected to a Poker_Session, including users holding the moderator role.
- **Reveal_Permitted_Viewer**: A Participant for whom the session's `revealPermission` configuration evaluates to true. This is role-and-permission based, so it covers `moderator-only`, `all-players`, and `select-specific` permission modes rather than assuming the moderator role.
- **Voting_Round**: The existing `VotingRound` record, whose `status` is `voting`, `revealed`, or `completed`.
- **Revealed_State**: The condition in which the current Voting_Round has `status` equal to `revealed` and voting metrics are available on the client.
- **Metrics_Engine**: The server-side calculation in `server/src/services/metrics-engine.ts` that produces the `VotingMetrics` record of a Voting_Round.
- **Card_Numeric_Value**: The real number that a card value contributes to numeric statistics. Every card value of the `fibonacci` and `power-of-2` systems, and every numeric card value of the `modified-fibonacci` system, has a Card_Numeric_Value equal to that card value itself. The `modified-fibonacci` card `'½'` has a Card_Numeric_Value of 0.5. The special cards `coffee`, `no-clue`, and `break` and the t-shirt sizes `XS`, `S`, `M`, `L`, `XL`, and `XXL` have no Card_Numeric_Value.
- **Numeric_Card**: A card value that has a Card_Numeric_Value.
- **Numeric_Vote**: A card selection whose card value is a Numeric_Card, that is, a selection whose card value has a Card_Numeric_Value.
- **Card_Ladder**: The ascending list of card values of the Poker_Session's active voting system that have a Card_Numeric_Value, ordered by that Card_Numeric_Value, with special cards and card values lacking a Card_Numeric_Value excluded. For the `fibonacci` system the Card_Ladder is `[0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]`. For the `modified-fibonacci` system the Card_Ladder is `[0, '½', 1, 2, 3, 5, 8, 13, 20, 40, 100]`, with `'½'` positioned by its Card_Numeric_Value of 0.5. For the `t-shirt` system the Card_Ladder is empty, because no t-shirt size has a Card_Numeric_Value.
- **Ladder_Position**: A real number locating a value on the Card_Ladder. For a card value present in the Card_Ladder it is that value's zero-based index. For the computed average it is the linear interpolation between the indices of the two adjacent Card_Ladder entries whose Card_Numeric_Values bracket the average.
- **Ladder_Distance**: The absolute difference between a Participant's Ladder_Position and the average's Ladder_Position.
- **Proximity_Classifier**: The pure function that takes the round's selections, the computed average, and the active voting system, and returns the Near_Set, the Far_Set, and the Ladder_Distance of each classified Participant.
- **Near_Set**: The set of Participant user IDs whose Ladder_Distance is at most 0.75.
- **Far_Set**: The set of Participant user IDs whose Ladder_Distance is at least 2.0.
- **Near_Average_Callout**: The floating, animated panel shown to Reveal_Permitted_Viewers that celebrates the Near_Set by display name.
- **Far_From_Average_Prompt**: The floating, animated panel shown privately to a Participant who is a member of the Far_Set, inviting an optional note.
- **Vote_Callout_Layer**: The single fixed-position stacking layer that hosts the Near_Average_Callout and the Far_From_Average_Prompt.
- **Callout_Copy_Catalog**: The named, exported collection of reviewable playful text entries used by the callouts, held as data rather than as literals embedded in templates.
- **Callout_Phrase**: One entry selected from the Callout_Copy_Catalog for one appearance of one callout.
- **Restricted_Term_List**: The named, exported collection of terms that no Callout_Copy_Catalog entry may contain, organised into an error-attributing group, a ranking-and-comparison group, and a region-specific-idiom group, so that the tone constraints of Requirement 4 are automatically decidable by a check over every catalog entry.
- **Callout_Note**: A short text note that a Participant optionally submits from the Far_From_Average_Prompt, attached to the Voting_Round it was written for.
- **Unsent_Note_Element**: The compact element that holds retained, unsubmitted Callout_Note text across a Voting_Round change, offering a submit control and a discard control for that retained text.
- **Dismissal_Record**: The per-browser-tab record of one callout dismissal, keyed by Poker_Session identifier, Voting_Round identifier, and the identity of the dismissed callout.
- **Entrance_Flourish**: The animation that plays when a callout becomes visible.
- **Idle_Flourish**: The low-amplitude looping animation that gives a visible callout personality while it rests.
- **Exit_Flourish**: The comic animation that plays when a callout leaves.
- **Reduced_Motion_Mode**: The condition in which the operating system reports `prefers-reduced-motion: reduce`, or the Poker_Session's fun-callout animation setting is disabled.
- **Session_Settings_Panel**: The existing owner-facing panel that edits `SessionConfiguration`.

## Requirements

### Requirement 1: Average-Relative Vote Proximity Classification

**User Story:** As a Participant, I want closeness to the average measured on the card ladder of the voting system in play, so that the callouts describe agreement in the same units the team actually votes in.

#### Acceptance Criteria

1. THE Proximity_Classifier SHALL accept the round's selections, the computed average, the active voting system identifier, and the display name of each Participant appearing in the selections, and SHALL return a Near_Set, a Far_Set, and the Ladder_Distance of each classified Participant keyed by that Participant's user ID, with the Near_Set and the Far_Set sharing no member.
2. THE Proximity_Classifier SHALL derive the Card_Ladder as the list of the active voting system's card values that have a Card_Numeric_Value, sorted in ascending order of Card_Numeric_Value, with entries sharing a Card_Numeric_Value collapsed to a single entry and with every card value that has no Card_Numeric_Value, including the special cards and the t-shirt sizes, excluded.
3. THE Proximity_Classifier SHALL compute the Ladder_Position of a Numeric_Vote as the zero-based index of that card value within the Card_Ladder.
4. IF the average lies strictly between the Card_Numeric_Values of two adjacent Card_Ladder entries, THEN THE Proximity_Classifier SHALL compute the average's Ladder_Position as `lowerIndex + (average - lowerValue) / (upperValue - lowerValue)`, where `lowerValue` and `upperValue` are the Card_Numeric_Values of the two adjacent Card_Ladder entries that bracket the average.
5. IF the average is below the Card_Numeric_Value of the first Card_Ladder entry, THEN THE Proximity_Classifier SHALL set the average's Ladder_Position to 0.
6. IF the average is above the Card_Numeric_Value of the last Card_Ladder entry, THEN THE Proximity_Classifier SHALL set the average's Ladder_Position to the index of the last Card_Ladder entry.
7. THE Proximity_Classifier SHALL place a Participant in the Near_Set when that Participant's Ladder_Distance, rounded to 6 decimal places, is less than or equal to 0.75.
8. THE Proximity_Classifier SHALL place a Participant in the Far_Set when that Participant's Ladder_Distance, rounded to 6 decimal places, is greater than or equal to 2.0.
9. THE Proximity_Classifier SHALL leave a Participant whose Ladder_Distance, rounded to 6 decimal places, is greater than 0.75 and less than 2.0 out of both the Near_Set and the Far_Set, so that an unremarkable vote produces no callout of either kind.
10. THE Proximity_Classifier SHALL exclude from both the Near_Set and the Far_Set every Participant who cast no selection in the round, counting as no selection a Participant whose user ID is absent from the selections and a Participant whose recorded selection is null or undefined.
11. THE Proximity_Classifier SHALL exclude from both the Near_Set and the Far_Set every Participant whose selection is one of the special cards `coffee`, `no-clue`, or `break`.
12. THE Proximity_Classifier SHALL exclude from both the Near_Set and the Far_Set every Participant whose selection has no Card_Numeric_Value and every Participant whose selection is absent from the Card_Ladder of the active voting system.
13. THE Proximity_Classifier SHALL return an empty Near_Set, an empty Far_Set, and an empty collection of Ladder_Distance entries, without raising an error, when the supplied average is null, is undefined, is not of a numeric type, or is not a finite number.
14. THE Proximity_Classifier SHALL return an empty Near_Set, an empty Far_Set, and an empty collection of Ladder_Distance entries, without raising an error, when the Card_Ladder contains fewer than two entries.
15. THE Proximity_Classifier SHALL compute its Near_Set, Far_Set, and Ladder_Distance results independently of the `VotingMetrics.outliers` field, SHALL neither read nor write that field, and SHALL leave the mode-relative meaning of `outliers` as a separate notion whose definition Requirement 15 owns.
16. THE Proximity_Classifier SHALL order the Near_Set by ascending Ladder_Distance, SHALL break equal distances by case-insensitive display name ordering, and SHALL break equal display names by ascending user ID, so that the celebration list is stable across renders.
17. THE Proximity_Classifier SHALL be a pure function that produces the same result for the same inputs and performs no input mutation, no network access, and no reading of browser or clock state.
18. IF the average is exactly equal to the Card_Numeric_Value of a Card_Ladder entry, THEN THE Proximity_Classifier SHALL set the average's Ladder_Position to the zero-based index of that entry.
19. IF the supplied active voting system identifier matches no voting system known to the System, THEN THE Proximity_Classifier SHALL return an empty Near_Set, an empty Far_Set, and an empty collection of Ladder_Distance entries, without raising an error.
20. THE Proximity_Classifier SHALL accept selections containing up to 100 entries and SHALL return its result for such input within 50 milliseconds.

---

### Requirement 2: Near-Average Celebration Callout

**User Story:** As a Reveal_Permitted_Viewer, I want a fun floating panel naming the people whose votes landed closest to the average, so that the reveal becomes a shared moment of recognition instead of a bare table of numbers.

#### Acceptance Criteria

1. WHEN the current Voting_Round enters Revealed_State, THE System SHALL display the Near_Average_Callout to every Reveal_Permitted_Viewer in that Poker_Session within 1 second of that viewer's client receiving the revealed round state.
2. WHILE a Participant is not a Reveal_Permitted_Viewer, THE System SHALL withhold the Near_Average_Callout from that Participant, including removing any Near_Average_Callout already visible on that Participant's client within 1 second of that Participant ceasing to be a Reveal_Permitted_Viewer.
3. THE Near_Average_Callout SHALL display the display name of each Participant in the Near_Set, in the ascending Ladder_Distance order returned by the Proximity_Classifier, subject to the displayed-name limit defined in Requirement 8.
4. THE Near_Average_Callout SHALL display exactly one Callout_Phrase drawn from the near-average section of the Callout_Copy_Catalog, and SHALL keep that same Callout_Phrase displayed for the entire time the panel remains visible within that Voting_Round.
5. THE Near_Average_Callout SHALL present each named Participant as an equal member of the celebrated group, with no numeric distance, rank, position, score, or ordinal label attached to any name.
6. THE Near_Average_Callout SHALL omit the display name, count, and distance of every Participant in the Far_Set, so that no viewer learns from this panel who voted furthest from the average.
7. WHERE at least two Participants cast a Numeric_Vote, the Near_Set contains every Participant who cast a Numeric_Vote, and the Far_Set is empty, THE Near_Average_Callout SHALL display the full-agreement Callout_Phrase variant in place of the near-average Callout_Phrase.
8. IF the Near_Set is empty while the Far_Set is non-empty, THEN THE Near_Average_Callout SHALL display the wide-spread Callout_Phrase variant and SHALL display no participant names.
9. THE Near_Average_Callout SHALL display no text string that is identical, after trimming and case-insensitive comparison, to the label text of the existing consensus indicator, so that the two components do not restate each other.
10. THE Near_Average_Callout SHALL include a dismiss control that removes the panel for the dismissing viewer only, and SHALL transmit no dismissal state for that control to any other Participant.
11. WHEN a Reveal_Permitted_Viewer activates the dismiss control, THE System SHALL play the Exit_Flourish and SHALL leave the Near_Average_Callout hidden on that viewer's client for the remainder of that Voting_Round, including across subsequent re-renders, session state refreshes, and reconnections within that same Voting_Round.
12. THE Near_Average_Callout SHALL remain visible until an exit trigger defined in Requirement 5 occurs, with no automatic timeout.
13. IF the Near_Set and the Far_Set are both empty when the current Voting_Round enters Revealed_State, THEN THE System SHALL withhold the Near_Average_Callout from every Participant in that Poker_Session.
14. WHEN a Voting_Round later than the Voting_Round in which a viewer dismissed the Near_Average_Callout enters Revealed_State, THE System SHALL discard that recorded dismissal, so that the Near_Average_Callout is again eligible for display to that viewer under criterion 1.

---

### Requirement 3: Far-From-Average Participant Prompt

**User Story:** As a Participant whose vote landed far from the average, I want a warm private nudge inviting me to explain my thinking, so that my different view reaches the team without me being singled out in front of everyone.

#### Acceptance Criteria

1. WHEN the current Voting_Round enters Revealed_State and the viewing Participant's own user ID is a member of the Far_Set, THE System SHALL display the Far_From_Average_Prompt to that Participant within 1000 milliseconds of that Participant's client receiving the revealed round state.
2. WHILE the viewing Participant's own user ID is absent from the Far_Set, THE System SHALL withhold the Far_From_Average_Prompt from that Participant.
3. THE System SHALL display the Far_From_Average_Prompt only on the client of the Participant it concerns, and SHALL transmit no Far_From_Average_Prompt state, visibility signal, or dismissal signal to any other Participant.
4. WHERE a Reveal_Permitted_Viewer is also a member of the Far_Set, THE System SHALL display both the Near_Average_Callout and the Far_From_Average_Prompt to that Participant, and SHALL let each of the two panels be dismissed independently of the other.
5. THE Far_From_Average_Prompt SHALL display exactly one Callout_Phrase drawn from the far-from-average section of the Callout_Copy_Catalog, inviting the Participant to say or add something, and SHALL display that same Callout_Phrase for every re-render of the prompt within the same Voting_Round.
6. THE Far_From_Average_Prompt SHALL omit the viewing Participant's Ladder_Distance, the viewing Participant's own card value, the group average, the count of Participants further from the average, the display name and card value of every other Participant, and any comparison of the viewing Participant against another named Participant.
7. THE Far_From_Average_Prompt SHALL provide a multi-line text input for an optional Callout_Note that accepts at most 280 characters, a submit control, and a dismiss control, and SHALL present that text input empty each time the prompt becomes visible for a Voting_Round.
8. THE Far_From_Average_Prompt SHALL label the dismiss control with text that states declining as a complete and consequence-free choice, SHALL exclude the words "cancel", "skip", "ignore", and "later" from that label, and SHALL render the dismiss control with the same text size and the same target size as the submit control.
9. WHEN a Participant activates the dismiss control, THE System SHALL play the Exit_Flourish, SHALL discard any unsubmitted text without transmitting it, and SHALL leave the Far_From_Average_Prompt hidden for the remainder of that Voting_Round.
10. THE Far_From_Average_Prompt SHALL remain visible until an exit trigger defined in Requirement 5 occurs, with no automatic timeout.
11. WHEN the server confirms that a submitted Callout_Note has been stored for that Voting_Round, THE System SHALL play the Exit_Flourish on the Far_From_Average_Prompt and SHALL leave it hidden for the remainder of that Voting_Round.
12. IF the server rejects a submitted Callout_Note, THEN THE System SHALL keep the Far_From_Average_Prompt visible to that Participant only, SHALL retain the text the Participant entered, and SHALL display an error indication stating that the note was not saved.
13. WHILE a submitted Callout_Note is awaiting a server response, THE System SHALL disable the submit control of the Far_From_Average_Prompt, so that one activation of the submit control produces at most one stored Callout_Note.

---

### Requirement 4: Playful Copy Catalog and Emotional Safety

**User Story:** As a team member, I want the humour in these panels to be curated, varied, and kind, so that the feature stays funny over many sprints and never makes anyone feel judged.

#### Acceptance Criteria

1. THE Callout_Copy_Catalog SHALL be a named exported collection of text entries, and THE System SHALL source every displayed Callout_Phrase from the Callout_Copy_Catalog with no callout text literal embedded in a component template, so that the humour can be reviewed, translated, and amended as data.
2. THE Callout_Copy_Catalog SHALL contain a near-average section with at least 6 and at most 40 entries, a far-from-average section with at least 6 and at most 40 entries, a full-agreement section with at least 2 and at most 40 entries, and a wide-spread section with at least 2 and at most 40 entries, and every entry within a section SHALL be distinct from every other entry of that section under case-insensitive comparison with leading, trailing, and repeated whitespace normalised.
3. WHEN a callout requires a Callout_Phrase, THE System SHALL select the entry through a deterministic function of the Voting_Round identifier, the requested section, and the zero-based index of the entry displayed for the immediately preceding appearance of that section within the same Poker_Session, using no random source, no clock reading, and no state other than those three inputs, and SHALL supply a preceding index of -1 for the first appearance of that section within the Poker_Session.
4. THE Callout_Phrase selection function SHALL return exactly one entry that belongs to the requested section of the Callout_Copy_Catalog and contains at least one non-whitespace character, for every Voting_Round identifier value and for every preceding index value, including -1 and values outside the index range of that section.
5. WHERE a preceding appearance of the requested section exists within the same Poker_Session, THE Callout_Phrase selection function SHALL return an entry whose index differs from the index of that preceding entry.
6. Every entry in the far-from-average section SHALL be phrased as a question or an invitation ending in a question mark, SHALL address the Participant's reasoning, and SHALL contain no term from the error-attributing group of the Restricted_Term_List, which includes "wrong", "outlier", "off", "worst", "weird", and "mistake".
7. Every entry in the near-average section SHALL refer to the celebrated Participants only as a group, and SHALL contain no term from the ranking and comparison group of the Restricted_Term_List, no count of Participants, and no reference to any Participant outside the Near_Set.
8. THE System SHALL present no leaderboard, no ranking table, no accuracy score, no streak counter, and no cumulative per-Participant proximity statistic anywhere in this feature, and SHALL retain no per-Participant Ladder_Distance value beyond the Voting_Round it was computed for.
9. Every entry in the Callout_Copy_Catalog SHALL consist of between 12 and 90 characters inclusive, counting spaces, punctuation, and decorative glyphs, SHALL contain at most 2 decorative glyphs, and SHALL contain no term from the region-specific idiom group of the Restricted_Term_List.
10. WHERE an entry or panel displays an emoji or other decorative glyph, THE System SHALL mark that glyph as hidden from assistive technology, SHALL exclude that glyph from the panel's accessible name, and SHALL convey the callout's full information in the text that remains when every decorative glyph is removed.
11. Every entry in the far-from-average section SHALL contain at least one second-person pronoun and no Participant display name, and every entry in the near-average section SHALL contain no second-person pronoun, matching the voice of the existing toast and consensus indicator copy.
12. IF the requested section of the Callout_Copy_Catalog is absent or holds no entry, THEN THE System SHALL withhold the callout that requested the Callout_Phrase and SHALL display neither an empty panel nor placeholder text.
13. THE System SHALL hold the Restricted_Term_List as a named exported collection covering an error-attributing group, a ranking and comparison group, and a region-specific idiom group, and SHALL treat a term as present in an entry when it matches case-insensitively on a whole word, including its plural and verb-inflected forms, so that criteria 6, 7, and 9 are decidable by an automated check over every catalog entry.
14. THE Callout_Phrase selection function SHALL display every entry of a section at least once within any sequence of consecutive appearances of that section whose length equals twice the number of entries in that section, so that the humour stays varied across many Voting_Rounds.

---

### Requirement 5: Animation Choreography

**User Story:** As a Participant, I want these panels to arrive with personality, breathe while they sit there, and leave with a comic exit when the next story starts, so that the reveal moment feels alive rather than mechanical.

#### Acceptance Criteria

1. WHEN the Near_Average_Callout becomes visible, THE System SHALL play an Entrance_Flourish that scales the panel from a compressed state of between 40 and 60 percent of its resting size, through a single overshoot peak of between 105 and 112 percent of its resting size, to a final resting size of 100 percent within a tolerance of 0.5 percent, with a total duration between 300 and 600 milliseconds and an overshoot easing curve.
2. WHEN the Far_From_Average_Prompt becomes visible, THE System SHALL play an Entrance_Flourish that translates the panel from a starting offset of at least 100 percent of the panel width outside the nearest viewport edge to its resting position within a tolerance of 1 pixel, with a starting rotation of between 6 and 15 degrees that settles to 0 degrees within a tolerance of 0.1 degrees, with a total duration between 300 and 600 milliseconds and an overshoot easing curve.
3. THE Near_Average_Callout SHALL stagger the Entrance_Flourish of each displayed participant name by between 40 and 90 milliseconds relative to the preceding name in display order, and SHALL complete the whole staggered sequence within 900 milliseconds of the panel becoming visible, reducing the stagger interval toward 40 milliseconds as needed to stay within that 900 millisecond bound.
4. WHILE a callout rests in its visible state, THE System SHALL play an Idle_Flourish that repeats with a loop period between 1.5 and 4 seconds, whose translation amplitude is at least 1 pixel and at most 4 pixels, and whose rotation amplitude is at least 0.3 degrees and at most 1.5 degrees.
5. THE System SHALL stop the Idle_Flourish within 30 seconds of the callout becoming visible, SHALL return the panel to its resting transform within 300 milliseconds of stopping, and SHALL thereafter hold the panel with no translation exceeding 1 pixel and no rotation exceeding 0.1 degrees, so that the panel settles rather than moving for the whole discussion.
6. WHEN the server reports that a new Voting_Round has started, THE System SHALL play the Exit_Flourish on every visible callout.
7. THE Exit_Flourish SHALL combine a scale down to at most 30 percent of resting size, a rotation of at least 12 degrees, a downward translation of at least 50 percent of panel height, and a fade to full transparency, with a duration between 250 and 450 milliseconds.
8. WHEN the Exit_Flourish completes, THE System SHALL remove the callout element from the document.
9. WHEN the board is cleared, WHEN a re-vote starts, WHEN the current Voting_Round leaves Revealed_State, or WHEN the viewer dismisses a callout, THE System SHALL play the Exit_Flourish on every visible callout affected by that trigger.
10. WHEN a second exit trigger occurs while an Exit_Flourish is already running, THE System SHALL complete the running Exit_Flourish once and SHALL remove the callout element exactly once.
11. THE System SHALL animate only the CSS `transform`, `opacity`, and `filter` properties in the Entrance_Flourish, the Idle_Flourish, and the Exit_Flourish.
12. THE System SHALL animate at most 24 elements simultaneously within the Vote_Callout_Layer.
13. WHEN the Near_Set contains more names than the 24 elements the Vote_Callout_Layer animates simultaneously, THE System SHALL apply the Entrance_Flourish to the first 24 names in display order and SHALL render each surplus name at its resting transform and full opacity without an Entrance_Flourish within 900 milliseconds of the panel becoming visible, rather than exceeding the simultaneous animation budget.
14. THE System SHALL implement all callout motion with CSS keyframes, CSS transitions, and Angular's current enter and leave animation primitives, and SHALL introduce no dependency on the deprecated `@angular/animations` package and no third-party animation library.
15. WHEN the Entrance_Flourish of a callout completes, THE System SHALL start that callout's Idle_Flourish within 100 milliseconds, beginning from the resting transform reached by the Entrance_Flourish, with no visible discontinuity exceeding 1 pixel of translation or 0.1 degrees of rotation at the handoff.
16. IF an exit trigger occurs while the Entrance_Flourish of a callout is still running, THEN THE System SHALL cancel that Entrance_Flourish within 50 milliseconds, SHALL start the Exit_Flourish from the transform and opacity the element holds at cancellation, and SHALL NOT start that callout's Idle_Flourish.
17. IF a callout's Exit_Flourish has not reported completion within 700 milliseconds of the exit trigger, THEN THE System SHALL remove that callout element from the document exactly once and SHALL release its share of the simultaneous animation budget.

---

### Requirement 6: Reduced Motion and Animation Opt-Out

**User Story:** As a Participant who is sensitive to motion, I want to receive the same information without the bouncing and spinning, so that I can take part in planning without discomfort.

#### Acceptance Criteria

1. WHILE Reduced_Motion_Mode is active, THE System SHALL replace the Entrance_Flourish and the Exit_Flourish of every callout with an opacity-only transition of at most 150 milliseconds that runs from full transparency to full opacity on entrance and from full opacity to full transparency on exit, and SHALL remove the callout element from the document when that exit transition completes.
2. WHILE Reduced_Motion_Mode is active, THE System SHALL omit the Idle_Flourish entirely, scheduling no looping or repeating animation on any element within the Vote_Callout_Layer.
3. WHILE Reduced_Motion_Mode is active, THE System SHALL schedule no keyframe animation and no transition that changes the CSS `transform` property, or any of the `translate`, `rotate`, and `scale` properties, of any element within the Vote_Callout_Layer.
4. WHILE Reduced_Motion_Mode is active, THE System SHALL display the same Callout_Phrase text, the same participant names in the same order, the same count of names not displayed, and the same interactive controls, each operable, as it displays outside Reduced_Motion_Mode.
5. THE `SessionConfiguration` type SHALL include an optional `funCallouts` boolean property that controls whether this feature's callouts appear in the Poker_Session, and SHALL treat a record that omits that property as valid.
6. WHEN a Poker_Session is created, THE System SHALL set `funCallouts` to the boolean value supplied in the creation configuration, and SHALL set `funCallouts` to `true` when the creation configuration supplies no boolean value for that property.
7. WHILE the Poker_Session's `funCallouts` property is `false`, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session, including a Participant who joins the Poker_Session while the property is `false`.
8. WHEN the session owner changes the `funCallouts` setting in the Session_Settings_Panel, THE System SHALL store the new value and SHALL broadcast the updated configuration, carrying `funCallouts` as a boolean, to every connected Participant in that Poker_Session within 2 seconds and without requiring any Participant to reload the page.
9. WHEN the `funCallouts` setting changes to `false` while a callout is visible, THE System SHALL play the Exit_Flourish on every visible callout in that Poker_Session and SHALL remove each of those callout elements from the document exactly once when that Exit_Flourish completes.
10. IF a Participant other than the session owner submits a change to the `funCallouts` setting, THEN THE System SHALL reject the change, SHALL leave the stored configuration unchanged, SHALL broadcast no configuration update, and SHALL return an error message indicating the rejected setting to the submitting Participant only.
11. WHERE a stored `SessionConfiguration` record omits the `funCallouts` property, THE System SHALL treat the value as `true` through a single shared coercion helper, matching the handling already established for `fluidCardHeight`, and SHALL resolve every value that is not a JavaScript boolean to `true` through that same helper.
12. WHEN the operating system's reported reduced-motion preference changes while a callout is visible, THE System SHALL apply the behaviour of criteria 1 through 4 to every visible callout within 2 seconds and without requiring the Participant to reload the page.
13. IF a change to the `funCallouts` setting carries a value that is not a JavaScript boolean, THEN THE System SHALL reject the change, SHALL leave the stored configuration unchanged, and SHALL return an error message indicating the rejected setting to the submitting Participant only.

---

### Requirement 7: Non-Blocking Placement, Layering, and Pointer Behaviour

**User Story:** As a Participant, I want to keep reading the metrics and keep clicking cards while the callouts are on screen, so that the fun never gets in the way of the estimation work.

#### Acceptance Criteria

1. THE System SHALL render both the Near_Average_Callout and the Far_From_Average_Prompt inside a single Vote_Callout_Layer that is fixed to the viewport and whose bounding box intersects the bounding box of the page header, of the metrics panel, and of the card deck region by 0 pixels, with a clearance of at least 8 pixels from each of those three regions.
2. WHEN a pointer, mouse, or touch event is dispatched at a point that lies inside the Vote_Callout_Layer and outside the bounding box of every interactive control of the callouts, THE System SHALL deliver that event to the topmost session-page element at that point, by setting `pointer-events` to `none` on the Vote_Callout_Layer and setting `pointer-events` to `auto` only on the interactive controls of the callouts.
3. THE Vote_Callout_Layer SHALL form a single stacking context whose stack order is strictly below the countdown overlay, strictly below the toast container, and strictly below the modal dialog layers of the session page, and SHALL contain no descendant whose effective stack order exceeds that of the Vote_Callout_Layer, so that an existing overlay renders on top of every overlapping callout pixel.
4. THE Vote_Callout_Layer SHALL carry a stack order strictly above the board, metrics, card deck, story, issue, and history sections of the session page.
5. WHILE the countdown overlay is active, THE System SHALL suppress the display of both callouts and SHALL exclude the Vote_Callout_Layer from hit testing.
6. WHEN both callouts are visible to the same Participant, THE System SHALL stack them along the layer's anchored edge with the Near_Average_Callout nearest that edge and the Far_From_Average_Prompt next, SHALL separate their bounding boxes by a gap of at least 8 pixels, and SHALL render their bounding boxes with an intersection area of 0 pixels.
7. THE System SHALL constrain each callout to a width of at most 360 pixels and at most the viewport width minus 16 pixels, SHALL constrain each callout to a height of at most 40 percent of the viewport height, and WHEN a callout's content exceeds that height, THE System SHALL scroll that content inside the callout's own scroll container without changing the page scroll position or the document scrollable height.
8. THE System SHALL apply no page-level scroll lock, no backdrop, no `inert` attribute, and no `aria-modal` attribute while a callout is visible, and SHALL leave the page scroll position and the document scrollable height unchanged by the appearance or disappearance of a callout.
9. THE System SHALL animate the callouts such that, for the full duration of the animation, the bounding box of every element outside the Vote_Callout_Layer deviates by 0 pixels from its pre-animation position and size.
10. IF the viewport is too small for the Vote_Callout_Layer to satisfy the clearances of criterion 1 together with the size limits of criterion 7, THEN THE System SHALL suppress both callouts rather than render a callout that overlaps the page header, the metrics panel, or the card deck region.
11. WHEN a callout appears or disappears, THE System SHALL leave the currently focused element focused, SHALL keep the keyboard tab sequence of the session page elements in its existing order, and SHALL NOT confine keyboard focus to the Vote_Callout_Layer.
12. WHEN the countdown overlay becomes inactive, THE System SHALL resume display within 1 second for each callout that is still inside its display period.

---

### Requirement 8: Responsive and Overflow Behaviour

**User Story:** As a Participant on a phone or in a large session, I want the callouts to stay readable and out of the way, so that long name lists and narrow screens do not break the board.

#### Acceptance Criteria

1. WHILE the viewport width is below 768 pixels, THE System SHALL constrain each callout to a rendered width of at most the viewport width less 32 pixels, measured as the callout's outer box including its own padding and border.
2. WHILE the viewport width is below 768 pixels, THE System SHALL constrain the combined rendered height of all simultaneously visible callouts in the Vote_Callout_Layer to at most 45 percent of the viewport height, and IF the combined content height would exceed that limit, THEN THE System SHALL make the Vote_Callout_Layer internally scrollable rather than growing beyond 45 percent of the viewport height.
3. THE Near_Average_Callout SHALL display at most 8 participant names, and WHERE more than 8 participant names qualify for display, THE Near_Average_Callout SHALL display the first 8 names in the order supplied by the reveal result and SHALL represent the remaining names as a single summary element stating the count of names not displayed.
4. WHEN a display name exceeds 18 characters, THE Near_Average_Callout SHALL display the first 18 characters followed by an ellipsis and SHALL expose the untruncated display name through the element's `title` attribute and accessible name.
5. THE Near_Average_Callout SHALL wrap participant names onto additional lines rather than overflowing its own bounding box horizontally, such that no name element's rendered right edge extends past the callout's content box right edge.
6. WHEN the viewport is resized while a callout is visible, THE System SHALL re-apply the width and height constraints of criteria 1 and 2 and SHALL keep every edge of the callout inside the viewport bounds within 300 milliseconds of the resize event completing.
7. THE Far_From_Average_Prompt text input SHALL remain at least 44 pixels tall, and WHILE the on-screen keyboard of a mobile browser is open, THE System SHALL keep the full bounding box of the Far_From_Average_Prompt text input inside the visible viewport area not covered by the keyboard.
8. IF the viewport height is too small to satisfy both criterion 2 and criterion 7 at the same time, THEN THE System SHALL prioritise keeping the Far_From_Average_Prompt text input fully visible and SHALL reduce the Vote_Callout_Layer height below 45 percent of the viewport height as needed.

---

### Requirement 9: Keyboard and Assistive Technology Behaviour

**User Story:** As a Participant using a keyboard or a screen reader, I want to hear the callout and reach its controls without losing my place in the voting interface, so that the feature includes me rather than interrupting me.

#### Acceptance Criteria

1. WHEN a callout becomes visible, THE System SHALL leave keyboard focus on the element that held focus immediately before the callout appeared, SHALL move no keyboard focus into that callout, and SHALL leave the caret position and text selection of that element unchanged.
2. THE Near_Average_Callout SHALL expose its Callout_Phrase, every participant name it displays, and its summary element text to assistive technology through a polite live region that announces atomically as a single announcement, and SHALL emit that announcement within 1000 milliseconds of the panel becoming visible.
3. THE Far_From_Average_Prompt SHALL expose its Callout_Phrase to assistive technology through a polite live region that announces atomically as a single announcement, and SHALL emit that announcement within 500 milliseconds of the panel becoming visible.
4. THE System SHALL place the interactive controls of both callouts in the keyboard tab sequence after every interactive element of the main board content of the session page, SHALL expose no element of the callouts other than their interactive controls in the tab sequence, and SHALL assign no positive tab index value to any element of the Vote_Callout_Layer.
5. THE System SHALL give every interactive control of both callouts a non-empty accessible name that names the action the control performs and identifies the callout the control belongs to, and SHALL make that accessible name unique among the controls present in the Vote_Callout_Layer.
6. WHEN an interactive control of either callout receives keyboard focus, THE System SHALL render a focus indicator that fully surrounds that control's bounding box, is at least 2 CSS pixels thick, holds a contrast ratio of at least 3 to 1 against the callout background adjacent to it, and remains visible for as long as that control holds keyboard focus.
7. WHILE keyboard focus is inside a callout, WHEN the Participant presses the Escape key, THE System SHALL dismiss only that callout through the same dismiss behaviour as that callout's dismiss control, including discarding any unsubmitted Callout_Note text, and SHALL leave any other visible callout displayed.
8. WHEN a callout that contains keyboard focus is removed from the document, THE System SHALL move keyboard focus to the main board content region of the session page within 100 milliseconds of that removal, so that the next forward tab press continues from that region.
9. THE System SHALL give every interactive control of both callouts a target size of at least 32 by 32 pixels, measured as the control's bounding box including its padding, at every viewport width including widths below 768 pixels.
10. WHILE a callout rests in its visible state, THE System SHALL render that callout's Callout_Phrase text, participant name text, summary element text, and control label text at a contrast ratio of at least 4.5 to 1 against the callout background behind that text.
11. WHILE a callout remains visible and its displayed text and participant names are unchanged, THE System SHALL emit no further assistive technology announcement for that callout, so that the staggered name entrance and the Idle_Flourish produce exactly one announcement per appearance.
12. IF a callout is removed from the document while keyboard focus is outside that callout, THEN THE System SHALL leave keyboard focus on the element that holds it and SHALL leave that element's caret position and text selection unchanged.

---

### Requirement 10: Participant Note Capture, Transport, and Persistence

**User Story:** As a Participant who voted differently from the group, I want my short explanation to reach the team and survive into the round history, so that my reasoning influences the estimate instead of evaporating.

#### Acceptance Criteria

1. THE Far_From_Average_Prompt text input SHALL accept at most 280 characters and SHALL prevent entry of any character beyond the 280th, counting every typed, pasted, and whitespace character.
2. WHEN a Participant activates the submit control while the text input holds at least one non-whitespace character, THE System SHALL send a Callout_Note carrying the text with leading and trailing whitespace removed, the author's user ID, and the identifier of the Voting_Round the note was written for, and SHALL keep the submit control disabled until the server's acceptance or rejection for that submission is received.
3. WHILE the text input is empty or holds only whitespace characters, THE System SHALL disable the submit control.
4. WHEN the server receives a Callout_Note whose round identifier matches the current Voting_Round, THE System SHALL store the Callout_Note against that Voting_Round and SHALL broadcast the stored Callout_Note, with its author display name, to every Participant in that Poker_Session within 2 seconds of receipt.
5. WHEN the server receives a Callout_Note whose round identifier matches a Voting_Round already saved to history, THE System SHALL store the Callout_Note against that history entry and SHALL broadcast the stored Callout_Note, with its author display name and the identifier of the Voting_Round it belongs to, to every Participant in that Poker_Session within 2 seconds of receipt.
6. IF the server receives a Callout_Note whose text exceeds 280 characters after leading and trailing whitespace removal, THEN THE System SHALL reject the note, SHALL store nothing, SHALL return an error message indicating the 280-character limit to the submitting Participant only, and SHALL retain the submitted text in that Participant's text input with the submit control re-enabled.
7. IF the server receives a Callout_Note whose text is empty after leading and trailing whitespace removal, THEN THE System SHALL reject the note, SHALL store nothing, SHALL return an error message indicating that note text is required to the submitting Participant only, and SHALL leave that Participant's text input and submit control available for a further attempt.
8. IF the server receives a Callout_Note whose round identifier matches no Voting_Round in that Poker_Session, THEN THE System SHALL reject the note, SHALL store nothing, SHALL return an error message indicating the round is unknown to the submitting Participant only, and SHALL retain the submitted text in that Participant's text input with the submit control re-enabled.
9. THE System SHALL store Callout_Note text exactly as received after leading and trailing whitespace removal, with no other modification, and SHALL render it as text so that markup contained in a note is displayed literally rather than interpreted.
10. THE `HistoryEntry` type SHALL include an optional collection of Callout_Note records holding at most one Callout_Note per Participant, and THE System SHALL carry every Callout_Note record of a Voting_Round into its history entry when the board is cleared, with text, author, and round identifier unchanged.
11. THE session history panel SHALL display the author display name and the full stored text of every Callout_Note attached to a history entry, ordered oldest first by the time the server stored each note.
12. WHEN a Callout_Note is submitted successfully, THE System SHALL replace the Far_From_Average_Prompt content with an acknowledgement drawn from the Callout_Copy_Catalog and SHALL remove the text input and submit control for the Voting_Round the note was attached to.
13. WHEN a new Voting_Round starts while the Far_From_Average_Prompt text input holds at least one non-whitespace unsubmitted character, THE System SHALL retain that text together with the identifier of the Voting_Round the text was written for and SHALL collapse the Far_From_Average_Prompt into an Unsent_Note_Element that offers a submit control and a discard control.
14. THE Unsent_Note_Element SHALL remain available across any number of subsequent Voting_Round starts until the Participant submits the retained text, discards the retained text, or leaves the Poker_Session.
15. WHEN a Participant submits the text retained in the Unsent_Note_Element, THE System SHALL attach the Callout_Note to the Voting_Round the text was written for rather than to the Voting_Round currently in progress, and SHALL remove the Unsent_Note_Element only after the server accepts that note.
16. THE System SHALL leave the estimate export document format unchanged by this feature and SHALL exclude Callout_Note records from exported estimate documents.
17. IF the server receives a Callout_Note from a Participant who already has a stored Callout_Note for the identified Voting_Round, THEN THE System SHALL reject the note, SHALL leave the stored Callout_Note unchanged, and SHALL return an error message indicating that a note already exists for that round to the submitting Participant only.
18. WHEN a Participant activates the discard control on the Unsent_Note_Element, THE System SHALL delete the retained text, SHALL remove the Unsent_Note_Element, and SHALL send no Callout_Note.

---

### Requirement 11: Suppression and Edge Cases

**User Story:** As a Participant, I want the callouts to stay quiet whenever the numbers cannot support them, so that the feature never shows a nonsensical or empty panel.

#### Acceptance Criteria

1. WHILE the voting metrics of the current Voting_Round report insufficient data, that is, while fewer than two Participants have cast a Numeric_Vote in that round, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session.
2. WHILE the computed average of the current Voting_Round is null, is absent, or is not a finite number, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session.
3. WHILE the Poker_Session's active voting system has a Card_Ladder of fewer than two entries, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session.
4. WHILE the Poker_Session's active voting system is `t-shirt`, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session, which follows from criterion 3 of this requirement because no t-shirt size has a Card_Numeric_Value and the `t-shirt` Card_Ladder is therefore empty.
5. WHILE the current Voting_Round is outside Revealed_State, that is, while its status is not `revealed` or its voting metrics are unavailable on the client, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant in that Poker_Session.
6. WHILE the current Voting_Round is in Revealed_State, at least two Participants cast a Numeric_Vote, and every Participant who cast a Numeric_Vote selected the same card value, THE System SHALL display the Near_Average_Callout with its full-agreement Callout_Phrase variant to every Reveal_Permitted_Viewer and SHALL display the Far_From_Average_Prompt to no Participant.
7. WHILE exactly one Participant cast a Numeric_Vote in the current Voting_Round, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant, because the voting metrics report insufficient data in that condition.
8. WHILE the current Voting_Round is in Revealed_State, at least two Participants cast a Numeric_Vote, and every Participant who cast a Numeric_Vote is a member of the Far_Set, THE System SHALL display the Near_Average_Callout with its wide-spread Callout_Phrase variant and no participant names to every Reveal_Permitted_Viewer, and SHALL display the Far_From_Average_Prompt privately to each Participant in the Far_Set.
9. WHEN the System receives Poker_Session participant state in which a Participant whose display name is shown in a visible Near_Average_Callout is no longer present, THE System SHALL re-evaluate the Proximity_Classifier against the remaining selections, SHALL remove that display name from the Near_Average_Callout within 2 seconds, and SHALL leave the currently displayed Callout_Phrase unchanged while the resulting Near_Set is non-empty.
10. WHEN the Near_Set becomes empty because the last Participant it contained was removed from the Poker_Session while the Near_Average_Callout is visible, THE System SHALL display the wide-spread Callout_Phrase variant with no participant names within 2 seconds rather than an empty name list, and SHALL keep the Near_Average_Callout visible while the Far_Set remains non-empty.
11. WHILE the session page is showing its session-not-found state, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt, and SHALL hold no callout element in the document.
12. WHILE the session page has paused interaction because the connection is not established, THE System SHALL display no callout that was not already visible when the connection was lost, and SHALL leave every already visible callout displayed without replaying its Entrance_Flourish.
13. WHILE the current Voting_Round is in Revealed_State, the voting metrics report sufficient data, and both the Near_Set and the Far_Set are empty, THE System SHALL display neither the Near_Average_Callout nor the Far_From_Average_Prompt to any Participant.
14. THE System SHALL evaluate the suppression conditions stated in criteria 1 through 5 and criteria 11 through 13 of this requirement before the display conditions of the Near_Average_Callout and the Far_From_Average_Prompt, so that a satisfied suppression condition always overrides a satisfied display condition.
15. IF a suppression condition stated in criteria 1 through 5, criterion 11, or criterion 13 of this requirement becomes true while a callout is visible, THEN THE System SHALL play the Exit_Flourish on that callout, SHALL remove that callout from the document within 2 seconds, and SHALL retain any unsubmitted Callout_Note text held by that Participant.

---

### Requirement 12: Reconnect, Refresh, Dismissal Memory, and Session Isolation

**User Story:** As a Participant who refreshed the page or dropped off the network, I want the callouts to behave predictably on return, so that the feature neither loses my place nor nags me with a panel I already dismissed.

#### Acceptance Criteria

1. WHEN a Participant reconnects to a Poker_Session whose current Voting_Round is in Revealed_State, THE System SHALL evaluate the Proximity_Classifier against the synchronised round state within 2 seconds of receiving that state, and SHALL display every callout that the evaluation and that Participant's permissions warrant and for which no Dismissal_Record exists for the current combination of Poker_Session identifier, Voting_Round identifier, and callout identity.
2. THE System SHALL record the dismissal of a callout as a Dismissal_Record against the combination of Poker_Session identifier, Voting_Round identifier, and the identity of the dismissed callout, in storage scoped to the browser tab, retaining at most the 50 most recent Dismissal_Records and discarding the oldest record first when a new record would exceed that limit.
3. WHILE a Dismissal_Record exists for the combination of the current Poker_Session identifier, the current Voting_Round identifier, and a given callout, THE System SHALL withhold that callout from that Participant, and SHALL continue to withhold it across page reload and across reconnection for as long as that Voting_Round remains the current Voting_Round.
4. WHEN a Participant joins a Poker_Session whose current Voting_Round is already in Revealed_State and that Participant cast no selection in that round, THE System SHALL display no Far_From_Average_Prompt to that Participant for that Voting_Round, and SHALL govern the display of the Near_Average_Callout to that Participant solely by that Participant's reveal permission.
5. THE System SHALL derive callout state only from the state of the Poker_Session identified by the current route, and SHALL discard every derived Near_Set, Far_Set, dismissal evaluation, and visible callout of a previously routed Poker_Session before displaying any callout for the newly routed Poker_Session, so that a callout of one Poker_Session is never displayed in another Poker_Session.
6. WHEN a Participant navigates away from the session page, THE System SHALL remove every visible callout from the document without playing the Exit_Flourish and SHALL cancel every pending animation timer and frame request of the Vote_Callout_Layer, leaving no timer and no frame request scheduled by the Vote_Callout_Layer outstanding.
7. WHEN a Participant signs out, THE System SHALL clear every Dismissal_Record and every retained unsent note text held for that browser tab, and SHALL discard that data without transmitting it to the server.
8. IF the storage scoped to the browser tab is unavailable or a write of a Dismissal_Record fails, THEN THE System SHALL hold that dismissal in memory for the lifetime of the loaded page, SHALL withhold the dismissed callout for the remainder of that Voting_Round, and SHALL display no error indication to the Participant.
9. WHEN the session page is reloaded, THE System SHALL restore the Dismissal_Records and the retained unsent note text held in storage scoped to that browser tab before evaluating the visibility of any callout, so that a callout dismissed before the reload stays hidden after the reload.
10. IF a retained unsent note text is restored after a page reload or a reconnection while the Voting_Round it was written for is no longer the current Voting_Round, THEN THE System SHALL present that text in the Unsent_Note_Element and SHALL keep it attached to the Voting_Round identifier it was written for.

---

### Requirement 13: Isolation, Non-Regression, and Quality

**User Story:** As a developer, I want this feature to be additive, well tested, and confined to the poker board, so that the retrospective board and the existing poker flow keep working untouched.

#### Acceptance Criteria

1. THE System SHALL leave the retrospective session registry, the retrospective WebSocket handler, the retrospective routes, and every retrospective component unchanged, such that every pre-existing retrospective automated test passes without any edit to its setup, inputs, or assertions, and such that no Callout_Note type, event, or component is referenced from any retrospective module.
2. WHERE every selection of a round is drawn from the card values of the plain `fibonacci` deck or the special cards, THE System SHALL leave the calculation of `average`, `mode`, `spread`, `distribution`, `outliers`, `numericVoteCount`, and `insufficientData` unchanged, such that each of these seven values is identical to the value produced before this feature was added and such that every pre-existing metrics test passes without any edit to its assertions, while the corrections specified in Requirement 14 and Requirement 15 apply to the selections and voting systems outside that deck.
3. THE System SHALL leave the existing reveal, board-clear, re-vote, issue, and participant WebSocket flows unchanged, such that the name, payload fields, and recipient set of every pre-existing event in those flows are identical to those produced before this feature was added, and such that the only additions are the Callout_Note event routing and the optional Callout_Note collection carried on Voting_Round and history payloads.
4. WHEN the server receives a Callout_Note event, THE System SHALL route it through the existing poker WebSocket handler and SHALL deliver the resulting broadcast only to the connections joined to the Poker_Session identified by that event, so that zero Callout_Note messages reach a connection joined to another Poker_Session and zero reach the retrospective WebSocket endpoint.
5. THE System SHALL define every type, enumeration, and constant shared between the client and the server for this feature in the shared types module, and SHALL import them on both the client and the server from that single module rather than redeclaring any of them.
6. THE System SHALL serialise the Callout_Note collection of a Voting_Round across the WebSocket boundary as a JSON array, so that no `Map` instance is sent unserialised and so that deserialising the array on the receiving side yields a collection deeply equal to the sent collection, preserving each note's text, author identifier, round identifier, and position in the collection, for collections of 0 up to 100 notes.
7. THE System SHALL add new components as Angular standalone components that declare their own `imports`, hold their state in signals and computed signals, register no NgModule, and are reached from the session route without adding a new eagerly loaded route.
8. THE System SHALL introduce no `any` type annotation, assertion, or cast in the code added for this feature, and SHALL compile with zero errors and zero warnings under the project's strict TypeScript and strict template settings.
9. THE automated test suites of the client and the server SHALL each run to completion after this feature is integrated with zero failing tests and zero tests newly skipped or disabled by this feature.
10. THE unit test coverage of the code added for this feature SHALL be at least 90 percent of statements and at least 90 percent of branches, measured over the client and server source files added or modified by this feature.
11. THE automated tests of this feature SHALL assert the Ladder_Distance boundary values 0.75 and 2.0 as both inclusive thresholds, the unclassified band strictly between them, the 280-character Callout_Note limit at 280 and at 281 trimmed characters, and the empty-after-trim rejection.
12. IF the Callout_Note collection received on a Voting_Round or history payload cannot be deserialised into a collection of Callout_Note records, THEN THE System SHALL treat that collection as empty, SHALL leave every other field of the received round or history state applied unchanged, and SHALL continue rendering the board without an uncaught error.
13. IF the server receives a Callout_Note event whose Poker_Session identifier differs from the Poker_Session the sending connection is joined to, THEN THE System SHALL reject the event, SHALL store nothing, SHALL broadcast nothing, and SHALL return an error message indicating the session mismatch to the sending connection only.

---

### Requirement 14: Correct Numeric Classification in the Metrics Engine

**User Story:** As a Participant estimating with the modified-Fibonacci or t-shirt deck, I want the metrics panel to report either a real number or no number at all, so that I never read a corrupted average and never act on a figure the engine cannot actually compute.

#### Acceptance Criteria

1. THE System SHALL define Card_Numeric_Value as a single shared mapping from card value to real number, in which every card value of the `fibonacci` system and of the `power-of-2` system maps to that card value itself, every numeric card value of the `modified-fibonacci` system maps to that card value itself, and the card value `'½'` maps to 0.5.
2. THE System SHALL assign no Card_Numeric_Value to the special cards `coffee`, `no-clue`, and `break`, and SHALL assign no Card_Numeric_Value to the t-shirt sizes `XS`, `S`, `M`, `L`, `XL`, and `XXL`.
3. THE Metrics_Engine SHALL classify a selection as a Numeric_Card only when that selection's card value has a Card_Numeric_Value.
4. THE Metrics_Engine SHALL compute `average` as the arithmetic mean of the Card_Numeric_Values of the Numeric_Vote selections, using the Card_Numeric_Value of each selection in place of its raw card value.
5. THE Metrics_Engine SHALL compute `spread` as the difference between the greatest and the least Card_Numeric_Value among the Numeric_Vote selections.
6. THE Metrics_Engine SHALL compute `outliers` from Card_Numeric_Values rather than from raw card values, as further specified in Requirement 15.
7. THE Metrics_Engine SHALL count in `numericVoteCount` only the selections whose card value has a Card_Numeric_Value.
8. WHILE fewer than two selections of a round have a Card_Numeric_Value, THE Metrics_Engine SHALL set `insufficientData` to `true`, SHALL set `average` to null, SHALL set `mode` to null, SHALL set `spread` to null, and SHALL return an empty `outliers` collection.
9. WHILE the active voting system is `t-shirt`, THE Metrics_Engine SHALL set `insufficientData` to `true` and SHALL set `average`, `mode`, and `spread` each to null, because no t-shirt size has a Card_Numeric_Value.
10. THE Metrics_Engine SHALL return an `average` that is either null or a finite number, and a `spread` that is either null or a finite number, for every selection map and every active voting system it is called with.
11. THE Metrics_Engine SHALL return `NaN` for neither `average` nor `spread` under any selection map and any active voting system.
12. THE Metrics_Engine SHALL count every card value present in the selections, including the special cards `coffee`, `no-clue`, and `break` and including the t-shirt sizes, in `distribution`, such that the sum of the counts in `distribution` equals the number of selections in the round.
13. THE Metrics_Engine SHALL select `mode` among the Card_Numeric_Values of the Numeric_Vote selections as the Card_Numeric_Value held by the greatest number of those selections, and SHALL resolve a tie in that count in favour of the least Card_Numeric_Value, preserving the tie-break the Metrics_Engine applies today.
14. THE Metrics_Engine SHALL return `mode` as the card value whose Card_Numeric_Value was selected, such that a round whose mode is the `modified-fibonacci` card `'½'` reports `mode` as `'½'` rather than as 0.5.
15. WHERE every selection of a round is drawn from the card values of the plain `fibonacci` deck or the special cards, THE Metrics_Engine SHALL return `average`, `mode`, `spread`, `distribution`, `outliers`, `numericVoteCount`, and `insufficientData` each identical to the value the Metrics_Engine returns for that selection map before this feature is implemented, such that every pre-existing metrics test passes without any edit to its inputs or assertions.
16. THE Metrics_Engine SHALL accept the extended card value set, covering every card value of every voting system declared in the shared types module, at its public signature, such that every call site passes its selections without a narrowing type cast and such that the `asCardValue` workaround helper used by the export tests is no longer required.
17. IF a selection carries a card value that belongs to no voting system known to the System, THEN THE Metrics_Engine SHALL count that card value in `distribution`, SHALL exclude that selection from `average`, `mode`, `spread`, `outliers`, and `numericVoteCount`, and SHALL return its result without raising an error.
18. THE Metrics_Engine SHALL remain a pure function of its arguments, producing the same result for the same selections and active voting system, mutating no argument, and reading no clock, network, or browser state.

---

### Requirement 15: Voting-System-Aware Outlier Detection

**User Story:** As a Participant estimating with the power-of-2 or modified-Fibonacci deck, I want divergent votes flagged on my deck rather than silently ignored, so that the outlier count in the metrics panel reflects what the team actually voted.

#### Acceptance Criteria

1. THE Metrics_Engine SHALL accept the active voting system identifier of the Poker_Session as an argument alongside the round's selections.
2. THE Metrics_Engine SHALL compute `outliers` against the Card_Ladder of the supplied active voting system rather than against the `FIBONACCI_SEQUENCE` constant.
3. THE Metrics_Engine SHALL place a Participant in `outliers` when the absolute difference between the index of that Participant's card value within the Card_Ladder and the index of the `mode` card value within that same Card_Ladder is greater than 2, preserving the threshold of 2 the Metrics_Engine applies today.
4. WHILE the active voting system is `power-of-2`, THE Metrics_Engine SHALL evaluate the outlier condition of criterion 3 for every Numeric_Vote of the round, including the card values 4, 16, 32, and 64.
5. WHILE the active voting system is `modified-fibonacci`, THE Metrics_Engine SHALL evaluate the outlier condition of criterion 3 for every Numeric_Vote of the round, including the card values `'½'`, 20, 40, and 100.
6. WHERE the Card_Ladder of the active voting system holds fewer than two entries, including the `t-shirt` system whose Card_Ladder is empty, THE Metrics_Engine SHALL return an empty `outliers` collection.
7. WHERE the active voting system is `fibonacci`, THE Metrics_Engine SHALL return an `outliers` collection equal to the collection it returns for that selection map before this feature is implemented, with the order of its entries preserved.
8. THE Metrics_Engine SHALL exclude from `outliers` every Participant whose selection has no Card_Numeric_Value and every Participant who cast no selection in the round.
9. THE Metrics_Engine SHALL exclude from `outliers` every Participant whose card value is absent from the Card_Ladder of the active voting system.
10. THE System SHALL pass the active voting system identifier at every call site of the Metrics_Engine, namely the two calls in `server/src/services/game-session.ts` and the two calls in `server/src/services/session-manager.ts`, such that no call site relies on a default voting system value.
11. IF the supplied active voting system identifier matches no voting system known to the System, THEN THE Metrics_Engine SHALL return an empty `outliers` collection and SHALL return its remaining metrics fields without raising an error.
12. THE System SHALL keep the mode-relative `outliers` collection and this feature's average-relative Near_Set and Far_Set as separate values computed by separate functions, and SHALL present them to the Participant through separate elements carrying separate labels, such that no element describes the `outliers` collection and the Far_Set as the same notion and no element displays a value of one under the label of the other.
13. THE System SHALL leave the `VotingMetrics.outliers` field name, its position in the `VotingMetrics` type, and its list-of-user-identifier shape unchanged, such that every existing consumer of that field continues to read it without modification.

---

## Correctness Properties

These properties are intended for property-based verification with `fast-check` over generated selection maps, voting systems, and participant lists.

1. **Disjointness** — For every generated selection map and voting system, the Near_Set and the Far_Set share no member. Guaranteed structurally by the 0.75 and 2.0 thresholds in Requirement 1.
2. **Classification soundness** — Every member of the Near_Set and of the Far_Set cast a Numeric_Vote whose card value appears in the Card_Ladder of the active voting system.
3. **Suppression under insufficient data** — Whenever the voting metrics report insufficient data, or the average is not finite, the Proximity_Classifier returns an empty Near_Set and an empty Far_Set.
4. **Distance monotonicity** — For any two classified Participants, if the first has a strictly smaller Ladder_Distance than the second, then membership of the second in the Near_Set implies membership of the first in the Near_Set, and membership of the first in the Far_Set implies membership of the second in the Far_Set.
5. **Near ordering** — The Near_Set ordering produced by the Proximity_Classifier is non-decreasing in Ladder_Distance for every generated input.
6. **Classifier purity and idempotence** — Calling the Proximity_Classifier twice with the same inputs yields deeply equal results and leaves the input selection map unmodified.
7. **Copy totality** — For every Voting_Round identifier, every section of the Callout_Copy_Catalog, and every previous-entry index, the Callout_Phrase selection function returns a non-empty string that is a member of the requested section.
8. **Copy non-repetition** — For every Voting_Round identifier and every previous-entry index, the selected Callout_Phrase differs from the entry at the previous-entry index.
9. **Copy tone constraints** — Every entry of the Callout_Copy_Catalog is at most 90 characters and contains none of the forbidden judgement words listed in Requirement 4.
10. **Exit totality** — For every sequence of generated round-state transitions, any transition that starts a new round, clears the board, starts a re-vote, or leaves Revealed_State drives every visible callout to the exited state, and leaves no callout element in the document.
11. **Exit idempotence** — Applying two or more exit triggers to the same callout removes that callout element exactly once.
12. **Reduced-motion safety** — While Reduced_Motion_Mode is active, the animation plan produced for any callout and any round state contains no keyframe or transition that targets the CSS `transform` property.
13. **Animation budget** — For every generated participant list, the count of elements the Vote_Callout_Layer animates simultaneously is at most 24.
14. **Note round-trip** — For every generated Callout_Note of at most 280 trimmed characters, serialising the note for WebSocket transport and deserialising it yields a note deeply equal to the original, including its author identifier and round identifier.
15. **Note validation** — For every generated string, the note is accepted exactly when its trimmed length lies between 1 and 280 inclusive, and is rejected otherwise with nothing stored.
16. **Session isolation** — For every generated pair of distinct Poker_Session states, the callout state derived for the first session is independent of the state of the second session.
17. **Entrance-to-idle handoff termination** — For every generated sequence of animation lifecycle events, a callout whose Entrance_Flourish completes without an intervening exit trigger reaches the idle state within 100 milliseconds of that completion, and any subsequent exit trigger still drives that callout to removal from the document exactly once. Derived from Requirement 5 criteria 15 and 8.
18. **Exit-during-entrance cancellation** — For every generated exit trigger that arrives while the Entrance_Flourish of a callout is still running, the resulting animation plan cancels the Entrance_Flourish, schedules no Idle_Flourish for that callout, and terminates with the callout element removed from the document exactly once. Derived from Requirement 5 criteria 16 and 8.
19. **Exit removal deadline** — For every generated callout whose Exit_Flourish reports no completion event, the callout element is removed from the document exactly once by the 700 millisecond deadline measured from the exit trigger, and the simultaneous animation budget it held is released. Derived from Requirement 5 criterion 17.
20. **Restricted term check totality** — For every entry of every section of the Callout_Copy_Catalog and every term of every group of the Restricted_Term_List, the whole-word case-insensitive presence check terminates and returns a boolean, so the tone constraints of Requirement 4 criteria 6, 7, and 9 are decidable for the whole catalog. Derived from Requirement 4 criterion 13.
21. **Copy coverage within twice section length** — For every section of the Callout_Copy_Catalog and every generated sequence of consecutive appearances of that section whose length equals twice the number of entries in that section, every entry of that section is selected at least once. Derived from Requirement 4 criterion 14.
22. **One note per Participant per round** — For every generated sequence of Callout_Note submissions, the stored Callout_Note collection of a Voting_Round holds at most one note per Participant, and every submission after a Participant's first accepted note for that round is rejected with the stored note left unchanged. Derived from Requirement 10 criteria 17 and 10.
23. **Suppression precedence** — For every generated combination of round state, metrics, voting system, permissions, and page state, whenever any suppression condition of Requirement 11 holds, the resolved visibility of both the Near_Average_Callout and the Far_From_Average_Prompt is hidden, regardless of which display conditions also hold. Derived from Requirement 11 criterion 14.
24. **Dismissal record eviction bound** — For every generated sequence of dismissals, the stored Dismissal_Record collection holds at most 50 records, holds the 50 most recent dismissals of that sequence, and retains the record for the current combination of Poker_Session identifier, Voting_Round identifier, and callout identity whenever that dismissal is among the 50 most recent. Derived from Requirement 12 criterion 2.
25. **No NaN metrics** — For every generated selection map over every voting system, including maps mixing special cards, t-shirt sizes, and `'½'`, the `average` the Metrics_Engine returns is null or a finite number and the `spread` it returns is null or a finite number, and neither is `NaN`. Derived from Requirement 14 criteria 10 and 11.
26. **Null metrics exactly on insufficient numeric votes** — For every generated selection map and voting system, `average` is null and `spread` is null exactly when fewer than two selections have a Card_Numeric_Value, and both are non-null finite numbers otherwise. Derived from Requirement 14 criterion 8.
27. **Fibonacci metrics non-regression** — For every generated selection map drawn from the plain `fibonacci` deck and the special cards, each of `average`, `mode`, `spread`, `distribution`, `outliers`, `numericVoteCount`, and `insufficientData` equals the value produced by the pre-change Metrics_Engine for the same selection map. Derived from Requirement 14 criterion 15 and Requirement 15 criterion 7.
28. **Outlier soundness** — For every generated selection map and voting system, every member of `outliers` cast a selection whose card value has a Card_Numeric_Value, appears in the Card_Ladder of that voting system, and holds a Card_Ladder index whose absolute difference from the Card_Ladder index of `mode` is greater than 2. Derived from Requirement 15 criteria 3, 8, and 9.
29. **Outlier emptiness on short ladders** — For every generated selection map and every voting system whose Card_Ladder holds fewer than two entries, the returned `outliers` collection is empty. Derived from Requirement 15 criterion 6.
30. **Distribution totality** — For every generated selection map and voting system, the sum of the counts in `distribution` equals the number of selections in that map, and `distribution` holds one key per distinct card value present. Derived from Requirement 14 criterion 12.
31. **Mode card-value fidelity** — For every generated selection map whose `mode` is non-null, the returned `mode` is a card value present in the selections whose Card_Numeric_Value is the modal Card_Numeric_Value, so a modal `'½'` is reported as `'½'`. Derived from Requirement 14 criteria 13 and 14.

---

## Decisions Recorded for Review

These choices were made to produce a complete first draft. Each is a product-level call that can be changed before design begins.

1. **New classifier instead of reusing `outliers`.** The existing `outliers` field measures Fibonacci index distance from the **mode**, and its index table covers only the plain Fibonacci ladder, so it produces no classification at all for `power-of-2`, `modified-fibonacci`, or `t-shirt`. Reusing it would also put two different meanings of "outlier" in the same panel. Requirement 1 therefore specifies an independent, average-relative, ladder-based classifier and leaves `outliers` alone.
2. **Ladder distance instead of raw numeric distance.** On the Fibonacci ladder, 55 and 89 are adjacent cards but 34 apart numerically, so a raw threshold would brand every high estimate as far from the average. Measuring in card steps keeps the thresholds meaningful across all numeric voting systems.
3. **Thresholds of 0.75 and 2.0 card steps**, with a deliberate unclassified band between them so that an ordinary vote triggers nothing at all.
4. **Client-side derivation.** Selections, metrics, and round state already reach every client, so the classification needs no new broadcast. Only the optional note introduces a new WebSocket event.
5. **Notes are broadcast to the whole session and attributed to their author.** The note is opt-in speech, so attribution serves the team. The panel that invites it stays private.
6. **Notes persist into `HistoryEntry` but the CSV export format is unchanged**, to keep the blast radius of this feature off the existing export route and its tests.
7. **A `funCallouts` session setting is included**, following the `countdownAnimation` precedent, so a team that finds the panels distracting can switch them off without a code change.
8. **A reveal-permitted viewer who also voted far sees both panels.** Suppressing the prompt for moderators would deny them the same invitation to explain their thinking.
9. **No automatic timeout.** The panels leave on a round transition or a dismissal, matching the request that they disappear when the next story's voting starts.
10. **`'½'` is mapped to a Card_Numeric_Value of 0.5 rather than excluded from numeric statistics.** Excluding it would be the smaller change, but it would silently drop a legitimate half-point estimate out of the average, the mode, and the spread, so a team that voted `0`, `'½'`, `1` would see metrics computed from two of their three votes with no indication that one was discarded.
11. **A t-shirt round now reports `insufficientData` rather than fabricating numbers.** No t-shirt size carries a defensible numeric value, so the honest result is no average, no mode, and no spread, rather than a figure derived from an invented ordinal scale.
12. **The mode-relative `outliers` field is repaired rather than deleted.** The metrics panel already reads it and a team already relies on it on the Fibonacci deck, so Requirement 15 makes it correct on every deck. The callouts keep their own average-relative Near_Set and Far_Set, and Requirement 15 criterion 12 keeps the two presented as the separate notions they are.

### Pre-Existing Behaviour Now In Scope

Both defects in the server metrics engine are now specified in this document rather than deferred: the non-number card values that corrupt `average`, `mode`, and `spread` are addressed by Requirement 14, and the outlier detection that is inert outside the plain Fibonacci deck is addressed by Requirement 15.

Recorded for context: the export layer's `formatAverage` already renders a non-finite average as `-`, which masked Defect A on the one surface a team looks at most, which is why the corrupted `average` and `spread` produced no reported user-visible symptom even though every other consumer of `VotingMetrics` received `NaN`. Requirements 1.13 and 11.2 remain in place, so the callouts stay inert whenever the average is not a finite number regardless of the engine repair.
