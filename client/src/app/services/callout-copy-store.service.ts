import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  CALLOUT_COPY_CATALOG,
  selectCalloutPhrase,
  type CalloutCopyCatalog,
  type CalloutSection,
} from '@shared/callout-copy';

/**
 * Catalog the store draws phrases from. Defaults to the shared catalog; exists as a token so a
 * spec can supply a catalog with an emptied section (R4.12) without touching the shared data.
 */
export const CALLOUT_COPY_CATALOG_TOKEN = new InjectionToken<CalloutCopyCatalog>(
  'CALLOUT_COPY_CATALOG_TOKEN',
  { providedIn: 'root', factory: () => CALLOUT_COPY_CATALOG }
);

/**
 * Per-tab phrase memo and rotation cursor for the vote callouts.
 *
 * - `lastIndexBySection` feeds `previousIndex` into `selectCalloutPhrase`; `-1` on the first
 *   appearance of a section (R4.3, R4.5).
 * - `chosenByRound` memoises the first resolution of each `(roundId, section)` pair so the phrase
 *   stays identical across re-renders, state refreshes and reconnects within a round (R2.4, R3.5).
 *
 * Both maps are in-memory only: a page reload re-seeds the rotation for that tab. Nothing here is
 * broadcast. Call `reset()` when the routed session changes and on sign-out (R12.5).
 */
@Injectable({ providedIn: 'root' })
export class CalloutCopyStoreService {
  private readonly catalog = inject(CALLOUT_COPY_CATALOG_TOKEN);

  private readonly lastIndexBySection = new Map<CalloutSection, number>();
  private readonly chosenByRound = new Map<`${string}:${CalloutSection}`, number>();

  /**
   * The phrase for this round and section, or `null` when the section is absent or empty so the
   * caller withholds the callout (R4.12).
   */
  phraseFor(section: CalloutSection, roundId: string): string | null {
    const key = `${roundId}:${section}` as const;

    const memo = this.chosenByRound.get(key);
    if (memo !== undefined) {
      return this.catalog[section]?.[memo] ?? null;
    }

    const picked = selectCalloutPhrase(
      this.catalog,
      section,
      roundId,
      this.lastIndexBySection.get(section) ?? -1
    );
    if (!picked) return null;

    this.chosenByRound.set(key, picked.index);
    this.lastIndexBySection.set(section, picked.index);
    return picked.text;
  }

  /** Clears the rotation cursor and the per-round memo (session change, sign-out). */
  reset(): void {
    this.lastIndexBySection.clear();
    this.chosenByRound.clear();
  }
}
