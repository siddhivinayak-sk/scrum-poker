import * as fc from 'fast-check';
import {
  ALL_EXACT_LINES,
  CLOSEST_LINES,
  CLOSEST_TITLES,
  FURTHEST_LINES,
  FURTHEST_TITLES,
  bandFor,
  fillCopy,
  pickCopy,
} from '../final-weight-copy';

const BANNED = [
  'stupid', 'idiot', 'dumb', 'moron', 'loser', 'fool', 'useless', 'incompetent',
  'clueless', 'worst', 'terrible', 'awful', 'pathetic', 'hate', 'shut up', 'ugly',
  'lazy', 'failure', 'trash', 'garbage', 'imbecile', 'jerk', 'crap', 'damn', 'hell',
];

const pools: Array<[string, readonly string[]]> = [
  ['CLOSEST_TITLES', CLOSEST_TITLES],
  ['FURTHEST_TITLES', FURTHEST_TITLES],
  ['ALL_EXACT_LINES', ALL_EXACT_LINES],
  ...Object.entries(CLOSEST_LINES).map(([k, v]): [string, readonly string[]] => [`CLOSEST_LINES.${k}`, v]),
  ...Object.entries(FURTHEST_LINES).map(([k, v]): [string, readonly string[]] => [`FURTHEST_LINES.${k}`, v]),
];

const allLines = pools.flatMap(([, p]) => p);
const runs = { numRuns: 100 };

describe('final-weight-copy', () => {
  // Feature: final-weight-accuracy, Property 6: Copy selection is deterministic and safe
  describe('Property 6: Copy selection is deterministic and safe', () => {
    it.each(pools)('%s has at least 5 lines, each short and free of banned words', (_n, pool) => {
      expect(pool.length).toBeGreaterThanOrEqual(5);
      for (const line of pool) {
        expect(line.length).toBeLessThan(120);
        const lower = line.toLowerCase();
        for (const word of BANNED) {
          expect(lower).not.toMatch(new RegExp(`\\b${word}\\b`));
        }
      }
    });

    it('pickCopy is deterministic and returns a line from the pool', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: pools.length - 1 }),
          fc.string(),
          fc.integer({ min: 0, max: 1000 }),
          (poolIdx, roundId, salt) => {
            const pool = pools[poolIdx][1];
            const a = pickCopy(pool, roundId, salt);
            const b = pickCopy(pool, roundId, salt);
            return a === b && pool.includes(a);
          },
        ),
        runs,
      );
    });

    it('fillCopy leaves no placeholder and returns plain text', () => {
      const plain = fc.string({ maxLength: 20 }).filter((s) => !/[{}]/.test(s));
      fc.assert(
        fc.property(fc.constantFrom(...allLines), plain, plain, (line, name, card) => {
          const out = fillCopy(line, { name, card });
          expect(out).not.toContain('{name}');
          expect(out).not.toContain('{card}');
          expect(out).not.toMatch(/[{}]/);
          // Plain text: no markup is introduced beyond what the inputs carry
          const inputMarkup = /[<>]/.test(name + card);
          if (!inputMarkup) expect(out).not.toMatch(/[<>]/);
          return true;
        }),
        runs,
      );
    });

    it('fillCopy replaces every occurrence of a repeated placeholder', () => {
      expect(fillCopy('{name} {name} {card} {card}', { name: 'A', card: '5' })).toBe('A A 5 5');
    });
  });

  describe('bandFor', () => {
    it('maps distance boundaries to bands', () => {
      expect(bandFor(1)).toBe('near');
      expect(bandFor(2)).toBe('mid');
      expect(bandFor(3)).toBe('mid');
      expect(bandFor(4)).toBe('far');
    });
  });

  describe('pickCopy', () => {
    it('returns empty string for an empty pool', () => {
      expect(pickCopy([], 'r1', 0)).toBe('');
    });
  });
});
