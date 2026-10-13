/**
 * Feature: helm-chart-deployment - Property 2.
 *
 * Property 2: The selector label set is fixed and version-independent.
 *
 * *For any* two renderings that supply identical values but differ in
 * `version`, `appVersion`, or both, the `scrum-poker.selectorLabels` block is
 * byte-identical between them and contains exactly the keys
 * `app.kubernetes.io/name` and `app.kubernetes.io/instance`; and within a
 * single rendering, `Deployment.spec.selector.matchLabels`,
 * `Deployment.spec.template.metadata.labels`, and `Service.spec.selector` all
 * carry that same key/value set.
 *
 * **Validates: Requirements 1.11, 2.8, 3.6**
 *
 * Why the selector set matters: `Deployment.spec.selector` is immutable after
 * creation. A version-derived key inside it would make every `appVersion` bump
 * an un-upgradeable release, so the set has to stay at exactly the two
 * identity keys and has to be invariant under chart metadata changes.
 *
 * ### How this test behaves before the Deployment and Service templates exist
 *
 * Tasks 7.x and 8.1 have not run yet, so today only the ConfigMap and the
 * ServiceAccount render. The property is written so it needs no edit once
 * those templates land:
 *
 * - Selector blocks are located **generically** - the rendered documents are
 *   walked for any `selector` or `matchLabels` mapping of strings, and for any
 *   pod `template.metadata.labels` - rather than by hard-coded document index.
 *   The moment a Deployment or Service renders, its blocks join the set under
 *   assertion automatically.
 * - `assertExpectedSelectorSites` additionally pins the three sites the design
 *   names: whenever a document of the owning kind is present, the block at
 *   that path must have been located. A Deployment that forgot
 *   `spec.selector.matchLabels` therefore fails rather than passing vacuously.
 * - The version-independence half already has teeth today, because
 *   `scrum-poker.labels` embeds the two selector labels in every resource's
 *   `metadata.labels`. The test extracts that selector subset and compares it
 *   across the version pair, and separately proves the pair really differed by
 *   requiring the version-derived labels to move.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import {
  chartDir,
  defaultNamespace,
  helmBinary,
  renderChart,
  stringifyValues,
  withDefaults,
} from './support/render-chart.js';
import { assertConfig, releaseNameArb, validValuesArb } from './support/generators.js';

/** The only two keys `scrum-poker.selectorLabels` is allowed to emit. */
const SELECTOR_KEYS = ['app.kubernetes.io/instance', 'app.kubernetes.io/name'] as const;

/**
 * Labels whose value is derived from chart metadata. They must move when
 * `version` or `appVersion` moves - that is what proves a version-pair
 * iteration was not comparing two identical renders.
 */
const VERSION_DERIVED_LABEL_KEYS = ['helm.sh/chart', 'app.kubernetes.io/version'] as const;

/** The three selector sites the design names, by owning resource kind. */
const EXPECTED_SELECTOR_SITES: { kind: string; path: string }[] = [
  { kind: 'Deployment', path: 'spec.selector.matchLabels' },
  { kind: 'Deployment', path: 'spec.template.metadata.labels' },
  { kind: 'Service', path: 'spec.selector' },
];

/**
 * Subtrees that legitimately hold a `matchLabels` of their own which is *not*
 * the chart's selector label set - pod/node affinity term selectors, and
 * topology spread constraints. Excluded from the generic walk so the property
 * stays about `scrum-poker.selectorLabels`.
 */
const NON_SELECTOR_SUBTREES = new Set(['affinity', 'topologySpreadConstraints']);

interface SelectorBlock {
  /** Human-readable `Kind.path.to.block`, used in failure messages. */
  location: string;
  labels: Record<string, string>;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A non-empty mapping no value of which is itself a mapping or a list - the
 * shape of a label block.
 *
 * Scalars rather than strings on purpose. Whether a label *value* is a string
 * of 1-63 characters is Requirement 1.10, which Property 1 covers; this
 * property is about the key set and its invariance, so the locator accepts any
 * scalar and normalises it, and a non-string value fails Property 1 rather
 * than silently dropping a block out of this walk.
 */
function isLabelMap(value: unknown): value is Record<string, unknown> {
  return (
    isMapping(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((entry) => !isMapping(entry) && !Array.isArray(entry))
  );
}

/** Normalise a parsed scalar label value back to the text Helm emitted. */
function scalarToString(value: unknown): string {
  return value === null || value === undefined ? 'null' : String(value);
}

/** A label block with every value normalised to text. */
function normalizeLabels(block: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(block).map(([key, value]) => [key, scalarToString(value)]),
  );
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

function docKind(doc: unknown): string {
  const kind = isMapping(doc) ? doc['kind'] : undefined;
  return typeof kind === 'string' ? kind : 'Unknown';
}

/**
 * Walk a rendered document and collect every selector label block, wherever it
 * sits. Three shapes count:
 *
 * - a `selector` mapping of strings (`Service.spec.selector`),
 * - a `matchLabels` mapping of strings (`Deployment.spec.selector.matchLabels`),
 * - the `metadata.labels` of any `template` block (the pod template labels,
 *   which Kubernetes matches against the Deployment selector).
 *
 * A `selector` whose value is not a mapping of strings - a Deployment's
 * `spec.selector`, which nests `matchLabels` - is stepped through rather than
 * collected, so each block is counted once.
 */
function collectSelectorBlocks(node: unknown, prefix: string, out: SelectorBlock[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectSelectorBlocks(entry, `${prefix}[${index}]`, out));
    return;
  }
  if (!isMapping(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (NON_SELECTOR_SUBTREES.has(key)) {
      continue;
    }
    const childPath = prefix === '' ? key : `${prefix}.${key}`;
    if ((key === 'selector' || key === 'matchLabels') && isLabelMap(value)) {
      out.push({ location: childPath, labels: normalizeLabels(value) });
    }
    if (key === 'template' && isMapping(value)) {
      const templateLabels = getPath(value, 'metadata.labels');
      if (isLabelMap(templateLabels)) {
        out.push({ location: `${childPath}.metadata.labels`, labels: normalizeLabels(templateLabels) });
      }
    }
    collectSelectorBlocks(value, childPath, out);
  }
}

/** Every selector block in a rendered manifest stream, prefixed by its kind. */
function selectorBlocks(docs: unknown[]): SelectorBlock[] {
  const out: SelectorBlock[] = [];
  for (const doc of docs) {
    collectSelectorBlocks(doc, docKind(doc), out);
  }
  return out;
}

/** `metadata.labels` of every rendered resource, keyed by kind and name. */
function resourceLabels(docs: unknown[]): { location: string; labels: Record<string, string> }[] {
  const out: { location: string; labels: Record<string, string> }[] = [];
  for (const doc of docs) {
    const labels = getPath(doc, 'metadata.labels');
    if (isLabelMap(labels)) {
      const name = getPath(doc, 'metadata.name');
      out.push({ location: `${docKind(doc)}/${String(name)}`, labels: normalizeLabels(labels) });
    }
  }
  return out;
}

/** The selector-key subset of a label mapping, in key order. */
function selectorSubset(labels: Record<string, string>): Record<string, string> {
  const subset: Record<string, string> = {};
  for (const key of SELECTOR_KEYS) {
    const value = labels[key];
    if (value !== undefined) {
      subset[key] = value;
    }
  }
  return subset;
}

/**
 * A byte-comparable form of a label block: keys sorted, one `key: value` line
 * each. Sorting removes map-iteration order from the comparison; everything
 * else - including an empty value - is preserved exactly.
 */
function blockBytes(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}: ${labels[key] as string}`)
    .join('\n');
}

/**
 * Every rendered line that `scrum-poker.selectorLabels` could have emitted, in
 * document order, with indentation stripped. This is a byte-level view of the
 * raw `helm template` output rather than of the parsed tree, so a quoting or
 * spacing change inside the block is caught too.
 */
function rawSelectorLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => SELECTOR_KEYS.some((key) => line.startsWith(`${key}:`)));
}

/**
 * Pin the three sites the design names. A site is only required when a
 * document of its owning kind is present, so the assertion is a no-op before
 * tasks 7.x and 8.1 land and becomes binding the moment they do.
 */
function assertExpectedSelectorSites(docs: unknown[], blocks: SelectorBlock[]): void {
  const kinds = new Set(docs.map(docKind));
  const located = new Set(blocks.map((block) => block.location));
  for (const site of EXPECTED_SELECTOR_SITES) {
    if (!kinds.has(site.kind)) {
      continue;
    }
    expect(
      located.has(`${site.kind}.${site.path}`),
      `${site.kind} renders but ${site.path} holds no selector label block; located: ${[...located].join(', ')}`,
    ).toBe(true);
  }
}

/** Chart metadata the copy is patched with. */
interface ChartMetadata {
  version: string;
  appVersion: string;
}

/** SemVer 2 chart versions - Helm rejects anything else before templating. */
const chartVersionArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 0, max: 99 }),
    )
    .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
  fc
    .tuple(fc.integer({ min: 1, max: 9 }), fc.constantFrom('alpha.1', 'rc.2', 'beta'))
    .map(([major, pre]) => `${major}.0.0-${pre}`),
);

/**
 * `appVersion` is free-form in Chart.yaml, but it lands in the
 * `app.kubernetes.io/version` label value, so the generator stays inside the
 * label-value grammar: alphanumeric ends, at most 63 characters.
 */
const appVersionArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('latest', 'main', 'stable', '1.0.0', '2.3.4', '2.3.4-rc.1'),
  fc
    .tuple(
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
    )
    .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
);

/** Two metadata pairs that differ in `version`, in `appVersion`, or in both. */
const chartMetadataPairArb: fc.Arbitrary<[ChartMetadata, ChartMetadata]> = fc
  .tuple(chartVersionArb, appVersionArb, chartVersionArb, appVersionArb)
  .filter(
    ([versionA, appVersionA, versionB, appVersionB]) =>
      versionA !== versionB || appVersionA !== appVersionB,
  )
  .map(([versionA, appVersionA, versionB, appVersionB]) => [
    { version: versionA, appVersion: appVersionA },
    { version: versionB, appVersion: appVersionB },
  ]);

/**
 * A throwaway copy of the chart whose `Chart.yaml` this test may rewrite.
 *
 * The workspace chart is never modified: `version` and `appVersion` are
 * properties of chart metadata, not of values, so the only way to vary them is
 * to render a different chart directory.
 */
let chartCopyRoot: string | undefined;
let chartCopyDir = '';
let originalChartYaml = '';

beforeAll(() => {
  chartCopyRoot = mkdtempSync(path.join(tmpdir(), 'scrum-poker-chart-copy-'));
  chartCopyDir = path.join(chartCopyRoot, 'scrum-poker');
  cpSync(chartDir, chartCopyDir, { recursive: true });
  originalChartYaml = readFileSync(path.join(chartCopyDir, 'Chart.yaml'), 'utf8');
});

afterAll(() => {
  if (chartCopyRoot !== undefined) {
    rmSync(chartCopyRoot, { recursive: true, force: true });
    chartCopyRoot = undefined;
  }
});

/** Rewrite the copy's `version` and `appVersion`, leaving every other field alone. */
function patchChartMetadata(metadata: ChartMetadata): void {
  const patched = originalChartYaml
    .replace(/^version:.*$/m, `version: ${metadata.version}`)
    .replace(/^appVersion:.*$/m, `appVersion: "${metadata.appVersion}"`);
  writeFileSync(path.join(chartCopyDir, 'Chart.yaml'), patched, 'utf8');
}

interface CopyRenderResult {
  status: number;
  stdout: string;
  stderr: string;
  docs: unknown[];
}

/**
 * Render the patched copy. Deliberately local to this file rather than added
 * to `support/render-chart.ts`: only this property needs a chart directory
 * other than the workspace one.
 */
function renderChartCopy(
  values: Record<string, unknown>,
  metadata: ChartMetadata,
  releaseName: string,
): CopyRenderResult {
  patchChartMetadata(metadata);
  const valuesFile = path.join(chartCopyDir, '..', 'values.yaml');
  // Serialise through the shared `stringifyValues`, not the `yaml` package's
  // defaults. Default options emit plain scalars under YAML 1.2 core
  // resolution while Helm parses with a Go YAML 1.1 parser, so a generated
  // string like `"N"` would be written bare as `name: N` and read back by
  // Helm as the boolean `false` - which then trips guard 8 (empty `extraEnv`
  // name) or the schema, and fails the render for a harness reason rather
  // than a chart one. The shared helper double-quotes string values so a JS
  // string always reaches Helm as a YAML string.
  writeFileSync(valuesFile, stringifyValues(values), 'utf8');
  const result = spawnSync(
    helmBinary(),
    [
      'template',
      releaseName,
      chartCopyDir,
      '-f',
      valuesFile,
      '--namespace',
      defaultNamespace,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (result.error) {
    throw new Error(`failed to run ${helmBinary()}: ${result.error.message}`);
  }
  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const docs: unknown[] = [];
  if (status === 0) {
    for (const document of parseAllDocuments(stdout)) {
      if (document.errors.length > 0) {
        throw new Error(
          `rendered manifest is not valid YAML: ${document.errors
            .map((error) => error.message)
            .join('; ')}\n--- output ---\n${stdout}`,
        );
      }
      const value: unknown = document.toJS({ maxAliasCount: -1 });
      if (value !== null && value !== undefined) {
        docs.push(value);
      }
    }
  }
  return { status, stdout, stderr: result.stderr ?? '', docs };
}

/** `scrum-poker.name`: `nameOverride` or the chart name, truncated to 63. */
function expectedNameLabel(resolvedValues: Record<string, unknown>): string {
  const override = resolvedValues['nameOverride'];
  const name = typeof override === 'string' && override !== '' ? override : 'scrum-poker';
  return name.slice(0, 63).replace(/-+$/, '');
}

describe('Property 2: the selector label set is fixed and version-independent', () => {
  it('emits exactly the two selector keys wherever a selector appears', () => {
    fc.assert(
      fc.property(releaseNameArb, validValuesArb, (releaseName, values) => {
        const result = renderChart(values, { releaseName });
        expect(result.status, result.stderr).toBe(0);

        const resolved = withDefaults(values);
        // The exact text `scrum-poker.selectorLabels` should have emitted.
        // Both values are quoted: a label value is a string in the Kubernetes
        // API, and an unquoted release name of `3` or `true` would render a
        // number or a boolean that the API server rejects (Requirement 1.10).
        const expectedLines = [
          `app.kubernetes.io/instance: "${releaseName}"`,
          `app.kubernetes.io/name: "${expectedNameLabel(resolved)}"`,
        ];

        const blocks = selectorBlocks(result.docs);
        assertExpectedSelectorSites(result.docs, blocks);

        // Wherever a selector appears it holds exactly the two identity keys -
        // no version key, no extras.
        for (const block of blocks) {
          expect(Object.keys(block.labels).sort(), `${block.location} selector keys`).toEqual([
            ...SELECTOR_KEYS,
          ]);
        }

        // `scrum-poker.labels` embeds the same two keys in every resource, so
        // the key set is pinned even before the Deployment and Service land.
        const labelled = resourceLabels(result.docs);
        expect(labelled.length).toBeGreaterThan(0);
        for (const resource of labelled) {
          expect(
            Object.keys(selectorSubset(resource.labels)).sort(),
            `${resource.location} carries both selector labels`,
          ).toEqual([...SELECTOR_KEYS]);
        }

        // Every site agrees on the values, and they are the derived ones. The
        // values are read from the raw output rather than the parsed tree so
        // the comparison is byte-level: a quoting or spacing change inside the
        // block fails here, where the parsed tree would hide it.
        const rawLines = [...new Set(rawSelectorLines(result.stdout))].sort();
        expect(rawLines).toEqual(expectedLines);
      }),
      assertConfig,
    );
  });

  it('keeps every selector block byte-identical across a version and appVersion change', () => {
    fc.assert(
      fc.property(
        releaseNameArb,
        validValuesArb,
        chartMetadataPairArb,
        (releaseName, values, [metadataA, metadataB]) => {
          const renderA = renderChartCopy(values, metadataA, releaseName);
          const renderB = renderChartCopy(values, metadataB, releaseName);
          expect(renderA.status, renderA.stderr).toBe(0);
          expect(renderB.status, renderB.stderr).toBe(0);

          const blocksA = selectorBlocks(renderA.docs);
          const blocksB = selectorBlocks(renderB.docs);
          assertExpectedSelectorSites(renderA.docs, blocksA);
          assertExpectedSelectorSites(renderB.docs, blocksB);

          // Structural comparison: same sites, same key/value sets.
          expect(blocksB.map((block) => block.location)).toEqual(
            blocksA.map((block) => block.location),
          );
          blocksA.forEach((block, index) => {
            const counterpart = blocksB[index] as SelectorBlock;
            expect(Object.keys(block.labels).sort(), `${block.location} selector keys`).toEqual([
              ...SELECTOR_KEYS,
            ]);
            expect(blockBytes(counterpart.labels), `${block.location} across versions`).toBe(
              blockBytes(block.labels),
            );
          });

          // Byte comparison of the raw rendered selector lines, which covers
          // the two keys wherever they appear - inside a selector block and
          // inside the common label block alike.
          const rawA = rawSelectorLines(renderA.stdout);
          const rawB = rawSelectorLines(renderB.stdout);
          expect(rawA.length).toBeGreaterThan(0);
          expect(rawB).toEqual(rawA);

          // Guard against a vacuous pass: the version-derived labels must have
          // moved, otherwise the two renders were not actually different.
          const labelsA = resourceLabels(renderA.docs);
          const labelsB = resourceLabels(renderB.docs);
          expect(labelsA.length).toBeGreaterThan(0);
          expect(labelsB.map((resource) => resource.location)).toEqual(
            labelsA.map((resource) => resource.location),
          );
          labelsA.forEach((resource, index) => {
            const counterpart = labelsB[index] as { location: string; labels: Record<string, string> };
            expect(
              blockBytes(selectorSubset(counterpart.labels)),
              `${resource.location} selector subset across versions`,
            ).toBe(blockBytes(selectorSubset(resource.labels)));

            if (metadataA.version !== metadataB.version) {
              expect(counterpart.labels['helm.sh/chart']).not.toBe(
                resource.labels['helm.sh/chart'],
              );
            }
            if (metadataA.appVersion !== metadataB.appVersion) {
              expect(counterpart.labels['app.kubernetes.io/version']).not.toBe(
                resource.labels['app.kubernetes.io/version'],
              );
            }
            for (const key of VERSION_DERIVED_LABEL_KEYS) {
              expect(resource.labels[key], `${resource.location} ${key}`).toBeTruthy();
            }
          });
        },
      ),
      assertConfig,
    );
  });
});

/**
 * Locator checks against synthetic manifests.
 *
 * Not part of Property 2 - these only prove the generic walk really finds the
 * three sites the design names, so the property above is known to tighten the
 * moment tasks 7.x and 8.1 land rather than to keep passing vacuously. They
 * render nothing and run in milliseconds.
 */
describe('selector block locator', () => {
  const selector = { 'app.kubernetes.io/name': 'scrum-poker', 'app.kubernetes.io/instance': 'rel' };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'rel', labels: { ...selector, 'helm.sh/chart': 'scrum-poker-0.1.0' } },
    spec: {
      selector: { matchLabels: { ...selector } },
      template: { metadata: { labels: { ...selector } }, spec: { containers: [{ name: 'c' }] } },
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'rel', labels: { ...selector } },
    spec: { selector: { ...selector }, ports: [{ name: 'http', port: 80 }] },
  };

  it('finds all three sites the design names', () => {
    const blocks = selectorBlocks([deployment, service]);

    expect(blocks.map((block) => block.location).sort()).toEqual([
      'Deployment.spec.selector.matchLabels',
      'Deployment.spec.template.metadata.labels',
      'Service.spec.selector',
    ]);
    assertExpectedSelectorSites([deployment, service], blocks);
  });

  it('fails a Deployment that renders no matchLabels', () => {
    const broken = { ...deployment, spec: { ...deployment.spec, selector: {} } };
    const blocks = selectorBlocks([broken]);

    expect(() => assertExpectedSelectorSites([broken], blocks)).toThrow(
      /spec\.selector\.matchLabels holds no selector label block/,
    );
  });

  it('surfaces an extra selector key so the key-set assertion fails', () => {
    const versioned = {
      ...service,
      spec: { ...service.spec, selector: { ...selector, 'app.kubernetes.io/version': '1.0.0' } },
    };
    const block = selectorBlocks([versioned])[0] as SelectorBlock;

    expect(Object.keys(block.labels).sort()).not.toEqual([...SELECTOR_KEYS]);
  });

  it('ignores a matchLabels that belongs to an affinity term', () => {
    const scheduled = {
      kind: 'Deployment',
      spec: {
        selector: { matchLabels: { ...selector } },
        template: {
          metadata: { labels: { ...selector } },
          spec: {
            affinity: {
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  { labelSelector: { matchLabels: { tier: 'cache' } } },
                ],
              },
            },
          },
        },
      },
    };

    const locations = selectorBlocks([scheduled]).map((block) => block.location);

    expect(locations).toEqual([
      'Deployment.spec.selector.matchLabels',
      'Deployment.spec.template.metadata.labels',
    ]);
  });
});
