/**
 * Feature: helm-chart-deployment - task 10.3.
 *
 * Property 12: Operator ingress annotations take precedence over computed ones
 *
 * *For any* `ingress.annotations` map, *any* `ingress.websocket.affinity`
 * value, and *any* `config.preservePath` value, every key/value pair supplied
 * in `ingress.annotations` appears verbatim in the rendered Ingress
 * annotations; every computed annotation whose key was not supplied appears
 * with its computed value; and
 * `nginx.ingress.kubernetes.io/rewrite-target` is absent whenever
 * `config.preservePath` is `true` and the operator did not supply that key.
 *
 * **Validates: Requirements 8.11, 8.13**
 *
 * ### What the chart actually does, and where it can go wrong
 *
 * `templates/ingress.yaml` collects the computed annotations into a dict and
 * then merges the operator's map *over* them:
 *
 *   $ann = merge (deepCopy (.Values.ingress.annotations | default dict)) $ann
 *
 * `merge dst src` is meant to leave `dst` keys intact, so putting
 * `ingress.annotations` in the `dst` position is what makes an operator key
 * win. Three things can break that and each drives an input class below:
 *
 *   - **Merge direction.** Swap the two arguments and every computed key
 *     silently overwrites the operator's. So the generator does not *hope* for
 *     a key collision: it deliberately supplies a subset of the computed keys
 *     on every run, with values distinguishable from the computed ones.
 *   - **Conditional keys.** `affinity` and `session-cookie-name` exist only
 *     when `ingress.websocket.affinity` is true, and `rewrite-target` only
 *     when `config.preservePath` is false. Both flags are generated, so each
 *     computed key is exercised in both its present and absent state - which
 *     is the whole of criterion 8.13.
 *   - **The chart's own defaults.** `proxy-read-timeout` and
 *     `proxy-send-timeout` live in `ingress.annotations` in `values.yaml`, not
 *     in the computed dict. They reach the template through Helm's own values
 *     merge, so they are in the `dst` map alongside anything the operator
 *     supplied and must survive the template's merge untouched - unless the
 *     operator overrode them, in which case the operator's value is the one
 *     that has to survive.
 *
 * ### Why the expectation is computed from `withDefaults`
 *
 * Helm merges a `-f` file over `values.yaml` key by key, so the map the
 * template sees in `.Values.ingress.annotations` is *not* the patch this test
 * supplies: it is that patch over the chart's two default timeout entries.
 * `withDefaults` applies the same merge, so the expected "operator half" of
 * the annotation map is derived from the chart file rather than restated here,
 * and a change to the committed defaults cannot leave this test asserting
 * against a stale copy of them.
 *
 * ### Why the raw text is read as well as the parsed document
 *
 * Two of the obligations here are invisible to a YAML parser. Key order is
 * erased by parsing, and so is quoting - and quoting is load-bearing, because
 * an annotation value is a string in the Kubernetes API while a bare `3600`,
 * `true`, or `no` is resolved by a YAML 1.1 parser to a number or a boolean
 * that the API server then rejects. Both are therefore asserted against the
 * `# Source:`-prefixed ingress chunk of the `helm template` stream, while
 * values and the exact key set are asserted against the parsed document.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  annotationMapArb,
  assertConfig,
  COMPUTED_INGRESS_ANNOTATION_KEYS,
} from './support/generators.js';
import { renderChart, withDefaults, type RenderResult } from './support/render-chart.js';

const AFFINITY_KEY = 'nginx.ingress.kubernetes.io/affinity';
const COOKIE_NAME_KEY = 'nginx.ingress.kubernetes.io/session-cookie-name';
const REWRITE_TARGET_KEY = 'nginx.ingress.kubernetes.io/rewrite-target';
const PROXY_READ_TIMEOUT_KEY = 'nginx.ingress.kubernetes.io/proxy-read-timeout';
const PROXY_SEND_TIMEOUT_KEY = 'nginx.ingress.kubernetes.io/proxy-send-timeout';

/** The two annotations `values.yaml` ships, and the value both carry. */
const CHART_DEFAULT_TIMEOUT_KEYS = [PROXY_READ_TIMEOUT_KEY, PROXY_SEND_TIMEOUT_KEY] as const;
const CHART_DEFAULT_TIMEOUT = '3600';

/** Values the template computes, as literals (criteria 8.8 and 8.10). */
const COMPUTED_AFFINITY_VALUE = 'cookie';
const COMPUTED_REWRITE_TARGET_VALUE = '/';

/** `# Source:` path Helm prints above the ingress chunk of the stream. */
const INGRESS_SOURCE = '# Source: scrum-poker/templates/ingress.yaml';

/**
 * One rendered `metadata.annotations` entry, as it appears in the stream:
 * four spaces, a plain key, `: `, then a double-quoted value. Helm's `quote`
 * is `%q`, so even a value holding a newline stays on one line as an escape.
 * A generated annotation key never holds a colon, so the lazy key group
 * cannot swallow the separator.
 */
const ANNOTATION_LINE = /^ {4}(?<key>[^:]+): (?<value>.*)$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, dottedPath: string): unknown {
  let cursor: unknown = root;
  for (const segment of dottedPath.split('.')) {
    if (!isMapping(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/** Go sorts map keys bytewise over UTF-8, which is what `range` iterates in. */
function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * The rendered `metadata.annotations` mapping, or an empty one when the field
 * was omitted. Annotation keys hold dots, so they are never reachable through
 * `getPath` - the mapping is fetched and then indexed directly.
 */
function annotationsOf(ingress: Record<string, unknown>): Record<string, unknown> {
  const annotations = getPath(ingress, 'metadata.annotations');
  return isMapping(annotations) ? annotations : {};
}

/** The single rendered Ingress, with the "exactly one" check applied. */
function soleIngress(result: RenderResult, context: string): Record<string, unknown> {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);
  const docs = result.docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === 'Ingress',
  );
  expect(docs.length, `${context}: expected exactly one Ingress`).toBe(1);
  return docs[0] as Record<string, unknown>;
}

/** The ingress document's text, sliced out of the `helm template` stream. */
function ingressChunk(stdout: string, context: string): string {
  const start = stdout.indexOf(INGRESS_SOURCE);
  expect(start, `${context}: the stream holds no ingress chunk`).toBeGreaterThanOrEqual(0);
  const rest = stdout.slice(start);
  const end = rest.indexOf('\n---');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The raw `metadata.annotations` entry lines of the ingress chunk, in rendered
 * order, or `undefined` when the template emitted no annotations block at all.
 *
 * `metadata.annotations` is the only two-space `annotations:` key in the
 * document, and the `range` body emits its entries with no blank line between
 * them, so the block is the contiguous run of four-space lines that follows.
 */
function rawAnnotationLines(chunk: string): string[] | undefined {
  const lines = chunk.split('\n').map((line) => line.replace(/\r$/, ''));
  const header = lines.indexOf('  annotations:');
  if (header === -1) {
    return undefined;
  }
  const entries: string[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!/^ {4}\S/.test(line)) {
      break;
    }
    entries.push(line);
  }
  return entries;
}

/**
 * Assert the rendered block's shape - every value double-quoted, keys in
 * bytewise order - and return the keys in rendered order.
 */
function assertBlockShapeAndOrder(chunk: string, context: string): string[] {
  const lines = rawAnnotationLines(chunk) ?? [];
  const keys: string[] = [];
  for (const line of lines) {
    const match = ANNOTATION_LINE.exec(line);
    expect(match, `${context}: unparseable annotation line ${JSON.stringify(line)}`).not.toBeNull();
    const groups = (match as RegExpExecArray).groups as { key: string; value: string };
    expect(
      /^".*"$/.test(groups.value),
      `${context}: annotation ${JSON.stringify(groups.key)} rendered the unquoted scalar ` +
        `${JSON.stringify(groups.value)}; a bare 3600, true, or no is resolved by YAML 1.1 to a ` +
        'number or a boolean the API server rejects',
    ).toBe(true);
    keys.push(groups.key);
  }

  expect(keys, `${context}: annotation keys are not in bytewise sorted order`).toEqual(
    [...keys].sort(byteCompare),
  );
  return keys;
}

interface AnnotationSample {
  /** Free-form operator annotations, including awkward keys and values. */
  background: Record<string, string>;
  /** Deliberate collisions with the keys the template computes. */
  overrides: Partial<Record<(typeof COMPUTED_INGRESS_ANNOTATION_KEYS)[number], string>>;
  affinity: boolean;
  /** Empty exercises the `scrum-poker.fullname` fallback (criterion 8.8). */
  cookieName: string;
  preservePath: boolean;
}

/**
 * Override values chosen to be distinguishable from every computed value, so
 * "the operator's value survived" and "the computed value survived" can never
 * be confused. The empty string is in the space because an empty annotation
 * value is legal in the Kubernetes API, and because sprig's `merge` treats an
 * empty destination value as absent - exactly the case where a merge-based
 * precedence rule can silently lose the operator's entry.
 */
const overrideValueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('sticky', 'off', 'no', '7200', '/$1', '/app/$2') },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 12 }) },
  { weight: 1, arbitrary: fc.constant('') },
);

/** An arbitrary subset of the computed keys, each with an operator value. */
const overridesArb: fc.Arbitrary<AnnotationSample['overrides']> = fc.record(
  {
    [AFFINITY_KEY]: overrideValueArb,
    [COOKIE_NAME_KEY]: overrideValueArb,
    [REWRITE_TARGET_KEY]: overrideValueArb,
    [PROXY_READ_TIMEOUT_KEY]: overrideValueArb,
    [PROXY_SEND_TIMEOUT_KEY]: overrideValueArb,
  },
  { requiredKeys: [] },
);

const sampleArb: fc.Arbitrary<AnnotationSample> = fc.record({
  background: annotationMapArb,
  overrides: overridesArb,
  affinity: fc.boolean(),
  cookieName: fc.oneof(fc.constant(''), fc.constantFrom('poker-affinity', 'sticky-cookie')),
  preservePath: fc.boolean(),
});

/**
 * The values patch for a sample. `ingress.hosts` and `config.basePath` are
 * left at the committed defaults, which already agree (`/scrum-poker`), so
 * guard 13 stays satisfied in the `preservePath: true` half of the space while
 * this property varies only what it is about.
 */
function valuesFor(sample: AnnotationSample): Record<string, unknown> {
  return {
    config: { preservePath: sample.preservePath },
    ingress: {
      enabled: true,
      annotations: { ...sample.background, ...sample.overrides },
      websocket: { affinity: sample.affinity, cookieName: sample.cookieName },
    },
  };
}

/**
 * The map the template sees in `.Values.ingress.annotations`: the patch merged
 * over the chart's defaults, the way Helm merges a `-f` file.
 */
function effectiveOperatorAnnotations(sample: AnnotationSample): Record<string, string> {
  const resolved = getPath(withDefaults(valuesFor(sample)), 'ingress.annotations');
  expect(isMapping(resolved), 'ingress.annotations resolved to a non-mapping').toBe(true);
  return resolved as Record<string, string>;
}

/** The annotations the template computes for a sample (criteria 8.8, 8.10). */
function computedAnnotations(sample: AnnotationSample, fullname: string): Record<string, string> {
  const computed: Record<string, string> = {};
  if (sample.affinity) {
    computed[AFFINITY_KEY] = COMPUTED_AFFINITY_VALUE;
    computed[COOKIE_NAME_KEY] = sample.cookieName === '' ? fullname : sample.cookieName;
  }
  if (!sample.preservePath) {
    computed[REWRITE_TARGET_KEY] = COMPUTED_REWRITE_TARGET_VALUE;
  }
  return computed;
}

/** Render one sample and assert every clause of Property 12 against it. */
function assertAnnotationPrecedence(sample: AnnotationSample, context: string): void {
  const result = renderChart(valuesFor(sample));
  const ingress = soleIngress(result, context);

  const fullname = getPath(ingress, 'metadata.name');
  expect(typeof fullname, `${context}: Ingress name is not a string`).toBe('string');

  const operator = effectiveOperatorAnnotations(sample);
  const computed = computedAnnotations(sample, fullname as string);
  const renderedMap = annotationsOf(ingress);

  // Requirement 8.11, first clause: every supplied pair appears verbatim, and
  // for a key the template also computes, the operator's value is the one that
  // survives.
  for (const [key, value] of Object.entries(operator)) {
    const collides = Object.hasOwn(computed, key);
    expect(
      renderedMap[key],
      collides
        ? `${context}: operator annotation ${JSON.stringify(key)} lost to the computed value ` +
          `${JSON.stringify(computed[key])}`
        : `${context}: operator annotation ${JSON.stringify(key)} did not survive`,
    ).toBe(value);
  }

  // Requirement 8.11, second clause: a computed key the operator did not
  // supply keeps its computed value.
  for (const [key, value] of Object.entries(computed)) {
    if (!Object.hasOwn(operator, key)) {
      expect(renderedMap[key], `${context}: computed annotation ${JSON.stringify(key)}`).toBe(
        value,
      );
    }
  }

  // Requirement 8.13: with the full path forwarded, rewrite-target exists only
  // because an operator asked for it.
  if (sample.preservePath && !Object.hasOwn(operator, REWRITE_TARGET_KEY)) {
    expect(
      renderedMap[REWRITE_TARGET_KEY],
      `${context}: rewrite-target must be absent when preservePath is true and the operator ` +
        'did not supply it, otherwise the ingress strips the base path the application expects',
    ).toBeUndefined();
  }

  // Requirement 8.7: the chart's own timeout defaults are in the merge's
  // destination map and survive it, unless the operator replaced them.
  for (const key of CHART_DEFAULT_TIMEOUT_KEYS) {
    if (!Object.hasOwn(sample.background, key) && !Object.hasOwn(sample.overrides, key)) {
      expect(
        renderedMap[key],
        `${context}: the chart default ${JSON.stringify(key)} did not survive the merge`,
      ).toBe(CHART_DEFAULT_TIMEOUT);
    }
  }

  // Nothing beyond the union, so the merge invents no key and drops none.
  expect(renderedMap, `${context}: rendered annotation map`).toEqual({ ...computed, ...operator });

  // Quoting and key order, which parsing erases.
  const keys = assertBlockShapeAndOrder(ingressChunk(result.stdout, context), context);
  expect(keys, `${context}: rendered key set`).toEqual(Object.keys(renderedMap).sort(byteCompare));
}

/**
 * A pinned sample holding every corner at once: affinity on with an empty
 * cookie name (so the fullname fallback is computed and then overridden
 * anyway), an operator rewrite-target while `preservePath` is true, an
 * overridden and a defaulted proxy timeout, and background values holding a
 * colon, a comma, a newline, and a `$1` that nginx would treat as a capture
 * reference.
 */
const PINNED_SAMPLE: AnnotationSample = {
  background: {
    'example.com/colon': 'key: value',
    'example.com/list': 'a,b,c',
    'example.com/multiline': 'line1\nline2',
    'example.com/numeric': '3600',
    'example.com/boolean': 'no',
  },
  overrides: {
    [AFFINITY_KEY]: 'sticky',
    [COOKIE_NAME_KEY]: 'operator-cookie',
    [REWRITE_TARGET_KEY]: '/$1',
    [PROXY_READ_TIMEOUT_KEY]: '7200',
  },
  affinity: true,
  cookieName: '',
  preservePath: true,
};

describe('Property 12: operator ingress annotations take precedence over computed ones', () => {
  it('covers every annotation key the template computes', () => {
    // Ties the deliberate-collision generator to the shared constant, so a new
    // computed key added to the chart cannot slip past this property silently.
    expect([...COMPUTED_INGRESS_ANNOTATION_KEYS].sort()).toEqual(
      [
        AFFINITY_KEY,
        COOKIE_NAME_KEY,
        REWRITE_TARGET_KEY,
        PROXY_READ_TIMEOUT_KEY,
        PROXY_SEND_TIMEOUT_KEY,
      ].sort(),
    );
  });

  it('lets an operator entry replace the computed annotation holding the same key', () => {
    fc.assert(
      fc.property(sampleArb, (sample) => {
        assertAnnotationPrecedence(sample, `sample ${JSON.stringify(sample)}`);
      }),
      { ...assertConfig, examples: [[PINNED_SAMPLE]] },
    );
  });
});

describe('Ingress annotations: pinned cases', () => {
  it('omits rewrite-target for the committed defaults, which preserve the path', () => {
    const result = renderChart({});
    const ingress = soleIngress(result, 'committed defaults');

    expect(annotationsOf(ingress)).toEqual({
      [PROXY_READ_TIMEOUT_KEY]: CHART_DEFAULT_TIMEOUT,
      [PROXY_SEND_TIMEOUT_KEY]: CHART_DEFAULT_TIMEOUT,
    });
  });

  it('computes rewrite-target only when the path is not preserved', () => {
    const stripped = soleIngress(
      renderChart({ config: { preservePath: false } }),
      'preservePath false',
    );

    expect(annotationsOf(stripped)[REWRITE_TARGET_KEY]).toBe(COMPUTED_REWRITE_TARGET_VALUE);
  });

  it('keeps an operator rewrite-target while the path is preserved (Requirement 8.13)', () => {
    const ingress = soleIngress(
      renderChart({
        config: { preservePath: true },
        ingress: { enabled: true, annotations: { [REWRITE_TARGET_KEY]: '/$1' } },
      }),
      'operator rewrite-target',
    );

    expect(
      annotationsOf(ingress)[REWRITE_TARGET_KEY],
      'the only way this key may appear under preservePath is because an operator asked for it',
    ).toBe('/$1');
  });

  it('substitutes the fullname for an empty cookie name (Requirement 8.8)', () => {
    const ingress = soleIngress(
      renderChart({ ingress: { enabled: true, websocket: { affinity: true, cookieName: '' } } }),
      'empty cookie name',
    );
    const fullname = getPath(ingress, 'metadata.name');
    const annotations = annotationsOf(ingress);

    expect(annotations[AFFINITY_KEY]).toBe(COMPUTED_AFFINITY_VALUE);
    expect(annotations[COOKIE_NAME_KEY]).toBe(fullname);
  });

  it('renders a byte-identical annotation block across two renders', () => {
    const values = valuesFor(PINNED_SAMPLE);
    const first = renderChart(values);
    const second = renderChart(values);
    soleIngress(first, 'first render');
    soleIngress(second, 'second render');

    const firstBlock = rawAnnotationLines(ingressChunk(first.stdout, 'first render'));
    const secondBlock = rawAnnotationLines(ingressChunk(second.stdout, 'second render'));

    expect(firstBlock, 'the annotation block is not byte-stable across renders').toEqual(
      secondBlock,
    );
    expect(firstBlock?.length, 'the pinned sample renders a populated block').toBeGreaterThan(0);
  });

  it('omits the annotations block when nothing is supplied and nothing is computed', () => {
    // `default dict` covers an operator who nulls the whole mapping out; with
    // affinity off and the path preserved the computed dict is empty too, so
    // the `if $ann` guard must omit the field rather than render `{}`.
    const result = renderChart({
      config: { preservePath: true },
      ingress: { enabled: true, annotations: null },
    });
    const ingress = soleIngress(result, 'nulled annotations');

    expect(getPath(ingress, 'metadata'), 'metadata still renders').toBeTruthy();
    expect(annotationsOf(ingress), 'no annotations field renders at all').toEqual({});
    expect(rawAnnotationLines(ingressChunk(result.stdout, 'nulled annotations'))).toBeUndefined();
  });
});
