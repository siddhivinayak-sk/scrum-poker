import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { TestBed } from '@angular/core/testing';
import {
  CalloutPersistenceService,
  DISMISSAL_LIMIT,
  DismissalRecord,
} from './callout-persistence.service';

const DISMISSAL_KEY = 'scrum-poker-callout-dismissals';

/**
 * Small identifier domains so that generated sequences repeat triples as well as exceed the limit.
 * `at` is assigned from the sequence index, so it is strictly increasing (the eviction ordering key).
 */
const dismissalSequenceArb = fc
  .array(
    fc.record({
      sessionId: fc.constantFrom('s1', 's2', 's3'),
      roundId: fc.constantFrom('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'),
      callout: fc.constantFrom('near' as const, 'far' as const),
    }),
    { minLength: 0, maxLength: 160 }
  )
  .map((items): DismissalRecord[] => items.map((item, index) => ({ ...item, at: 1_000 + index })));

function tripleOf(r: DismissalRecord): string {
  return JSON.stringify([r.sessionId, r.roundId, r.callout]);
}

function freshService(): CalloutPersistenceService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(CalloutPersistenceService);
}

/**
 * Feature: vote-reveal-fun-callouts
 * Property 24: Dismissal record eviction bound
 *
 * For every generated sequence of dismissals, the stored Dismissal_Record collection holds at most 50
 * records, holds the 50 most recent dismissals of that sequence, and retains the record for the current
 * combination of session identifier, round identifier and callout identity whenever that dismissal is
 * among the 50 most recent.
 *
 * **Validates: Requirements 12.2, 12.3, 2.11, 2.14, 3.9**
 */
describe('Feature: vote-reveal-fun-callouts, Property 24: Dismissal record eviction bound', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  it('holds at most 50 records, exactly the 50 most recent, in order', () => {
    fc.assert(
      fc.property(dismissalSequenceArb, (sequence) => {
        sessionStorage.clear();
        const service = freshService();

        for (const record of sequence) {
          service.recordDismissal(record);
          // The bound holds after every single dismissal, not only at the end.
          expect(service.dismissals().length).toBeLessThanOrEqual(DISMISSAL_LIMIT);
        }

        expect(service.dismissals()).toEqual(sequence.slice(-DISMISSAL_LIMIT));
      }),
      { numRuns: 100 }
    );
  });

  it('retains the triple of every dismissal among the 50 most recent, and withholds nothing else', () => {
    fc.assert(
      fc.property(dismissalSequenceArb, (sequence) => {
        sessionStorage.clear();
        const service = freshService();
        sequence.forEach((record) => service.recordDismissal(record));

        const retained = sequence.slice(-DISMISSAL_LIMIT);
        const retainedTriples = new Set(retained.map(tripleOf));

        // Every dismissal among the 50 most recent is still found.
        for (const record of retained) {
          expect(service.isDismissed(record.sessionId, record.roundId, record.callout)).toBe(true);
        }

        // isDismissed is true exactly for the triples present in the retained window.
        for (const sessionId of ['s1', 's2', 's3']) {
          for (const roundId of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']) {
            for (const callout of ['near', 'far'] as const) {
              expect(service.isDismissed(sessionId, roundId, callout)).toBe(
                retainedTriples.has(JSON.stringify([sessionId, roundId, callout]))
              );
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('persists the same bounded window to tab storage and restores it on reload', () => {
    fc.assert(
      fc.property(dismissalSequenceArb, (sequence) => {
        sessionStorage.clear();
        const service = freshService();
        sequence.forEach((record) => service.recordDismissal(record));

        const expected = sequence.slice(-DISMISSAL_LIMIT);
        if (sequence.length > 0) {
          const stored: unknown = JSON.parse(sessionStorage.getItem(DISMISSAL_KEY) ?? 'null');
          expect(stored).toEqual(expected);
        }

        // A new service instance (page reload) restores exactly the retained window.
        const reloaded = freshService();
        expect(reloaded.dismissals()).toEqual(expected);
      }),
      { numRuns: 100 }
    );
  });
});
