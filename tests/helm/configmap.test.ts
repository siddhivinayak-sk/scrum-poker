/**
 * Feature: helm-chart-deployment - task 3.2.
 *
 * Deterministic unit tests for `templates/configmap.yaml`:
 *
 * - exactly four `data` keys, no more and no fewer,
 * - every rendered value enclosed in double quotes,
 * - `BASE_PATH` present with the value `""` when `config.basePath` is empty.
 *
 * **Validates: Requirements 4.2, 4.3, 4.6**
 *
 * ### Why these assertions read the raw bytes
 *
 * The quoting requirement cannot be checked against the parsed tree. YAML
 * parses `PORT: "3000"` and `PORT: 3000` into the string `'3000'` and the
 * number `3000`, and a parser that coerces - or a reader that stringifies -
 * erases the distinction the API server actually enforces: Kubernetes rejects
 * a ConfigMap whose `data` value is not a string, and `server.ts` compares
 * `PRESERVE_PATH` against the string `'true'`. So the `data` block is sliced
 * out of the raw `helm template` output and inspected line by line, and the
 * parsed document is used only as a cross-check that the quoted text survives
 * a round trip as a string.
 *
 * Every case that moves `config.basePath` also disables the ingress. Guard 13
 * couples `config.basePath` to the ingress paths whenever `ingress.enabled`
 * and `config.preservePath` are both true, and these tests are about the
 * ConfigMap, not about that guard - `tests/helm` covers guard 13 separately.
 */
import { describe, expect, it } from 'vitest';
import { renderChart } from './support/render-chart.js';

/** The `# Source:` path Helm prints above the ConfigMap chunk. */
const CONFIGMAP_SOURCE = 'scrum-poker/templates/configmap.yaml';

/** The four keys the ConfigMap is allowed to carry, in rendered order. */
const EXPECTED_KEYS = ['PORT', 'NODE_ENV', 'BASE_PATH', 'PRESERVE_PATH'] as const;

/** One `data` entry as it appears in the rendered bytes. */
interface RawDataEntry {
  key: string;
  /** The text to the right of `key:`, untouched - quotes included. */
  rawValue: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The raw text of the document Helm rendered from `configmap.yaml`.
 *
 * Helm emits one `---` separated chunk per template, each prefixed with a
 * `# Source:` comment, so the chunk can be recovered byte for byte from the
 * stream without re-serialising anything.
 */
function configMapChunk(stdout: string): string {
  const chunks = stdout.split(/^---\s*$/m);
  const matching = chunks.filter((chunk) => chunk.includes(`# Source: ${CONFIGMAP_SOURCE}`));
  expect(
    matching.length,
    `expected exactly one document sourced from ${CONFIGMAP_SOURCE}\n--- output ---\n${stdout}`,
  ).toBe(1);
  return matching[0] as string;
}

/**
 * The `data` block of the rendered ConfigMap, as raw `key`/`rawValue` pairs in
 * document order.
 *
 * The block runs from the top-level `data:` line to the next line that starts
 * at column zero, so a trailing top-level key would end it rather than being
 * swallowed. A nested or block-scalar value is not expected here - all four
 * values are single-line scalars - and would surface as a line that fails the
 * `key: value` match below, which is reported rather than skipped.
 */
function rawDataEntries(chunk: string): RawDataEntry[] {
  const lines = chunk.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'data:');
  expect(start, `rendered ConfigMap has no top-level data block\n${chunk}`).toBeGreaterThanOrEqual(
    0,
  );

  const entries: RawDataEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ')) {
      break;
    }
    const match = /^ {2}([^\s:]+):[ ]?(.*)$/.exec(line);
    expect(match, `data block holds a line that is not a two-space indented scalar: ${line}`)
      .not.toBeNull();
    const [, key, rawValue] = match as RegExpExecArray;
    entries.push({ key: key as string, rawValue: (rawValue as string).trimEnd() });
  }
  return entries;
}

/** The parsed `data` mapping, for the string round-trip cross-check. */
function parsedData(docs: unknown[]): Record<string, unknown> {
  const configMaps = docs.filter((doc) => isMapping(doc) && doc['kind'] === 'ConfigMap');
  expect(configMaps.length, 'expected exactly one rendered ConfigMap').toBe(1);
  const data = (configMaps[0] as Record<string, unknown>)['data'];
  expect(isMapping(data), 'rendered ConfigMap data is not a mapping').toBe(true);
  return data as Record<string, unknown>;
}

/** Values patch plus the four `data` values it should produce. */
interface Case {
  name: string;
  values: Record<string, unknown>;
  expected: Record<(typeof EXPECTED_KEYS)[number], string>;
}

/** Disables the ingress, so guard 13 stays out of a base-path case. */
const noIngress = { ingress: { enabled: false } };

const cases: Case[] = [
  {
    name: 'chart defaults',
    values: {},
    expected: {
      PORT: '3000',
      NODE_ENV: 'production',
      BASE_PATH: '/scrum-poker',
      PRESERVE_PATH: 'true',
    },
  },
  {
    name: 'an empty config.basePath',
    values: { ...noIngress, config: { basePath: '' } },
    expected: {
      PORT: '3000',
      NODE_ENV: 'production',
      BASE_PATH: '',
      PRESERVE_PATH: 'true',
    },
  },
  {
    name: 'config.basePath at the cluster root',
    values: { ...noIngress, config: { basePath: '/' } },
    expected: {
      PORT: '3000',
      NODE_ENV: 'production',
      BASE_PATH: '/',
      PRESERVE_PATH: 'true',
    },
  },
  {
    name: 'config.preservePath false',
    values: { config: { preservePath: false } },
    expected: {
      PORT: '3000',
      NODE_ENV: 'production',
      BASE_PATH: '/scrum-poker',
      PRESERVE_PATH: 'false',
    },
  },
  {
    name: 'a development environment on a non-default port',
    values: {
      ...noIngress,
      service: { targetPort: 8080 },
      config: { nodeEnv: 'development', basePath: '/a/b' },
    },
    expected: {
      PORT: '8080',
      NODE_ENV: 'development',
      BASE_PATH: '/a/b',
      PRESERVE_PATH: 'true',
    },
  },
];

describe('ConfigMap data keys and value quoting', () => {
  for (const testCase of cases) {
    describe(testCase.name, () => {
      const result = renderChart(testCase.values);

      it('renders exactly the four expected keys, in order', () => {
        expect(result.status, result.stderr).toBe(0);

        const entries = rawDataEntries(configMapChunk(result.stdout));

        expect(entries.map((entry) => entry.key)).toEqual([...EXPECTED_KEYS]);
        expect(Object.keys(parsedData(result.docs)).sort()).toEqual([...EXPECTED_KEYS].sort());
      });

      it('encloses every value in double quotes', () => {
        expect(result.status, result.stderr).toBe(0);

        const entries = rawDataEntries(configMapChunk(result.stdout));

        for (const entry of entries) {
          // Double-quoted, and nothing trailing it. `""` is the empty-value
          // form and passes; a bare `3000`, a `true`, or a single-quoted
          // `'true'` does not.
          expect(entry.rawValue, `${entry.key} is not a double-quoted scalar`).toMatch(
            /^"(?:[^"\\]|\\.)*"$/,
          );
        }
      });

      it('carries the expected value for each key', () => {
        expect(result.status, result.stderr).toBe(0);

        const entries = rawDataEntries(configMapChunk(result.stdout));
        const parsed = parsedData(result.docs);

        for (const key of EXPECTED_KEYS) {
          const entry = entries.find((candidate) => candidate.key === key) as RawDataEntry;
          const expected = testCase.expected[key];

          // The rendered bytes: the expected text, quoted.
          expect(entry.rawValue, `${key} rendered value`).toBe(`"${expected}"`);
          // And the round trip: still a string, with the same content.
          expect(typeof parsed[key], `${key} parses as a string`).toBe('string');
          expect(parsed[key], `${key} parsed value`).toBe(expected);
        }
      });
    });
  }
});

describe('Requirement 4.6: an empty base path keeps the key', () => {
  const result = renderChart({ ...noIngress, config: { basePath: '' } });

  it('renders BASE_PATH as a present, empty, quoted value rather than omitting it', () => {
    expect(result.status, result.stderr).toBe(0);

    const chunk = configMapChunk(result.stdout);
    const entries = rawDataEntries(chunk);
    const basePath = entries.find((entry) => entry.key === 'BASE_PATH');

    expect(basePath, `BASE_PATH is absent from the data block\n${chunk}`).toBeDefined();
    expect((basePath as RawDataEntry).rawValue).toBe('""');
    // Not `BASE_PATH:` with nothing after it, and not `null` - both of which
    // the API server rejects, and neither of which `server.ts` reads as an
    // empty prefix.
    expect(chunk).toContain('BASE_PATH: ""');
    expect(parsedData(result.docs)['BASE_PATH']).toBe('');
    // The key count is unchanged by the empty value.
    expect(entries).toHaveLength(EXPECTED_KEYS.length);
  });
});
