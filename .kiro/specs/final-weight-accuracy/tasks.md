# Implementation Plan: Final Weight and Estimation Accuracy

## Overview

Bottom-up, following project conventions: shared types and pure logic, then server, then client services, components, tests, docs and the 0.0.10 release edits. Every change is guarded by `finalWeightEnabled` so existing behaviour does not change.

Execution order: 0 baseline, 1 shared (then checkpoint), 2 server, 3 client state and gate, 4 client UI, 5 docs, 6 release, 7 final checkpoint.

Test commands:
- Server (Jest, also runs the `shared/` tests through its `roots`): `cd server && npm test`
- Client (Vitest via Angular CLI): `cd client && npm test`

## Tasks

- [x] 0. Baseline
  - [x] 0.1 Run `cd server && npm test` and `cd client && npm test`; record the results so later failures can be attributed
    - Search existing tests for exact-shape assertions on config, `board:cleared`, `HistoryEntry`, `IssueItem` and the export (for example `poker-events-nonregression`, `sessions-funcallouts`, `no-regression`, export property tests) and note them
    - _Requirements: 13.1, 13.2, 13.3_

- [x] 1. Shared contract and pure logic
  - [x] 1.1 Extend `shared/types.ts`
    - `finalWeightEnabled?` (no change to `DEFAULT_SESSION_CONFIG`), `resolveFinalWeightEnabled`, `FinalWeightRecord`, optional `finalWeight` on `VotingRound`, `HistoryEntry`, `IssueItem`, exported event constants, payload and rejection types
    - _Requirements: 1.1, 1.2, 11.8, 11.12, 12.5_
  - [x] 1.2 Create `shared/final-weight.ts`
    - `scoringLadder`, `votesFromRound`, `buildFinalWeightOptions`, `computeAccuracy` (total), `computeStandings`
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x] 1.3 Create `shared/final-weight-copy.ts`
    - Pools, `bandFor`, `pickCopy`, `fillCopy`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.9_
  - [x] 1.4 Add the optional trailing `Final Weight` column to `shared/estimate-export.ts`
    - Existing `SUMMARY_HEADER` and output unchanged when no entry has a weight
    - _Requirements: 12.2, 12.3, 12.4_
  - [x] 1.5 Property tests for `resolveFinalWeightEnabled` and `buildFinalWeightOptions`
    - **Property 1: Setting resolver accepts only boolean true**
    - **Property 2: Candidate options are complete, ordered and unique**
    - **Validates: Requirements 1.2, 5.2, 5.3, 5.7, 6.4**
  - [x] 1.6 Property tests for `computeAccuracy`, distance and `computeStandings`
    - **Property 3: Accuracy result invariants**
    - **Property 4: Distance equals ladder index difference**
    - **Property 5: Standings are the per-round mean distance**
    - **Validates: Requirements 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.12, 10.3, 10.4, 10.6**
  - [x] 1.7 Property and unit tests for the copy pools
    - **Property 6: Copy selection is deterministic and safe**
    - **Validates: Requirements 9.1, 9.3, 9.8**
  - [x] 1.8 Export tests: byte-identical without weights, `Final Weight` last column with weights
    - **Property 8: Export column is last and absent output is unchanged**
    - **Validates: Requirements 12.2, 12.3, 12.4**
  - [x] 1.9 Checkpoint - Shared layer
    - Run `cd server && npm test` (the shared tests run through the server Jest `roots`) and compare with the baseline before starting server work. Ensure all tests pass, ask the user if questions arise.

- [x] 2. Server
  - [x] 2.1 `GameSession.setFinalWeight`, `clearBoard` copy (omit key when unset), issue copy, `revote` issue reset
    - Newest history entry only; revealed current round only; last valid submit wins
    - _Requirements: 4.13, 4.15, 4.16, 10.1, 11.4, 11.5, 11.7, 11.8, 12.6, 12.7, 12.8, 12.9_
  - [x] 2.2 `GameSession` tests, including weight `0`, re-vote, and unchanged entry shape
    - **Property 7: History entry carries the weight only when set**
    - **Validates: Requirements 4.15, 11.7, 11.8, 12.9, 13.3**
  - [x] 2.3 `SessionRegistry.createSession` (coerce only when the key is present) and `PUT /:id/config` validation
    - Owner or moderator may change it; non-boolean gives 400 `INVALID_SETTING`
    - _Requirements: 1.3, 1.4, 1.5, 3.2, 3.3, 3.4_
  - [x] 2.4 `handleFinalWeightSubmit` with moderator pre-check, `unknown` guards, validation, server-side result, broadcasts
    - _Requirements: 1.7, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.6, 12.7_
  - [x] 2.5 Handler, route and registry tests
    - Non-moderator (including a user with only reveal or issue permission), disabled, bad shape, bad value, stale round, voting-state round, two moderators, config broadcast
    - _Requirements: 1.7, 3.3, 3.4, 4.11, 4.16, 11.2, 11.3, 11.4, 11.5_
  - [x] 2.6 Checkpoint - Server
    - Run `cd server && npm test` and compare with the baseline. Ensure all tests pass, ask the user if questions arise.

- [x] 3. Client state and gate
  - [x] 3.1 `session-state.service.ts`: `finalWeightEnabled`, `latestAccuracy`, `finalweight:set` handling (patch round and history), restore without announcement, clear on `history:cleared`, setting off and stale `round:started`
    - _Requirements: 3.4, 3.5, 6.11, 7.5, 7.6, 7.8, 11.9_
  - [x] 3.2 `FinalWeightGateService` with `guard` and `guardEndSession`
    - Moderator-role check, ack wait (5 s), error mapping, End Session sequencing (3 s)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8, 4.9, 4.10, 4.12, 4.13, 4.14, 11.9, 11.10, 11.11_
  - [x] 3.3 Service tests: confirm, skip, cancel, timeout, each rejection, dialog closing when the round changes, feature turned off
    - _Requirements: 3.5, 4.7, 4.8, 4.9, 4.12, 4.14, 11.9, 11.10, 11.11_

- [x] 4. Client UI
  - [x] 4.1 Create-board toggle and settings-panel toggle
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_
  - [x] 4.2 Tests: default unchecked, payload, existing toggles untouched
    - _Requirements: 2.1, 2.2, 2.3, 13.1_
  - [x] 4.3 `FinalWeightDialogComponent` (gate and edit modes)
    - _Requirements: 5.4, 5.5, 5.6, 8.2, 8.3, 8.4, 9.7, 11.10, 14.1, 14.2, 14.3, 14.4, 14.5, 14.7_
  - [x] 4.4 `FinalWeightBalloonComponent` with standings and reduced-motion support; check placement against chat, callout layer and note balloon
    - _Requirements: 7.2, 7.3, 7.4, 7.7, 7.9, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.9, 10.2, 10.3, 10.4, 10.5, 14.6_
  - [x] 4.5 `FinalWeightHeaderButtonComponent` and mounting in `session-poker-page`
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6, 8.7_
  - [x] 4.6 Route every entry point through the gate
    - The six entry points: facilitator-flow `clearAndNext`, facilitator-flow `nextIssue` (three Next buttons), story-manager `clearBoard`, story-manager story submit, issue-list-panel `selectIssue`, session-poker-page `confirmEndSession`
    - Re-Vote untouched
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 13.4_
  - [x] 4.7 Show the weight in session history and the issue list
    - _Requirements: 12.1, 12.10, 12.11_
  - [x] 4.8 Component and integration tests
    - All six entry points (End Session included), moderator vs non-moderator, owner who is not a moderator, header icon states per role, reload restore, no DOM or WS traffic when disabled
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 4.10, 4.11, 8.1, 8.2, 8.4, 8.5, 8.6, 13.4, 14.1_
  - [x] 4.9 Checkpoint - Client
    - Run `cd client && npm test`; existing specs (`no-regression`, `accessibility`, callouts, chat, facilitator-flow, story-manager, issue-list) must pass unchanged. Ensure all tests pass, ask the user if questions arise.

- [x] 5. Documentation
  - [x] 5.1 Update `README.md`: feature section, settings, WS events, REST validation, How to Use step, project structure additions, the End Session behaviour and its limitation
    - _Requirements: 4.6, 11.12, 15.1_

- [x] 6. Release 0.0.10
  - [x] 6.1 `helm/scrum-poker/Chart.yaml`: `version: 0.0.10`, `appVersion: "0.0.10"`
    - _Requirements: 15.2_
  - [x] 6.2 Replace `0.0.9` release references in `helm/scrum-poker/README.md` and `README.md`
    - Only the release version; leave unrelated numbers untouched; `client/package.json` and `server/package.json` stay unchanged
    - _Requirements: 15.3, 15.4_
  - [x] 6.3 Verify: `helm lint helm/scrum-poker` and `bash tests/helm-smoke.test.sh` if tools are available; build `server` and `client`
    - Do not commit or tag (maintainer step)
    - _Requirements: 13.7, 15.5_

- [x] 7. Final checkpoint - Ensure all tests pass
  - Run `cd server && npm test` and `cd client && npm test`; both pass versus the baseline. Manual walk-through with the setting off (no change) and on (dialog at every entry point, balloon for all, icon per role, voting-system change mid-session, weight `0`). Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- Each task references specific requirements for traceability; property tests map to Properties 1-8 in design.md.
- No `any` in new code; use `unknown` and type guards.
- No new npm dependency and no `package.json` change.
- Card values are `ExtendedCardValue`. `0` is a valid weight: never use truthiness checks on a weight (`!== undefined`).
- Shared imports on the client use `@shared/...`.
- Tests run once, never in watch mode. If the client runner starts in watch mode, use `npm test -- --watch=false`.
- Property tests run at least 100 cases and carry `// Feature: final-weight-accuracy, Property N: <title>`.
- Do not create the git commit or tag; that stays with the maintainer (see `release-versioning.instructions.md`).
- Retro code is not touched.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["1.1"] },
    { "id": 2, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 3, "tasks": ["1.5", "1.6", "1.7", "1.8"] },
    { "id": 4, "tasks": ["2.1", "2.3"] },
    { "id": 5, "tasks": ["2.2", "2.4"] },
    { "id": 6, "tasks": ["2.5"] },
    { "id": 7, "tasks": ["3.1"] },
    { "id": 8, "tasks": ["3.2"] },
    { "id": 9, "tasks": ["3.3", "4.1", "4.3", "4.4"] },
    { "id": 10, "tasks": ["4.2", "4.5"] },
    { "id": 11, "tasks": ["4.6"] },
    { "id": 12, "tasks": ["4.7"] },
    { "id": 13, "tasks": ["4.8"] },
    { "id": 14, "tasks": ["5.1"] },
    { "id": 15, "tasks": ["6.1", "6.2"] },
    { "id": 16, "tasks": ["6.3"] }
  ]
}
```
