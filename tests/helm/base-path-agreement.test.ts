/**
 * Feature: helm-chart-deployment - task 13.4.
 *
 * Property 13: Base path and ingress path agreement decides rendering
 *
 * *For any* `config.basePath` value and *any* `ingress.hosts` structure, with
 * `ingress.enabled` and `config.preservePath` both `true`, rendering succeeds
 * exactly when every ingress `path` - after removing one trailing `/` from
 * values longer than one character, and treating an empty `config.basePath` as
 * `/` - equals `config.basePath` by exact string comparison; and whenever
 * rendering fails, the message names `config.basePath`, the first mismatched
 * `path` value in supplied iteration order, and the zero-based index of the
 * `ingress.hosts` entry holding it.
 *
 * **Validates: Requirements 9.1, 9.2, 9.3**
 *
 * ### Why the generator decides consistency at the sample level
 *
 * A sample renders only when *every* path agrees, and a generated sample holds
 * up to four host entries of up to three paths each. Choosing each path's
 * agreement independently would therefore have left the succeeding half of the
 * space - the half Requirements 9.1 and 9.3 are mostly about - reachable only
 * when a dozen coin flips landed the same way. So each sample is first drawn as
 * consistent or inconsistent, and the path strings are then built to match that
 * decision: a consistent sample aligns every path, an inconsistent one plants
 * the *first* mismatch at a chosen flat position, aligns everything before it,
 * and leaves everything after it free to agree or not. The free tail is what
 * makes the "first in supplied iteration order" clause of 9.2 testable rather
 * than accidental: a chart that reported the *last* mismatch, or the
 * lexicographically smallest, would pass a one-mismatch generator and fail
 * here.
 *
 * ### Which path strings count as aligned
 *
 * Alignment is not string identity with `config.basePath`, because the guard
 * normalises both sides first. Two shapes are aligned and both are generated:
 *
 *   - the normalised base path verbatim, and
 *   - the normalised base path plus one trailing `/`, which the guard strips.
 *
 * The second shape covers Requirement 9.3's `/` case twice over: with an empty
 * `config.basePath` the normalised value is `/`, so the aligned pair is `/` and
 * `//` - and `//` is only equal after exactly one slash is removed.
 *
 * The mismatch space is built symmetrically around that rule. `${base}//`
 * appears in it on purpose: it is aligned under a *repeated* strip and
 * mismatched under a single one, so it is the case that separates
 * `trimSuffix "/"` from a loop. `''` is in it because an operator can write an
 * empty path (the schema leaves `ingress.hosts` unconstrained) and an empty
 * string must not be treated as the cluster root.
 *
 * ### How the failure is attributed to this guard
 *
 * Every layer of the chart rejects with a non-zero status, so a status check
 * alone would be satisfied by a schema rejection or by guard 6, 7, 11, or 12
 * firing instead. The expected host index, path index, and raw path value are
 * therefore asserted as one contiguous substring of the message - a message
 * about a different entry, or from a different guard, cannot produce it.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assertConfig, basePathArb, hostsArb } from './support/generators.js';
import { renderChart, type RenderResult } from './support/render-chart.js';

interface PathEntry {
  path: string;
  pathType?: string;
}

interface HostEntry {
  host: string;
  paths: PathEntry[];
}

interface Sample {
  /** Always schema-valid and guard 6/7-clean, so only guard 13 can speak. */
  basePath: string;
  hosts: HostEntry[];
}

/** Any trace of a rendered resource in the raw output (Requirement 9.6). */
const MANIFEST_TOKEN = /^(?:# Source:|apiVersion:|kind:)/m;

/** `scrum-poker.normalizedBasePath`: an empty base path means the cluster root. */
function normalizeBasePath(basePath: string): string {
  return basePath === '' ? '/' : basePath;
}

/**
 * The ingress path as the guard compares it: one trailing `/` removed from a
 * value longer than one character, so a bare `/` survives intact. `replace`
 * with an anchored pattern removes exactly one, matching `trimSuffix "/"`.
 */
function comparablePath(rawPath: string): string {
  return rawPath.length > 1 ? rawPath.replace(/\/$/, '') : rawPath;
}

interface Mismatch {
  hostIndex: number;
  pathIndex: number;
  rawPath: string;
}

/** The first disagreeing path in supplied iteration order, if any. */
function firstMismatch(sample: Sample): Mismatch | undefined {
  const normalized = normalizeBasePath(sample.basePath);
  for (const [hostIndex, hostEntry] of sample.hosts.entries()) {
    for (const [pathIndex, pathEntry] of hostEntry.paths.entries()) {
      if (comparablePath(pathEntry.path) !== normalized) {
        return { hostIndex, pathIndex, rawPath: pathEntry.path };
      }
    }
  }
  return undefined;
}

/** Path strings the guard accepts for a given base path. */
function alignedPathArb(normalized: string): fc.Arbitrary<string> {
  return fc.constantFrom(normalized, `${normalized}/`);
}

/** Path strings the guard must reject for a given base path. */
function mismatchedPathArb(normalized: string): fc.Arbitrary<string> {
  return fc
    .constantFrom(
      '/',
      '',
      '/other',
      '/a/b',
      `${normalized}x`,
      `${normalized}/extra`,
      // Aligned only if a trailing slash were stripped repeatedly.
      `${normalized}//`,
    )
    .filter((candidate) => comparablePath(candidate) !== normalized);
}

/** Rewrite a host structure's path strings, keeping its shape and pathTypes. */
function withPaths(hosts: HostEntry[], flatPaths: string[]): HostEntry[] {
  let cursor = 0;
  return hosts.map((hostEntry) => ({
    ...hostEntry,
    paths: hostEntry.paths.map((pathEntry) => ({ ...pathEntry, path: flatPaths[cursor++] as string })),
  }));
}

const sampleArb: fc.Arbitrary<Sample> = fc
  .tuple(basePathArb, hostsArb, fc.boolean())
  .chain(([basePath, hosts, consistent]) => {
    const normalized = normalizeBasePath(basePath);
    const aligned = alignedPathArb(normalized);
    const mismatched = mismatchedPathArb(normalized);
    const total = hosts.reduce((count, hostEntry) => count + hostEntry.paths.length, 0);

    if (consistent) {
      return fc
        .array(aligned, { minLength: total, maxLength: total })
        .map((flatPaths) => ({ basePath, hosts: withPaths(hosts, flatPaths) }));
    }

    // Plant the first mismatch at `index`: everything before it agrees, so the
    // chart has no earlier candidate to report, and everything after it is
    // free, so reporting a later one is distinguishable from reporting this.
    return fc.integer({ min: 0, max: total - 1 }).chain((index) =>
      fc
        .tuple(
          fc.array(aligned, { minLength: index, maxLength: index }),
          mismatched,
          fc.array(fc.oneof(aligned, mismatched), {
            minLength: total - index - 1,
            maxLength: total - index - 1,
          }),
        )
        .map(([before, at, after]) => ({
          basePath,
          hosts: withPaths(hosts, [...before, at, ...after]),
        })),
    );
  });

/** The values patch for a sample: the guard's active state, nothing else. */
function valuesFor(sample: Sample): Record<string, unknown> {
  return {
    config: { basePath: sample.basePath, preservePath: true },
    ingress: { enabled: true, hosts: sample.hosts },
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every rendered ingress path, flattened in rendered order - the evidence that
 * a succeeding render really produced the rules it was asked for, rather than
 * passing the guard by rendering nothing.
 */
function renderedPaths(result: RenderResult): string[] {
  const ingresses = result.docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === 'Ingress',
  );
  expect(ingresses.length, 'expected exactly one Ingress').toBe(1);
  const rules = (ingresses[0] as Record<string, unknown>)['spec'];
  const ruleList = isMapping(rules) ? rules['rules'] : undefined;
  expect(Array.isArray(ruleList), 'Ingress spec.rules is not a list').toBe(true);

  const paths: string[] = [];
  for (const rule of ruleList as unknown[]) {
    const http = isMapping(rule) ? rule['http'] : undefined;
    const entries = isMapping(http) ? http['paths'] : undefined;
    expect(Array.isArray(entries), 'an Ingress rule carries no paths list').toBe(true);
    for (const entry of entries as unknown[]) {
      expect(isMapping(entry), 'an Ingress path entry is not a mapping').toBe(true);
      paths.push((entry as Record<string, unknown>)['path'] as string);
    }
  }
  return paths;
}

/** Assert every clause of Property 13 against a single render of `sample`. */
function assertAgreementDecidesRendering(sample: Sample): void {
  const context = `basePath=${JSON.stringify(sample.basePath)} hosts=${JSON.stringify(sample.hosts)}`;
  const expected = firstMismatch(sample);
  const result = renderChart(valuesFor(sample));

  if (expected === undefined) {
    // Requirements 9.1 and 9.3: every pair agrees, so the render completes and
    // carries the supplied paths through unchanged.
    expect(
      result.status,
      `${context}: every ingress path agrees with the base path, yet the render failed\n${result.stderr}`,
    ).toBe(0);
    expect(renderedPaths(result), `${context}: rendered ingress paths`).toEqual(
      sample.hosts.flatMap((hostEntry) => hostEntry.paths.map((pathEntry) => pathEntry.path)),
    );
    return;
  }

  // Requirement 9.2: a non-zero exit, and a message naming the values path.
  expect(
    result.status,
    `${context}: ingress.hosts[${expected.hostIndex}].paths[${expected.pathIndex}].path ` +
      `${JSON.stringify(expected.rawPath)} disagrees with the base path, yet the render succeeded`,
  ).not.toBe(0);
  expect(result.stderr, `${context}: the message does not name config.basePath\n${result.stderr}`).toContain(
    'config.basePath:',
  );

  // Requirement 9.2: the *first* mismatch, named together with the zero-based
  // ingress.hosts index holding it. Asserted as one contiguous substring, so a
  // message about another entry - or from another guard - cannot satisfy it.
  // Every generated path is ASCII over [a-z0-9-/], where Go's %q and
  // JSON.stringify agree.
  expect(
    result.stderr,
    `${context}: the message does not name the first mismatched path with its host index\n${result.stderr}`,
  ).toContain(
    `ingress.hosts[${expected.hostIndex}].paths[${expected.pathIndex}].path ` +
      JSON.stringify(expected.rawPath),
  );

  // Requirement 9.6: the rejection reaches stdout as nothing at all.
  expect(result.docs, `${context}: documents survived a rejected render`).toEqual([]);
  expect(
    result.stdout,
    `${context}: a resource reached stdout despite the rejection\n${result.stdout.slice(0, 400)}`,
  ).not.toMatch(MANIFEST_TOKEN);
}

/** Pinned samples, carried through the same assertions as the generated ones. */
const PINNED_SAMPLES: Sample[] = [
  // Requirement 9.3 verbatim: the cluster root expressed as "/".
  { basePath: '', hosts: [{ host: '', paths: [{ path: '/', pathType: 'Prefix' }] }] },
  // The same case reached through the trailing-slash strip.
  { basePath: '', hosts: [{ host: 'poker.example.com', paths: [{ path: '//' }] }] },
  // A prefix and its trailing-slash spelling agree.
  { basePath: '/scrum-poker', hosts: [{ host: '', paths: [{ path: '/scrum-poker/' }] }] },
  // The committed default pairing.
  {
    basePath: '/scrum-poker',
    hosts: [{ host: 'poker.example.com', paths: [{ path: '/scrum-poker', pathType: 'Prefix' }] }],
  },
  // Root ingress path against a non-root base path - the blank-page case.
  { basePath: '/scrum-poker', hosts: [{ host: '', paths: [{ path: '/' }] }] },
  // A prefix of the base path is still a mismatch.
  { basePath: '/a/b', hosts: [{ host: '', paths: [{ path: '/a' }] }] },
  // Two trailing slashes: aligned only under a repeated strip.
  { basePath: '/scrum-poker', hosts: [{ host: '', paths: [{ path: '/scrum-poker//' }] }] },
  // An empty ingress path is not the cluster root.
  { basePath: '', hosts: [{ host: '', paths: [{ path: '' }] }] },
  // The first mismatch is in the second host, at its second path, with a
  // further mismatch behind it - so reporting the last one is visible here.
  {
    basePath: '/scrum-poker',
    hosts: [
      { host: 'a.example.com', paths: [{ path: '/scrum-poker' }, { path: '/scrum-poker/' }] },
      {
        host: 'b.example.com',
        paths: [{ path: '/scrum-poker' }, { path: '/wrong' }, { path: '/also-wrong' }],
      },
    ],
  },
];

describe('Property 13: base path and ingress path agreement decides rendering', () => {
  it('draws both outcomes, and plants the first mismatch at varying positions', () => {
    // Non-vacuity, checked without spawning a render: every assertion in this
    // property is conditional on `firstMismatch`, so a generator that drifted
    // to one side of the decision would leave half of them unreached and the
    // property would still pass. Sampling is cheap enough to assert on.
    const samples = fc.sample(sampleArb, 300);
    const mismatches = samples.map(firstMismatch);
    const agreeing = mismatches.filter((mismatch) => mismatch === undefined).length;

    expect(agreeing, 'no sample had every path agreeing').toBeGreaterThan(30);
    expect(samples.length - agreeing, 'no sample held a mismatch').toBeGreaterThan(30);

    // The planted mismatch is not always at the first path of the first host,
    // which is what makes the "first in iteration order" clause meaningful.
    const planted = mismatches.filter((mismatch): mismatch is Mismatch => mismatch !== undefined);
    expect(
      planted.some((mismatch) => mismatch.hostIndex > 0),
      'every mismatch landed in the first host entry',
    ).toBe(true);
    expect(
      planted.some((mismatch) => mismatch.pathIndex > 0),
      'every mismatch landed at the first path of its host entry',
    ).toBe(true);
  });

  it('renders exactly when every ingress path agrees, and names the first mismatch otherwise', () => {
    fc.assert(
      fc.property(sampleArb, (sample) => {
        assertAgreementDecidesRendering(sample);
      }),
      { ...assertConfig, examples: PINNED_SAMPLES.map((sample): [Sample] => [sample]) },
    );
  });
});

describe('Base path agreement: the guard is scoped to its WHERE clause', () => {
  it('ignores a mismatch when the ingress rewrites the path away', () => {
    // Requirement 9.1 applies only while config.preservePath is true: with the
    // path rewritten to "/" before it reaches the application, the two are
    // deliberately free to differ.
    const result = renderChart({
      config: { basePath: '/scrum-poker', preservePath: false },
      ingress: { enabled: true, hosts: [{ host: '', paths: [{ path: '/' }] }] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(renderedPaths(result)).toEqual(['/']);
  });

  it('ignores a mismatch when no ingress is rendered at all', () => {
    const result = renderChart({
      config: { basePath: '/scrum-poker', preservePath: true },
      ingress: { enabled: false, hosts: [{ host: '', paths: [{ path: '/elsewhere' }] }] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      result.docs.filter((doc) => isMapping(doc) && doc['kind'] === 'Ingress'),
      'a disabled ingress renders no Ingress resource',
    ).toEqual([]);
  });
});
