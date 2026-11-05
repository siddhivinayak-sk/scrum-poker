/**
 * Playful, safe copy for the Final Weight result balloon.
 * English only. Every line is about the guess, never about the person.
 * Placeholders: {name} (voter) and {card} (card or weight).
 */

export type DistanceBand = 'near' | 'mid' | 'far';

/** Maps a distance in ladder steps to a band: 1 -> near, 2-3 -> mid, >=4 -> far. */
export function bandFor(distance: number): DistanceBand {
  if (distance >= 4) return 'far';
  if (distance >= 2) return 'mid';
  return 'near';
}

export const CLOSEST_TITLES: readonly string[] = [
  'Sharpshooter',
  'Crystal Ball',
  'Estimation Whisperer',
  'Bullseye Buddy',
  'Team Compass',
  'Mind Reader',
];

export const FURTHEST_TITLES: readonly string[] = [
  'Bold Explorer',
  'Wildcard',
  'Dreamer of Other Sprints',
  'Brave Pioneer',
  'Plot Twist',
  'Adventurous Guesser',
];

export const CLOSEST_LINES: Record<'exact' | DistanceBand, readonly string[]> = {
  exact: [
    '{name} hit it dead on with {card}. Spooky.',
    '{name} nailed it with {card}. Bullseye!',
    '{name} called {card} and the team agreed. Crystal clear.',
    'Exactly {card} from {name}. Did you peek at the answer sheet?',
    '{name} landed right on {card}. Perfect aim.',
  ],
  near: [
    '{name} was a hair away with {card}. Sharp instincts.',
    '{name} played {card}, just one step from the mark.',
    'So close! {name} showed {card} and nearly nailed it.',
    '{name} read the team\'s mind with {card}. Almost exactly.',
    'One step off with {card}. {name} is on the right track.',
  ],
  mid: [
    '{name} showed {card}, the closest guess in the room.',
    '{name} played {card} and led the pack this round.',
    'Nobody got nearer than {name} with {card}. Nice work.',
    '{name} brought {card}, the best aim of a tricky round.',
    'The closest guess this time: {card} from {name}.',
  ],
  far: [
    'Tough round, but {name} came closest with {card}.',
    'It was a wild one. {name} still led with {card}.',
    '{name} played {card}, the nearest star in a scattered sky.',
    'Everyone spread out, and {card} from {name} was the closest.',
    'In a round full of surprises, {name} and {card} came out ahead.',
  ],
};

export const FURTHEST_LINES: Record<DistanceBand, readonly string[]> = {
  near: [
    '{name} was just one step off with {card}. Almost a prophet.',
    '{card} from {name} was a tiny stroll away from the answer.',
    '{name} showed {card}. One step away, barely a detour.',
    'A small wander for {name} with {card}. Still in the neighborhood.',
    '{name} picked {card}. Not far, just taking the scenic route.',
  ],
  mid: [
    '{name} played {card}. Bold. The team will remember this.',
    '{card} from {name} took the road less traveled.',
    '{name} went exploring with {card}. Bring a map next time.',
    'A few steps of adventure: {name} showed {card}.',
    '{name} had a vision with {card}. The vision was creative.',
  ],
  far: [
    '{name} showed {card} from another galaxy. Is this sprint planning or a treasure map?',
    '{card} from {name} came in from a parallel universe.',
    '{name} played {card}. That guess has its own zip code.',
    'Wild guess alert: {card} from {name} is planning a different sprint.',
    '{name} sailed far past the horizon with {card}. Bon voyage, guess.',
  ],
};

/** Shown instead of a closest/furthest pair when every scorable voter matched the weight. */
export const ALL_EXACT_LINES: readonly string[] = [
  'Hive mind! Everybody landed on {card}.',
  'Hive mind! The whole team picked {card}.',
  'Perfect harmony: all voters matched {card}.',
  'One team, one brain, one card: {card}.',
  'Total sync! Everyone aimed at {card} and hit it.',
];

/** Deterministic FNV-1a (32-bit) hash. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Picks one entry from the pool, deterministically from roundId and salt. Empty pool gives ''. */
export function pickCopy(pool: readonly string[], roundId: string, salt: number): string {
  if (pool.length === 0) return '';
  const index = fnv1a(`${roundId}:${salt}`) % pool.length;
  return pool[index];
}

/** Replaces {name} and {card} with plain text. No HTML handling; callers render as text. */
export function fillCopy(line: string, vars: { name: string; card: string }): string {
  return line
    .split('{name}').join(vars.name)
    .split('{card}').join(vars.card);
}
