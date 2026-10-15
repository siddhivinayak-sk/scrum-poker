# Implementation Plan: Vote Reveal Fun Callouts

## Overview

Implementation language: **TypeScript** (the design uses concrete TypeScript throughout, so no language choice is needed).

The plan builds bottom-up so every task compiles and the existing suites stay green before the next task starts:

1. Capture the frozen metrics baseline from **unmodified** code, with its non-regression property.
2. Shared foundation: `Card_Numeric_Value` / `Card_Ladder`, the type-widening chain (R14.16), `asCardValue` removal, note types, and `funCallouts`.
3. Metrics engine rework (Requirements 14 and 15).
4. Pure shared units: proximity classifier and copy catalog / phrase selection.
5. Server: note handling, routing, and the `funCallouts` config guard.
6. Client state and persistence services.
7. Pure client resolvers: visibility and animation lifecycle.
8. Components and CSS, then wiring into the session page and settings panel, then history rendering.
9. Final integration checks.

**Test runners.** Server and `shared/__tests__` specs run under **Jest** (`cd server && npm test`; `server/jest.config.ts` has `../shared` in `roots`, so shared specs run there with `fast-check`). Client specs run under **Vitest** through `ng test` (`cd client && npm test`). Never add Karma/Jasmine config and never add a `moduleNameMapper` for `@shared/*`. Run suites single-shot, not in watch mode. Every task's runner is stated on its test sub-tasks.

**Flagged tensions needing implementation decisions** (each is repeated in the task that acts on it):

| # | Tension | Decision carried into the tasks |
|---|---|---|
| 1 | R15.1/R15.10 want the voting system as an argument; R14.15/R13.2 want ~30 one-argument `calculate(selections)` test calls to pass unedited | `votingSystem` is an **optional** second parameter defaulting to `'fibonacci'`; all four production call sites pass it explicitly; a source-scan test enforces it (2.3, 4.1, 4.2, 4.5) |
| 2 | R6.10 wants owner-only `funCallouts`, but the settings panel and `PUT /config` are moderator-gated | Client renders and sends `funCallouts` only when `ownerId === currentUser.id` (the existing page `isOwner` computed, not `isSessionOwner`); the route rejects any request carrying the key from a non-owner with 403 and a non-boolean with 400 (8.3, 14.2) |
| 3 | R14.9 makes every t-shirt round `insufficientData: true` with null `average`/`mode`/`spread` | Accepted consequence: metrics panel shows the existing "Insufficient data" string, consensus indicator disappears for t-shirt, exported mode cell becomes `-`. Existing copy string and `computeConsensusLevel` t-shirt branch are left untouched (4.1, 4.4) |
| 4 | `session-manager.ts` has no `SessionConfiguration` | Pass `DEFAULT_SESSION_CONFIG.votingSystem` explicitly (4.2) |
| 5 | R14.16 forces a type-level widening beyond `calculate` | Widen to `ExtendedCardValue` across shared, server and client; zero runtime effect; `CardValue` itself is not redefined (2.3) |
| 6 | R10.12 needs an acknowledgement catalog section R4.2 does not bound | Add a fifth `acknowledgement` section with the same discipline (6.9) |
| 7 | R6.9 (play Exit_Flourish) composes with R6.1 (Reduced_Motion_Mode includes `funCallouts` off) | When `funCallouts` flips to false the exit runs as the ≤150 ms opacity-only exit; removal still happens exactly once (11.2, 13.2, 13.3) |
| 8 | R7.2's `pointer-events: none` makes R7.7's scroll container pointer-unreachable | Follow R7.2 literally; do **not** implement the conditional `pointer-events: auto` remedy (13.5) |
| 9 | R4.3 "within the same Poker_Session" | Rotation cursor and per-round memo are per-tab in-memory client state (10.2) |
| 10 | Several requirements are geometry/contrast/screen-reader/keyboard facts jsdom cannot verify | Automated tests assert structure and declarations only; manual checks are outside this task list (see Notes) |

## Tasks

- [x] 1. Capture the frozen metrics baseline (BEFORE any code is changed)
  - [x] 1.1 Commit the frozen reference copy of the current Metrics_Engine
    - Before touching any file, run `cd server && npm test` once and confirm the suite is green, so the baseline is taken from a known-good, unmodified tree.
    - Create `server/src/services/__tests__/metrics-engine.baseline.ts` exporting `calculateBaseline(selections: Map<string, CardValue>): VotingMetrics`, a **verbatim logic copy** of the current `server/src/services/metrics-engine.ts` `calculate` (same `FIBONACCI_INDEX`, `SPECIAL_CARD_SET`, `isSpecialCard`, `isNumericCard`, distribution, average, mode with lowest-value tie-break, spread, and `> 2` Fibonacci-index outlier rule, same iteration order).
    - The file must be self-contained: it imports only from `shared/types` (existing names `FIBONACCI_SEQUENCE`, `SPECIAL_CARDS`, `CardValue`, `NumericCardValue`, `SpecialCardValue`, `VotingMetrics`) and is **never imported by production code**. Add a header comment stating it is frozen and must not be edited after this commit.
    - Do not copy from a later-edited version of the engine; this task must land before any task that modifies `metrics-engine.ts`.
    - Runner: none (support file, picked up by 1.2).
    - _Requirements: 13.2, 14.15, 15.7_

  - [x] 1.2 Write the Fibonacci metrics non-regression property test (REQUIRED)
    - **Property 27: Fibonacci metrics non-regression**
    - In `server/src/services/__tests__/metrics-engine-baseline.property.spec.ts` (**Jest**), generate selection maps drawn only from `[...FIBONACCI_SEQUENCE, ...SPECIAL_CARDS]` (varying participant counts including 0, 1, and ≥2 numeric voters) and assert that `calculate(selections)` equals `calculateBaseline(selections)` on all seven fields: `average`, `mode`, `spread`, `distribution`, `outliers` (with entry **order preserved**), `numericVoteCount`, `insufficientData`. Minimum 100 runs.
    - At this point `calculate` still has one parameter, so the property calls it with one argument; task 4.3 extends it for the new second parameter.
    - Tag with `// Feature: vote-reveal-fun-callouts, Property 27: ...`.
    - This test is required (not optional) and must pass against the unmodified engine.
    - **Validates: Requirements 13.2, 14.15, 15.7**

- [x] 2. Shared foundation: Card_Numeric_Value, widening chain, note types, funCallouts
  - [x] 2.1 Add `CARD_NUMERIC_VALUE`, `CARD_LADDERS` and helpers to `shared/types.ts`
    - Add `CARD_NUMERIC_VALUE: ReadonlyMap<ExtendedCardValue, number>` per design §1.1 (fibonacci and power-of-2 values map to themselves, `'½'` → 0.5, modified-fibonacci extras 20/40/100; `coffee`, `no-clue`, `break`, and all t-shirt sizes absent).
    - Add `cardNumericValue()`, `isNumericCard()`, `buildCardLadders()` (filter `VOTING_SYSTEMS[system]` by `CARD_NUMERIC_VALUE.has`, sort ascending by mapped value, collapse equal mapped values), `CARD_LADDERS`, `cardLadderFor(votingSystem: string)` (returns `[]` for an unknown identifier), and `ladderIndexOf()`.
    - Expected ladders: fibonacci `[0,1,2,3,5,8,13,21,34,55,89]`; modified-fibonacci `[0,'½',1,2,3,5,8,13,20,40,100]`; power-of-2 `[0,1,2,4,8,16,32,64]`; t-shirt `[]` (no special case).
    - Additive only: do not rename or modify any existing export. No `any`.
    - _Requirements: 1.2, 14.1, 14.2, 14.3, 15.2_

  - [x] 2.2 Write example tests for the card ladders
    - Runner: **Jest** (`shared/__tests__/card-ladders.spec.ts`).
    - Assert the four literal ladders above, that t-shirt is empty, that `cardLadderFor('nonsense')` is `[]`, that `cardNumericValue('½') === 0.5`, that specials and t-shirt sizes have no value, and that `CARD_LADDERS.fibonacci` equals `FIBONACCI_SEQUENCE` element-for-element.
    - _Requirements: 1.2, 14.1, 14.2, 15.2_

  - [x] 2.3 Apply the type-widening chain to `ExtendedCardValue` (R14.16)
    - **Type-level only, zero runtime effect.** `CardValue` is a strict subtype of `ExtendedCardValue`, so writes still compile; `CardValue` itself is NOT redefined or widened.
    - Shared (`shared/types.ts`): `VotingRound.selections` → `Map<string, ExtendedCardValue>`; `ParticipantVote.cardValue` → `ExtendedCardValue | null`; `VotingMetrics.mode` → `ExtendedCardValue | null` (needed so `'½'` can be returned as `'½'`, R14.14).
    - Server: `GameSession.selectCard` / `getSelections` / `RevealResult.selections` and the `session-manager.ts` equivalents → `ExtendedCardValue`; remove the `cardValue as CardValue` cast in `handleCardSelect` in `server/src/websocket/handler.ts` (its input is already validated against `getValidCards`).
    - Engine, signature and guards only: change `calculate`'s first parameter to `ReadonlyMap<string, ExtendedCardValue>` and widen the parameter types of the internal `isSpecialCard` / `isNumericCard` guards so the file type-checks. Do **not** change any runtime logic in this task (the frozen baseline from 1.1 must still equal the engine).
    - Client: `SessionStateService._selections` / `selections` and the `cards:revealed` payload type, the `new Map<string, CardValue>(...)` construction in the round-restore path, `deriveBoardCards` / `BoardCard.cardValue` in `board.component.ts`, and the `CardValue` import in `metrics.component.ts` → `ExtendedCardValue` as needed to compile.
    - Existing tests that annotate a local `Map<string, CardValue>` must keep compiling unedited (a `Map<string, CardValue>` is assignable to the widened `ReadonlyMap` parameter).
    - Verify: `cd server && npx tsc --noEmit`, `cd client && npx tsc -p tsconfig.app.json --noEmit` (or `ng build`), then both existing suites green including task 1.2.
    - _Requirements: 14.14, 14.16, 13.2, 13.3_

  - [x] 2.4 Remove the `asCardValue` workaround helpers (R14.16)
    - Delete `asCardValue` and its doc comment from `shared/__tests__/estimate-export.property.spec.ts` (used at the `selections.set(...)` and `cardValue:` sites) and from `server/src/routes/__tests__/sessions-export.spec.ts` (used at `session.selectCard(...)`); pass the `ExtendedCardValue` directly at each former call site.
    - Remove now-unused `CardValue` imports. Assertions and generated inputs must not change.
    - Runner: **Jest**; both files must pass unedited apart from the helper removal.
    - _Requirements: 14.16_

  - [x] 2.5 Add Callout_Note types, event names and note collections to `shared/types.ts`
    - Add `CalloutNote`, `NOTE_MAX_LENGTH = 280`, `CalloutNoteRejection` (`NOTE_SESSION_MISMATCH`, `NOTE_INVALID`, `NOTE_EMPTY`, `NOTE_TOO_LONG`, `NOTE_ROUND_UNKNOWN`, `NOTE_DUPLICATE`), `CALLOUT_NOTE_SUBMIT` / `CALLOUT_NOTE_ADDED` / `CALLOUT_NOTE_REJECTED` (`'callout:note:submit' | 'callout:note:added' | 'callout:note:rejected'`) and their three payload interfaces.
    - Add optional `calloutNotes?: CalloutNote[]` to `VotingRound` and `HistoryEntry`. Model it as a **plain array, never a Map** (project pitfall: `selections` is a Map, notes must not be).
    - Add `isCalloutNote` (type guard, no `any`) and `normaliseCalloutNotes(value: unknown): CalloutNote[]` that returns `[]` for anything not a well-formed note array.
    - Use a dedicated `callout:note:rejected` event rather than the existing `error` event so the client's `error` toast path is untouched.
    - _Requirements: 10.2, 10.10, 13.3, 13.5, 13.6, 13.12_

  - [x] 2.6 Add `funCallouts` to `SessionConfiguration` and `resolveFunCallouts`
    - Add optional `funCallouts?: boolean` to `SessionConfiguration`, `funCallouts: true` to `DEFAULT_SESSION_CONFIG`, and `resolveFunCallouts(value: unknown): boolean` (`typeof value === 'boolean' ? value : true`). Keep it a separate function from `resolveFluidCardHeight`; do not couple to it.
    - Do not touch `SessionRegistry` here (task 8.3 normalises at creation).
    - _Requirements: 6.5, 6.6, 6.11_

  - [x] 2.7 Write property test for note round-trip across the WebSocket boundary
    - **Property 14: Note round-trip across the WebSocket boundary**
    - Runner: **Jest** (`shared/__tests__/callout-note-transport.property.spec.ts`). Generate 0–100 `CalloutNote` records; assert `normaliseCalloutNotes(JSON.parse(JSON.stringify(notes)))` deep-equals the original (text, `authorId`, `roundId`, position) and that the serialised form contains no `Map`. Add example cases that malformed inputs (`null`, object, array with a bad member) normalise to `[]` without throwing.
    - **Validates: Requirements 13.6**

  - [x] 2.8 Write tests for `resolveFunCallouts`
    - Runner: **Jest** (`shared/__tests__/fun-callouts.spec.ts`). Property over `true`, `false`, `undefined`, `null`, strings, numbers, objects, arrays: result equals the boolean when given a boolean, otherwise `true`. Assert `DEFAULT_SESSION_CONFIG.funCallouts === true`. (No numbered design property; covers the R6.11 single coercion point.)
    - _Requirements: 6.5, 6.6, 6.11_

- [x] 3. Checkpoint - Shared foundation green
  - Ensure all tests pass, ask the user if questions arise. Run `cd server && npm test` and `cd client && npm test` (single-shot) and confirm both projects type-check; task 1.2 must still pass against the untouched runtime engine logic.

- [x] 4. Metrics engine rework (Requirements 14 and 15)
  - [x] 4.1 Rework `calculate` for Card_Numeric_Value and voting-system-aware outliers
    - Signature: `calculate(selections: ReadonlyMap<string, ExtendedCardValue>, votingSystem: VotingSystemType | string = 'fibonacci'): VotingMetrics`.
    - **Flagged conflict 1:** the second parameter is deliberately **optional with a `'fibonacci'` default**, because both existing metrics test files call `calculate(selections)` with one argument (~30 sites) and R14.15/R13.2 forbid editing them. R15.10 is read as constraining *production* call sites (task 4.2). The default is never reached in production.
    - Follow design §2.3: (1) `distribution` counts `String(card)` for every entry including specials, t-shirt sizes and unknown values; (2) numeric votes are only entries in `CARD_NUMERIC_VALUE`; (3) fewer than 2 numeric votes → `average/mode/spread = null`, `outliers = []`, `insufficientData = true`; (4) `average` = mean of mapped values; (5) `spread` = mapped max − min; (6) `mode` computed over mapped values, ties to the least mapped value, **returned as the representative card value** (so `'½'` stays `'½'`); (7) outliers via `ladderIndexOf(cardLadderFor(votingSystem), …)` with threshold `> 2`, empty when the ladder has < 2 entries or the mode is not on the ladder, members only from the ladder, iteration order of `selections` preserved.
    - **Flagged consequence 3 (t-shirt):** a t-shirt round now yields `insufficientData: true` with null `average/mode/spread`. Do not special-case t-shirt in the engine (it falls out of the empty ladder) and do not reword the "Insufficient data" copy or edit `computeConsensusLevel`.
    - Keep `outliers` name, position and `string[]` shape unchanged; pure function, no clock/network/DOM.
    - Verify the existing `metrics-engine.test.ts` and `metrics-engine.property.test.ts` pass **unedited** and task 1.2 still passes.
    - _Requirements: 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15, 14.17, 14.18, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8, 15.9, 15.11, 15.13_

  - [x] 4.2 Pass the voting system at every production `calculate(` call site
    - `game-session.ts` `revealCards()` and `clearBoard()`: `calculate(this.currentRound.selections, this.config.votingSystem)`.
    - `session-manager.ts` `revealCards()` and `clearBoard()`: **Flagged tension 4** — this legacy module holds no configuration, so pass `DEFAULT_SESSION_CONFIG.votingSystem` explicitly (behaviour-preserving) rather than relying on the parameter default.
    - Existing `game-session.*` and `session-manager.*` tests must pass unedited.
    - _Requirements: 15.1, 15.10_

  - [x] 4.3 Extend the non-regression property for the new parameter (REQUIRED)
    - **Property 27: Fibonacci metrics non-regression** (extension)
    - In `server/src/services/__tests__/metrics-engine-baseline.property.spec.ts` (**Jest**), keep the one-argument comparison and add a second property asserting `calculate(selections, 'fibonacci')` also equals `calculateBaseline(selections)` on all seven fields (outlier order preserved). Do not edit `metrics-engine.baseline.ts`.
    - Required (not optional).
    - **Validates: Requirements 13.2, 14.15, 15.7**

  - [x] 4.4 Audit and absorb the t-shirt `insufficientData` consequences (REQUIRED)
    - **Flagged consequence 3.** Search client and server for tests or fixtures that push a **t-shirt round through the real engine** and assert numeric output (`mode: 'L'`-style values, `NaN` average/spread, or a consensus indicator on t-shirt). Update only those fixtures/assertions that encode the old fabricated-number behaviour, to expect `insufficientData: true` and null `average/mode/spread`.
    - Confirm without editing: `MetricsComponent` renders the existing "Insufficient data — fewer than 2 numeric votes" string for such metrics; `computeConsensusLevel` returns `'none'` for them; `shared/__tests__/consensus*.spec.ts` (hand-built metrics literals) pass unedited; the t-shirt export test still passes because it compares the route output to `buildEstimateExportCsv` of the same history (its mode cell now exports `-`).
    - Do **not** reword the message, do not delete the unreachable t-shirt branch in `computeConsensusLevel`, and do not modify `shared/estimate-export.ts`.
    - Runner: **Jest** for server/shared, **Vitest** for client; run both suites.
    - _Requirements: 14.9, 13.2, 10.16_

  - [x] 4.5 Write the source-scan test that every production `calculate(` passes a voting system
    - Runner: **Jest** (`server/src/services/__tests__/calculate-call-sites.spec.ts`). Read each `.ts` file under `server/src/services/` (excluding `metrics-engine.ts` and `__tests__/`), find every `calculate(` occurrence and assert it carries a second argument; assert there are exactly four such call sites (two in `game-session.ts`, two in `session-manager.ts`). Include a guard that the scanner finds a known sample so it cannot pass vacuously.
    - _Requirements: 15.10_

  - [x] 4.6 Write property test for no-NaN metrics
    - **Property 25: No NaN metrics**
    - Runner: **Jest**, `server/src/services/__tests__/metrics-engine-extended.property.spec.ts` (shared file for Properties 25, 26, 28, 29, 30, 31). Define `extendedCardArb` over `ALL_EXTENDED_CARDS` plus a `foreignCardArb`; for all four voting systems assert `average` and `spread` are `null` or finite and never `NaN`.
    - **Validates: Requirements 14.4, 14.5, 14.10, 14.11, 14.17**

  - [x] 4.7 Write property test for null metrics exactly on insufficient numeric votes
    - **Property 26: Null metrics exactly on insufficient numeric votes**
    - Same file as 4.6. `average`/`spread` are null exactly when fewer than two selections have a Card_Numeric_Value, finite otherwise; `insufficientData` agrees; `t-shirt` always takes the null branch.
    - **Validates: Requirements 14.7, 14.8, 14.9**

  - [x] 4.8 Write property test for outlier soundness
    - **Property 28: Outlier soundness**
    - Same file as 4.6. Every member of `outliers` has a Card_Numeric_Value, is on the active ladder, and has `|index − modeIndex| > 2`; every non-member fails at least one condition.
    - **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.8, 15.9**

  - [x] 4.9 Write property test for outlier emptiness on short ladders
    - **Property 29: Outlier emptiness on short ladders**
    - Same file as 4.6. For `t-shirt` and generated unknown identifiers, `outliers` is `[]` and the other fields are returned without throwing.
    - **Validates: Requirements 15.6, 15.11**

  - [x] 4.10 Write property test for distribution totality
    - **Property 30: Distribution totality**
    - Same file as 4.6. Sum of `distribution` counts equals the number of selections; one key per distinct card value, including specials, t-shirt sizes and foreign values.
    - **Validates: Requirements 14.12, 14.17**

  - [x] 4.11 Write property test for mode card-value fidelity
    - **Property 31: Mode card-value fidelity**
    - Same file as 4.6. A non-null `mode` is a card present in the selections whose mapped value is the modal mapped value, ties to the least mapped value, so a modal `'½'` is returned as `'½'`, not `0.5`.
    - **Validates: Requirements 14.13, 14.14, 14.18**

  - [x] 4.12 Write example and boundary tests for the reworked engine
    - Runner: **Jest** (`server/src/services/__tests__/metrics-engine-boundaries.test.ts`). Cases: `'½'` modal round returns `mode === '½'`; `modified-fibonacci` votes `0,'½',1` give a finite average of 0.5 (previously `NaN`); `power-of-2` round with `0` and `64` flags outliers; `modified-fibonacci` round with `'½'` and `100` flags outliers; t-shirt round → `insufficientData === true` and null `average/mode/spread`; a foreign card value is counted in `distribution` only; an unknown voting-system id returns empty `outliers` without throwing.
    - _Requirements: 14.9, 14.14, 14.17, 15.4, 15.5, 15.11_

- [x] 5. Checkpoint - Metrics engine green
  - Ensure all tests pass, ask the user if questions arise. Confirm the baseline non-regression properties (1.2, 4.3) and all pre-existing metrics, game-session, session-manager, consensus and export tests pass unedited.

- [x] 6. Pure shared units: proximity classifier and copy catalog
  - [x] 6.1 Implement `shared/vote-proximity.ts`
    - Export `NEAR_THRESHOLD = 0.75`, `FAR_THRESHOLD = 2.0`, `DISTANCE_PRECISION = 6`, `ProximityInput`, `ClassifiedParticipant`, `ProximityResult`, `EMPTY_PROXIMITY`, `classifyProximity`.
    - Implement design §3.1: guard clauses first (non-finite/non-number average, ladder < 2 entries, unknown system → `EMPTY_PROXIMITY`, never throw), `averageLadderPosition` with clamp-before-interpolate (non-strict comparisons so exact ladder values land on their index), round the **distance** once to 6 decimals before comparing thresholds, `if / else if` so near and far cannot overlap, skip null/undefined selections, cards without a Card_Numeric_Value and cards absent from the ladder.
    - Order both arrays by ascending distance, then code-unit (not `localeCompare`) case-insensitive display name, then `userId`.
    - Must not reference `outliers`, `Date`, `Math.random`, `window` or `process`, must not mutate inputs, and must allocate fresh result arrays.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19, 1.20_

  - [x] 6.2 Write property test for Near/Far disjointness
    - **Property 1: Near and Far sets are disjoint**
    - Runner: **Jest**, `shared/__tests__/vote-proximity.property.spec.ts` (shared file for Properties 1–6). Generate selection maps over all card kinds and all four systems plus averages from `ladderAverageArb` (below min, above max, exactly on each entry, between entries).
    - **Validates: Requirements 1.1, 1.7, 1.8, 1.9**

  - [x] 6.3 Write property test for classification soundness
    - **Property 2: Classification soundness**
    - Same file as 6.2. Every classified participant cast a selection with a Card_Numeric_Value that is on the active ladder; none without a selection, with specials, t-shirt sizes or cross-deck cards.
    - **Validates: Requirements 1.10, 1.11, 1.12, 15.8, 15.9**

  - [x] 6.4 Write property test for suppression under insufficient data
    - **Property 3: Suppression under insufficient data**
    - Same file as 6.2. Use `averageArb` (`NaN`, `±Infinity`, `null`, `undefined`, strings, objects), ladders with < 2 entries, and unknown system ids; the result is fully empty and no error is raised.
    - **Validates: Requirements 1.13, 1.14, 1.19**

  - [x] 6.5 Write property test for distance monotonicity
    - **Property 4: Distance monotonicity**
    - Same file as 6.2. For any two classified participants with strictly ordered distances, near-membership of the farther implies near-membership of the nearer, and far-membership of the nearer implies far-membership of the farther.
    - **Validates: Requirements 1.7, 1.8, 1.9**

  - [x] 6.6 Write property test for stable near ordering
    - **Property 5: Near ordering is stable and non-decreasing**
    - Same file as 6.2. Order is non-decreasing in distance with ties by case-insensitive name then `userId`; two calls give the same order.
    - **Validates: Requirements 1.16**

  - [x] 6.7 Write property test for classifier purity and idempotence
    - **Property 6: Classifier purity and idempotence**
    - Same file as 6.2. Two calls deep-equal each other and the input `selections` and `displayNames` maps are unmodified (snapshot before/after).
    - **Validates: Requirements 1.17**

  - [x] 6.8 Write boundary examples and source-scan tests for the classifier
    - Runner: **Jest** (`shared/__tests__/vote-proximity.spec.ts`). Named cases from the design worked-examples table: distance exactly `0.75` is near (inclusive), exactly `2.0` is far (inclusive), `0.750001` and `1.999999` are in neither; modified-fibonacci `0,'½',1` gives distances `1,0,1`; t-shirt returns `EMPTY_PROXIMITY`; one timed example for 100 selections finishing under 50 ms.
    - Source scans over `shared/vote-proximity.ts`: the string `outliers` never appears (R1.15) and no `Date`, `Math.random`, `window` or `process` reference appears (R1.17).
    - _Requirements: 1.7, 1.8, 1.9, 1.14, 1.15, 1.17, 1.20, 13.11_

  - [x] 6.9 Implement `shared/callout-copy.ts` (catalog, restricted terms, phrase selection)
    - Export `CalloutSection`, `CalloutCopyCatalog`, `CALLOUT_COPY_CATALOG` using the design §4.2 entries (near 8, far 8, fullAgreement 3, wideSpread 3), `RestrictedTerm` / `RestrictedTermList`, `RESTRICTED_TERMS` (error-attributing, ranking-and-comparison, region-specific-idiom groups with **enumerated forms**, no stemmer), `containsRestrictedTerm` (letter-only tokenisation, whole-word, case-insensitive, multi-word forms), and `selectCalloutPhrase(catalog, section, roundId, previousIndex)`.
    - **Flagged 6:** add a fifth `acknowledgement` section (≥ 2 distinct entries) and apply R4.9 / R4.13 to it voluntarily.
    - `selectCalloutPhrase`: FNV-1a seed over `roundId|section` only when `previousIndex` is not an integer in `[0, n)`; otherwise strict rotation `(previousIndex + 1) % n`; return `null` for an absent or empty section. No clock, no random.
    - Catalog constraints (R4.2, R4.6, R4.7, R4.9, R4.11): 12–90 characters, ≤ 2 glyphs, far entries end in `?` with a second-person pronoun, near entries have no second-person pronoun, no digit and no ranking term; no entry equals a consensus label (`full agreement`, `partial agreement`, `high divergence`).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 10.12, 2.9_

  - [x] 6.10 Write the catalog scan (copy tone constraints)
    - **Property 9: Copy tone constraints**
    - Runner: **Jest**, `shared/__tests__/callout-copy.spec.ts`. Exhaustively scan every entry of every section: length 12–90, ≤ 2 glyphs, no region-specific idiom; far entries end in `?`, contain `you`/`your`, no error-attributing term; near entries no second-person pronoun, no digit, no ranking term; section sizes within R4.2 bounds, every section ≥ 2 entries, entries distinct after case folding and whitespace normalisation; no entry equals a consensus-indicator label. Add near-miss negative cases for `containsRestrictedTerm` (`offer` vs `off`, `topic` vs `top`, `leaden` vs `lead`).
    - **Validates: Requirements 4.6, 4.7, 4.9, 4.11**

  - [x] 6.11 Write property test for copy selection totality
    - **Property 7: Copy selection totality**
    - Runner: **Jest**, `shared/__tests__/callout-copy.property.spec.ts` (shared file for Properties 7, 8, 20, 21). For every round id, section and previous index (including `-1`, non-integers, out-of-range) exactly one non-blank entry of the requested section is returned.
    - **Validates: Requirements 4.3, 4.4**

  - [x] 6.12 Write property test for copy non-repetition
    - **Property 8: Copy non-repetition**
    - Same file as 6.11. For any in-range previous index the selected index differs from it.
    - **Validates: Requirements 4.5**

  - [x] 6.13 Write property test for restricted-term check totality
    - **Property 20: Restricted-term check totality**
    - Same file as 6.11. For every entry and every form of every term of every group the check terminates with a boolean; matches any letter case and any declared form; rejects substring-only near misses.
    - **Validates: Requirements 4.13**

  - [x] 6.14 Write property test for copy coverage within twice the section length
    - **Property 21: Copy coverage within twice the section length**
    - Same file as 6.11. Simulate a chain of `2 × n` consecutive appearances (feeding each result back as `previousIndex`) for every section and assert every entry is selected at least once.
    - **Validates: Requirements 4.14**

- [x] 7. Checkpoint - Pure shared units green
  - Ensure all tests pass, ask the user if questions arise. Run `cd server && npm test` (this includes `shared/__tests__`).

- [x] 8. Server: note handling, routing, and the funCallouts config guard
  - [x] 8.1 Add `GameSession.addCalloutNote` and carry notes into history
    - Implement `addCalloutNote({ roundId, authorId, authorName, text })` returning `{ ok: true, note } | { ok: false, code }`, applying checks in design order: trim → empty (`NOTE_EMPTY`) → over `NOTE_MAX_LENGTH` (`NOTE_TOO_LONG`) → resolve target (current round if `currentRound.id === roundId`, else `history.find(e => e.roundId === roundId)`; else `NOTE_ROUND_UNKNOWN`) → duplicate author (`NOTE_DUPLICATE`, linear scan, stored note unchanged) → store a note with a UUID `id`, trimmed `text` exactly as received, server-clock ISO `storedAt`.
    - `clearBoard()` copies `calloutNotes` into the `HistoryEntry` as a **copy** (`[...notes]`, `undefined` when none) with text, author and round id unchanged.
    - Confirm `serializeRound` passes `calloutNotes` through as a plain array; do not add a Map.
    - Existing `game-session.*` tests must pass unedited.
    - _Requirements: 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.17, 13.6_

  - [x] 8.2 Route `callout:note:submit` in the poker WebSocket handler
    - In `server/src/websocket/handler.ts` add one case for `CALLOUT_NOTE_SUBMIT` **outside** the role-permission switch (any participant may submit; authorisation is by authorship). Implement `handleCalloutNoteSubmit`: session-mismatch check first (`typeof claimed !== 'string' || claimed !== sessionId` → `NOTE_SESSION_MISMATCH`, nothing stored, nothing broadcast, error to sender only), then shape check (`NOTE_INVALID`), then `session.addCalloutNote`.
    - On success broadcast `CALLOUT_NOTE_ADDED { roundId, note }` to the connections joined to that session only; on failure send `CALLOUT_NOTE_REJECTED { roundId, code, message }` to the sending connection only. Do **not** use the existing `error` event.
    - No new `any` (type the payload via the shared payload interfaces). Do not touch `retro-handler.ts`; the `/retro` upgrade path must not receive the event.
    - Every pre-existing event keeps its name, payload keys and recipient set.
    - _Requirements: 10.4, 10.5, 10.6, 10.7, 10.8, 10.17, 13.1, 13.3, 13.4, 13.13_

  - [x] 8.3 Normalise `funCallouts` at creation and add the owner-only config guard
    - `SessionRegistry.createSession`: store `funCallouts: resolveFunCallouts(config.funCallouts)` so every `getSessionState()` and `session:config-updated` broadcast carries a real boolean.
    - `PUT /api/sessions/:sessionId/config` in `server/src/routes/sessions.ts`: **before** `updateConfig`, if the body config has own property `funCallouts`: reject with **403** `{ error: 'FORBIDDEN', setting: 'funCallouts' }` when `session.ownerId !== user.id`, or **400** `{ error: 'INVALID_SETTING', setting: 'funCallouts' }` when the value is not a boolean. Rejection covers the whole request: no state change, no broadcast, error to the submitter only.
    - **Flagged conflict 2:** the route currently allows the owner **or any moderator**. Keep that for every other field; the `funCallouts` guard is the only behavioural change and is additive (a request without the key takes today's path).
    - _Requirements: 6.6, 6.8, 6.10, 6.11, 6.13_

  - [x] 8.4 Write property test for note validation
    - **Property 15: Note validation**
    - Runner: **Jest**, `server/src/services/__tests__/callout-notes.property.spec.ts` (shared file for Properties 15 and 22). Generate arbitrary strings (including whitespace-padded, unicode, 280/281 boundaries): accepted exactly when trimmed length is 1–280, otherwise rejected with the specific code and nothing stored; stored text equals the trimmed input exactly.
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.6, 10.7, 10.9**

  - [x] 8.5 Write property test for one note per participant per round
    - **Property 22: One note per participant per round**
    - Same file as 8.4. For generated submission sequences across current and history rounds, each round holds at most one note per author and every later submission is rejected with `NOTE_DUPLICATE` and the stored note unchanged.
    - **Validates: Requirements 10.4, 10.5, 10.10, 10.17**

  - [x] 8.6 Write property test for session isolation of note events
    - **Property 16: Session isolation**
    - Runner: **Jest**, `server/src/websocket/__tests__/callout-note-routing.property.spec.ts`. For generated pairs of distinct sessions: a note event whose `sessionId` differs from the connection's session is rejected, nothing stored, nothing broadcast, error to the sender only; a valid event reaches only connections joined to its session and zero connections on the retro endpoint.
    - **Validates: Requirements 12.5, 13.4, 13.13**

  - [x] 8.7 Write note storage and history examples
    - Runner: **Jest** (`server/src/services/__tests__/callout-notes.spec.ts`). Exactly 280 trimmed characters accepted; 281 rejected `NOTE_TOO_LONG`; whitespace-only rejected `NOTE_EMPTY`; unknown round rejected `NOTE_ROUND_UNKNOWN`; note on a current round and on a history entry both stored; `clearBoard()` copies notes into the history entry unchanged and later mutation of the round array does not reach the entry; the CSV from `buildEstimateExportCsv` is byte-identical with and without `calloutNotes` attached (R10.16; `shared/estimate-export.ts` remains unmodified).
    - _Requirements: 10.6, 10.7, 10.8, 10.10, 10.16, 13.11_

  - [x] 8.8 Write config route tests for `funCallouts`
    - Runner: **Jest** with `supertest` (`server/src/routes/__tests__/sessions-funcallouts.spec.ts`). Owner change accepted and broadcast; non-owner moderator rejected 403 with stored config unchanged and no broadcast; plain participant rejected; non-boolean rejected 400; a request without the key from a moderator still works; created sessions always carry a boolean `funCallouts` (default `true`).
    - _Requirements: 6.6, 6.8, 6.10, 6.13_

  - [x] 8.9 Write WebSocket non-regression tests and extend the isolation suite
    - Runner: **Jest**. Add `server/src/websocket/__tests__/poker-events-nonregression.spec.ts` comparing the name, payload key set and recipient set of every pre-existing poker event (`story:submit`, `card:select`, `cards:reveal`, `cards:revealed`, `board:clear`, `board:cleared`, `round:started`, `round:revote`, `role:change`, `history:clear`, `participant:remove`, `participant:removed`, `participant:joined`, `participant:left`, `issue:*`, `session:state`, `session:config-updated`, `auto:reveal-triggered`, `error`) against recorded baselines; `cards:revealed` must gain no field.
    - Extend `server/src/__tests__/isolation.spec.ts`: add the new runtime `shared/types` names to `ADDED_SHARED_EXPORTS` (`CARD_NUMERIC_VALUE`, `cardNumericValue`, `isNumericCard`, `CARD_LADDERS`, `cardLadderFor`, `ladderIndexOf`, `NOTE_MAX_LENGTH`, `CALLOUT_NOTE_SUBMIT`, `CALLOUT_NOTE_ADDED`, `CALLOUT_NOTE_REJECTED`, `normaliseCalloutNotes`, `resolveFunCallouts`) and add an import-scan asserting no retro module references any callout symbol.
    - _Requirements: 13.1, 13.3, 13.5_

- [x] 9. Checkpoint - Server green
  - Ensure all tests pass, ask the user if questions arise. Run `cd server && npm test` and confirm `retro-*` tests are untouched and passing.

- [x] 10. Client state and persistence services
  - [x] 10.1 Implement `CalloutPersistenceService` with dismissal records and the note-draft reducer
    - Create `client/src/app/services/callout-persistence.service.ts` (`providedIn: 'root'`, `inject()` + Signals): export `DismissalRecord`, `NoteDraft`, `DraftEvent`, `reduceNoteDraft`, `DISMISSAL_LIMIT = 50`, and the service with `dismissals` / `draft` read-only signals, `recordDismissal`, draft persistence, and `clearAll()`.
    - Storage is tab-scoped `sessionStorage` under `scrum-poker-callout-dismissals` and `scrum-poker-callout-draft`; do **not** add anything to `localStorage`. Hydrate in the **constructor** so restore-before-evaluate holds by injection order. `recordDismissal` appends then `slice(-50)`. On unavailable storage or a throwing write, flip an internal flag and keep serving from the in-memory mirror silently (no toast, no error indication).
    - `reduceNoteDraft` handles `typed` (non-whitespace stores against the current round id; emptied clears), `round-changed` (draft unchanged), `submitted`, `accepted` (clears only after acceptance), `rejected` (keeps), `discarded`, `session-changed`, `signed-out`.
    - `clearAll()` removes both keys and resets both signals without any network call. No `any`.
    - _Requirements: 10.13, 10.14, 10.15, 10.18, 12.2, 12.3, 12.5, 12.7, 12.8, 12.9, 12.10, 4.8_

  - [x] 10.2 Implement `CalloutCopyStoreService`
    - Create `client/src/app/services/callout-copy-store.service.ts` (`providedIn: 'root'`) with `phraseFor(section, roundId)` per design §4.5: per-session `lastIndexBySection` (feeds `previousIndex`, `-1` on first appearance) and `chosenByRound` memo so the first resolution for a `(roundId, section)` pair is the only one that consults the rotation (R2.4, R3.5). Return `null` when the section is empty (R4.12). Clear both maps on session change and on sign-out.
    - **Flagged 9:** the cursor and memo are per-tab in-memory state; a reload re-seeds the rotation. Do not add broadcast traffic.
    - _Requirements: 2.4, 3.5, 4.3, 4.5, 4.12, 12.5_

  - [x] 10.3 Extend `SessionStateService` for callout notes and cleanup
    - Add a `calloutNotes` signal (round id → note array) fed by `callout:note:added` and by `normaliseCalloutNotes(...)` over `calloutNotes` on received `session:state` rounds and history entries; a malformed collection yields `[]` while every other field applies unchanged and no error is thrown (R13.12).
    - Expose the `callout:note:added` and `callout:note:rejected` streams (the only new RxJS bridges) so the prompt component can resolve its submit without a second socket subscription.
    - Extend `reset()` (already called by `AuthService.logout()`) to call `CalloutPersistenceService.clearAll()` and clear the copy store, so no change to `AuthService` and no extra injector workaround. Clear callout state when the routed session id changes (R12.5).
    - The existing `error` subscription/toast path must be unchanged.
    - _Requirements: 10.4, 10.5, 10.11, 12.5, 12.7, 13.3, 13.12_

  - [x] 10.4 Write property test for the dismissal eviction bound
    - **Property 24: Dismissal record eviction bound**
    - Runner: **Vitest** (`ng test`), `client/src/app/services/callout-persistence.property.spec.ts`. For generated dismissal sequences the store holds at most 50 records, exactly the 50 most recent, and retains the record for the current `(sessionId, roundId, callout)` triple whenever it is among them. Stub `sessionStorage`.
    - **Validates: Requirements 12.2, 12.3, 2.11, 2.14, 3.9**

  - [x] 10.5 Write persistence service examples
    - Runner: **Vitest** (`callout-persistence.service.spec.ts`). Hydration from storage in the constructor restores dismissals and the draft before the first read; a throwing `setItem` degrades to memory and keeps the callout withheld with no error surface; `clearAll()` empties signals and keys and makes no HTTP/WS call; `reduceNoteDraft` transitions (typed, round-changed keeps, accepted clears, rejected keeps, discarded clears, session-changed/signed-out clear).
    - _Requirements: 10.13, 10.14, 10.15, 10.18, 12.7, 12.8, 12.9, 12.10_

  - [x] 10.6 Write copy store examples
    - Runner: **Vitest** (`callout-copy-store.service.spec.ts`). The same `(roundId, section)` returns the identical phrase on repeated calls (memo); consecutive rounds never repeat the previous index; session change clears the cursor; an emptied section yields `null`.
    - _Requirements: 2.4, 3.5, 4.5, 4.12_

  - [x] 10.7 Write `SessionStateService` callout tests
    - Runner: **Vitest** (`session-state-callouts.spec.ts`). `callout:note:added` updates the signal; a malformed `calloutNotes` payload on a round or history entry normalises to `[]` with the rest of the state applied; `reset()` clears persistence and copy-store state; the existing `error` toast behaviour is unchanged.
    - _Requirements: 12.7, 13.3, 13.12_

- [x] 11. Pure client resolvers: visibility and animation lifecycle
  - [x] 11.1 Implement `callout-visibility.ts` (pure resolver)
    - Create `client/src/app/components/vote-callout/callout-visibility.ts` exporting `SuppressionReason`, `CalloutResolverInput`, `NearCalloutModel`, `FarPromptModel`, `CalloutResolution`, `resolveCalloutVisibility`, `MIN_LAYER_VIEWPORT_WIDTH = 320`, `MIN_LAYER_VIEWPORT_HEIGHT = 420`, `MAX_NAMES = 8`, `NAME_TRUNCATE_AT = 18`, `truncateName`, and `computeLayerHeightBudget(viewportHeight, keyboardInset)`.
    - Follow design §5.1 ordering exactly: every suppression check (no-session, stale session id, session-not-found, countdown, funCallouts off via `resolveFunCallouts`, viewport too small, not revealed, insufficient data, non-finite average, unknown system, short ladder) is an early `return` **before** `classifyProximity`; then classification, empty-both → suppressed, variant selection (`fullAgreement` / `wideSpread` / `nearAverage`), empty copy section → suppressed, then **independent** per-callout gating (reveal permission, dismissal for the current session+round+callout, far membership of the viewer, `connectionBlocked && !alreadyVisible`).
    - Models must carry **no** distance, rank, index or count of far participants and no far display name (structural R2.5/R2.6/R3.6); do not forward `distances`. No `any`; no Angular, DOM, clock or storage dependency.
    - A reveal-permitted viewer in the Far_Set gets both models (R3.4). `replayEntrance` is `false` while `connectionBlocked`.
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8, 2.11, 2.13, 2.14, 3.1, 3.2, 3.4, 3.6, 4.12, 6.7, 7.5, 7.10, 8.3, 8.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 12.1, 12.3, 12.4, 12.5_

  - [x] 11.2 Implement `callout-animation.ts` (lifecycle reducer, budget, stagger)
    - Create `client/src/app/components/vote-callout/callout-animation.ts` exporting `CalloutPhase`, `LifecycleState`, `LifecycleEvent`, `ExitCause`, `LifecycleEffect`, `EXIT_REMOVAL_DEADLINE_MS = 700`, `reduceCalloutLifecycle`, `ANIMATION_BUDGET = 24` with an `AnimationBudget` class (`acquire`, `release`, `inFlight`, `plan`), and `computeStagger(nameCount)` (40–90 ms, whole sequence ≤ 900 ms with `ENTRANCE_MS = 420`).
    - Reducer follows the design §7.6 transition table: `entrance-end` → `idle` emits `start-idle` **unless** `reducedMotion`; exit during `entering` emits `capture-transform` and never `start-idle`; repeated exit triggers while `exiting` are no-ops; `exit-end` / `exit-deadline` → `removed` with exactly one `remove` and one `release-budget`; `removed` ignores everything; `entrance-end` in `idle` is idempotent (covers the `animationend`/timeout race).
    - **Flagged 7:** when `funCallouts` turns false, Reduced_Motion_Mode is active by definition, so the exit cause `fun-callouts-off` runs as the opacity-only ≤150 ms exit; removal still happens exactly once.
    - Pure, no timers inside the reducer.
    - _Requirements: 5.3, 5.6, 5.8, 5.9, 5.10, 5.12, 5.13, 5.15, 5.16, 5.17, 6.1, 6.2, 6.9, 11.15_

  - [x] 11.3 Write property test for suppression precedence
    - **Property 23: Suppression precedence**
    - Runner: **Vitest**, `client/src/app/components/vote-callout/callout-visibility.property.spec.ts`. Generate the full cross-product of suppression-relevant flags (`resolverInputArb`); whenever any suppression condition holds, both `near` and `far` models are hidden regardless of satisfied display conditions.
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.7, 11.13, 11.14, 6.7, 7.5, 7.10, 4.12**

  - [x] 11.4 Write property test for exit totality
    - **Property 10: Exit totality**
    - Runner: **Vitest**, `client/src/app/components/vote-callout/callout-animation.property.spec.ts` (shared file for Properties 10, 11, 17, 18, 19, 12, 13). Use `lifecycleEventArb`; every exit cause drives every visible callout to `removed`.
    - **Validates: Requirements 5.6, 5.8, 5.9, 6.9, 11.15**

  - [x] 11.5 Write property test for exit idempotence
    - **Property 11: Exit idempotence**
    - Same file as 11.4. Sequences with ≥ 2 exit triggers produce exactly one `remove` and one `release-budget`.
    - **Validates: Requirements 5.10**

  - [x] 11.6 Write property test for entrance-to-idle handoff termination
    - **Property 17: Entrance-to-idle handoff termination**
    - Same file as 11.4. An uninterrupted entrance reaches `idle`; any later exit still removes exactly once.
    - **Validates: Requirements 5.8, 5.15**

  - [x] 11.7 Write property test for exit-during-entrance cancellation
    - **Property 18: Exit-during-entrance cancellation**
    - Same file as 11.4. An exit during `entering` emits `capture-transform`, never `start-idle`, and removes exactly once.
    - **Validates: Requirements 5.8, 5.16**

  - [x] 11.8 Write property test for the exit removal deadline
    - **Property 19: Exit removal deadline**
    - Same file as 11.4. With no `exit-end`, `exit-deadline` (arming 700 ms) removes exactly once and releases the budget share.
    - **Validates: Requirements 5.17**

  - [x] 11.9 Write property test for reduced-motion safety
    - **Property 12: Reduced-motion safety**
    - Same file as 11.4. While `reducedMotion` is true the plan contains no `start-idle` and the stylesheet text parsed from `vote-callout.keyframes.scss` (reduced-motion and `--still` blocks) has no `transform`, `translate`, `rotate` or `scale` in any animation or transition.
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [x] 11.10 Write property test for the animation budget
    - **Property 13: Animation budget**
    - Same file as 11.4. For generated participant lists and acquire/release sequences, in-flight ≤ capacity and every surplus name is marked at-rest; exercise the surplus branch with a small synthetic capacity because the real name cap (8) cannot reach 24.
    - **Validates: Requirements 5.12, 5.13**

  - [x] 11.11 Write resolver examples
    - Runner: **Vitest** (`callout-visibility.spec.ts`). Variants (`fullAgreement` for ≥ 2 identical numeric votes, `wideSpread` with no names when near is empty and far is not); permission gating per reveal-permission mode; dual panel for a permitted far viewer; independent dismissal; participant-left reclassification dropping a name (R11.9) and switching to `wideSpread` (R11.10); `connectionBlocked` hides new but keeps already-visible; stale `stateSessionId` yields nothing; the near model has no digit, distance or far name; name truncation at 18 characters with the full name preserved; 8-name cap with `hiddenNameCount`.
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8, 8.3, 8.4, 11.6, 11.9, 11.10, 11.12, 12.5_

  - [x] 11.12 Write animation helper examples
    - Runner: **Vitest** (`callout-animation.spec.ts`). `computeStagger` for 1–8 and large counts stays within 40–90 ms and 900 ms total; `computeLayerHeightBudget` reduces below 45 vh when a keyboard inset would cover the input; `AnimationBudget` acquire/release arithmetic.
    - _Requirements: 5.3, 5.12, 5.13, 8.7, 8.8_

- [x] 12. Checkpoint - Client services and resolvers green
  - Ensure all tests pass, ask the user if questions arise. Run `cd client && npm test` (single-shot) and `cd server && npm test`; confirm strict TypeScript compiles with no `any` in the new code.

- [x] 13. Components and CSS
  - [x] 13.1 Create `vote-callout.keyframes.scss` and import it once from `client/src/styles.scss`
    - Put all `@keyframes` and custom-property defaults here, not in component styles (emulated encapsulation does not scope keyframes, and the `anyComponentStyle` budget is 6 kB warn / 12 kB error). Tokens per design §7.2 (`--callout-entrance-ms: 420ms`, `--callout-exit-ms: 320ms`, `--callout-idle-ms: 2600ms`, `--callout-idle-iterations: 11`, `--callout-reduced-ms: 150ms`).
    - Keyframes: `callout-pop-in` (0.5 → 1.08 at 60% → 1), `callout-slide-in` (offscreen, 9° → −1.2° → 0°), `callout-idle` (±2 px, ±0.6°, ends on identity transform so 11 × 2600 ms = 28.6 s < 30 s and handoff discontinuity is 0), `callout-pop-out` (≤ 0.25 scale, 14°, 70% downward, fade; reads `--callout-exit-from` / `--callout-exit-opacity`). Overshoot lives in the keyframes with a monotone easing curve.
    - Animate only `transform` and `opacity`. Include the `@media (prefers-reduced-motion: reduce)` block and the `.vote-callout-layer--still` block (opacity-only, ≤ 150 ms, no transform/translate/rotate/scale).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.11, 5.15, 6.1, 6.2, 6.3_

  - [x] 13.2 Implement `NearAverageCalloutComponent`
    - `client/src/app/components/vote-callout/near-average-callout.component.ts`, standalone, signal `input()`/`output()` API per design §6.2: phrase with the glyph split into an `aria-hidden` span, `@for` name chips (all rendered on first paint; stagger via `--name-index` CSS delay; surplus names get `callout__name--at-rest`), `title` and `aria-label` carrying the full name, optional "and N more" summary, a dismiss button `aria-label="Dismiss the vote agreement callout"` with `(keydown.escape)` handled with `stopPropagation()`.
    - Drive the lifecycle through `reduceCalloutLifecycle`; swap to idle on `animationend` with a `setTimeout(ENTRANCE_MS + 80)` fallback (same idempotent event); on exit capture `getComputedStyle` transform/opacity into the CSS variables; before removal, if `el.contains(document.activeElement)` move focus to `#main-content` (give it `tabindex="-1"`), otherwise touch nothing. Record every timer and clear it in `ngOnDestroy`; use no `requestAnimationFrame`. Never call `.focus()` on appear.
    - Use `animate.enter` / `animate.leave`; no `@angular/animations`, no third-party animation library. Text is interpolated (never `innerHTML`). No `any`. No distance, rank or ordinal rendered on any name.
    - _Requirements: 2.3, 2.4, 2.5, 2.7, 2.8, 2.10, 2.11, 2.12, 5.1, 5.3, 5.4, 5.5, 5.8, 5.10, 5.13, 5.14, 5.15, 5.16, 5.17, 6.1, 6.2, 6.4, 8.3, 8.4, 8.5, 9.1, 9.5, 9.7, 9.8, 9.12, 4.10, 12.6, 13.7_

  - [x] 13.3 Implement `FarFromAveragePromptComponent`
    - `client/src/app/components/vote-callout/far-from-average-prompt.component.ts`, standalone, signals: `draft`, `pending`, `errorMessage`, `accepted`, `canSubmit = !pending() && draft().trim().length > 0`. Textarea `maxlength="280"`, `min-height: 44px`, accessible name `Add a note about your estimate`; submit `Share this` (`aria-label="Share your note on this round"`); dismiss `No thanks, all good` (`aria-label="Decline to add a note about your estimate"`) with the same class, font size and box size as submit, and none of the words cancel/skip/ignore/later.
    - Submit disables immediately and sends `callout:note:submit { sessionId, roundId, text }` once; resolve on the `callout:note:added` for this author and round (acknowledgement phrase from the `acknowledgement` section, remove input and submit, then exit) or `callout:note:rejected` (stay visible, keep text, re-enable submit, inline error "note was not saved"). Dismiss/Escape discards unsent text and transmits nothing, including no dismissal signal to anyone else.
    - Start empty on each appearance; when a new round starts with non-whitespace text, hand the draft to `CalloutPersistenceService` via `reduceNoteDraft` so it survives as an unsent note. Same lifecycle, focus-move, timer cleanup and no-autofocus rules as 13.2.
    - The prompt shows no distance, own card value, average, counts, or other participants' names or cards.
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 10.1, 10.2, 10.3, 10.6, 10.7, 10.8, 10.12, 10.13, 9.1, 9.5, 9.7, 9.8, 9.12, 5.2, 5.14, 12.6_

  - [x] 13.4 Implement `UnsentNoteComponent`
    - `client/src/app/components/vote-callout/unsent-note.component.ts`: a compact, non-animated element (no entrance/idle/exit, no dismissal record) that renders the retained text read-only with submit (`aria-label="Share your saved note on its original round"`) and discard (`aria-label="Discard your saved note"`) controls. Submit sends against the **stored** round id, not the current one, and clears the draft only after `callout:note:added` (kept on rejection); discard clears the draft and sends nothing.
    - Visible exactly when a draft exists whose `roundId` differs from the current round and whose `sessionId` matches the routed session (so a draft restored after reload appears bound to its round).
    - _Requirements: 10.13, 10.14, 10.15, 10.18, 12.10, 9.5, 9.9_

  - [x] 13.5 Implement `VoteCalloutLayerComponent` and its layout CSS
    - `client/src/app/components/vote-callout/vote-callout-layer.component.ts`, standalone, importing the three child components. State per design §6.1: `resolution` computed (from `SessionStateService`, permissions, `CalloutPersistenceService.dismissals`, a debounced `viewport` signal fed by `resize` and `visualViewport` listeners, `countdownActive`, `connectionBlocked`), `nearModel` / `farModel`, phrases from `CalloutCopyStoreService`, `reducedMotion` (OS `matchMedia` change-listener signal **or** `!resolveFunCallouts(config.funCallouts)`), `staggerMs`, `animatedNameCount` from an instance `AnimationBudget`, and `unsentDraft`.
    - Two `role="status" aria-live="polite" aria-atomic="true"` live regions as **siblings** of the animated subtree (one near, one far), text written once per appearance from glyph-stripped phrase + full names + summary, empty when hidden; always present so the node is never inserted mid-announcement.
    - Exit triggers derive from existing signals (round id change, round cleared, re-vote, left revealed state, dismissal, suppression, `funCallouts` off). On `ngOnDestroy` clear every timer and remove callouts without an exit flourish.
    - Layout CSS per design §8: `position: fixed`, `z-index: 900` (above content sections, below mobile history backdrop 999, dialogs/menus 1000, countdown 9999, toast 10000), `isolation: isolate`, bottom-right 16 px inset, `flex-direction: column-reverse`, 8 px gap, `max-width: min(360px, 100vw − 16px)`, `max-height: 40vh`, `pointer-events: none` on layer and panel bodies and `auto` only on buttons/textarea, no descendant `z-index`, `overscroll-behavior: contain`; mobile block (< 768 px: width `100vw − 32px`, `max-height: 45vh`, internal scroll, 32 px minimum control size, 44 px input); focus-visible outline ≥ 2 px with 3:1 contrast; tokens from the design's contrast table (`#ffffff` background, `#1a1a2e` text, `#4a5568` summary, `#1b3fa8` actions). No `inert`, no `aria-modal`, no backdrop, no scroll lock.
    - **Flagged 8:** follow R7.2 literally; do **not** implement the conditional `pointer-events: auto` on an overflowing scroll container (recorded as the agreed remedy only).
    - _Requirements: 2.1, 2.2, 3.1, 3.4, 5.6, 5.9, 5.12, 6.8, 6.9, 6.12, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 8.1, 8.2, 8.5, 8.6, 8.7, 8.8, 9.2, 9.3, 9.4, 9.6, 9.9, 9.10, 9.11, 11.12, 11.15, 12.1, 12.5, 12.6, 13.7_

  - [x] 13.6 Write near-average callout component tests
    - Runner: **Vitest** with `TestBed` / `ComponentFixture` and `componentRef.setInput` (no Karma/Jasmine patterns). Names in order, truncation plus `title`/`aria-label`, summary count, no digit in any name chip (R2.5), no far name anywhere (R2.6), dismiss control and Escape handling, glyph `aria-hidden`, fake-timer check that the panel is still present far beyond any plausible auto-dismiss (R2.12).
    - _Requirements: 2.3, 2.5, 2.6, 2.10, 2.12, 8.3, 8.4, 9.5, 9.7, 4.10_

  - [x] 13.7 Write far-from-average prompt component tests
    - Runner: **Vitest**. Zero WebSocket sends across appear/type/dismiss (R3.3, R3.9); submit disabled while empty/whitespace and while pending; each rejection code retains text, re-enables submit and shows the error; acceptance shows the acknowledgement and removes input and submit; dismiss label literal text, forbidden words absent, equal font size and box size with submit; `maxlength` 280; no timeout (R3.10).
    - _Requirements: 3.3, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 10.1, 10.3, 10.12_

  - [x] 13.8 Write unsent note component tests
    - Runner: **Vitest**. Survives repeated round changes; submit uses the stored round id; removal only after acceptance; discard sends nothing; a stale draft restored from storage appears bound to its round.
    - _Requirements: 10.13, 10.14, 10.15, 10.18, 12.10_

  - [x] 13.9 Write layer component tests
    - Runner: **Vitest** (plus `@testing-library/angular` for interaction). Live-region role/`aria-live`/`aria-atomic`/text, text written once per appearance; focus unchanged on appear, moved to `#main-content` on removal with focus inside, untouched on removal with focus outside (caret/selection preserved); tab order puts every callout control after every board control and no positive `tabindex`; accessible names non-empty and pairwise distinct; `scrollHeight`/`scrollTop` unchanged around mount/unmount and no `inert`/`aria-modal`/backdrop; `pointer-events` none on layer and panels, auto on controls; countdown hides and restores the layer; reduced motion (`matchMedia` stub, including a live `change` event) keeps text, names and controls identical; zero pending fake timers and zero `requestAnimationFrame` calls after destroy; dual-panel DOM order (near first); `axe-core` check only if `axe-core` is already a client devDependency (otherwise skip the contrast rule and rely on the recorded token ratios).
    - _Requirements: 6.4, 6.12, 7.2, 7.5, 7.6, 7.8, 7.11, 7.12, 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 9.11, 9.12, 12.6_

  - [x] 13.10 Write stylesheet and dependency assertions
    - Runner: **Jest** or **Vitest** (file-system source scans; use Vitest in `client/`). Parse `vote-callout.keyframes.scss` and layer styles: entrance start/peak/rest scale bands, slide rotation bands, idle amplitude and period bands, exit bands, only `transform`/`opacity` animated, layer `z-index: 900`, `isolation: isolate`, no descendant `z-index`, 16 px edge gap, 8 px panel gap, 360 px / 40 vh / 45 vh caps, 32 px control minimum. Assert `client/package.json` has no `@angular/animations` dependency and no source file under `components/vote-callout/` imports it or a third-party animation library; assert no `any` annotations or casts in the added files (R13.8).
    - _Requirements: 5.1, 5.2, 5.4, 5.7, 5.11, 5.14, 7.3, 7.4, 7.7, 8.1, 8.2, 9.9, 13.8_

- [x] 14. Wiring into the session page and settings panel
  - [x] 14.1 Host the layer in `session-poker-page.component.ts`
    - Import `VoteCalloutLayerComponent` and render `<app-vote-callout-layer />` as the **last child** of `.session-poker-page`, inside the `@else` (session found) branch after `<app-countdown-overlay>`, and **outside** every `.interaction-blocker` wrapper (so a paused connection does not make visible callouts inert; the resolver's `connectionBlocked` gate handles "no new callouts").
    - Add `tabindex="-1"` to the existing `#main-content` board region so focus can be moved there on removal. No other change to header, metrics, deck, issue, history, countdown or dialog markup; no new eager route.
    - _Requirements: 7.4, 7.5, 9.4, 9.8, 11.11, 11.12, 13.7_

  - [x] 14.2 Add the owner-only `funCallouts` checkbox to the settings panel
    - In `session-settings-panel.component.ts` add a `funCallouts` form control and a "Fun callouts" checkbox in the Additional Options fieldset, matching the existing toggle markup.
    - **Flagged conflict 2:** the panel is shown for moderators (the page passes `isSessionOwner()`, which is role-based). Render the `funCallouts` control and include the `funCallouts` key in the `PUT` body **only** when `sessionState.ownerId() === currentUser().id` (the page's existing `isOwner` computed, passed in as a new input rather than reusing `isSessionOwner`). A non-owner moderator never sends the field, so their edits to other fields keep working.
    - The update flows through the existing `session:config-updated` → `sessionConfig` signal, so every client re-evaluates without reload.
    - _Requirements: 6.5, 6.8, 6.10_

  - [x] 14.3 Write page wiring tests
    - Runner: **Vitest**. The layer is the last child of `.session-poker-page`, is absent in the session-not-found state, is not inside `.interaction-blocker`, is hidden while the countdown overlay is active and returns within one change-detection cycle after it clears; existing page markup and tab order are otherwise unchanged.
    - _Requirements: 7.5, 7.12, 9.4, 11.11, 11.12_

  - [x] 14.4 Write settings panel tests
    - Runner: **Vitest**. Owner sees the checkbox and sends `funCallouts`; a non-owner moderator does not see it and their PUT body omits the key while other field edits still send; toggling updates the form without affecting other controls.
    - _Requirements: 6.8, 6.10_

- [x] 15. History panel notes
  - [x] 15.1 Render notes in `SessionHistoryComponent`
    - In the existing expanded detail region add a `Notes` block rendered with `@if (entry.calloutNotes?.length)` and `@for (note of orderedNotes(entry); track note.id)`, showing `note.authorName` and the **full** `note.text` via interpolation (never `innerHTML` or `bypassSecurityTrust*`, so markup displays literally). Implement `orderedNotes` as a pure decorate-sort-undecorate by `storedAt` ascending with the stored index as a stable tie-break. Add scoped styles within the component style budget.
    - Do not touch `shared/estimate-export.ts` or the export route.
    - _Requirements: 10.9, 10.10, 10.11, 10.16_

  - [x] 15.2 Write history notes tests
    - Runner: **Vitest**. Author and full text rendered, oldest first with stable tie-break, markup in a note (`<b>x</b>`) displayed literally, no block when `calloutNotes` is absent or empty.
    - _Requirements: 10.9, 10.11_

- [x] 16. Checkpoint - Components, wiring and history green
  - Ensure all tests pass, ask the user if questions arise. Run `cd client && npm test` and `cd client && npx ng build` (strict templates, budgets, zero warnings), and `cd server && npm test`.

- [x] 17. Final integration checks
  - [x] 17.1 Write the client end-to-end integration test with a faked socket
    - Runner: **Vitest**. Drive `SessionStateService` with a stubbed `WebSocketService` through a reveal (`cards:revealed`), then assert the real resolver + layer show the near callout to a reveal-permitted viewer and the prompt to a far viewer; submit a note and resolve with `callout:note:added`; start a new round and assert both panels exit and a drafted note collapses into the unsent element; flip `funCallouts` off via `session:config-updated` and assert removal; sign out via `reset()` and assert persistence is cleared.
    - _Requirements: 2.1, 3.1, 3.11, 5.6, 6.9, 10.13, 12.7_

  - [x] 17.2 Write the server end-to-end flow test
    - Runner: **Jest** (`server/src/websocket/__tests__/callout-flow.spec.ts`). Real `GameSession` + handler with fake sockets: reveal on a `power-of-2` and a `t-shirt` session (outliers flagged / insufficient data), submit a note to the current round, clear the board, submit a note to the history round, assert broadcasts reach only that session, `cards:revealed` payload keys are unchanged, the history entry carries the notes, and the export CSV is identical to one built from the same history without notes.
    - _Requirements: 10.4, 10.5, 10.10, 10.16, 13.3, 13.4, 14.9, 15.4_

- [x] 18. Final checkpoint - Everything green
  - Ensure all tests pass, ask the user if questions arise. Both suites single-shot with zero failing and zero newly skipped tests (R13.9); strict TypeScript and strict templates clean (R13.8); optionally confirm line/branch coverage ≥ 90% over the files added or modified by this feature (R13.10).

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP. **Tasks 1.2, 4.3 and 4.4 are intentionally required** (baseline capture, Fibonacci non-regression, and the t-shirt consequence audit). Task 1.1 must land before any task that modifies `metrics-engine.ts`; 2.3 only changes types and signatures, so the frozen baseline still equals the runtime logic when 1.2 runs.
- Each task references specific requirements; each property-based sub-task names its design property number. All 31 properties map to exactly one sub-task: P1–P6 → 6.2–6.7, P7/P8 → 6.11/6.12, P9 → 6.10, P10 → 11.4, P11 → 11.5, P12 → 11.9, P13 → 11.10, P14 → 2.7, P15 → 8.4, P16 → 8.6, P17 → 11.6, P18 → 11.7, P19 → 11.8, P20 → 6.13, P21 → 6.14, P22 → 8.5, P23 → 11.3, P24 → 10.4, P25 → 4.6, P26 → 4.7, P27 → 1.2 and 4.3, P28 → 4.8, P29 → 4.9, P30 → 4.10, P31 → 4.11.
- Property sub-tasks that share a spec file (for example 4.6–4.11, 6.2–6.7, 6.11–6.14, 8.4–8.5, 11.4–11.10) append a `describe` block to the same file, so they sit in different waves of the dependency graph.
- Runner summary: **Jest** (`cd server && npm test`) covers `server/src/**` and `shared/__tests__/**`; **Vitest** (`cd client && npm test`, via `ng test`) covers `client/src/**`. Do not add Karma config or a `moduleNameMapper` for `@shared/*`.
- No `any` in code added for this feature (R13.8); retro modules are never modified (R13.1); `shared/estimate-export.ts` and `shared/csv.ts` are never modified (R10.16).
- Out of scope for this task list (manual verification, not coding tasks): rendered geometry and clearances at 320/375/768/1024/1440 px, real colour-contrast measurement, on-screen keyboard behaviour on iOS Safari and Android Chrome, and real screen-reader output on NVDA, JAWS and VoiceOver. Automated tests above assert the declarations and structure that make those hold.
- Deferred and deliberately not done: rewording the "Insufficient data — fewer than 2 numeric votes" string, deleting the now-unreachable t-shirt branch of `computeConsensusLevel`, translating the catalog, and the conditional `pointer-events` remedy for an overflowing callout.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "6.9", "11.2", "13.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "6.1", "6.10", "6.11", "10.2", "11.4", "11.12"] },
    { "id": 3, "tasks": ["2.4", "2.5", "4.1", "6.2", "6.8", "6.12", "10.6", "11.5"] },
    { "id": 4, "tasks": ["2.6", "2.7", "4.2", "4.3", "4.6", "4.12", "6.3", "6.13", "10.1", "11.6", "15.1"] },
    { "id": 5, "tasks": ["2.8", "4.4", "4.5", "4.7", "6.4", "6.14", "8.1", "8.3", "10.3", "10.4", "10.5", "11.1", "11.7", "13.4", "15.2"] },
    { "id": 6, "tasks": ["4.8", "6.5", "8.2", "8.4", "8.7", "8.8", "10.7", "11.3", "11.8", "11.11", "13.2", "13.3", "13.8", "14.2"] },
    { "id": 7, "tasks": ["4.9", "6.6", "8.5", "8.6", "8.9", "11.9", "13.5", "13.6", "13.7", "14.4", "17.2"] },
    { "id": 8, "tasks": ["4.10", "6.7", "11.10", "13.9", "13.10", "14.1"] },
    { "id": 9, "tasks": ["4.11", "14.3", "17.1"] }
  ]
}
```
