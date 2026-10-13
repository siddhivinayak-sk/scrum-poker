/**
 * Feature: helm-chart-deployment
 *
 * Property 1: Rendered resource names stay inside Kubernetes bounds
 *
 * *For any* release name composed of lowercase alphanumeric and hyphen
 * characters and *any* chart `version` and `appVersion` metadata values, every
 * `metadata.name` in the rendered output - including the `-config` and
 * `-secret` suffixed names - is between 1 and 63 characters long and ends in an
 * alphanumeric character, and every label value applied by
 * `scrum-poker.labels` is a non-empty string of at most 63 characters.
 *
 * **Validates: Requirements 1.9, 1.10, 2.2, 3.2, 4.1, 12.14**
 *
 * The assertions walk *every* document in the rendered stream rather than a
 * fixed list of kinds, so the property covers whatever templates exist at the
 * time it runs and strengthens on its own as the Deployment, Service, Ingress,
 * and Secret templates land.
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
  renderChart,
  type RenderResult,
} from './support/render-chart.js';
import { MAX_HELM_RELEASE_NAME_LENGTH, assertConfig, releaseNameArb } from './support/generators.js';

/** Kubernetes' ceiling for a DNS label, a label value, and a resource name. */
const MAX_NAME_LENGTH = 63;

/** RFC 1123 subdomain, the form Kubernetes requires of these resource names. */
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** The five keys `scrum-poker.labels` applies (Requirement 1.10). */
const COMMON_LABEL_KEYS = [
  'helm.sh/chart',
  'app.kubernetes.io/name',
  'app.kubernetes.io/instance',
  'app.kubernetes.io/version',
  'app.kubernetes.io/managed-by',
] as const;

interface ChartMetadata {
  version: string;
  appVersion: string;
}

/**
 * Chart `version` values. Helm rejects a `Chart.yaml` whose `version` is not
 * SemVer 2, so the generator stays inside SemVer and varies the parts that
 * reach a label: the pre-release suffix, and build metadata, whose `+` the
 * `scrum-poker.chart` helper has to replace with `_` because `+` is not legal
 * in a label value.
 */
const chartVersionArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
    fc.option(fc.constantFrom('alpha', 'alpha.1', 'beta.12', 'rc.2', '0.dev.7'), {
      nil: undefined,
    }),
    fc.option(fc.constantFrom('build.5', '20240101', 'sha.abc1234', 'exp.sha.5114f85'), {
      nil: undefined,
    }),
  )
  .map(([major, minor, patch, pre, build]) => {
    const core = `${major}.${minor}.${patch}`;
    return `${core}${pre === undefined ? '' : `-${pre}`}${build === undefined ? '' : `+${build}`}`;
  });

/**
 * Chart `appVersion` values. The helper quotes `.Chart.AppVersion` straight
 * into `app.kubernetes.io/version` without truncating, so the generator stays
 * inside what Kubernetes accepts as a label value: 1-63 characters. Requirement
 * 1.5 permits up to 128 characters in the metadata field itself, but a value
 * past 63 could not satisfy Requirement 1.10 no matter what the chart did, so
 * that range is a chart-metadata concern rather than a rendering one and is out
 * of this property's input space.
 */
const appVersionArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
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
    ),
  },
  { weight: 1, arbitrary: chartVersionArb },
  // The 63-character boundary itself.
  { weight: 1, arbitrary: fc.constant(`v${'1'.repeat(62)}`) },
);

const chartMetadataArb: fc.Arbitrary<ChartMetadata> = fc.record({
  version: chartVersionArb,
  appVersion: appVersionArb,
});

/** Parse the `helm template` YAML stream, dropping comment-only chunks. */
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

/**
 * Render the chart with `version` and `appVersion` replaced.
 *
 * Chart metadata is not a value, so it cannot be supplied through `-f`: the
 * chart is copied to a temporary directory and the copy's `Chart.yaml` is
 * rewritten. Nothing under `helm/scrum-poker/` is touched. The copy is a
 * handful of small files, so this costs far less than the `helm template`
 * spawn it feeds.
 */
function renderWithChartMetadata(
  metadata: ChartMetadata,
  values: Record<string, unknown> = {},
  releaseName = 'rel',
): RenderResult {
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-meta-'));
  try {
    const chartCopy = path.join(workDir, 'scrum-poker');
    cpSync(chartDir, chartCopy, { recursive: true });

    const chartFile = path.join(chartCopy, 'Chart.yaml');
    const documents = parseAllDocuments(readFileSync(chartFile, 'utf8'));
    const first = documents[0];
    if (!first) {
      throw new Error(`no YAML document found in ${chartFile}`);
    }
    const chart = first.toJS({ maxAliasCount: -1 }) as Record<string, unknown>;
    chart['version'] = metadata.version;
    chart['appVersion'] = metadata.appVersion;
    writeFileSync(chartFile, stringify(chart), 'utf8');

    const valuesFile = path.join(workDir, 'values.yaml');
    writeFileSync(valuesFile, stringify(values), 'utf8');

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

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RenderedResource {
  kind: string;
  name: unknown;
  labels: Record<string, unknown>;
}

/**
 * Every document in the stream, described by kind, `metadata.name`, and
 * `metadata.labels` - read generically, so a template added later is covered
 * without touching this file.
 */
function describeResources(docs: unknown[]): RenderedResource[] {
  return docs.map((doc, index) => {
    if (!isMapping(doc)) {
      throw new Error(`document ${index} is not a mapping: ${JSON.stringify(doc)}`);
    }
    const metadata = doc['metadata'];
    if (!isMapping(metadata)) {
      throw new Error(`document ${index} has no metadata mapping: ${JSON.stringify(doc)}`);
    }
    const labels = metadata['labels'];
    return {
      kind: typeof doc['kind'] === 'string' ? doc['kind'] : `document ${index}`,
      name: metadata['name'],
      labels: isMapping(labels) ? labels : {},
    };
  });
}

/** Assert Property 1 over a single render. */
function assertNameAndLabelBounds(result: RenderResult, context: string): void {
  expect(result.status, `${context}\n${result.stderr}`).toBe(0);

  const resources = describeResources(result.docs);
  // Guards against a vacuous pass: a render that emitted nothing would
  // otherwise satisfy every assertion below.
  expect(resources.length, `${context}: rendered no resources`).toBeGreaterThan(0);

  for (const resource of resources) {
    const where = `${context}: ${resource.kind}`;

    expect(typeof resource.name, `${where} has no string metadata.name`).toBe('string');
    const name = resource.name as string;

    expect(name.length, `${where} name "${name}" is empty`).toBeGreaterThanOrEqual(1);
    expect(name.length, `${where} name "${name}" exceeds ${MAX_NAME_LENGTH}`).toBeLessThanOrEqual(
      MAX_NAME_LENGTH,
    );
    expect(name[name.length - 1], `${where} name "${name}" does not end alphanumeric`).toMatch(
      /^[a-z0-9]$/,
    );
    expect(name, `${where} name "${name}" is not a DNS-1123 subdomain`).toMatch(
      DNS_1123_SUBDOMAIN,
    );

    for (const key of COMMON_LABEL_KEYS) {
      const value = resource.labels[key];

      expect(typeof value, `${where} label ${key} is not a string: ${JSON.stringify(value)}`).toBe(
        'string',
      );
      const labelValue = value as string;

      expect(labelValue.length, `${where} label ${key} is empty`).toBeGreaterThanOrEqual(1);
      expect(
        labelValue.length,
        `${where} label ${key} value "${labelValue}" exceeds ${MAX_NAME_LENGTH}`,
      ).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  }
}

describe('Property 1: rendered resource names stay inside Kubernetes bounds', () => {
  it('bounds every metadata.name and every common label value', () => {
    fc.assert(
      fc.property(releaseNameArb, chartMetadataArb, (releaseName, metadata) => {
        const result = renderWithChartMetadata(metadata, {}, releaseName);

        assertNameAndLabelBounds(
          result,
          `release "${releaseName}" (${releaseName.length} chars), version ` +
            `"${metadata.version}", appVersion "${metadata.appVersion}"`,
        );
      }),
      {
        ...assertConfig,
        examples: [
          // A release name at Helm's 53-character ceiling, so fullname +
          // "-scrum-poker" overflows 63 and truncation must bite.
          [`a${'b'.repeat(MAX_HELM_RELEASE_NAME_LENGTH - 2)}c`, { version: '0.1.0', appVersion: 'latest' }],
          // Truncation of fullname lands exactly on a hyphen, so trimSuffix has
          // to run; the 56-character base of the suffixed names does too.
          [`a${'-b'.repeat(25)}-c`, { version: '0.1.0', appVersion: 'latest' }],
          [`${'ab-'.repeat(17)}c`, { version: '0.1.0', appVersion: 'latest' }],
          // Shortest legal release name.
          ['a', { version: '0.1.0', appVersion: 'latest' }],
          // Build metadata must reach the label with "+" replaced by "_".
          ['rel', { version: '1.0.0+exp.sha.5114f85', appVersion: 'latest' }],
          // appVersion at the label-value boundary.
          ['rel', { version: '0.1.0', appVersion: `v${'1'.repeat(62)}` }],
        ],
      },
    );
  });

  it('holds for the chart as committed, with its own metadata', () => {
    assertNameAndLabelBounds(
      renderChart({}, { releaseName: 'a'.repeat(MAX_HELM_RELEASE_NAME_LENGTH) }),
      'committed chart metadata, 53-character release name',
    );
  });

  it('replaces "+" in chart build metadata rather than emitting an illegal label value', () => {
    const result = renderWithChartMetadata({ version: '1.0.0+exp.sha.5114f85', appVersion: '1' });
    const [resource] = describeResources(result.docs);

    expect(resource?.labels['helm.sh/chart']).toBe('scrum-poker-1.0.0_exp.sha.5114f85');
  });
});
