import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, NOTE_MAX_LENGTH, CalloutNote } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Property tests for Callout_Note handling in GameSession.addCalloutNote.
 *
 * Shared file for Properties 15 and 22 (task 8.5 appends to this file and reuses the
 * module-scope fixtures and generators below).
 */

// ---------------------------------------------------------------------------
// Module-scope fixtures (reused by Property 22 / task 8.5)
// ---------------------------------------------------------------------------

const AUTHOR_ID = 'author-1';
const AUTHOR_NAME = 'Alice';

type RoundTarget = 'current' | 'history';

interface NoteFixture {
  session: GameSession;
  /** Round id of the active (current) round. */
  currentRoundId: string;
  /** Round id of the round already saved to history. */
  historyRoundId: string;
}

/**
 * Build a session holding one saved history round and one active current round,
 * so notes can be addressed to either target.
 */
function makeNoteFixture(): NoteFixture {
  const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);
  const historyRound = session.startRound('History story');
  session.revealCards();
  session.clearBoard();
  const currentRound = session.startRound('Current story');
  return { session, currentRoundId: currentRound.id, historyRoundId: historyRound.id };
}

function roundIdFor(fixture: NoteFixture, target: RoundTarget): string {
  return target === 'current' ? fixture.currentRoundId : fixture.historyRoundId;
}

/** Notes stored against the given target round (empty array when none). */
function storedNotes(fixture: NoteFixture, target: RoundTarget): CalloutNote[] {
  if (target === 'current') {
    return fixture.session.getCurrentRound()?.calloutNotes ?? [];
  }
  const entry = fixture.session.getHistory().find((e) => e.roundId === fixture.historyRoundId);
  return entry?.calloutNotes ?? [];
}

// ---------------------------------------------------------------------------
// Module-scope generators (reused by Property 22 / task 8.5)
// ---------------------------------------------------------------------------

const roundTargetArb: fc.Arbitrary<RoundTarget> = fc.constantFrom<RoundTarget>('current', 'history');

/** Whitespace characters that String.prototype.trim() removes. */
const whitespaceCharArb = fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u2028', '\ufeff');
const paddingArb = fc.array(whitespaceCharArb, { maxLength: 6 }).map((chars) => chars.join(''));

/** Single UTF-16 code unit, non-whitespace characters (including non-ASCII). */
const singleUnitCharArb = fc.constantFrom('a', 'Z', '7', '-', 'é', 'ß', '日', 'Ж', '!');

/** Text of exactly `length` non-whitespace code units. */
function coreOfLength(length: number): fc.Arbitrary<string> {
  return fc
    .array(singleUnitCharArb, { minLength: length, maxLength: length })
    .map((chars) => chars.join(''));
}

/** Whitespace-padded text whose trimmed length is exactly `length`. */
function paddedOfLength(length: number): fc.Arbitrary<string> {
  return fc
    .tuple(paddingArb, coreOfLength(length), paddingArb)
    .map(([lead, core, trail]) => `${lead}${core}${trail}`);
}

/**
 * Arbitrary note text biased toward the validation boundaries:
 * raw strings (any unicode), whitespace-only, whitespace-padded text, and the 1/280/281 edges.
 */
const noteTextArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 400 }) },
  { weight: 2, arbitrary: fc.string({ maxLength: 400 }) },
  { weight: 2, arbitrary: paddingArb },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: NOTE_MAX_LENGTH - 1 }).chain(paddedOfLength) },
  { weight: 2, arbitrary: fc.constantFrom(1, NOTE_MAX_LENGTH - 1, NOTE_MAX_LENGTH).chain(paddedOfLength) },
  { weight: 2, arbitrary: fc.constantFrom(NOTE_MAX_LENGTH + 1, NOTE_MAX_LENGTH + 2).chain(paddedOfLength) },
  { weight: 1, arbitrary: fc.integer({ min: NOTE_MAX_LENGTH + 1, max: 600 }).chain(paddedOfLength) },
);

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

describe('Callout notes - property tests', () => {
  // Feature: vote-reveal-fun-callouts, Property 15: Note validation
  /**
   * **Validates: Requirements 10.1, 10.2, 10.3, 10.6, 10.7, 10.9**
   *
   * For every generated string, the note is accepted exactly when its trimmed length lies
   * between 1 and 280 inclusive, and is rejected otherwise (with the specific code) and
   * nothing is stored. An accepted note stores the trimmed input exactly.
   */
  it('Property 15: accepts exactly when trimmed length is 1-280, otherwise rejects with the specific code and stores nothing', () => {
    fc.assert(
      fc.property(noteTextArb, roundTargetArb, (text, target) => {
        const fixture = makeNoteFixture();
        const roundId = roundIdFor(fixture, target);
        const otherTarget: RoundTarget = target === 'current' ? 'history' : 'current';

        const trimmed = text.trim();
        const result = fixture.session.addCalloutNote({
          roundId,
          authorId: AUTHOR_ID,
          authorName: AUTHOR_NAME,
          text,
        });

        const shouldAccept = trimmed.length >= 1 && trimmed.length <= NOTE_MAX_LENGTH;

        // The other round never receives the note.
        expect(storedNotes(fixture, otherTarget)).toHaveLength(0);

        if (shouldAccept) {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.note.text).toBe(trimmed);
          expect(result.note.roundId).toBe(roundId);
          expect(result.note.authorId).toBe(AUTHOR_ID);

          const stored = storedNotes(fixture, target);
          expect(stored).toHaveLength(1);
          expect(stored[0].text).toBe(trimmed);
        } else {
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.code).toBe(trimmed.length === 0 ? 'NOTE_EMPTY' : 'NOTE_TOO_LONG');
          expect(storedNotes(fixture, target)).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: vote-reveal-fun-callouts, Property 22: One note per participant per round
  /**
   * **Validates: Requirements 10.4, 10.5, 10.10, 10.17**
   *
   * For any sequence of submissions (authors x rounds x texts), each round holds at most one
   * note per author. The first valid submission by an author to a round is stored; every later
   * valid submission by that author to that round is rejected with NOTE_DUPLICATE and the stored
   * note is left unchanged. Other authors and the other round are unaffected.
   */
  it('Property 22: only an author\'s first valid note per round is stored; later ones are rejected NOTE_DUPLICATE with the stored note unchanged', () => {
    const authorArb = fc.constantFrom('author-1', 'author-2', 'author-3');
    const validTextArb = fc.integer({ min: 1, max: 40 }).chain(paddedOfLength);
    const submissionArb = fc.record({
      authorId: authorArb,
      target: roundTargetArb,
      text: fc.oneof({ weight: 3, arbitrary: validTextArb }, { weight: 1, arbitrary: noteTextArb }),
    });

    fc.assert(
      fc.property(fc.array(submissionArb, { minLength: 1, maxLength: 30 }), (submissions) => {
        const fixture = makeNoteFixture();
        // Model: first accepted note per (target, author), as a snapshot taken at acceptance time.
        const expected = new Map<string, CalloutNote>();

        for (const { authorId, target, text } of submissions) {
          const key = `${target}|${authorId}`;
          const trimmed = text.trim();
          const valid = trimmed.length >= 1 && trimmed.length <= NOTE_MAX_LENGTH;
          const before = expected.get(key);

          const result = fixture.session.addCalloutNote({
            roundId: roundIdFor(fixture, target),
            authorId,
            authorName: `Name of ${authorId}`,
            text,
          });

          if (!valid) {
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe(trimmed.length === 0 ? 'NOTE_EMPTY' : 'NOTE_TOO_LONG');
          } else if (before === undefined) {
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.note.authorId).toBe(authorId);
            expect(result.note.roundId).toBe(roundIdFor(fixture, target));
            expect(result.note.text).toBe(trimmed);
            expected.set(key, { ...result.note });
          } else {
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.code).toBe('NOTE_DUPLICATE');
          }

          // Stored note for this author/round is exactly the first accepted one (or absent).
          const mine = storedNotes(fixture, target).filter((n) => n.authorId === authorId);
          expect(mine).toEqual(before === undefined && !expected.has(key) ? [] : [expected.get(key)]);
        }

        // Final state: at most one note per author per round, matching the model exactly.
        for (const target of ['current', 'history'] as RoundTarget[]) {
          const stored = storedNotes(fixture, target);
          const authors = stored.map((n) => n.authorId);
          expect(new Set(authors).size).toBe(authors.length);
          for (const note of stored) {
            expect(note).toEqual(expected.get(`${target}|${note.authorId}`));
          }
          const expectedCount = [...expected.keys()].filter((k) => k.startsWith(`${target}|`)).length;
          expect(stored).toHaveLength(expectedCount);
        }
      }),
      { numRuns: 100 },
    );
  });
});
