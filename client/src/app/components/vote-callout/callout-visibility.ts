/**
 * Pure visibility resolver for the vote callouts.
 *
 * No Angular, DOM, clock or storage dependency lives here. Every suppression condition is an
 * early `return` that runs before the proximity classifier and before any per-callout display
 * condition, so a satisfied suppression condition always overrides a satisfied display
 * condition (R11.14) by construction rather than by convention.
 *
 * The models returned here deliberately carry no distance, rank, index or count of far
 * participants, and no far display name (R2.5, R2.6, R3.6). The classifier's `distances` map is
 * never forwarded, so no per-participant Ladder_Distance outlives the computation (R4.8).
 *
 * Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8, 2.11, 2.13, 2.14, 3.1, 3.2, 3.4, 3.6, 4.12, 6.7,
 * 7.5, 7.10, 8.3, 8.4, 8.7, 8.8, 11.1-11.5, 11.7-11.14, 12.1, 12.3, 12.4, 12.5
 */
import type { CalloutSection } from '@shared/callout-copy';
import {
  VOTING_SYSTEMS,
  cardLadderFor,
  resolveFunCallouts,
  type ExtendedCardValue,
  type VotingMetrics,
} from '@shared/types';
import { classifyProximity, consensusReference } from '@shared/vote-proximity';
import type { DismissalRecord } from '../../services/callout-persistence.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Narrowest viewport in which the layer clearances and size limits can all hold (R7.10). */
export const MIN_LAYER_VIEWPORT_WIDTH = 320;
/** Shortest viewport that fits a two-line phrase plus a 44 px input under the 40% cap (R7.10). */
export const MIN_LAYER_VIEWPORT_HEIGHT = 420;
/** Most names the near callout displays; the remainder collapses into a summary (R8.3). */
export const MAX_NAMES = 8;
/** Display names longer than this are truncated to this many characters plus an ellipsis (R8.4). */
export const NAME_TRUNCATE_AT = 18;

/** Share of the viewport height the layer may occupy on narrow viewports (R8.2). */
const LAYER_HEIGHT_RATIO = 0.45;
/** Minimum height of the Far_From_Average_Prompt text input (R8.7). */
const INPUT_MIN_HEIGHT_PX = 44;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | 'no-session' // no routed session id, or state belongs to another session (R12.5)
  | 'session-not-found' // R11.11
  | 'countdown-active' // R7.5
  | 'fun-callouts-off' // R6.7
  | 'viewport-too-small' // R7.10
  | 'not-revealed' // R11.5
  | 'insufficient-data' // R11.1, R11.7
  | 'non-finite-average' // R11.2
  | 'unknown-voting-system' // R1.19
  | 'short-ladder' // R11.3, R11.4
  | 'no-classification' // R11.13, R2.13
  | 'empty-copy-section'; // R4.12

export interface CalloutResolverInput {
  readonly routedSessionId: string | null;
  /** Session the held state belongs to; must equal `routedSessionId` (R12.5). */
  readonly stateSessionId: string | null;
  readonly sessionNotFound: boolean;
  readonly countdownActive: boolean;
  /** Interaction is paused because the connection is not established (R11.12). */
  readonly connectionBlocked: boolean;
  /** Raw configuration value; coerced by `resolveFunCallouts` (R6.11). */
  readonly funCallouts: unknown;
  readonly votingSystem: string;
  readonly round: { readonly id: string; readonly status: string } | null;
  readonly metrics: VotingMetrics | null;
  readonly selections: ReadonlyMap<string, ExtendedCardValue | null | undefined>;
  readonly displayNames: ReadonlyMap<string, string>;
  readonly viewerId: string | null;
  /** Already role-and-permission aware (R2.1, R2.2). */
  readonly hasRevealPermission: boolean;
  readonly dismissals: readonly DismissalRecord[];
  readonly alreadyVisible: { readonly near: boolean; readonly far: boolean };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly sectionSizes: Readonly<Record<CalloutSection, number>>;
}

export interface NearCalloutName {
  /** Untruncated display name; exposed through `title` and the accessible name (R8.4). */
  readonly full: string;
  /** Text actually rendered; at most 18 characters plus an ellipsis. */
  readonly shown: string;
}

export interface NearCalloutModel {
  readonly roundId: string;
  readonly variant: 'nearAverage' | 'fullAgreement' | 'wideSpread'; // R2.7, R2.8
  readonly names: readonly NearCalloutName[]; // R8.3, R8.4
  /** Names beyond `MAX_NAMES`, rendered as one summary element (R8.3). */
  readonly hiddenNameCount: number;
  /** False mounts the element at rest with no entrance animation (R11.12). */
  readonly replayEntrance: boolean;
}

export interface FarPromptModel {
  readonly roundId: string;
  readonly replayEntrance: boolean;
}

export type CalloutResolution =
  | { readonly kind: 'suppressed'; readonly reason: SuppressionReason }
  | {
      readonly kind: 'visible';
      readonly near: NearCalloutModel | null;
      readonly far: FarPromptModel | null;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * First `NAME_TRUNCATE_AT` characters followed by an ellipsis when the name is longer; the name
 * unchanged otherwise (R8.4). Counts code points so a surrogate pair is never split.
 */
export function truncateName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= NAME_TRUNCATE_AT) return name;
  return chars.slice(0, NAME_TRUNCATE_AT).join('') + '\u2026';
}

/**
 * Maximum height in pixels of the Vote_Callout_Layer.
 *
 * With no keyboard open this is 45% of the viewport height (R8.2). While an on-screen keyboard
 * covers `keyboardInset` pixels, the budget is 45% of the area still visible, so it drops below
 * 45% of the full viewport and the prompt's text input stays inside the uncovered area (R8.7,
 * R8.8). It never drops below the input's own 44 px unless the visible area itself is smaller.
 * Non-finite or negative inputs are treated as 0.
 */
export function computeLayerHeightBudget(viewportHeight: number, keyboardInset: number): number {
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const rawInset = Number.isFinite(keyboardInset) && keyboardInset > 0 ? keyboardInset : 0;
  const inset = Math.min(rawInset, height);
  const visible = height - inset;

  if (inset === 0) return Math.floor(height * LAYER_HEIGHT_RATIO);

  const proportional = Math.floor(visible * LAYER_HEIGHT_RATIO);
  return Math.min(visible, Math.max(proportional, INPUT_MIN_HEIGHT_PX));
}

function isKnownVotingSystem(votingSystem: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOTING_SYSTEMS, votingSystem);
}

function isDismissed(
  dismissals: readonly DismissalRecord[],
  sessionId: string,
  roundId: string,
  callout: DismissalRecord['callout']
): boolean {
  return dismissals.some(
    (d) => d.sessionId === sessionId && d.roundId === roundId && d.callout === callout
  );
}

function suppressed(reason: SuppressionReason): CalloutResolution {
  return { kind: 'suppressed', reason };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveCalloutVisibility(input: CalloutResolverInput): CalloutResolution {
  // ---- Suppression block: every check is an early return (R11.14) ----------
  const { routedSessionId } = input;
  if (routedSessionId === null) return suppressed('no-session');
  if (input.stateSessionId !== routedSessionId) return suppressed('no-session');
  if (input.sessionNotFound) return suppressed('session-not-found');
  if (input.countdownActive) return suppressed('countdown-active');
  if (!resolveFunCallouts(input.funCallouts)) return suppressed('fun-callouts-off');
  if (
    input.viewport.width < MIN_LAYER_VIEWPORT_WIDTH ||
    input.viewport.height < MIN_LAYER_VIEWPORT_HEIGHT
  ) {
    return suppressed('viewport-too-small');
  }

  const { round, metrics } = input;
  if (round === null || round.status !== 'revealed' || metrics === null) {
    return suppressed('not-revealed');
  }
  if (metrics.insufficientData || metrics.numericVoteCount < 2) {
    return suppressed('insufficient-data');
  }
  const average: unknown = metrics.average;
  if (typeof average !== 'number' || !Number.isFinite(average)) {
    return suppressed('non-finite-average');
  }

  const ladder = cardLadderFor(input.votingSystem);
  if (ladder.length === 0 && !isKnownVotingSystem(input.votingSystem)) {
    return suppressed('unknown-voting-system');
  }
  if (ladder.length < 2) return suppressed('short-ladder');

  // ---- Classification ------------------------------------------------------
  // Anchor divergence on the consensus (mode) value, not the mean. The mean is dragged toward a
  // lone extreme vote, which inverts near/far; the consensus value is robust to that (R1.7-R1.9).
  // Fall back to the mean only when there is no numeric vote to form a consensus from.
  const reference = consensusReference(input.selections) ?? average;
  const { near, far } = classifyProximity({
    selections: input.selections,
    reference,
    votingSystem: input.votingSystem,
    displayNames: input.displayNames,
  });
  if (near.length === 0 && far.length === 0) return suppressed('no-classification');

  // ---- Variant selection (near panel) --------------------------------------
  let numericVoters = 0;
  for (const card of input.selections.values()) {
    if (card !== null && card !== undefined && ladder.includes(card)) numericVoters += 1;
  }
  const variant: NearCalloutModel['variant'] =
    far.length === 0 && near.length === numericVoters && numericVoters >= 2
      ? 'fullAgreement'
      : near.length === 0
        ? 'wideSpread'
        : 'nearAverage';

  const variantSize = input.sectionSizes[variant];
  if (!(variantSize > 0)) return suppressed('empty-copy-section');

  // ---- Per-callout gating: not suppression; each panel decides alone -------
  const roundId = round.id;
  const replayEntrance = !input.connectionBlocked;

  const nearVisible =
    input.hasRevealPermission &&
    !isDismissed(input.dismissals, routedSessionId, roundId, 'near') &&
    !(input.connectionBlocked && !input.alreadyVisible.near);

  const viewerId = input.viewerId;
  const farVisible =
    viewerId !== null &&
    far.some((p) => p.userId === viewerId) &&
    !isDismissed(input.dismissals, routedSessionId, roundId, 'far') &&
    !(input.connectionBlocked && !input.alreadyVisible.far);

  const names: readonly NearCalloutName[] =
    variant === 'wideSpread'
      ? []
      : near.slice(0, MAX_NAMES).map((p) => ({
          full: p.displayName,
          shown: truncateName(p.displayName),
        }));
  const hiddenNameCount = variant === 'wideSpread' ? 0 : Math.max(0, near.length - MAX_NAMES);

  return {
    kind: 'visible',
    near: nearVisible ? { roundId, variant, names, hiddenNameCount, replayEntrance } : null,
    far: farVisible ? { roundId, replayEntrance } : null,
  };
}
