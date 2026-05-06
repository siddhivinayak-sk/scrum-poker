import {
  computeConsensusLevel,
  VotingMetrics,
  VotingSystemType,
  ConsensusLevel,
} from '../types';

/**
 * Unit tests for computeConsensusLevel
 * Validates: Requirements 9.2, 9.3, 9.4
 */

function buildMetrics(overrides: Partial<VotingMetrics> = {}): VotingMetrics {
  return {
    average: 5,
    mode: null,
    spread: 0,
    distribution: {},
    outliers: [],
    numericVoteCount: 3,
    insufficientData: false,
    ...overrides,
  };
}

describe('computeConsensusLevel', () => {
  describe('returns "none"', () => {
    it('returns "none" when metrics is null', () => {
      expect(computeConsensusLevel(null, 'fibonacci')).toBe('none');
    });

    it('returns "none" when insufficientData is true', () => {
      const metrics = buildMetrics({ insufficientData: true, spread: 0, numericVoteCount: 5 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('none');
    });

    it('returns "none" when numericVoteCount is 0', () => {
      const metrics = buildMetrics({ numericVoteCount: 0, spread: 0 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('none');
    });

    it('returns "none" when numericVoteCount is 1', () => {
      const metrics = buildMetrics({ numericVoteCount: 1, spread: 0 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('none');
    });

    it('returns "none" when spread is null', () => {
      const metrics = buildMetrics({ spread: null, numericVoteCount: 5 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('none');
    });

    it('returns "none" for t-shirt with only one size in distribution', () => {
      const metrics = buildMetrics({
        spread: 2,
        numericVoteCount: 3,
        distribution: { 'M': 3 },
      });
      expect(computeConsensusLevel(metrics, 't-shirt')).toBe('none');
    });
  });

  describe('returns "full"', () => {
    it('returns "full" when spread is 0 and numericVoteCount >= 2 (fibonacci)', () => {
      const metrics = buildMetrics({ spread: 0, numericVoteCount: 4 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('full');
    });

    it('returns "full" when spread is 0 and numericVoteCount >= 2 (t-shirt)', () => {
      const metrics = buildMetrics({
        spread: 0,
        numericVoteCount: 3,
        distribution: { 'M': 3 },
      });
      expect(computeConsensusLevel(metrics, 't-shirt')).toBe('full');
    });
  });

  describe('returns "partial"', () => {
    it('returns "partial" when spread is 3 (fibonacci)', () => {
      const metrics = buildMetrics({ spread: 3, numericVoteCount: 4 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('partial');
    });

    it('returns "partial" when spread is 5 (fibonacci)', () => {
      const metrics = buildMetrics({ spread: 5, numericVoteCount: 3 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('partial');
    });

    it('returns "partial" for t-shirt with position diff of 1 (e.g., S and M)', () => {
      const metrics = buildMetrics({
        spread: 1,
        numericVoteCount: 4,
        distribution: { 'S': 2, 'M': 2 },
      });
      expect(computeConsensusLevel(metrics, 't-shirt')).toBe('partial');
    });

    it('returns "partial" for t-shirt with position diff of 2 (e.g., S and L)', () => {
      const metrics = buildMetrics({
        spread: 2,
        numericVoteCount: 3,
        distribution: { 'S': 1, 'L': 2 },
      });
      expect(computeConsensusLevel(metrics, 't-shirt')).toBe('partial');
    });
  });

  describe('returns "high-divergence"', () => {
    it('returns "high-divergence" when spread is 6 (fibonacci)', () => {
      const metrics = buildMetrics({ spread: 6, numericVoteCount: 3 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('high-divergence');
    });

    it('returns "high-divergence" when spread is 13 (fibonacci)', () => {
      const metrics = buildMetrics({ spread: 13, numericVoteCount: 5 });
      expect(computeConsensusLevel(metrics, 'fibonacci')).toBe('high-divergence');
    });

    it('returns "high-divergence" for t-shirt with position diff of 3 (e.g., S and XL)', () => {
      const metrics = buildMetrics({
        spread: 3,
        numericVoteCount: 4,
        distribution: { 'S': 2, 'XL': 2 },
      });
      expect(computeConsensusLevel(metrics, 't-shirt')).toBe('high-divergence');
    });
  });
});
