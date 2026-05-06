import * as fc from 'fast-check';
import {
  computeConsensusLevel,
  VotingMetrics,
  VotingSystemType,
} from '../types';

/**
 * **Validates: Requirements 9.2, 9.3, 9.4**
 *
 * Property 11: Consensus level computation
 *
 * For any VotingMetrics and voting system type, computeConsensusLevel SHALL return:
 * - 'full' if and only if spread === 0 and numericVoteCount >= 2
 * - 'high-divergence' if and only if spread > 5 (for numeric systems) or position difference > 2 (for t-shirt)
 * - 'partial' if and only if 0 < spread <= 5 (numeric) or 0 < positionDiff <= 2 (t-shirt)
 * - 'none' if metrics is null or insufficientData is true or numericVoteCount < 2
 */

const T_SHIRT_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const numericSystemArb = fc.constantFrom<VotingSystemType>('fibonacci', 'modified-fibonacci', 'power-of-2');
const allSystemArb = fc.constantFrom<VotingSystemType>('fibonacci', 'modified-fibonacci', 't-shirt', 'power-of-2');

function buildNumericMetrics(
  spread: number,
  numericVoteCount: number,
  insufficientData: boolean
): VotingMetrics {
  return {
    average: spread === 0 ? 5 : 5 + spread,
    mode: null,
    spread,
    distribution: {},
    outliers: [],
    numericVoteCount,
    insufficientData,
  };
}

function buildTShirtMetrics(
  spread: number,
  numericVoteCount: number,
  insufficientData: boolean,
  positionDiff: number
): VotingMetrics {
  const distribution: Record<string, number> = {};
  if (positionDiff > 0 && positionDiff < T_SHIRT_ORDER.length) {
    distribution[T_SHIRT_ORDER[0]] = 1;
    distribution[T_SHIRT_ORDER[positionDiff]] = 1;
  }
  return {
    average: null,
    mode: null,
    spread,
    distribution,
    outliers: [],
    numericVoteCount,
    insufficientData,
  };
}

describe('computeConsensusLevel - Property 11', () => {
  describe('returns "none" conditions', () => {
    it('returns "none" when metrics is null', () => {
      fc.assert(
        fc.property(allSystemArb, (votingSystem: VotingSystemType) => {
          expect(computeConsensusLevel(null, votingSystem)).toBe('none');
        })
      );
    });

    it('returns "none" when insufficientData is true', () => {
      fc.assert(
        fc.property(
          fc.record({
            spread: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 6, max: 100 })),
            numericVoteCount: fc.integer({ min: 0, max: 20 }),
            votingSystem: allSystemArb,
          }),
          (params: { spread: number; numericVoteCount: number; votingSystem: VotingSystemType }) => {
            const metrics = buildNumericMetrics(params.spread, params.numericVoteCount, true);
            expect(computeConsensusLevel(metrics, params.votingSystem)).toBe('none');
          }
        )
      );
    });

    it('returns "none" when numericVoteCount < 2', () => {
      fc.assert(
        fc.property(
          fc.record({
            spread: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 6, max: 100 })),
            numericVoteCount: fc.integer({ min: 0, max: 1 }),
            votingSystem: allSystemArb,
          }),
          (params: { spread: number; numericVoteCount: number; votingSystem: VotingSystemType }) => {
            const metrics = buildNumericMetrics(params.spread, params.numericVoteCount, false);
            expect(computeConsensusLevel(metrics, params.votingSystem)).toBe('none');
          }
        )
      );
    });

    it('returns "none" for t-shirt system when distribution has fewer than 2 t-shirt positions', () => {
      fc.assert(
        fc.property(
          fc.record({
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            spread: fc.integer({ min: 1, max: 100 }),
          }),
          (params: { numericVoteCount: number; spread: number }) => {
            // Distribution with only one t-shirt size
            const distribution: Record<string, number> = {};
            distribution[T_SHIRT_ORDER[0]] = 1;

            const metrics: VotingMetrics = {
              average: null,
              mode: null,
              spread: params.spread,
              distribution,
              outliers: [],
              numericVoteCount: params.numericVoteCount,
              insufficientData: false,
            };
            expect(computeConsensusLevel(metrics, 't-shirt')).toBe('none');
          }
        )
      );
    });
  });

  describe('returns "full" conditions', () => {
    it('returns "full" if and only if spread === 0 and numericVoteCount >= 2 and not insufficientData', () => {
      fc.assert(
        fc.property(
          fc.record({
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            votingSystem: allSystemArb,
          }),
          (params: { numericVoteCount: number; votingSystem: VotingSystemType }) => {
            const metrics = buildNumericMetrics(0, params.numericVoteCount, false);
            expect(computeConsensusLevel(metrics, params.votingSystem)).toBe('full');
          }
        )
      );
    });
  });

  describe('returns "high-divergence" conditions', () => {
    it('returns "high-divergence" for numeric systems when spread > 5', () => {
      fc.assert(
        fc.property(
          fc.record({
            spread: fc.integer({ min: 6, max: 100 }),
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            votingSystem: numericSystemArb,
          }),
          (params: { spread: number; numericVoteCount: number; votingSystem: VotingSystemType }) => {
            const metrics = buildNumericMetrics(params.spread, params.numericVoteCount, false);
            expect(computeConsensusLevel(metrics, params.votingSystem)).toBe('high-divergence');
          }
        )
      );
    });

    it('returns "high-divergence" for t-shirt system when position difference > 2', () => {
      fc.assert(
        fc.property(
          fc.record({
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            positionDiff: fc.integer({ min: 3, max: 5 }),
          }),
          (params: { numericVoteCount: number; positionDiff: number }) => {
            const metrics = buildTShirtMetrics(
              params.positionDiff, // spread is non-zero
              params.numericVoteCount,
              false,
              params.positionDiff
            );
            expect(computeConsensusLevel(metrics, 't-shirt')).toBe('high-divergence');
          }
        )
      );
    });
  });

  describe('returns "partial" conditions', () => {
    it('returns "partial" for numeric systems when 0 < spread <= 5', () => {
      fc.assert(
        fc.property(
          fc.record({
            spread: fc.integer({ min: 1, max: 5 }),
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            votingSystem: numericSystemArb,
          }),
          (params: { spread: number; numericVoteCount: number; votingSystem: VotingSystemType }) => {
            const metrics = buildNumericMetrics(params.spread, params.numericVoteCount, false);
            expect(computeConsensusLevel(metrics, params.votingSystem)).toBe('partial');
          }
        )
      );
    });

    it('returns "partial" for t-shirt system when 0 < position difference <= 2', () => {
      fc.assert(
        fc.property(
          fc.record({
            numericVoteCount: fc.integer({ min: 2, max: 20 }),
            positionDiff: fc.integer({ min: 1, max: 2 }),
          }),
          (params: { numericVoteCount: number; positionDiff: number }) => {
            const metrics = buildTShirtMetrics(
              params.positionDiff, // spread is non-zero
              params.numericVoteCount,
              false,
              params.positionDiff
            );
            expect(computeConsensusLevel(metrics, 't-shirt')).toBe('partial');
          }
        )
      );
    });
  });
});
