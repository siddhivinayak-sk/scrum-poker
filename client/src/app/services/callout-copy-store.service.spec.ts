import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  CALLOUT_COPY_CATALOG,
  selectCalloutPhrase,
  type CalloutCopyCatalog,
  type CalloutSection,
} from '@shared/callout-copy';
import { CALLOUT_COPY_CATALOG_TOKEN, CalloutCopyStoreService } from './callout-copy-store.service';

const indexOf = (section: CalloutSection, text: string | null): number =>
  CALLOUT_COPY_CATALOG[section].indexOf(text as string);

describe('CalloutCopyStoreService', () => {
  describe('with the shared catalog', () => {
    let store: CalloutCopyStoreService;

    beforeEach(() => {
      TestBed.configureTestingModule({});
      store = TestBed.inject(CalloutCopyStoreService);
    });

    it('returns an entry of the requested section', () => {
      const phrase = store.phraseFor('nearAverage', 'round-1');

      expect(phrase).not.toBeNull();
      expect(CALLOUT_COPY_CATALOG.nearAverage).toContain(phrase);
    });

    it('seeds the first appearance with previousIndex -1 (R4.3)', () => {
      const expected = selectCalloutPhrase(CALLOUT_COPY_CATALOG, 'farFromAverage', 'round-1', -1);

      expect(store.phraseFor('farFromAverage', 'round-1')).toBe(expected?.text);
    });

    it('returns the identical phrase for the same (roundId, section) on repeated calls (R2.4, R3.5)', () => {
      const first = store.phraseFor('nearAverage', 'round-1');

      // Other rounds and sections advance the cursor in between; the memo must hold.
      store.phraseFor('nearAverage', 'round-2');
      store.phraseFor('nearAverage', 'round-3');
      store.phraseFor('farFromAverage', 'round-1');

      expect(store.phraseFor('nearAverage', 'round-1')).toBe(first);
      expect(store.phraseFor('nearAverage', 'round-1')).toBe(first);
    });

    it('never repeats the previous index across consecutive rounds (R4.5)', () => {
      const sections: CalloutSection[] = ['nearAverage', 'farFromAverage', 'fullAgreement', 'wideSpread'];

      for (const section of sections) {
        let previous = -1;
        for (let n = 0; n < CALLOUT_COPY_CATALOG[section].length * 2 + 1; n++) {
          const index = indexOf(section, store.phraseFor(section, `${section}-round-${n}`));

          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).not.toBe(previous);
          previous = index;
        }
      }
    });

    it('keeps a separate rotation cursor per section', () => {
      const near = store.phraseFor('nearAverage', 'round-1');
      store.phraseFor('farFromAverage', 'round-1');
      store.phraseFor('farFromAverage', 'round-2');

      // The next near-average round rotates from the near cursor only.
      const nextNear = store.phraseFor('nearAverage', 'round-2');
      const expectedIndex = (indexOf('nearAverage', near) + 1) % CALLOUT_COPY_CATALOG.nearAverage.length;

      expect(nextNear).toBe(CALLOUT_COPY_CATALOG.nearAverage[expectedIndex]);
    });

    it('reset() clears the rotation cursor so the next appearance is seeded again', () => {
      const first = store.phraseFor('nearAverage', 'round-1');
      const rotated = store.phraseFor('nearAverage', 'round-2');
      const expectedRotation =
        CALLOUT_COPY_CATALOG.nearAverage[
          (indexOf('nearAverage', first) + 1) % CALLOUT_COPY_CATALOG.nearAverage.length
        ];
      expect(rotated).toBe(expectedRotation);

      store.reset();

      // Cursor is -1 again: the same round id resolves to the same seeded entry as the very first call.
      expect(store.phraseFor('nearAverage', 'round-1')).toBe(first);
    });

    it('reset() clears the per-round memo', () => {
      store.phraseFor('nearAverage', 'round-1');
      store.phraseFor('nearAverage', 'round-2');

      store.reset();

      // Without the memo, round-2 is resolved afresh from a -1 cursor (seed branch).
      const seeded = selectCalloutPhrase(CALLOUT_COPY_CATALOG, 'nearAverage', 'round-2', -1);
      expect(store.phraseFor('nearAverage', 'round-2')).toBe(seeded?.text);
    });
  });

  describe('with an emptied section (R4.12)', () => {
    let store: CalloutCopyStoreService;

    beforeEach(() => {
      const catalog: CalloutCopyCatalog = {
        ...CALLOUT_COPY_CATALOG,
        nearAverage: [],
      };
      TestBed.configureTestingModule({
        providers: [{ provide: CALLOUT_COPY_CATALOG_TOKEN, useValue: catalog }],
      });
      store = TestBed.inject(CalloutCopyStoreService);
    });

    it('yields null for the emptied section on every call', () => {
      expect(store.phraseFor('nearAverage', 'round-1')).toBeNull();
      expect(store.phraseFor('nearAverage', 'round-1')).toBeNull();
      expect(store.phraseFor('nearAverage', 'round-2')).toBeNull();
    });

    it('still serves the other sections', () => {
      expect(CALLOUT_COPY_CATALOG.farFromAverage).toContain(store.phraseFor('farFromAverage', 'round-1'));
    });
  });

  describe('with an absent section (R4.12)', () => {
    it('yields null when the section key is missing from the catalog', () => {
      const { wideSpread: _omitted, ...rest } = CALLOUT_COPY_CATALOG;
      TestBed.configureTestingModule({
        providers: [{ provide: CALLOUT_COPY_CATALOG_TOKEN, useValue: rest as unknown as CalloutCopyCatalog }],
      });
      const store = TestBed.inject(CalloutCopyStoreService);

      expect(store.phraseFor('wideSpread', 'round-1')).toBeNull();
    });
  });
});
