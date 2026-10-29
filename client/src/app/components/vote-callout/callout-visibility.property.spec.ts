import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { CalloutSection } from '@shared/callout-copy';
import type { ExtendedCardValue, VotingMetrics } from '@shared/types';
import type { DismissalRecord } from '../../services/callout-persistence.service';
import {
  MIN_LAYER_VIEWPORT_HEIGHT,
  MIN_LAYER_VIEWPORT_WIDTH,
  resolveCalloutVisibility,
  type CalloutResolverInput,
  type SuppressionReason,
} from './callout-visibility';

/**
 * Property tests for the pure callout visibility resolver.
 *
 * Feature: vote-reveal-fun-callouts, Property 23: Suppression precedence
 *
 * Starting from a healthy input that would show BOTH callouts, each suppression condition of
 * Requirement 11 (plus the session, countdown, setting, viewport and empty-copy conditions) is
 * switched on independently. Display-side inputs (permission, viewer, dismissals, connection
 * state, already-visible flags) are generated freely so that display conditions are satisfied in
 * many combinations. Whenever at least one suppression condition holds, the resolution must be
 * `suppressed`, which by construction carries neither a near nor a far model.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'session-a';
const ROUND = 'round-x';

type Votes = Record<string, ExtendedCardValue | null>;

/**
 * Fibonacci ladder indices: 0:0 1:1 2:2 3:3 4:5 5:8 6:13 7:21 8:34 9:55 10:89.
 * Consensus is the mode 5 (ann, bob) at index 4: ann/bob are near, dee's 21 is far, cy's 8 is in
 * the middle band. (The classifier anchors on the consensus value, not the mean.)
 */
const HEALTHY_VOTES: Votes = { ann: 5, bob: 5, cy: 8, dee: 21 };
const HEALTHY_AVERAGE = 6.5;

/**
 * Distinct votes 5 and 13; the consensus is their median 9 (ladder position ~5.2). 5 (index 4) is
 * 1.2 away and 13 (index 6) is 0.8 away: both sit in the middle band, so neither set (R11.13).
 */
const MIDDLE_BAND_VOTES: Votes = { ann: 5, bob: 13 };

const VIEWER_IDS: readonly (string | null)[] = ['dee', 'ann', 'zed', null];

function metricsFor(votes: Votes, average: unknown): VotingMetrics {
  const numericVoteCount = Object.values(votes).filter((c) => typeof c === 'number').length;
  return {
    average: average as number | null,
    mode: null,
    spread: null,
    distribution: {},
    outliers: [],
    numericVoteCount,
    insufficientData: numericVoteCount < 2,
  };
}

function displayNamesFor(votes: Votes): Map<string, string> {
  const names = new Map<string, string>();
  for (const id of Object.keys(votes)) {
    names.set(id, id.charAt(0).toUpperCase() + id.slice(1));
  }
  return names;
}

const SECTION_SIZES: Readonly<Record<CalloutSection, number>> = {
  nearAverage: 10,
  farFromAverage: 10,
  fullAgreement: 3,
  wideSpread: 3,
  acknowledgement: 3,
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Display-side inputs: none of these may ever resurrect a suppressed resolution. */
interface DisplayConditions {
  readonly viewerId: string | null;
  readonly hasRevealPermission: boolean;
  readonly connectionBlocked: boolean;
  readonly dismissNear: boolean;
  readonly dismissFar: boolean;
  readonly alreadyVisible: { readonly near: boolean; readonly far: boolean };
  /** Values `resolveFunCallouts` coerces to true, so they are not a suppression condition. */
  readonly funCalloutsEnabled: unknown;
}

const displayConditionsArb: fc.Arbitrary<DisplayConditions> = fc.record({
  viewerId: fc.constantFrom(...VIEWER_IDS),
  hasRevealPermission: fc.boolean(),
  connectionBlocked: fc.boolean(),
  dismissNear: fc.boolean(),
  dismissFar: fc.boolean(),
  alreadyVisible: fc.record({ near: fc.boolean(), far: fc.boolean() }),
  funCalloutsEnabled: fc.constantFrom<unknown>(true, undefined, null, 'false', 0, 1, {}),
});

type DeckKind = 'ok' | 't-shirt' | 'unknown';
type SessionFault = 'none' | 'no-routed-session' | 'state-other-session' | 'state-no-session';
type RoundFault = 'none' | 'no-round' | 'voting' | 'completed' | 'no-metrics';
type MetricsFault =
  | { readonly kind: 'none' }
  | { readonly kind: 'flagged-insufficient'; readonly count: number }
  | { readonly kind: 'low-count'; readonly count: number }
  | { readonly kind: 'bad-average'; readonly average: unknown };
type ViewportFault = 'none' | 'narrow' | 'short' | 'both';

/** Every suppression-relevant dimension, each independently switchable. */
interface SuppressionFlags {
  readonly session: SessionFault;
  readonly sessionNotFound: boolean;
  readonly countdownActive: boolean;
  readonly funCalloutsOff: boolean;
  readonly viewportFault: ViewportFault;
  readonly roundFault: RoundFault;
  readonly metricsFault: MetricsFault;
  readonly deck: DeckKind;
  readonly emptyClassification: boolean;
  readonly emptyCopySize: number | null;
}

const metricsFaultArb: fc.Arbitrary<MetricsFault> = fc.oneof(
  fc.constant<MetricsFault>({ kind: 'none' }),
  fc.record({
    kind: fc.constant('flagged-insufficient' as const),
    count: fc.integer({ min: 0, max: 6 }),
  }),
  fc.record({ kind: fc.constant('low-count' as const), count: fc.integer({ min: 0, max: 1 }) }),
  fc.record({
    kind: fc.constant('bad-average' as const),
    average: fc.constantFrom<unknown>(
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '6.5',
      {}
    ),
  })
);

const suppressionFlagsArb: fc.Arbitrary<SuppressionFlags> = fc.record({
  session: fc.constantFrom<SessionFault>(
    'none',
    'no-routed-session',
    'state-other-session',
    'state-no-session'
  ),
  sessionNotFound: fc.boolean(),
  countdownActive: fc.boolean(),
  funCalloutsOff: fc.boolean(),
  viewportFault: fc.constantFrom<ViewportFault>('none', 'narrow', 'short', 'both'),
  roundFault: fc.constantFrom<RoundFault>('none', 'no-round', 'voting', 'completed', 'no-metrics'),
  metricsFault: metricsFaultArb,
  deck: fc.constantFrom<DeckKind>('ok', 't-shirt', 'unknown'),
  emptyClassification: fc.boolean(),
  /** A non-positive or NaN size makes every variant section unusable (R4.12). */
  emptyCopySize: fc.constantFrom<number | null>(null, 0, -1, Number.NaN),
});

const NO_SUPPRESSION: SuppressionFlags = {
  session: 'none',
  sessionNotFound: false,
  countdownActive: false,
  funCalloutsOff: false,
  viewportFault: 'none',
  roundFault: 'none',
  metricsFault: { kind: 'none' },
  deck: 'ok',
  emptyClassification: false,
  emptyCopySize: null,
};

const healthyViewportArb = fc.record({
  width: fc.integer({ min: MIN_LAYER_VIEWPORT_WIDTH, max: 4000 }),
  height: fc.integer({ min: MIN_LAYER_VIEWPORT_HEIGHT, max: 4000 }),
});

const faultyViewportArb = (fault: ViewportFault) => {
  const anyWidth = fc.integer({ min: 0, max: 4000 });
  const anyHeight = fc.integer({ min: 0, max: 4000 });
  switch (fault) {
    case 'narrow':
      return fc.record({
        width: fc.integer({ min: 0, max: MIN_LAYER_VIEWPORT_WIDTH - 1 }),
        height: anyHeight,
      });
    case 'short':
      return fc.record({
        width: anyWidth,
        height: fc.integer({ min: 0, max: MIN_LAYER_VIEWPORT_HEIGHT - 1 }),
      });
    case 'both':
      return fc.record({
        width: fc.integer({ min: 0, max: MIN_LAYER_VIEWPORT_WIDTH - 1 }),
        height: fc.integer({ min: 0, max: MIN_LAYER_VIEWPORT_HEIGHT - 1 }),
      });
    case 'none':
      return healthyViewportArb;
  }
};

/** Reasons that each active suppression condition may legitimately produce. */
function expectedReasons(flags: SuppressionFlags): Set<SuppressionReason> {
  const reasons = new Set<SuppressionReason>();
  if (flags.session !== 'none') reasons.add('no-session');
  if (flags.sessionNotFound) reasons.add('session-not-found');
  if (flags.countdownActive) reasons.add('countdown-active');
  if (flags.funCalloutsOff) reasons.add('fun-callouts-off');
  if (flags.viewportFault !== 'none') reasons.add('viewport-too-small');
  if (flags.roundFault !== 'none') reasons.add('not-revealed');
  if (flags.metricsFault.kind === 'flagged-insufficient' || flags.metricsFault.kind === 'low-count') {
    reasons.add('insufficient-data');
  }
  if (flags.metricsFault.kind === 'bad-average') reasons.add('non-finite-average');
  if (flags.deck === 't-shirt') reasons.add('short-ladder');
  if (flags.deck === 'unknown') reasons.add('unknown-voting-system');
  if (flags.emptyClassification) reasons.add('no-classification');
  if (flags.emptyCopySize !== null) reasons.add('empty-copy-section');
  return reasons;
}

function isSuppressed(flags: SuppressionFlags): boolean {
  return expectedReasons(flags).size > 0;
}

function dismissalsFor(display: DisplayConditions): DismissalRecord[] {
  const records: DismissalRecord[] = [];
  if (display.dismissNear) records.push({ sessionId: SESSION, roundId: ROUND, callout: 'near', at: 1 });
  if (display.dismissFar) records.push({ sessionId: SESSION, roundId: ROUND, callout: 'far', at: 2 });
  return records;
}

function buildInput(
  flags: SuppressionFlags,
  display: DisplayConditions,
  viewport: { width: number; height: number }
): CalloutResolverInput {
  const votes = flags.emptyClassification ? MIDDLE_BAND_VOTES : HEALTHY_VOTES;

  let metrics: VotingMetrics | null = metricsFor(votes, HEALTHY_AVERAGE);
  switch (flags.metricsFault.kind) {
    case 'flagged-insufficient':
      metrics = {
        ...metrics,
        insufficientData: true,
        numericVoteCount: flags.metricsFault.count,
      };
      break;
    case 'low-count':
      metrics = {
        ...metrics,
        insufficientData: false,
        numericVoteCount: flags.metricsFault.count,
      };
      break;
    case 'bad-average':
      metrics = { ...metrics, average: flags.metricsFault.average as number | null };
      break;
    case 'none':
      break;
  }
  if (flags.roundFault === 'no-metrics') metrics = null;

  const round =
    flags.roundFault === 'no-round'
      ? null
      : {
          id: ROUND,
          status: flags.roundFault === 'voting' ? 'voting' : flags.roundFault === 'completed' ? 'completed' : 'revealed',
        };

  const routedSessionId = flags.session === 'no-routed-session' ? null : SESSION;
  const stateSessionId =
    flags.session === 'state-other-session'
      ? 'session-b'
      : flags.session === 'state-no-session'
        ? null
        : SESSION;

  const votingSystem =
    flags.deck === 't-shirt' ? 't-shirt' : flags.deck === 'unknown' ? 'made-up' : 'fibonacci';

  const sectionSizes: Readonly<Record<CalloutSection, number>> =
    flags.emptyCopySize === null
      ? SECTION_SIZES
      : {
          ...SECTION_SIZES,
          nearAverage: flags.emptyCopySize,
          fullAgreement: flags.emptyCopySize,
          wideSpread: flags.emptyCopySize,
        };

  return {
    routedSessionId,
    stateSessionId,
    sessionNotFound: flags.sessionNotFound,
    countdownActive: flags.countdownActive,
    connectionBlocked: display.connectionBlocked,
    funCallouts: flags.funCalloutsOff ? false : display.funCalloutsEnabled,
    votingSystem,
    round,
    metrics,
    selections: new Map(Object.entries(votes)),
    displayNames: displayNamesFor(votes),
    viewerId: display.viewerId,
    hasRevealPermission: display.hasRevealPermission,
    dismissals: dismissalsFor(display),
    alreadyVisible: display.alreadyVisible,
    viewport,
    sectionSizes,
  };
}

/** `resolverInputArb`: the full cross-product of suppression-relevant flags (design, tests). */
const resolverCaseArb = suppressionFlagsArb.chain((flags) =>
  fc.record({
    flags: fc.constant(flags),
    display: displayConditionsArb,
    viewport: faultyViewportArb(flags.viewportFault),
  })
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Feature: vote-reveal-fun-callouts, Property 23: Suppression precedence', () => {
  it('hides both callouts whenever any suppression condition holds, whatever display conditions hold', () => {
    fc.assert(
      fc.property(resolverCaseArb, ({ flags, display, viewport }) => {
        fc.pre(isSuppressed(flags));

        const result = resolveCalloutVisibility(buildInput(flags, display, viewport));

        expect(result.kind).toBe('suppressed');
        // A suppressed resolution carries no panel model at all: neither near nor far.
        expect('near' in result).toBe(false);
        expect('far' in result).toBe(false);
        if (result.kind === 'suppressed') {
          // The reason is attributable to a condition that was actually switched on.
          expect(expectedReasons(flags).has(result.reason)).toBe(true);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('does not suppress when no suppression condition holds (generator is not vacuous)', () => {
    fc.assert(
      fc.property(displayConditionsArb, healthyViewportArb, (display, viewport) => {
        const result = resolveCalloutVisibility(buildInput(NO_SUPPRESSION, display, viewport));

        expect(result.kind).toBe('visible');
      }),
      { numRuns: 200 }
    );
  });

  it('exercises display conditions that would otherwise show a panel (precedence is meaningful)', () => {
    // Same display inputs, with and without a single suppression condition: the callouts are
    // present without it and absent with it, for every kind of condition.
    const showingDisplay: DisplayConditions = {
      viewerId: 'dee',
      hasRevealPermission: true,
      connectionBlocked: false,
      dismissNear: false,
      dismissFar: false,
      alreadyVisible: { near: false, far: false },
      funCalloutsEnabled: true,
    };
    const viewport = { width: 1280, height: 800 };

    const baseline = resolveCalloutVisibility(buildInput(NO_SUPPRESSION, showingDisplay, viewport));
    expect(baseline.kind).toBe('visible');
    if (baseline.kind === 'visible') {
      expect(baseline.near).not.toBeNull();
      expect(baseline.far).not.toBeNull();
    }

    const singleConditions: readonly Partial<SuppressionFlags>[] = [
      { session: 'no-routed-session' },
      { session: 'state-other-session' },
      { session: 'state-no-session' },
      { sessionNotFound: true },
      { countdownActive: true },
      { funCalloutsOff: true },
      { viewportFault: 'narrow' },
      { viewportFault: 'short' },
      { roundFault: 'no-round' },
      { roundFault: 'voting' },
      { roundFault: 'completed' },
      { roundFault: 'no-metrics' },
      { metricsFault: { kind: 'flagged-insufficient', count: 5 } },
      { metricsFault: { kind: 'low-count', count: 1 } },
      { metricsFault: { kind: 'bad-average', average: Number.NaN } },
      { deck: 't-shirt' },
      { deck: 'unknown' },
      { emptyClassification: true },
      { emptyCopySize: 0 },
    ];

    for (const condition of singleConditions) {
      const flags: SuppressionFlags = { ...NO_SUPPRESSION, ...condition };
      const faultyViewport =
        flags.viewportFault === 'narrow'
          ? { width: MIN_LAYER_VIEWPORT_WIDTH - 1, height: 800 }
          : flags.viewportFault === 'short'
            ? { width: 1280, height: MIN_LAYER_VIEWPORT_HEIGHT - 1 }
            : viewport;
      const result = resolveCalloutVisibility(buildInput(flags, showingDisplay, faultyViewport));
      expect(result.kind, JSON.stringify(condition)).toBe('suppressed');
    }
  });
});
