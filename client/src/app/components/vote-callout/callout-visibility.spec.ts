import { describe, it, expect } from 'vitest';
import type { CalloutSection } from '@shared/callout-copy';
import type { ExtendedCardValue, VotingMetrics } from '@shared/types';
import type { DismissalRecord } from '../../services/callout-persistence.service';
import {
  MAX_NAMES,
  NAME_TRUNCATE_AT,
  resolveCalloutVisibility,
  truncateName,
  type CalloutResolverInput,
  type CalloutResolution,
  type NearCalloutModel,
} from './callout-visibility';

const SESSION = 'session-a';
const ROUND = 'round-x';

const SECTION_SIZES: Readonly<Record<CalloutSection, number>> = {
  nearAverage: 10,
  farFromAverage: 10,
  fullAgreement: 3,
  wideSpread: 3,
  acknowledgement: 3,
};

type Votes = Record<string, ExtendedCardValue | null>;

function isNumeric(card: ExtendedCardValue | null): boolean {
  return typeof card === 'number';
}

function metricsFor(votes: Votes, average: number | null): VotingMetrics {
  const numericVoteCount = Object.values(votes).filter(isNumeric).length;
  return {
    average,
    mode: null,
    spread: null,
    distribution: {},
    outliers: [],
    numericVoteCount,
    insufficientData: numericVoteCount < 2,
  };
}

/** Display name of a voter is simply its capitalised user id unless overridden. */
function namesFor(votes: Votes, overrides: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of Object.keys(votes)) {
    map.set(id, overrides[id] ?? id.charAt(0).toUpperCase() + id.slice(1));
  }
  return map;
}

function build(
  votes: Votes,
  average: number | null,
  overrides: Partial<CalloutResolverInput> = {},
  nameOverrides: Record<string, string> = {}
): CalloutResolverInput {
  return {
    routedSessionId: SESSION,
    stateSessionId: SESSION,
    sessionNotFound: false,
    countdownActive: false,
    connectionBlocked: false,
    funCallouts: true,
    votingSystem: 'fibonacci',
    round: { id: ROUND, status: 'revealed' },
    metrics: metricsFor(votes, average),
    selections: new Map(Object.entries(votes)),
    displayNames: namesFor(votes, nameOverrides),
    viewerId: 'zed', // not a voter unless a test says otherwise
    hasRevealPermission: true,
    dismissals: [],
    alreadyVisible: { near: false, far: false },
    viewport: { width: 1280, height: 800 },
    sectionSizes: SECTION_SIZES,
    ...overrides,
  };
}

function dismissal(callout: 'near' | 'far', roundId = ROUND, sessionId = SESSION): DismissalRecord {
  return { sessionId, roundId, callout, at: 1 };
}

function visible(
  res: CalloutResolution
): Extract<CalloutResolution, { kind: 'visible' }> {
  if (res.kind !== 'visible') {
    throw new Error(`expected visible, got suppressed: ${res.reason}`);
  }
  return res;
}

function nearOf(res: CalloutResolution): NearCalloutModel {
  const { near } = visible(res);
  if (near === null) throw new Error('expected a near model');
  return near;
}

// Fibonacci ladder indices: 0:0 1:1 2:2 3:3 4:5 5:8 6:13 7:21 8:34 9:55 10:89.

// The classifier anchors on the CONSENSUS value (the mode, or the median when every vote is
// distinct), not the mean. The `average` passed to `build` is still supplied on the metrics (and
// gates the non-finite-average suppression), but it no longer decides near/far membership.

/**
 * Mode is 5 (Ann and Bob), at ladder index 4. Cy's 8 (index 5) is 1 away -> neither set.
 * Dee's 21 (index 7) is 3 away -> far. So near = {Ann, Bob}, far = {Dee}.
 */
const MIXED: Votes = { ann: 5, bob: 5, cy: 8, dee: 21 };
const MIXED_AVG = 6.5;

/**
 * Every vote is distinct, so the consensus is the median of [1, 2, 34, 55] = 18, which sits at
 * ladder position ~6.63. 1 (index 1) and 2 (index 2) are far; 55 (index 9) is far; 34 (index 8)
 * lands 1.375 away -> neither set. No one is near, at least one is far -> the wideSpread variant.
 */
const ALL_FAR: Votes = { ann: 1, bob: 2, cy: 34, dee: 55 };
const ALL_FAR_AVG = 18;

describe('callout-visibility resolver examples', () => {
  describe('variants', () => {
    it('shows the nearAverage variant with names ordered by distance then name (R2.1, R2.5)', () => {
      const near = nearOf(resolveCalloutVisibility(build(MIXED, MIXED_AVG)));
      expect(near.variant).toBe('nearAverage');
      expect(near.roundId).toBe(ROUND);
      expect(near.names.map((n) => n.full)).toEqual(['Ann', 'Bob']);
      expect(near.hiddenNameCount).toBe(0);
    });

    it('uses fullAgreement when at least two numeric votes are identical and all are near (R2.7, R11.6)', () => {
      const votes: Votes = { ann: 5, bob: 5 };
      const res = visible(resolveCalloutVisibility(build(votes, 5)));
      expect(res.near?.variant).toBe('fullAgreement');
      expect(res.near?.names.map((n) => n.full)).toEqual(['Ann', 'Bob']);
      expect(res.far).toBeNull();
    });

    it('shows no far prompt to anyone under full agreement, even a non-voting viewer (R11.6)', () => {
      const votes: Votes = { ann: 8, bob: 8, cy: 8 };
      const res = visible(resolveCalloutVisibility(build(votes, 8, { viewerId: 'ann' })));
      expect(res.near?.variant).toBe('fullAgreement');
      expect(res.far).toBeNull();
    });

    it('ignores special cards when deciding fullAgreement (only numeric voters count)', () => {
      const votes: Votes = { ann: 5, bob: 5, cy: 'coffee' };
      const res = visible(resolveCalloutVisibility(build(votes, 5)));
      expect(res.near?.variant).toBe('fullAgreement');
      expect(res.near?.names.map((n) => n.full)).toEqual(['Ann', 'Bob']);
    });

    it('uses wideSpread with no names when near is empty and far is not (R2.8, R11.8)', () => {
      const res = visible(resolveCalloutVisibility(build(ALL_FAR, ALL_FAR_AVG, { viewerId: 'ann' })));
      expect(res.near?.variant).toBe('wideSpread');
      expect(res.near?.names).toEqual([]);
      expect(res.near?.hiddenNameCount).toBe(0);
      // Every numeric voter is far, so each of them still gets the private prompt (R11.8).
      expect(res.far).not.toBeNull();
    });
  });

  describe('permission gating', () => {
    it('hides the near panel from a viewer without reveal permission (R2.2)', () => {
      const res = visible(
        resolveCalloutVisibility(build(MIXED, MIXED_AVG, { hasRevealPermission: false }))
      );
      expect(res.near).toBeNull();
      expect(res.far).toBeNull(); // viewer is not in the far set either
    });

    it('still shows the far prompt to a far viewer who lacks reveal permission (R3.1)', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { hasRevealPermission: false, viewerId: 'dee' })
        )
      );
      expect(res.near).toBeNull();
      expect(res.far).toEqual({ roundId: ROUND, replayEntrance: true });
    });

    it.each([
      ['moderator-only: moderator', true],
      ['all-players: any player', true],
      ['select-specific: listed viewer', true],
      ['moderator-only: non-moderator', false],
      ['select-specific: unlisted viewer', false],
    ])('shows the near panel only when the evaluated permission is true (%s)', (_label, permitted) => {
      const res = visible(
        resolveCalloutVisibility(build(MIXED, MIXED_AVG, { hasRevealPermission: permitted }))
      );
      expect(res.near !== null).toBe(permitted);
    });

    it('shows nothing to a viewer who is neither permitted nor far (R2.2, R3.2)', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { hasRevealPermission: false, viewerId: 'ann' })
        )
      );
      expect(res).toEqual({ kind: 'visible', near: null, far: null });
    });

    it('gives no far prompt to a viewer with no viewer id (R3.2)', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: null })));
      expect(res.far).toBeNull();
    });

    it('gives no far prompt to a viewer who cast no selection (R12.5, R3.2)', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: 'late' })));
      expect(res.far).toBeNull();
      expect(res.near).not.toBeNull();
    });
  });

  describe('dual panel and independent dismissal', () => {
    it('gives a permitted far viewer both models (R3.4)', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: 'dee' })));
      expect(res.near?.variant).toBe('nearAverage');
      expect(res.far).toEqual({ roundId: ROUND, replayEntrance: true });
    });

    it('dismissing the near panel leaves the far prompt (R3.4, R2.11)', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { viewerId: 'dee', dismissals: [dismissal('near')] })
        )
      );
      expect(res.near).toBeNull();
      expect(res.far).not.toBeNull();
    });

    it('dismissing the far prompt leaves the near panel (R3.4)', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { viewerId: 'dee', dismissals: [dismissal('far')] })
        )
      );
      expect(res.near).not.toBeNull();
      expect(res.far).toBeNull();
    });

    it('keeps both hidden when both were dismissed, still reporting a visible resolution', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, {
            viewerId: 'dee',
            dismissals: [dismissal('near'), dismissal('far')],
          })
        )
      );
      expect(res.near).toBeNull();
      expect(res.far).toBeNull();
    });

    it('ignores dismissals recorded for another round or another session (R2.14, R12.3, R12.5)', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, {
            viewerId: 'dee',
            dismissals: [
              dismissal('near', 'round-older'),
              dismissal('far', ROUND, 'session-b'),
            ],
          })
        )
      );
      expect(res.near).not.toBeNull();
      expect(res.far).not.toBeNull();
    });
  });

  describe('participant-left reclassification', () => {
    it('drops a departed participant name and keeps the variant (R11.9)', () => {
      // Mode is 5 (Ann, Bob, Cy all vote 5), index 4. Dee's 21 is far. near = {Ann, Bob, Cy}.
      const withThree: Votes = { ann: 5, bob: 5, cy: 5, dee: 21 };
      const before = nearOf(resolveCalloutVisibility(build(withThree, MIXED_AVG)));
      expect(before.names.map((n) => n.full)).toEqual(['Ann', 'Bob', 'Cy']);

      // Cy leaves: selections and display names no longer contain Cy. Ann and Bob still hold the
      // mode at 5, so the variant is unchanged and only Cy's name drops out.
      const remaining: Votes = { ann: 5, bob: 5, dee: 21 };
      const after = nearOf(resolveCalloutVisibility(build(remaining, MIXED_AVG)));
      expect(after.names.map((n) => n.full)).toEqual(['Ann', 'Bob']);
      expect(after.names.map((n) => n.full)).not.toContain('Cy');
      expect(after.variant).toBe(before.variant);
    });

    it('switches to wideSpread with no names when the last near participant leaves (R11.10)', () => {
      // Zed2 shares the mode at 5 (index 4) with Ann and Bob, so Zed2 is near; Cy's 34 is far.
      const withNear: Votes = { ann: 5, bob: 5, zed2: 5, cy: 34 };
      const before = visible(resolveCalloutVisibility(build(withNear, 12, { viewerId: 'cy' })));
      expect(before.near?.variant).toBe('nearAverage');
      expect(before.near?.names.map((n) => n.full)).toEqual(['Ann', 'Bob', 'Zed2']);

      // Everyone near has left; the remaining votes are all distinct and all land outside the
      // near band around their median, so the panel falls back to wideSpread.
      const after = visible(resolveCalloutVisibility(build(ALL_FAR, ALL_FAR_AVG, { viewerId: 'ann' })));
      expect(after.near?.variant).toBe('wideSpread');
      expect(after.near?.names).toEqual([]);
      // The panel stays visible while the far set is non-empty (R11.10).
      expect(after.near).not.toBeNull();
      expect(after.far).not.toBeNull();
    });
  });

  describe('connectionBlocked (R11.12)', () => {
    it('shows no new callout while the connection is blocked', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { viewerId: 'dee', connectionBlocked: true })
        )
      );
      expect(res.near).toBeNull();
      expect(res.far).toBeNull();
    });

    it('keeps an already visible callout without replaying its entrance', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, {
            viewerId: 'dee',
            connectionBlocked: true,
            alreadyVisible: { near: true, far: false },
          })
        )
      );
      expect(res.near?.replayEntrance).toBe(false);
      expect(res.far).toBeNull();
    });

    it('treats each panel independently when both were already visible', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, {
            viewerId: 'dee',
            connectionBlocked: true,
            alreadyVisible: { near: true, far: true },
          })
        )
      );
      expect(res.near?.replayEntrance).toBe(false);
      expect(res.far?.replayEntrance).toBe(false);
    });

    it('replays the entrance when the connection is healthy', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: 'dee' })));
      expect(res.near?.replayEntrance).toBe(true);
      expect(res.far?.replayEntrance).toBe(true);
    });

    it('does not resurrect a dismissed callout that was already visible', () => {
      const res = visible(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, {
            connectionBlocked: true,
            alreadyVisible: { near: true, far: false },
            dismissals: [dismissal('near')],
          })
        )
      );
      expect(res.near).toBeNull();
    });
  });

  describe('session isolation (R12.5)', () => {
    it('yields nothing when the held state belongs to a different session', () => {
      expect(
        resolveCalloutVisibility(build(MIXED, MIXED_AVG, { stateSessionId: 'session-b' }))
      ).toEqual({ kind: 'suppressed', reason: 'no-session' });
    });

    it('yields nothing when the held state has no session id', () => {
      expect(
        resolveCalloutVisibility(build(MIXED, MIXED_AVG, { stateSessionId: null }))
      ).toEqual({ kind: 'suppressed', reason: 'no-session' });
    });

    it('yields nothing when there is no routed session', () => {
      expect(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { routedSessionId: null, stateSessionId: null })
        )
      ).toEqual({ kind: 'suppressed', reason: 'no-session' });
    });
  });

  describe('suppression overrides display (R11.14)', () => {
    it.each<[string, Partial<CalloutResolverInput>, string]>([
      ['session not found', { sessionNotFound: true }, 'session-not-found'],
      ['countdown active', { countdownActive: true }, 'countdown-active'],
      ['funCallouts false', { funCallouts: false }, 'fun-callouts-off'],
      ['viewport too narrow', { viewport: { width: 319, height: 800 } }, 'viewport-too-small'],
      ['viewport too short', { viewport: { width: 1280, height: 419 } }, 'viewport-too-small'],
      ['round still voting', { round: { id: ROUND, status: 'voting' } }, 'not-revealed'],
      ['no round', { round: null }, 'not-revealed'],
      ['t-shirt deck', { votingSystem: 't-shirt' }, 'short-ladder'],
      ['unknown deck', { votingSystem: 'made-up' }, 'unknown-voting-system'],
    ])('suppresses for %s', (_label, patch, reason) => {
      expect(resolveCalloutVisibility(build({ ...MIXED, zed: 8 }, MIXED_AVG, { ...patch, viewerId: 'dee' }))).toEqual({
        kind: 'suppressed',
        reason,
      });
    });

    it('suppresses when fewer than two numeric votes were cast (R11.1, R11.7)', () => {
      const votes: Votes = { ann: 5, bob: 'coffee' };
      expect(resolveCalloutVisibility(build(votes, 5))).toEqual({
        kind: 'suppressed',
        reason: 'insufficient-data',
      });
    });

    it.each<[string, number | null]>([
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('suppresses when the average is %s (R11.2)', (_label, average) => {
      expect(resolveCalloutVisibility(build(MIXED, average))).toEqual({
        kind: 'suppressed',
        reason: 'non-finite-average',
      });
    });

    it('suppresses when neither set has anyone (R11.13, R2.13)', () => {
      // Distinct votes 5 and 13; consensus is their median 9 (ladder position ~5.2). 5 (index 4)
      // is 1.2 away and 13 (index 6) is 0.8 away: both sit in the middle band, so neither set.
      const votes: Votes = { ann: 5, bob: 13 };
      expect(resolveCalloutVisibility(build(votes, 6.5))).toEqual({
        kind: 'suppressed',
        reason: 'no-classification',
      });
    });

    it('suppresses when the variant copy section is empty (R4.12)', () => {
      expect(
        resolveCalloutVisibility(
          build(MIXED, MIXED_AVG, { sectionSizes: { ...SECTION_SIZES, nearAverage: 0 } })
        )
      ).toEqual({ kind: 'suppressed', reason: 'empty-copy-section' });
    });
  });

  describe('near model privacy (R2.5, R2.6, R3.6)', () => {
    it('exposes only the documented keys and no distance, rank, index or count', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: 'dee' })));
      expect(Object.keys(res.near ?? {}).sort()).toEqual(
        ['hiddenNameCount', 'names', 'replayEntrance', 'roundId', 'variant'].sort()
      );
      for (const name of res.near?.names ?? []) {
        expect(Object.keys(name).sort()).toEqual(['full', 'shown']);
      }
      expect(Object.keys(res.far ?? {}).sort()).toEqual(['replayEntrance', 'roundId']);
      expect(Object.keys(res).sort()).toEqual(['far', 'kind', 'near']);
    });

    it('carries no far participant display name and no digit in any displayed name', () => {
      const res = visible(resolveCalloutVisibility(build(MIXED, MIXED_AVG, { viewerId: 'dee' })));
      const texts = (res.near?.names ?? []).flatMap((n) => [n.full, n.shown]);
      expect(texts).not.toContain('Dee');
      expect(texts.every((t) => !/\d/.test(t))).toBe(true);
      expect(JSON.stringify(res.near)).not.toContain('Dee');
    });

    it('never names a far participant even under wideSpread', () => {
      const res = visible(resolveCalloutVisibility(build(ALL_FAR, ALL_FAR_AVG)));
      expect(res.near?.variant).toBe('wideSpread');
      const serialised = JSON.stringify(res.near);
      for (const far of ['Ann', 'Bob', 'Cy', 'Dee']) expect(serialised).not.toContain(far);
    });

    it('does not mutate its input maps', () => {
      const input = build(MIXED, MIXED_AVG);
      const selectionsBefore = [...input.selections.entries()];
      const namesBefore = [...input.displayNames.entries()];
      resolveCalloutVisibility(input);
      expect([...input.selections.entries()]).toEqual(selectionsBefore);
      expect([...input.displayNames.entries()]).toEqual(namesBefore);
    });
  });

  describe('name truncation (R8.4)', () => {
    it('keeps a name of exactly 18 characters unchanged', () => {
      const name = 'A'.repeat(NAME_TRUNCATE_AT);
      expect(truncateName(name)).toBe(name);
    });

    it('cuts a longer name to 18 characters plus an ellipsis', () => {
      const name = 'B'.repeat(NAME_TRUNCATE_AT + 1);
      expect(truncateName(name)).toBe('B'.repeat(NAME_TRUNCATE_AT) + '\u2026');
    });

    it('does not split a surrogate pair at the cut', () => {
      const name = '😀'.repeat(NAME_TRUNCATE_AT + 2);
      const shown = truncateName(name);
      expect(Array.from(shown)).toHaveLength(NAME_TRUNCATE_AT + 1);
      expect(shown.endsWith('\u2026')).toBe(true);
    });

    it('preserves the full name in the model while shortening the shown text', () => {
      const longName = 'Bartholomew Montgomery Featherstonehaugh';
      const votes: Votes = { ann: 5, bob: 5 };
      const near = nearOf(resolveCalloutVisibility(build(votes, 5, {}, { ann: longName })));
      const entry = near.names.find((n) => n.full === longName);
      expect(entry).toBeDefined();
      expect(entry?.shown).toBe(longName.slice(0, NAME_TRUNCATE_AT) + '\u2026');
      expect(entry?.shown.length).toBe(NAME_TRUNCATE_AT + 1);
    });
  });

  describe('8-name cap (R8.3)', () => {
    function crowd(count: number): Votes {
      const votes: Votes = {};
      for (let i = 1; i <= count; i++) votes[`p${String(i).padStart(2, '0')}`] = 5;
      return votes;
    }

    it('shows all names and no summary at exactly the cap', () => {
      const near = nearOf(resolveCalloutVisibility(build(crowd(MAX_NAMES), 5)));
      expect(near.names).toHaveLength(MAX_NAMES);
      expect(near.hiddenNameCount).toBe(0);
    });

    it('shows the first 8 names in order and counts the rest', () => {
      const near = nearOf(resolveCalloutVisibility(build(crowd(11), 5)));
      expect(near.variant).toBe('fullAgreement');
      expect(near.names.map((n) => n.full)).toEqual(
        ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08']
      );
      expect(near.hiddenNameCount).toBe(3);
    });

    it('counts hidden names on top of the cap for a nearAverage crowd too', () => {
      const votes: Votes = { ...crowd(9), far1: 21 };
      const near = nearOf(resolveCalloutVisibility(build(votes, 6.5, { viewerId: 'zed' })));
      // 9 voters at 5 plus one at 21: average ~6.6 -> position ~4.5 is 0.5 from 5, 2.5 from 21.
      expect(near.variant).toBe('nearAverage');
      expect(near.names).toHaveLength(MAX_NAMES);
      expect(near.hiddenNameCount).toBe(1);
    });
  });
});
