# Implementation Plan: Multi-Session Improvements (Phase 1)

## Overview

This plan implements moderator controls, session integrity, UX enhancements, workflow features, and reliability improvements for the Scrum Poker application. Tasks are ordered by dependency: shared types first, then backend logic, then backend API/WebSocket layer, then frontend services, then frontend components.

## Tasks

- [ ] 1. Extend shared types with new interfaces
  - [x] 1.1 Add `IssueItem`, `SessionSummary`, and `ConsensusLevel` types to `shared/types.ts`
    - Add `IssueItem` interface with `id`, `title`, `status`, `historyEntryId?`, `createdAt`
    - Add `SessionSummary` interface with `sessionId`, `createdAt`, `lastActivityAt`, `completedRounds`, `participantCount`, `config`
    - Add `ConsensusLevel` type: `'full' | 'partial' | 'high-divergence' | 'none'`
    - Extend `GameSessionState` to include `issueList: IssueItem[]`
    - _Requirements: 7.2, 7.7, 9.1, 11.4_

  - [x] 1.2 Add `computeConsensusLevel` pure function to `shared/types.ts`
    - Implement consensus computation logic per design specification
    - Handle numeric systems (spread-based) and t-shirt system (position-based)
    - Return `'none'` for null metrics or insufficient data
    - _Requirements: 9.2, 9.3, 9.4_

  - [x] 1.3 Write property test for `computeConsensusLevel`
    - **Property 11: Consensus level computation**
    - **Validates: Requirements 9.2, 9.3, 9.4**
    - Test file: `shared/__tests__/consensus.property.spec.ts`
    - Generate random VotingMetrics with varying spread, numericVoteCount, insufficientData, and votingSystem

  - [x] 1.4 Write unit tests for new shared types and `computeConsensusLevel`
    - Test all consensus levels with concrete examples
    - Test edge cases: null metrics, zero votes, t-shirt position spread
    - Test file: `shared/__tests__/consensus.spec.ts`
    - _Requirements: 9.2, 9.3, 9.4_

- [ ] 2. Implement backend GameSession enhancements
  - [x] 2.1 Add issue list management methods to `GameSession`
    - Add `private issueList: IssueItem[]` field
    - Implement `addIssue(title: string): IssueItem`
    - Implement `addIssues(titles: string[]): IssueItem[]`
    - Implement `removeIssue(issueId: string): void`
    - Implement `reorderIssues(orderedIds: string[]): void`
    - Implement `getIssueList(): IssueItem[]`
    - Implement `markIssueEstimated(issueId: string, historyEntryId: string): void`
    - Implement `selectIssueForEstimation(issueId: string): VotingRound`
    - Update `getSessionState()` to include `issueList`
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 2.2 Write property test for issue list add
    - **Property 5: Issue list add appends correctly**
    - **Validates: Requirements 7.2**
    - Test file: `server/src/services/__tests__/game-session-issues.property.spec.ts`

  - [x] 2.3 Write property test for bulk import parsing
    - **Property 6: Bulk import parsing splits on newlines**
    - **Validates: Requirements 7.3**
    - Test file: `server/src/services/__tests__/game-session-issues.property.spec.ts`

  - [x] 2.4 Write property test for issue list reorder
    - **Property 7: Issue list reorder produces correct order**
    - **Validates: Requirements 7.4**
    - Test file: `server/src/services/__tests__/game-session-issues.property.spec.ts`

  - [x] 2.5 Write property test for issue selection starts round
    - **Property 8: Issue selection starts round with correct description**
    - **Validates: Requirements 7.6**
    - Test file: `server/src/services/__tests__/game-session-issues.property.spec.ts`

  - [x] 2.6 Write property test for issue list in session state
    - **Property 9: Issue list included in session state**
    - **Validates: Requirements 7.7**
    - Test file: `server/src/services/__tests__/game-session-issues.property.spec.ts`

  - [x] 2.7 Add `revote()` method to `GameSession`
    - Throw if no current round or round not revealed
    - Preserve `storyDescription` from current round
    - Discard current round without saving to history
    - Call `startRound(storyDescription)` to create fresh round
    - _Requirements: 8.2, 8.3, 8.4_

  - [x] 2.8 Write property test for re-vote
    - **Property 10: Re-vote preserves story, resets state, does not save history**
    - **Validates: Requirements 8.2, 8.3, 8.4**
    - Test file: `server/src/services/__tests__/game-session-revote.property.spec.ts`

  - [x] 2.9 Add `removeParticipantByModerator(userId: string)` method to `GameSession`
    - Delete participant's active selection from current round if any
    - Remove participant from participants map
    - Call `touch()` to update lastActivityAt
    - _Requirements: 1.2, 1.6_

  - [x] 2.10 Write property test for participant removal
    - **Property 2: Participant removal discards selection and removes from list**
    - **Validates: Requirements 1.2, 1.6**
    - Test file: `server/src/services/__tests__/game-session-removal.property.spec.ts`

  - [x] 2.11 Add `hasDisplayName(displayName: string): boolean` method to `GameSession`
    - Case-insensitive comparison with trimming
    - Return true if any existing participant has matching name
    - _Requirements: 2.1, 2.4, 2.5_

  - [x] 2.12 Write property test for display name uniqueness
    - **Property 3: Display name uniqueness with case-insensitive comparison**
    - **Validates: Requirements 2.1, 2.4, 2.5**
    - Test file: `server/src/services/__tests__/game-session-displayname.property.spec.ts`

  - [x] 2.13 Write property test for voting duration computation
    - **Property 4: Voting duration computation**
    - **Validates: Requirements 3.3, 14.3**
    - Test file: `server/src/services/__tests__/game-session-timer.property.spec.ts`

  - [x] 2.14 Write property test for UTC timestamp format
    - **Property 13: Timestamps stored in UTC ISO 8601 format**
    - **Validates: Requirements 14.1**
    - Test file: `server/src/services/__tests__/game-session-timer.property.spec.ts`

  - [x] 2.15 Write unit tests for all new GameSession methods
    - Test `removeParticipantByModerator`: removes participant, discards selection, handles missing user
    - Test `hasDisplayName`: case-insensitive, trimming, release on remove
    - Test `revote`: preserves story, resets state, throws on invalid state
    - Test `addIssue/addIssues`: appends correctly, rejects empty titles
    - Test `reorderIssues`: valid reorder, invalid IDs rejected
    - Test `selectIssueForEstimation`: starts round, marks issue as estimating
    - Test `getSessionState`: includes issueList
    - Test file: `server/src/services/__tests__/game-session.spec.ts`
    - _Requirements: 1.2, 1.6, 2.1, 2.4, 2.5, 7.2, 7.3, 7.4, 7.6, 7.7, 8.2, 8.3, 8.4_

- [ ] 3. Checkpoint - Backend GameSession logic complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement backend SessionRegistry and REST route enhancements
  - [x] 4.1 Add `getSessionsByOwner(ownerId: string)` to `SessionRegistry`
    - Filter sessions map by ownerId
    - Return array of matching GameSession instances
    - _Requirements: 11.1_

  - [x] 4.2 Add `GET /api/sessions/mine` REST endpoint
    - Authenticate request via Bearer token
    - Call `sessionRegistry.getSessionsByOwner(user.id)`
    - Map each session to `SessionSummary` (sessionId, createdAt, lastActivityAt, completedRounds, participantCount, config)
    - Sort by lastActivityAt descending
    - Return `{ sessions: SessionSummary[] }`
    - _Requirements: 11.1, 11.4_

  - [x] 4.3 Write unit tests for `getSessionsByOwner` and `/api/sessions/mine`
    - Test returns correct sessions for owner
    - Test returns empty array for unknown owner
    - Test 401 for unauthenticated request
    - Test file: `server/src/services/__tests__/session-registry.spec.ts` and `server/src/routes/__tests__/sessions.spec.ts`
    - _Requirements: 11.1, 11.4_

- [ ] 5. Implement backend WebSocket handler enhancements
  - [x] 5.1 Add display name uniqueness check on WebSocket connect
    - After token validation and before `addParticipant`, call `session.hasDisplayName(participant.displayName)`
    - If duplicate, close WebSocket with code 4009 and message "Display name already in use in this session"
    - _Requirements: 2.1, 2.3, 2.5_

  - [x] 5.2 Add `participant:remove` event handler
    - Verify sender is moderator
    - Verify target is not the sender (cannot remove self)
    - Verify target exists in session
    - Send `participant:removed` event to target user with reason
    - Call `session.removeParticipantByModerator(userId)`
    - Close target's WebSocket connections
    - Broadcast `participant:left` with updated participant list
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 5.3 Add `round:revote` event handler
    - Verify sender has reveal permission
    - Call `session.revote()`
    - Broadcast `round:started` with serialized new round
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

  - [x] 5.4 Add issue list event handlers (`issue:add`, `issue:remove`, `issue:reorder`, `issue:select`)
    - `issue:add`: verify issue permission, validate non-empty titles, call `session.addIssues(titles)`, broadcast `issue:list-updated`
    - `issue:remove`: verify issue permission, call `session.removeIssue(issueId)`, broadcast `issue:list-updated`
    - `issue:reorder`: verify issue permission, call `session.reorderIssues(orderedIds)`, broadcast `issue:list-updated`
    - `issue:select`: verify issue permission, call `session.selectIssueForEstimation(issueId)`, broadcast `round:started` and `issue:list-updated`
    - _Requirements: 7.2, 7.3, 7.4, 7.6_

  - [x] 5.5 Update `board:clear` handler to mark issue as estimated
    - After `session.clearBoard()`, check if the cleared round's story matches an issue title
    - If so, call `session.markIssueEstimated(issueId, historyEntry.roundId)`
    - Broadcast `issue:list-updated` if issue was marked
    - _Requirements: 7.5_

  - [x] 5.6 Write unit tests for new WebSocket event handlers
    - Test `participant:remove`: permission checks, target validation, broadcast
    - Test `round:revote`: permission check, broadcast
    - Test issue events: permission checks, validation, broadcasts
    - Test display name rejection on connect
    - Test file: `server/src/websocket/__tests__/handler.spec.ts`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 7.2, 7.4, 7.6, 8.2, 8.5_

- [ ] 6. Checkpoint - Backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement frontend SessionStateService enhancements
  - [x] 7.1 Add issue list signal and event subscriptions to `SessionStateService`
    - Add `_issueList = signal<IssueItem[]>([])` and `issueList` readonly signal
    - Subscribe to `issue:list-updated` event → update `_issueList`
    - Subscribe to `participant:removed` event → show toast notification
    - Update `session:state` handler to restore `issueList` from state
    - _Requirements: 7.7, 1.4, 12.2_

  - [x] 7.2 Write unit tests for SessionStateService issue list handling
    - Test `issue:list-updated` updates signal
    - Test `participant:removed` shows toast
    - Test `session:state` restores issue list
    - Test file: `client/src/app/services/session-state.service.spec.ts`
    - _Requirements: 7.7, 1.4, 12.2_

- [ ] 8. Implement frontend new components
  - [x] 8.1 Create `StarsAnimationComponent`
    - Canvas-based particle animation triggered by `active` input
    - Auto-removes after 3 seconds
    - Respects `prefers-reduced-motion` (skips entirely)
    - Uses `pointer-events: none` and `aria-hidden="true"`
    - Caps particle count at 50 for performance
    - File: `client/src/app/components/stars-animation/stars-animation.component.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 8.2 Write unit tests for `StarsAnimationComponent`
    - Test triggers on active=true, respects reduced-motion, auto-cleans after 3s
    - Test file: `client/src/app/components/stars-animation/stars-animation.component.spec.ts`
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 8.3 Create `ConsensusIndicatorComponent`
    - Displays consensus level using `computeConsensusLevel` from shared types
    - Three visual states: Full Agreement (green ✓), Partial Agreement (yellow ~), High Divergence (red ⚠)
    - Uses `role="status"` for accessibility
    - Inputs: `metrics`, `votingSystem`
    - File: `client/src/app/components/consensus-indicator/consensus-indicator.component.ts`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 8.4 Write unit tests for `ConsensusIndicatorComponent`
    - Test each consensus level renders correct state
    - Test accessibility attributes
    - Test file: `client/src/app/components/consensus-indicator/consensus-indicator.component.spec.ts`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 8.5 Create `FacilitatorFlowComponent`
    - Computed flow state from SessionStateService signals: idle, voting, revealed
    - Shows contextual prompts and action buttons per state
    - Progress indicator: `{estimated} / {total}` from issue list
    - Only visible to moderators/users with reveal permission
    - File: `client/src/app/components/facilitator-flow/facilitator-flow.component.ts`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 8.6 Write property test for facilitator progress computation
    - **Property 12: Facilitator progress computation**
    - **Validates: Requirements 10.5**
    - Test file: `client/src/app/components/facilitator-flow/facilitator-flow.property.spec.ts`

  - [x] 8.7 Write unit tests for `FacilitatorFlowComponent`
    - Test state derivation (idle/voting/revealed)
    - Test progress computation
    - Test action button visibility based on permissions
    - Test file: `client/src/app/components/facilitator-flow/facilitator-flow.component.spec.ts`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 8.8 Create `IssueListPanelComponent`
    - Sidebar panel with add single issue input, bulk import textarea, drag-and-drop reorder
    - Visual distinction for estimated issues (checkmark, grayed out)
    - Click to select issue for estimation (sends `issue:select` event)
    - Permission-gated: only users with issue permission can add/reorder/select
    - All participants can view the list
    - File: `client/src/app/components/issue-list-panel/issue-list-panel.component.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 8.9 Write unit tests for `IssueListPanelComponent`
    - Test add issue, bulk import, reorder, select for estimation
    - Test permission gating
    - Test file: `client/src/app/components/issue-list-panel/issue-list-panel.component.spec.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6_

  - [x] 8.10 Create `SessionResumeListComponent`
    - Fetches `GET /api/sessions/mine` on init
    - Displays list of previous sessions with session ID, creation date, completed rounds, last activity
    - Click navigates to `/session/{sessionId}`
    - Handles empty state and expired sessions gracefully
    - File: `client/src/app/components/session-resume-list/session-resume-list.component.ts`
    - _Requirements: 11.1, 11.2, 11.4, 11.5_

  - [x] 8.11 Write unit tests for `SessionResumeListComponent`
    - Test displays sessions, handles empty state, handles expired session
    - Test file: `client/src/app/components/session-resume-list/session-resume-list.component.spec.ts`
    - _Requirements: 11.1, 11.2, 11.4, 11.5_

- [ ] 9. Checkpoint - Frontend new components complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Modify existing frontend components
  - [x] 10.1 Update `SessionCreatePageComponent` with advanced settings grouping
    - Group reveal permission, issue permission, auto-reveal, and countdown into collapsible "Advanced Settings" section
    - Collapsed by default
    - Toggle button with `aria-expanded` attribute
    - Primary visible fields: voting system selection only
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_

  - [x] 10.2 Update `SessionSettingsPanelComponent` with advanced settings grouping and auto-reveal indicator
    - Same advanced settings grouping as create page
    - Add visual indicator (badge) near voting area when auto-reveal is enabled
    - _Requirements: 5.1, 5.4, 6.6_

  - [x] 10.3 Update `StoryManagerComponent` with re-vote button
    - Add "Re-Vote" button visible when cards are revealed and user has reveal permission
    - Re-vote sends `round:revote` WebSocket event
    - Update "Clear Board" button label to "Clear & Next Story" in facilitator flow context
    - _Requirements: 8.1, 8.2, 8.5_

  - [x] 10.4 Update `BoardComponent` to integrate `StarsAnimationComponent`
    - Add `StarsAnimationComponent` triggered on reveal transition (false → true)
    - Do NOT trigger on reconnect to already-revealed state (track previous reveal state)
    - _Requirements: 4.1, 4.5_

  - [x] 10.5 Update `LobbyComponent` to include `SessionResumeListComponent`
    - Add "Your Previous Sessions" section below existing cards
    - Only show when user has sessions to resume
    - _Requirements: 11.1_

  - [x] 10.6 Update `SessionPokerPageComponent` to integrate new components
    - Add `ConsensusIndicatorComponent` in the metrics section
    - Add `FacilitatorFlowComponent` in the story/board area
    - Add `IssueListPanelComponent` as a sidebar panel
    - _Requirements: 9.5, 10.1, 7.1_

  - [x] 10.7 Write unit tests for modified components
    - Test `SessionCreatePageComponent`: advanced settings collapsed by default, toggle behavior, aria-expanded
    - Test `SessionSettingsPanelComponent`: advanced settings grouping, auto-reveal indicator
    - Test `StoryManagerComponent`: re-vote button visibility, re-vote action
    - Test `BoardComponent`: stars animation triggers on reveal transition only
    - Test file: respective component spec files
    - _Requirements: 4.1, 4.5, 5.4, 6.1, 6.3, 6.7, 8.1_

  - [x] 10.8 Write property test for removable participants excludes self
    - **Property 1: Removable participants excludes self**
    - **Validates: Requirements 1.1, 1.5**
    - Test file: `client/src/app/components/board/__tests__/participant-removal.property.spec.ts`
    - Generate random participant lists with one moderator, verify removable set excludes moderator ID

- [ ] 11. Checkpoint - All frontend modifications complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Integration wiring and final verification
  - [x] 12.1 Update Angular routing to support new components
    - Ensure `SessionResumeListComponent` is properly imported in `LobbyComponent`
    - Ensure all new components are imported in `SessionPokerPageComponent`
    - Verify lazy loading if applicable
    - _Requirements: 11.1, 11.2_

  - [x] 12.2 Wire WebSocket close code 4009 handling in frontend
    - In `WebSocketService` or connection logic, detect close code 4009
    - Show toast: "This name is already taken in the session. Please choose a different name."
    - Redirect to login/name selection
    - _Requirements: 2.2_

  - [x] 12.3 Verify `session:state` reconnection includes all new state
    - Confirm `issueList` is included in serialized session state
    - Confirm frontend restores issue list on reconnect
    - _Requirements: 12.1, 12.2_

  - [x] 12.4 Write integration tests for end-to-end flows
    - Test moderator removal flow
    - Test duplicate name rejection
    - Test re-vote flow
    - Test issue list management flow
    - Test session resume flow
    - Test file: `server/src/__tests__/integration/` or `e2e/`
    - _Requirements: 1.2, 1.3, 2.1, 7.2, 7.6, 8.2, 11.2_

- [ ] 13. Final checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout (backend + frontend), so all code examples use TypeScript
- fast-check is used for property-based tests in both client (Vitest) and server (Jest) environments
