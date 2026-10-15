/**
 * Callout copy catalog, restricted-term list and phrase selection.
 *
 * Pure module: no Angular, DOM, clock, random source or storage dependency, and no import from
 * `shared/types.ts`. Everything the vote-reveal callouts say is held here as reviewable data
 * (R4.1); the tone constraints of R4.6, R4.7, R4.9, R4.11 and R4.13 are decidable by an automated
 * scan over the catalog using `containsRestrictedTerm` and the term groups below.
 */

/** Sections of the Callout_Copy_Catalog. */
export type CalloutSection =
  | 'nearAverage' // R4.2: 6-40 entries
  | 'farFromAverage' // R4.2: 6-40 entries
  | 'fullAgreement' // R4.2: 2-40 entries
  | 'wideSpread' // R4.2: 2-40 entries
  | 'acknowledgement'; // R10.12: post-submit acknowledgement; same discipline applied voluntarily

export type CalloutCopyCatalog = Readonly<Record<CalloutSection, readonly string[]>>;

export const CALLOUT_COPY_CATALOG: CalloutCopyCatalog = {
  // No second-person pronoun, no ranking or comparison term, no digit, group reference only
  // (R4.7, R4.11). Each entry 12-90 chars with at most one glyph (R4.9).
  nearAverage: [
    'Same wavelength, no discussion needed 📡',
    'These cards came out of the same deck of thinking.',
    'Minds met in the middle with no negotiation at all.',
    'Agreement spotted in the wild 🌿',
    'The average and this little group are quietly in tune.',
    'A small club of matching instincts has formed here.',
    'This group landed on the same note 🎵',
    'Cards aligned. Suspiciously smooth, this one.',
  ],

  // Every entry is a question ending in '?', addresses the participant's reasoning, carries a
  // second-person pronoun, names nobody, and contains no error-attributing term (R4.6, R4.11).
  farFromAverage: [
    'Your card tells a different story. Want to share the plot?',
    'You saw something the average did not. What was it?',
    'Care to narrate what your estimate is seeing?',
    'What is the risk you spotted that the rest have not?',
    'Would you like to add a note about your thinking?',
    'Something in this story caught your eye. Say more?',
    'Your number has a reason behind it. Write it down?',
    'Is there a detail you would like the team to hear?',
  ],

  fullAgreement: [
    'Unanimous. Somebody should frame this moment 🖼',
    'Every card agrees. Rare weather, this.',
    'A single number, no debate, nothing to discuss.',
  ],

  // Shown instead of names, so it reveals nothing about who voted how (R2.8).
  wideSpread: [
    'The estimates went sightseeing in every direction 🧭',
    'Broad range today. Plenty left to talk about.',
    'These cards hold genuinely different opinions.',
  ],

  // Shown in the private prompt after a note is stored (R10.12); second person is fine here.
  acknowledgement: [
    'Noted and shared with the team. Thank you 🙏',
    'Your note is on the round now. Appreciated.',
  ],
};

/** One restricted term, carried with every form it may take (R4.13). No stemmer is used. */
export interface RestrictedTerm {
  /** Lower-case word sequences; each is matched whole-word against the entry's tokens. */
  readonly forms: readonly string[];
}

export interface RestrictedTermList {
  /** Binds the farFromAverage section (R4.6). */
  readonly errorAttributing: readonly RestrictedTerm[];
  /** Binds the nearAverage section (R4.7). */
  readonly rankingAndComparison: readonly RestrictedTerm[];
  /** Binds every catalog entry (R4.9). */
  readonly regionSpecificIdiom: readonly RestrictedTerm[];
}

/** Restricted_Term_List with enumerated inflections: explicit forms avoid stemmer false positives. */
export const RESTRICTED_TERMS: RestrictedTermList = {
  errorAttributing: [
    { forms: ['wrong', 'wrongly', 'wrongs'] },
    { forms: ['outlier', 'outliers', 'outlying'] },
    { forms: ['off'] },
    { forms: ['worst'] },
    { forms: ['weird', 'weirdly', 'weirder', 'weirdest'] },
    { forms: ['mistake', 'mistakes', 'mistaken', 'mistook'] },
  ],
  rankingAndComparison: [
    { forms: ['close', 'closer', 'closest'] },
    { forms: ['near', 'nearer', 'nearest'] },
    { forms: ['good', 'better', 'best'] },
    { forms: ['top', 'tops', 'topped'] },
    { forms: ['first'] },
    { forms: ['second'] },
    { forms: ['third'] },
    { forms: ['rank', 'ranks', 'ranked', 'ranking'] },
    { forms: ['score', 'scores', 'scored', 'scoring'] },
    { forms: ['accuracy', 'accurate', 'accurately'] },
    { forms: ['precise', 'precisely', 'precision'] },
    { forms: ['win', 'wins', 'won', 'winner', 'winners', 'winning'] },
    { forms: ['beat', 'beats', 'beaten'] },
    { forms: ['lead', 'leads', 'leader', 'leading'] },
    { forms: ['champion', 'champions'] },
    { forms: ['podium'] },
    { forms: ['prize', 'prizes'] },
  ],
  regionSpecificIdiom: [
    { forms: ['ballpark'] },
    { forms: ['home run', 'home runs', 'homer', 'homers'] },
    { forms: ['slam dunk', 'slam dunks'] },
    { forms: ['touchdown', 'touchdowns'] },
    { forms: ['hail mary'] },
    { forms: ['left field'] },
    { forms: ['curveball', 'curveballs'] },
    { forms: ['wicket', 'wickets', 'sticky wicket'] },
    { forms: ['googly', 'googlies'] },
    { forms: ['touch base'] },
    { forms: ['ninth inning'] },
  ],
};

/** Lower-cases and splits on every non-letter, so punctuation, digits and glyphs are boundaries. */
function tokenise(entry: string): string[] {
  return entry
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Whole-word, case-insensitive presence check against a group of restricted terms (R4.13).
 * Multi-word forms match as a consecutive token run. Total: never throws for a string input.
 */
export function containsRestrictedTerm(entry: string, group: readonly RestrictedTerm[]): boolean {
  const tokens = tokenise(entry);
  for (const term of group) {
    for (const form of term.forms) {
      const want = tokenise(form);
      if (want.length === 0) continue;
      for (let i = 0; i + want.length <= tokens.length; i++) {
        if (want.every((word, k) => tokens[i + k] === word)) return true;
      }
    }
  }
  return false;
}

/** FNV-1a over `roundId|section`: deterministic, no clock, no random source (R4.3). */
function seedIndex(roundId: string, section: CalloutSection, size: number): number {
  let hash = 0x811c9dc5;
  const key = `${roundId}|${section}`;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % size;
}

/**
 * Deterministic phrase selection (R4.3-R4.5, R4.12, R4.14).
 *
 * - `previousIndex` an integer in [0, n): strict rotation `(previousIndex + 1) % n`, which differs
 *   from `previousIndex` for n >= 2 and covers every entry within n consecutive appearances.
 * - anything else (-1, non-integer, out of range): FNV-1a seed over `roundId|section`.
 * - absent or empty section: `null`, so the caller withholds the callout.
 */
export function selectCalloutPhrase(
  catalog: CalloutCopyCatalog,
  section: CalloutSection,
  roundId: string,
  previousIndex: number
): { readonly index: number; readonly text: string } | null {
  const entries = catalog?.[section];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const size = entries.length;

  const index =
    Number.isInteger(previousIndex) && previousIndex >= 0 && previousIndex < size
      ? (previousIndex + 1) % size
      : seedIndex(String(roundId), section, size);

  return { index, text: entries[index] as string };
}
