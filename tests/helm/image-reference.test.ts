/**
 * Feature: helm-chart-deployment - task 7.6.
 *
 * Property 4: The image reference is the exact concatenation of repository,
 * colon, and resolved tag
 *
 * *For any* `image.repository` value and *any* `image.tag` value, the rendered
 * container `image` equals `image.repository` + `:` + `image.tag` when
 * `image.tag` is non-empty, and equals `image.repository` + `:` +
 * `Chart.appVersion` when `image.tag` is empty or absent, with no additional
 * characters in either case.
 *
 * **Validates: Requirements 2.4, 2.15**
 *
 * ### What "no additional characters" is worth testing against
 *
 * The template renders
 * `printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) | quote`.
 * Three distinct things can corrupt that string, and each gets its own input
 * class below:
 *
 *   - **Quoting.** A repository or tag holding `"`, `\`, or a leading or
 *     trailing space must survive `quote` and the YAML round-trip byte for
 *     byte, with no escape residue and nothing trimmed.
 *   - **Type loss.** A tag such as `y`, `no`, `on`, `true`, `010`, `1e3`, or
 *     `~` is a plain YAML 1.1 scalar that resolves to a boolean, an integer, or
 *     null. If either the harness or the template dropped a pair of quotes the
 *     tag would arrive as `false` or `8` rather than as itself.
 *   - **Emptiness.** `default` treats only the empty string as empty, so a tag
 *     of `0` or `false` must be kept, not replaced by `Chart.appVersion`.
 *
 * ### Why `appVersion` needs a chart copy
 *
 * `appVersion` is chart metadata, not a value, so it cannot be supplied through
 * `-f`. The second clause therefore copies the chart to a temporary directory
 * and rewrites the copy's `Chart.yaml`, the same approach `name-bounds.test.ts`
 * takes. Nothing under `helm/scrum-poker/` is written to.
 *
 * ### The two ways a tag can be unsupplied
 *
 * The chart's own `values.yaml` declares `image.tag: ""`, so an operator who
 * supplies nothing still gets the empty-string branch. The genuinely absent
 * case is reachable two ways, and both are covered: `image.tag: null` in the
 * values file, which Helm resolves as deleting the chart default, and a chart
 * copy whose `values.yaml` omits the key altogether - the only route that
 * leaves `.Values.image.tag` nil rather than empty.
 *
 * An empty `appVersion` is excluded from the input space: it would render the
 * degenerate `repository:` that Requirement 2.15 literally prescribes, but
 * Requirement 1.5 requires the chart to declare a non-empty `appVersion`, so
 * that combination describes a broken chart rather than a rendering defect.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments, stringify } from 'yaml';
import {
  chartDir,
  defaultNamespace,
  helmBinary,
  loadDefaultValues,
  renderChart,
  stringifyValues,
  valuesStringifyOptions,
  type RenderResult,
} from './support/render-chart.js';
import { assertConfig } from './support/generators.js';

/** The one container the Deployment declares (Requirement 2.3). */
const CONTAINER_NAME = 'scrum-poker';

/** `image.repository` ceiling the values schema declares (Requirement 11.2). */
const MAX_REPOSITORY_LENGTH = 253;

/** `image.tag` ceiling the values schema declares (Requirement 11.2). */
const MAX_TAG_LENGTH = 128;

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const TAG_FIRST = [...LOWER_ALNUM, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')];
const TAG_INNER = [...TAG_FIRST, '.', '-'];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A single `a-z0-9`-bounded path segment, the shape a repository path uses. */
const repositorySegmentArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...LOWER_ALNUM),
    fc.array(fc.constantFrom(...LOWER_ALNUM, '-', '.', '_'), { maxLength: 10 }),
    fc.constantFrom(...LOWER_ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

const hostLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...LOWER_ALNUM),
    fc.array(fc.constantFrom(...LOWER_ALNUM, '-'), { maxLength: 8 }),
    fc.constantFrom(...LOWER_ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

/**
 * A registry host, half the time carrying a `:port`. The port matters: a
 * repository that already holds a colon is the input class a naive
 * "split on the last colon" reading of the image reference would mangle.
 */
const registryArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(hostLabelArb, { minLength: 2, maxLength: 3 }).map((labels) => labels.join('.')),
    fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: undefined }),
  )
  .map(([host, port]) => (port === undefined ? host : `${host}:${port}`));

/**
 * Repository values. The schema constrains this to a string of 1-253
 * characters and declares no pattern, so the awkward class below stays inside
 * the schema while exercising quoting and YAML type resolution.
 */
const repositoryArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .array(repositorySegmentArb, { minLength: 1, maxLength: 3 })
      .map((segments) => segments.join('/'))
      .filter((value) => value.length <= MAX_REPOSITORY_LENGTH),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(registryArb, fc.array(repositorySegmentArb, { minLength: 1, maxLength: 2 }))
      .map(([registry, segments]) => `${registry}/${segments.join('/')}`)
      .filter((value) => value.length <= MAX_REPOSITORY_LENGTH),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      // YAML 1.1 plain scalars that resolve to something other than a string.
      'y',
      'no',
      'true',
      '010',
      // Characters `quote` has to escape, and whitespace nothing may trim.
      'repo"with"quotes',
      'repo\\with\\backslash',
      ' leading-space',
      'trailing-space ',
      'repo with spaces',
      // The declared length ceiling.
      'r'.repeat(MAX_REPOSITORY_LENGTH),
    ),
  },
);

/**
 * Non-empty tags - the Requirement 2.4 branch. `0` and `false` are included
 * deliberately: Go's `default` treats only the empty string as empty, so both
 * must reach the manifest rather than falling back to `Chart.appVersion`.
 */
const nonEmptyTagArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...TAG_FIRST),
        fc.array(fc.constantFrom(...TAG_INNER), { maxLength: 20 }),
      )
      .map(([first, rest]) => `${first}${rest.join('')}`),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'latest',
      '1',
      '1.2.3',
      'v2.0.0',
      'v2.0.0-rc.1',
      '2024.05.1',
      'sha-abc1234',
      'main',
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      // Plain scalars a lost pair of quotes would turn into a non-string.
      'y',
      'Y',
      'n',
      'no',
      'on',
      'off',
      'true',
      'false',
      'null',
      '~',
      '010',
      '1e3',
      '1_000',
      // Non-empty but falsy-looking: `default` must still keep these.
      '0',
      // Quoting and whitespace.
      'tag"quote',
      'tag\\slash',
      'tag with space',
      ' leading',
      'trailing ',
      // The declared length ceiling.
      't'.repeat(MAX_TAG_LENGTH),
    ),
  },
);

/**
 * Chart `appVersion` values - the resolved tag for the Requirement 2.15
 * branch. Kept non-empty, and kept to values that are legal as an image tag,
 * since that is what the metadata field means here.
 */
const appVersionArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'latest',
      '1',
      '1.2',
      '1.2.3',
      'v2.0.0',
      'v2.0.0-rc.1',
      '2024.05.1',
      'sha-abc1234',
      'main',
      'true',
      'y',
      '010',
    ),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...TAG_FIRST),
        fc.array(fc.constantFrom(...TAG_INNER), { maxLength: 20 }),
      )
      .map(([first, rest]) => `${first}${rest.join('')}`),
  },
);

/** How an unsupplied tag is expressed (Requirement 2.15 names both forms). */
type UnsuppliedTag = 'empty' | 'null' | 'omitted-from-chart-defaults';

const unsuppliedTagArb: fc.Arbitrary<UnsuppliedTag> = fc.constantFrom(
  'empty',
  'null',
  'omitted-from-chart-defaults',
);

/**
 * Parse the `helm template` YAML stream, dropping the comment-only chunks a
 * template that renders nothing leaves behind.
 */
function parseManifestStream(stdout: string): unknown[] {
  const docs: unknown[] = [];
  for (const document of parseAllDocuments(stdout)) {
    if (document.errors.length > 0) {
      const messages = document.errors.map((error) => error.message).join('; ');
      throw new Error(`rendered manifest is not valid YAML: ${messages}\n--- output ---\n${stdout}`);
    }
    const value: unknown = document.toJS({ maxAliasCount: -1 });
    if (value !== null && value !== undefined) {
      docs.push(value);
    }
  }
  return docs;
}

/** Read a chart file's single YAML document as a mapping. */
function readYamlMapping(file: string): Record<string, unknown> {
  const [first] = parseAllDocuments(readFileSync(file, 'utf8'));
  if (!first) {
    throw new Error(`no YAML document found in ${file}`);
  }
  const parsed: unknown = first.toJS({ maxAliasCount: -1 });
  if (!isMapping(parsed)) {
    throw new Error(`${file} does not hold a mapping`);
  }
  return parsed;
}

/** The chart's declared `appVersion`, used by the committed-chart assertions. */
function chartAppVersion(): string {
  const appVersion = readYamlMapping(path.join(chartDir, 'Chart.yaml'))['appVersion'];
  expect(typeof appVersion, 'Chart.yaml appVersion is not a string').toBe('string');
  return appVersion as string;
}

interface ChartPatch {
  /** Replacement `appVersion` for the chart copy. */
  appVersion?: string;
  /** Delete `image.tag` from the copy's `values.yaml`, leaving it nil. */
  dropDefaultTag?: boolean;
}

/**
 * Render a throwaway copy of the chart with its metadata, and optionally its
 * declared defaults, patched.
 *
 * Both patches are things `-f` cannot express: `appVersion` lives in
 * `Chart.yaml`, and removing a declared default is the only way to make
 * `.Values.image.tag` nil rather than empty. The copy is a handful of small
 * files, so it costs far less than the `helm template` spawn it feeds.
 * `valuesStringifyOptions` is reused when rewriting, so a string-typed field
 * such as `appVersion: "1.2"` cannot be re-emitted as a plain scalar that Helm
 * would read back as a float and reject.
 */
function renderPatchedChart(
  patch: ChartPatch,
  values: Record<string, unknown> = {},
  releaseName = 'rel',
): RenderResult {
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-image-'));
  try {
    const chartCopy = path.join(workDir, 'scrum-poker');
    cpSync(chartDir, chartCopy, { recursive: true });

    if (patch.appVersion !== undefined) {
      const chartFile = path.join(chartCopy, 'Chart.yaml');
      const chart = readYamlMapping(chartFile);
      chart['appVersion'] = patch.appVersion;
      writeFileSync(chartFile, stringify(chart, valuesStringifyOptions), 'utf8');
    }

    if (patch.dropDefaultTag === true) {
      const defaultsFile = path.join(chartCopy, 'values.yaml');
      const defaults = readYamlMapping(defaultsFile);
      const image = defaults['image'];
      if (!isMapping(image)) {
        throw new Error('chart values.yaml holds no image mapping');
      }
      delete image['tag'];
      writeFileSync(defaultsFile, stringify(defaults, valuesStringifyOptions), 'utf8');
    }

    const valuesFile = path.join(workDir, 'values.yaml');
    writeFileSync(valuesFile, stringifyValues(values), 'utf8');

    const result = spawnSync(
      helmBinary(),
      ['template', releaseName, chartCopy, '-f', valuesFile, '--namespace', defaultNamespace],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    if (result.error) {
      throw new Error(`failed to run ${helmBinary()}: ${result.error.message}`);
    }
    const status = result.status ?? 1;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { status, stdout, stderr, docs: status === 0 ? parseManifestStream(stdout) : [] };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The `image` field of the Deployment's single container.
 *
 * Exactly one Deployment carrying exactly one container is asserted on the
 * way through, so a render that emitted none cannot satisfy the property
 * vacuously.
 */
function containerImage(result: RenderResult, context: string): string {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

  const deployments = result.docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === 'Deployment',
  );
  expect(deployments.length, `${context}: expected exactly one rendered Deployment`).toBe(1);

  const spec = (deployments[0] as Record<string, unknown>)['spec'];
  const template = isMapping(spec) ? spec['template'] : undefined;
  const podSpec = isMapping(template) ? template['spec'] : undefined;
  const containers = isMapping(podSpec) ? podSpec['containers'] : undefined;

  expect(Array.isArray(containers), `${context}: pod spec holds no containers list`).toBe(true);
  const list = containers as unknown[];
  expect(list.length, `${context}: expected exactly one container`).toBe(1);

  const container = list[0];
  expect(isMapping(container), `${context}: container is not a mapping`).toBe(true);
  const mapping = container as Record<string, unknown>;
  expect(mapping['name'], `${context}: unexpected container name`).toBe(CONTAINER_NAME);

  const image = mapping['image'];
  expect(
    typeof image,
    `${context}: container image is not a string: ${JSON.stringify(image)}`,
  ).toBe('string');
  return image as string;
}

describe('Property 4: the image reference is repository, colon, and resolved tag', () => {
  it('renders repository + ":" + tag for any non-empty tag', () => {
    fc.assert(
      fc.property(repositoryArb, nonEmptyTagArb, (repository, tag) => {
        const result = renderChart({ image: { repository, tag } });

        expect(
          containerImage(result, `repository ${JSON.stringify(repository)}, tag ${JSON.stringify(tag)}`),
        ).toBe(`${repository}:${tag}`);
      }),
      {
        ...assertConfig,
        examples: [
          ['nginx', 'latest'],
          // A repository that already carries a colon.
          ['registry.example.com:5000/team/scrum-poker', '1.2.3'],
          // Both declared length ceilings at once.
          ['r'.repeat(MAX_REPOSITORY_LENGTH), 't'.repeat(MAX_TAG_LENGTH)],
          // Plain scalars that resolve to a boolean or an integer unquoted.
          ['repo', 'y'],
          ['y', '010'],
          ['true', 'false'],
          // Non-empty but falsy-looking: `default` must not replace it.
          ['repo', '0'],
          // Characters `quote` escapes, and whitespace nothing may trim.
          ['repo"with"quotes', 'tag"quote'],
          ['repo\\with\\backslash', 'tag\\slash'],
          [' leading-space', 'trailing '],
        ],
      },
    );
  });

  it('renders repository + ":" + Chart.appVersion for any empty or absent tag', () => {
    fc.assert(
      fc.property(
        repositoryArb,
        unsuppliedTagArb,
        appVersionArb,
        (repository, unsupplied, appVersion) => {
          // `empty` and `null` are operator-side; `null` is Helm's way of
          // deleting the chart's declared `image.tag: ""`. The third form
          // removes the declaration itself, the only route that leaves
          // `.Values.image.tag` nil.
          const tagPatch: Record<string, unknown> =
            unsupplied === 'empty' ? { tag: '' } : unsupplied === 'null' ? { tag: null } : {};
          const result = renderPatchedChart(
            {
              appVersion,
              dropDefaultTag: unsupplied === 'omitted-from-chart-defaults',
            },
            { image: { repository, ...tagPatch } },
          );

          expect(
            containerImage(
              result,
              `repository ${JSON.stringify(repository)}, tag ${unsupplied}, ` +
                `appVersion ${JSON.stringify(appVersion)}`,
            ),
          ).toBe(`${repository}:${appVersion}`);
        },
      ),
      {
        ...assertConfig,
        examples: [
          ['nginx', 'empty' as UnsuppliedTag, 'latest'],
          ['nginx', 'null' as UnsuppliedTag, 'latest'],
          ['nginx', 'omitted-from-chart-defaults' as UnsuppliedTag, 'latest'],
          // An appVersion that is a float as a plain scalar.
          ['registry.example.com:5000/team/app', 'empty' as UnsuppliedTag, '1.2'],
          ['repo', 'omitted-from-chart-defaults' as UnsuppliedTag, 'v2.0.0-rc.1'],
          ['r'.repeat(MAX_REPOSITORY_LENGTH), 'null' as UnsuppliedTag, 'y'],
        ],
      },
    );
  });

  it('holds for the chart as committed, with its own repository and appVersion', () => {
    const defaults = loadDefaultValues();
    const image = defaults['image'];
    expect(isMapping(image), 'chart values.yaml holds no image mapping').toBe(true);
    const repository = (image as Record<string, unknown>)['repository'];

    // The committed default tag is empty, so the committed appVersion resolves.
    expect((image as Record<string, unknown>)['tag']).toBe('');
    expect(containerImage(renderChart({}), 'committed defaults')).toBe(
      `${String(repository)}:${chartAppVersion()}`,
    );
  });
});
