import * as fc from 'fast-check';
import {
  isCalloutNote,
  normaliseCalloutNotes,
  type CalloutNote,
  type VotingRound,
} from '../types';

/**
 * Property 14: note round-trip across the WebSocket boundary.
 * `VotingRound.selections` is a Map and needs hand-written (de)serialisation; the note collection is a
 * plain array precisely so that `JSON.stringify` / `JSON.parse` is lossless (design §1.4).
 */

/** Strings of any shape, including empty, non-ASCII and lone-surrogate content. */
const textArb: fc.Arbitrary<string> = fc.oneof(fc.string(), fc.string({ unit: 'binary' }));

const noteArb: fc.Arbitrary<CalloutNote> = fc.record({
  id: fc.uuid(),
  roundId: fc.oneof(fc.uuid(), fc.string()),
  authorId: fc.oneof(fc.uuid(), fc.string()),
  authorName: textArb,
  text: textArb,
  storedAt: fc
    .date({ min: new Date(0), max: new Date('2100-01-01T00:00:00.000Z'), noInvalidDate: true })
    .map((d) => d.toISOString()),
});

const notesArb: fc.Arbitrary<CalloutNote[]> = fc.array(noteArb, { minLength: 0, maxLength: 100 });

/** True when a Map instance occurs anywhere inside the value. */
function containsMap(value: unknown): boolean {
  if (value instanceof Map) return true;
  if (Array.isArray(value)) return value.some(containsMap);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some(containsMap);
  }
  return false;
}

describe('Property 14: Note round-trip across the WebSocket boundary', () => {
  // Feature: vote-reveal-fun-callouts, Property 14: Note round-trip across the WebSocket boundary
  // **Validates: Requirements 13.6**
  it('normaliseCalloutNotes(JSON.parse(JSON.stringify(notes))) deep-equals the original', () => {
    fc.assert(
      fc.property(notesArb, (notes) => {
        const wire = JSON.stringify(notes);
        const received = normaliseCalloutNotes(JSON.parse(wire));

        expect(received).toEqual(notes);
        expect(received).toHaveLength(notes.length);
        received.forEach((note, i) => {
          // text, author identifier, round identifier and position are preserved
          expect(note.text).toBe(notes[i].text);
          expect(note.authorId).toBe(notes[i].authorId);
          expect(note.roundId).toBe(notes[i].roundId);
          expect(note.id).toBe(notes[i].id);
        });
      }),
      { numRuns: 200 },
    );
  });

  // Feature: vote-reveal-fun-callouts, Property 14: Note round-trip across the WebSocket boundary
  // **Validates: Requirements 13.6**
  it('the serialised form is a plain array containing no Map', () => {
    fc.assert(
      fc.property(notesArb, (notes) => {
        const wire = JSON.stringify(notes);
        const parsed: unknown = JSON.parse(wire);

        expect(wire.startsWith('[')).toBe(true);
        expect(Array.isArray(parsed)).toBe(true);
        expect(containsMap(notes)).toBe(false);
        expect(containsMap(parsed)).toBe(false);
        // Re-serialising the received value is stable, so nothing was lost or reshaped
        expect(JSON.stringify(normaliseCalloutNotes(parsed))).toBe(wire);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: vote-reveal-fun-callouts, Property 14: Note round-trip across the WebSocket boundary
  // **Validates: Requirements 13.6**
  it('a round carrying notes round-trips its calloutNotes as a plain array', () => {
    fc.assert(
      fc.property(notesArb, (notes) => {
        const round: Pick<VotingRound, 'id' | 'calloutNotes'> = { id: 'r1', calloutNotes: notes };
        const received = JSON.parse(JSON.stringify(round)) as typeof round;

        expect(Array.isArray(received.calloutNotes)).toBe(true);
        expect(normaliseCalloutNotes(received.calloutNotes)).toEqual(notes);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property 14 examples: malformed inputs normalise without throwing', () => {
  const good: CalloutNote = {
    id: '11111111-1111-4111-8111-111111111111',
    roundId: 'round-1',
    authorId: 'u1',
    authorName: 'Ada',
    text: 'looks risky',
    storedAt: '2026-05-01T10:00:00.000Z',
  };

  // **Validates: Requirements 13.6**
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { 0: good, length: 1 }],
    ['a Map', new Map([['a', good]])],
    ['a string', 'notes'],
    ['a number', 42],
  ])('returns [] for %s', (_label, input) => {
    expect(() => normaliseCalloutNotes(input)).not.toThrow();
    expect(normaliseCalloutNotes(input)).toEqual([]);
  });

  // **Validates: Requirements 13.6**
  it('keeps the well-formed members of an array with a bad member', () => {
    const other: CalloutNote = { ...good, id: '22222222-2222-4222-8222-222222222222', text: 'agreed' };
    const input: unknown[] = [good, null, { id: 1 }, 'x', [good], { ...good, text: 5 }, other];

    expect(() => normaliseCalloutNotes(input)).not.toThrow();
    const result = normaliseCalloutNotes(input);
    expect(result).toEqual([good, other]);
    expect(result.every(isCalloutNote)).toBe(true);
  });

  // **Validates: Requirements 13.6**
  it('returns [] for an array whose members are all malformed, and for an empty array', () => {
    expect(normaliseCalloutNotes([null, 1, {}])).toEqual([]);
    expect(normaliseCalloutNotes([])).toEqual([]);
  });
});
