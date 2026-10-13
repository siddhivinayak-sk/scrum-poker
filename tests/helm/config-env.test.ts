/**
 * Feature: helm-chart-deployment - task 7.7.
 *
 * Property 7: Application configuration round-trips from values into the
 * container environment
 *
 * *For any* `service.targetPort`, `config.nodeEnv`, `config.basePath`, and
 * `config.preservePath` values, the rendered ConfigMap holds exactly the four
 * keys `PORT`, `NODE_ENV`, `BASE_PATH`, and `PRESERVE_PATH`, each value is a
 * double-quoted string whose parsed content equals the stringified input -
 * `""` when `config.basePath` is empty, with the key still present - and the
 * rendered container carries exactly one `envFrom` entry naming that
 * ConfigMap, positioned before the `env` list, with one `env` entry per
 * `extraEnv` item carrying that item's `name` and `value`.
 *
 * **Validates: Requirements 4.2, 4.3, 4.6, 4.7**
 *
 * ### Why the ConfigMap clause reads the raw bytes
 *
 * The quoting half of the property is invisible in the parsed tree: YAML reads
 * `PORT: "3000"` and `PORT: 3000` into the string `'3000'` and the number
 * `3000`, and Kubernetes rejects the second - a ConfigMap `data` value must be
 * a string. So the `data` block is sliced out of the `helm template` stream and
 * inspected line by line, and the parsed document is used only as a cross-check
 * that the quoted text survives the round trip as a string. The same reasoning
 * applies to the `envFrom`-before-`env` clause: ordering is a property of the
 * rendered document, and both keys live in the same mapping, so the parsed
 * object cannot be relied on to preserve their relative position.
 *
 * ### Why every iteration disables the ingress
 *
 * Guard 13 couples `config.basePath` to every ingress path whenever
 * `ingress.enabled` and `config.preservePath` are both true. This property
 * varies `basePath` and `preservePath` freely and says nothing about the
 * ingress, so `ingress.enabled` is pinned to `false` throughout - the same
 * approach `configmap.test.ts` takes. Guard 13 is covered on its own elsewhere.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renderChart, type RenderResult } from './support/render-chart.js';
import { assertConfig, basePathArb } from './support/generators.js';

/** The `# Source:` paths Helm prints above each rendered chunk. */
const CONFIGMAP_SOURCE = 'scrum-poker/templates/configmap.yaml';
const DEPLOYMENT_SOURCE = 'scrum-poker/templates/deployment.yaml';

/** The four keys the ConfigMap is allowed to carry, in rendered order. */
const EXPECTED_KEYS = ['PORT', 'NODE_ENV', 'BASE_PATH', 'PRESERVE_PATH'] as const;

/** The env entry the chart always renders first (Requirements 4.7, 4.11). */
const JWT_SECRET = 'JWT_SECRET';

/** The generated half of one iteration's input. */
interface ConfigInput {
  nodeEnv: 'production' | 'development';
  basePath: string;
  preservePath: boolean;
}

interface ExtraEnvEntry {
  name: string;
  value: string;
}

/** One `data` entry as it appears in the rendered bytes, quotes included. */
interface RawDataEntry {
  key: string;
  rawValue: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The raw text of the one chunk Helm rendered from `source`.
 *
 * Helm emits one `---` separated chunk per template, each prefixed with a
 * `# Source:` comment, so a chunk is recoverable byte for byte without
 * re-serialising anything.
 */
function chunkFor(result: RenderResult, source: string, context: string): string {
  const chunks = result.stdout.split(/^---\s*$/m);
  const matching = chunks.filter((chunk) => chunk.includes(`# Source: ${source}`));
  expect(
    matching.length,
    `${context}: expected exactly one document sourced from ${source}\n${result.stdout}`,
  ).toBe(1);
  return matching[0] as string;
}

/**
 * The `data` block of the rendered ConfigMap as raw `key`/`rawValue` pairs in
 * document order.
 *
 * The block runs from the top-level `data:` line to the next line starting at
 * column zero, so a following top-level key ends it rather than being
 * swallowed. All four values are single-line scalars; anything else surfaces as
 * a line that fails the `key: value` match and is reported rather than skipped.
 */
function rawDataEntries(chunk: string, context: string): RawDataEntry[] {
  const lines = chunk.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'data:');
  expect(
    start,
    `${context}: rendered ConfigMap has no top-level data block\n${chunk}`,
  ).toBeGreaterThanOrEqual(0);

  const entries: RawDataEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ')) {
      break;
    }
    const match = /^ {2}([^\s:]+):[ ]?(.*)$/.exec(line);
    expect(
      match,
      `${context}: data block holds a line that is not a two-space indented scalar: ${line}`,
    ).not.toBeNull();
    const [, key, rawValue] = match as RegExpExecArray;
    entries.push({ key: key as string, rawValue: (rawValue as string).trimEnd() });
  }
  return entries;
}

/** Every rendered document of the given `kind`. */
function docsOfKind(docs: unknown[], kind: string): Record<string, unknown>[] {
  return docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === kind,
  );
}

/** The one rendered ConfigMap's `metadata.name` - the name `envFrom` must carry. */
function configMapName(result: RenderResult, context: string): string {
  const configMaps = docsOfKind(result.docs, 'ConfigMap');
  expect(configMaps.length, `${context}: expected exactly one rendered ConfigMap`).toBe(1);
  const metadata = (configMaps[0] as Record<string, unknown>)['metadata'];
  expect(isMapping(metadata), `${context}: ConfigMap has no metadata mapping`).toBe(true);
  const name = (metadata as Record<string, unknown>)['name'];
  expect(typeof name, `${context}: ConfigMap metadata.name is not a string`).toBe('string');
  return name as string;
}

/** The parsed `data` mapping, for the string round-trip cross-check. */
function parsedData(result: RenderResult, context: string): Record<string, unknown> {
  const configMaps = docsOfKind(result.docs, 'ConfigMap');
  expect(configMaps.length, `${context}: expected exactly one rendered ConfigMap`).toBe(1);
  const data = (configMaps[0] as Record<string, unknown>)['data'];
  expect(isMapping(data), `${context}: rendered ConfigMap data is not a mapping`).toBe(true);
  return data as Record<string, unknown>;
}

/** The single application container of the one rendered Deployment. */
function appContainer(result: RenderResult, context: string): Record<string, unknown> {
  const deployments = docsOfKind(result.docs, 'Deployment');
  expect(deployments.length, `${context}: expected exactly one rendered Deployment`).toBe(1);
  const spec = (deployments[0] as Record<string, unknown>)['spec'];
  const template = isMapping(spec) ? spec['template'] : undefined;
  const podSpec = isMapping(template) ? template['spec'] : undefined;
  const containers = isMapping(podSpec) ? podSpec['containers'] : undefined;
  expect(Array.isArray(containers), `${context}: Deployment has no containers list`).toBe(true);
  expect((containers as unknown[]).length, `${context}: expected exactly one container`).toBe(1);
  const container = (containers as unknown[])[0];
  expect(isMapping(container), `${context}: container entry is not a mapping`).toBe(true);
  return container as Record<string, unknown>;
}

/** An environment variable name the kubelet accepts. */
const envVarNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), {
      minLength: 0,
      maxLength: 16,
    }),
  )
  .map(([first, rest]) => `${first}${rest.join('')}`);

/**
 * `extraEnv` lists, empty included - an empty list is the state Requirement
 * 4.11 pins, where `env` holds the `JWT_SECRET` entry and nothing else.
 */
const extraEnvArb: fc.Arbitrary<ExtraEnvEntry[]> = fc.array(
  fc.record({ name: envVarNameArb, value: fc.string({ maxLength: 24 }) }),
  { minLength: 0, maxLength: 4 },
);

/** The two environments the schema permits for `config.nodeEnv`. */
const nodeEnvArb: fc.Arbitrary<'production' | 'development'> = fc.constantFrom(
  'production',
  'development',
);

const configArb: fc.Arbitrary<ConfigInput> = fc.record({
  nodeEnv: nodeEnvArb,
  basePath: basePathArb,
  preservePath: fc.boolean(),
});

/** Ports the schema permits, biased to the boundaries and the chart default. */
const targetPortArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(1, 80, 3000, 8080, 65_535) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 65_535 }) },
);

/** The four `data` values the given input must produce, as plain strings. */
function expectedData(
  targetPort: number,
  config: ConfigInput,
): Record<(typeof EXPECTED_KEYS)[number], string> {
  return {
    PORT: String(targetPort),
    NODE_ENV: config.nodeEnv,
    BASE_PATH: config.basePath,
    PRESERVE_PATH: config.preservePath ? 'true' : 'false',
  };
}

describe('Property 7: application configuration round-trips into the container environment', () => {
  it('carries every config value through the ConfigMap and into the container env', () => {
    fc.assert(
      fc.property(targetPortArb, configArb, extraEnvArb, (targetPort, config, extraEnv) => {
        const context =
          `targetPort ${targetPort}, nodeEnv "${config.nodeEnv}", ` +
          `basePath "${config.basePath}", preservePath ${config.preservePath}, ` +
          `${extraEnv.length} extraEnv entries`;

        const result = renderChart({
          // Guard 13 couples basePath to the ingress paths; this property is
          // not about the ingress, so it stays off.
          ingress: { enabled: false },
          service: { targetPort },
          config: { ...config },
          extraEnv,
        });

        expect(result.status, `${context}\n${result.stderr}`).toBe(0);

        const expected = expectedData(targetPort, config);

        // --- ConfigMap: exactly four keys, in order (Requirement 4.2) ---
        const configChunk = chunkFor(result, CONFIGMAP_SOURCE, context);
        const entries = rawDataEntries(configChunk, context);
        expect(entries.map((entry) => entry.key), `${context}: data keys`).toEqual([
          ...EXPECTED_KEYS,
        ]);

        const parsed = parsedData(result, context);
        expect(Object.keys(parsed).sort(), `${context}: parsed data keys`).toEqual(
          [...EXPECTED_KEYS].sort(),
        );

        for (const key of EXPECTED_KEYS) {
          const entry = entries.find((candidate) => candidate.key === key) as RawDataEntry;

          // --- Quoting (Requirement 4.3): a double-quoted scalar, nothing
          // trailing it. `""` passes; a bare 3000 or true does not. The
          // generated values hold no character quote would escape, so the
          // rendered bytes are the expected text verbatim, in quotes.
          expect(entry.rawValue, `${context}: ${key} is not a double-quoted scalar`).toMatch(
            /^"(?:[^"\\]|\\.)*"$/,
          );
          expect(entry.rawValue, `${context}: ${key} rendered value`).toBe(`"${expected[key]}"`);

          // --- And the round trip: still a string, same content. An empty
          // basePath lands here as a present key holding '' (Requirement 4.6).
          expect(typeof parsed[key], `${context}: ${key} parses as a string`).toBe('string');
          expect(parsed[key], `${context}: ${key} parsed value`).toBe(expected[key]);
        }

        // --- Deployment: exactly one envFrom configMapRef (Requirement 4.4) ---
        const container = appContainer(result, context);
        const envFrom = container['envFrom'];
        expect(Array.isArray(envFrom), `${context}: container has no envFrom list`).toBe(true);
        expect((envFrom as unknown[]).length, `${context}: envFrom entry count`).toBe(1);

        const envFromEntry = (envFrom as unknown[])[0];
        expect(isMapping(envFromEntry), `${context}: envFrom entry is not a mapping`).toBe(true);
        // Only a configMapRef - a secretRef here would leak every Secret key
        // into the container environment.
        expect(
          Object.keys(envFromEntry as Record<string, unknown>),
          `${context}: envFrom entry keys`,
        ).toEqual(['configMapRef']);

        const ref = (envFromEntry as Record<string, unknown>)['configMapRef'];
        expect(isMapping(ref), `${context}: configMapRef is not a mapping`).toBe(true);
        expect((ref as Record<string, unknown>)['name'], `${context}: configMapRef.name`).toBe(
          configMapName(result, context),
        );

        // --- env is exactly [JWT_SECRET, ...extraEnv] in order (4.7, 4.11) ---
        const env = container['env'];
        expect(Array.isArray(env), `${context}: container has no env list`).toBe(true);

        const envEntries = (env as unknown[]).map((entry) => {
          expect(isMapping(entry), `${context}: env entry is not a mapping`).toBe(true);
          return entry as Record<string, unknown>;
        });

        expect(
          envEntries.map((entry) => entry['name']),
          `${context}: env names and order`,
        ).toEqual([JWT_SECRET, ...extraEnv.map((entry) => entry.name)]);

        // The first entry is the secret reference, not a literal.
        const jwtEntry = envEntries[0] as Record<string, unknown>;
        expect(jwtEntry['value'], `${context}: JWT_SECRET injected as a literal`).toBeUndefined();
        const valueFrom = jwtEntry['valueFrom'];
        expect(isMapping(valueFrom), `${context}: JWT_SECRET has no valueFrom mapping`).toBe(true);
        expect(
          isMapping((valueFrom as Record<string, unknown>)['secretKeyRef']),
          `${context}: JWT_SECRET has no secretKeyRef`,
        ).toBe(true);

        // Each extraEnv item reaches the container with its own name and value.
        extraEnv.forEach((supplied, index) => {
          const rendered = envEntries[index + 1] as Record<string, unknown>;
          expect(rendered['name'], `${context}: extraEnv[${index}].name`).toBe(supplied.name);
          expect(rendered['value'], `${context}: extraEnv[${index}].value`).toBe(supplied.value);
          expect(
            Object.keys(rendered).sort(),
            `${context}: extraEnv[${index}] keys`,
          ).toEqual(['name', 'value']);
        });

        // --- Ordering: envFrom precedes env, so a matching extraEnv name wins
        // (Requirement 4.7). Asserted on the rendered bytes, because both keys
        // sit in one mapping and the parsed object carries no position.
        const deploymentChunk = chunkFor(result, DEPLOYMENT_SOURCE, context);
        const deploymentLines = deploymentChunk.split(/\r?\n/);
        const envFromLine = deploymentLines.findIndex((line) => /^\s+envFrom:\s*$/.test(line));
        const envLine = deploymentLines.findIndex((line) => /^\s+env:\s*$/.test(line));
        expect(
          envFromLine,
          `${context}: no envFrom key in the rendered Deployment\n${deploymentChunk}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          envLine,
          `${context}: no env key in the rendered Deployment\n${deploymentChunk}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          envFromLine < envLine,
          `${context}: envFrom (line ${envFromLine}) must precede env (line ${envLine})`,
        ).toBe(true);
      }),
      {
        ...assertConfig,
        examples: [
          // The chart defaults, and no extraEnv: env holds JWT_SECRET alone.
          [3000, { nodeEnv: 'production', basePath: '/scrum-poker', preservePath: true }, []],
          // Requirement 4.6: an empty base path keeps the key, value "".
          [3000, { nodeEnv: 'production', basePath: '', preservePath: true }, []],
          // The cluster root, spelled explicitly.
          [3000, { nodeEnv: 'development', basePath: '/', preservePath: false }, []],
          // Port boundaries, which must render as quoted decimal digits.
          [1, { nodeEnv: 'production', basePath: '/a/b', preservePath: true }, []],
          [
            65_535,
            { nodeEnv: 'development', basePath: '/scrum-poker', preservePath: false },
            [{ name: 'LOG_LEVEL', value: 'debug' }],
          ],
          // An extraEnv name colliding with a ConfigMap key: it must still land
          // in env, after the envFrom reference, so the kubelet lets it win.
          [
            8080,
            { nodeEnv: 'production', basePath: '/scrum-poker', preservePath: true },
            [{ name: 'NODE_ENV', value: 'development' }],
          ],
          // Values YAML could mangle without correct quoting, and order with
          // more than one entry.
          [
            3000,
            { nodeEnv: 'production', basePath: '/app', preservePath: true },
            [
              { name: 'A_TRUE', value: 'true' },
              { name: 'B_NUM', value: '010' },
              { name: 'C_EMPTY', value: '' },
              { name: 'D_COLON', value: 'key: value' },
            ],
          ],
          // The schema's 64-character ceiling on config.basePath.
          [
            3000,
            { nodeEnv: 'production', basePath: `/${'a'.repeat(63)}`, preservePath: false },
            [],
          ],
        ],
      },
    );
  });
});
