/**
 * Feature: helm-chart-deployment - harness self-check.
 *
 * Not one of the 16 correctness properties: these checks only prove the shared
 * render helper and the shared generators work, so a later property failure
 * points at the chart rather than at the harness.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  chartDir,
  loadDefaultValues,
  mergeValues,
  renderChart,
  setPath,
  stringifyValues,
  withDefaults,
} from './support/render-chart.js';
import {
  MAX_HELM_RELEASE_NAME_LENGTH,
  guardViolationArb,
  releaseNameArb,
  schemaViolationArb,
  secretValueArb,
  validValuesArb,
} from './support/generators.js';

const HELM_RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** One `onWorkDir` observation: the directory, and whether it existed then. */
interface WorkDirSighting {
  dir: string;
  existedDuringRender: boolean;
  valuesFileDuringRender: boolean;
}

describe('renderChart', () => {
  it('renders the chart with default values and parses the manifest stream', () => {
    const result = renderChart({});

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(Array.isArray(result.docs)).toBe(true);
  });

  it('accepts a release name and namespace', () => {
    const result = renderChart({}, { releaseName: 'harness-rel', namespace: 'harness-ns' });

    expect(result.status).toBe(0);
  });

  it('passes values through a file, so dotted and comma-bearing annotations survive', () => {
    const result = renderChart({
      podAnnotations: {
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
        'example.com/list': 'a,b,c',
        'example.com/colon': 'key: value',
      },
    });

    expect(result.status).toBe(0);
  });

  it('captures a failed render as a non-zero status, a message, and no documents', () => {
    const result = renderChart({}, { releaseName: 'Invalid_Release' });

    expect(result.status).not.toBe(0);
    expect(result.docs).toEqual([]);
    expect(result.stderr).toContain('release name');
  });

  /**
   * Named, not counted. Counting `scrum-poker-helm-*` entries in the OS temp
   * directory made this check depend on what every other test file happened to
   * have in flight - vitest runs them in parallel, and several render through
   * their own similarly prefixed temp directories. The claim is about the one
   * directory *this* render created, so `onWorkDir` names it and the
   * assertions address that path alone.
   */
  it('deletes the temporary directory holding its values file', () => {
    const sightings: WorkDirSighting[] = [];
    const result = renderChart(
      {},
      {
        onWorkDir: (dir) =>
          sightings.push({
            dir,
            existedDuringRender: existsSync(dir),
            valuesFileDuringRender: existsSync(path.join(dir, 'values.yaml')),
          }),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(sightings).toHaveLength(1);

    const sighting = sightings[0] as WorkDirSighting;

    // Non-vacuity: there was a directory, and it did hold the values file
    // `helm template` was handed, so its absence below is a real deletion.
    expect(sighting.existedDuringRender).toBe(true);
    expect(sighting.valuesFileDuringRender).toBe(true);
    expect(path.basename(sighting.dir)).toMatch(/^scrum-poker-helm-/);

    expect(existsSync(path.join(sighting.dir, 'values.yaml'))).toBe(false);
    expect(existsSync(sighting.dir)).toBe(false);
  });

  it('deletes its temporary directory even when the render fails', () => {
    const sightings: string[] = [];
    const result = renderChart(
      {},
      { releaseName: 'Invalid_Release', onWorkDir: (dir) => sightings.push(dir) },
    );

    expect(result.status).not.toBe(0);
    expect(sightings).toHaveLength(1);
    expect(existsSync(sightings[0] as string)).toBe(false);
  });

  it('resolves the chart directory relative to the repository root', () => {
    expect(chartDir.replace(/\\/g, '/')).toMatch(/\/helm\/scrum-poker$/);
  });
});

/**
 * The values file is the harness's only channel into Helm, so a JS value's type
 * has to survive it. Helm parses values with a Go YAML 1.1 parser, which
 * resolves far more plain scalars to non-strings than the `yaml` package's
 * YAML 1.2 default style assumes - `N` as `false` being the one that made
 * Property 8 fail seed-dependently.
 */
describe('values serialisation fidelity', () => {
  /** The single application container of the rendered Deployment. */
  function appContainer(docs: unknown[]): Record<string, unknown> {
    for (const doc of docs) {
      if (typeof doc !== 'object' || doc === null) {
        continue;
      }
      const record = doc as Record<string, unknown>;
      if (record['kind'] !== 'Deployment') {
        continue;
      }
      const spec = record['spec'] as Record<string, unknown>;
      const template = spec['template'] as Record<string, unknown>;
      const podSpec = template['spec'] as Record<string, unknown>;
      const containers = podSpec['containers'] as Record<string, unknown>[];
      expect(containers).toHaveLength(1);
      return containers[0] as Record<string, unknown>;
    }
    throw new Error('no Deployment in the rendered manifest stream');
  }

  /** Plain scalars Helm's YAML 1.1 parser would read as a boolean, number, or null. */
  const COERCIBLE = [
    'y',
    'Y',
    'n',
    'N',
    'yes',
    'Yes',
    'YES',
    'no',
    'No',
    'on',
    'On',
    'off',
    'Off',
    'true',
    'False',
    'null',
    'Null',
    '~',
    '',
    '010',
    '0o10',
    '1_000',
    '1e3',
    '0x1f',
    '.inf',
    '.nan',
    '12:30',
    '3000',
    '-1',
    '1.5',
  ];

  it('quotes every string a YAML 1.1 parser would coerce', () => {
    for (const value of COERCIBLE) {
      expect(stringifyValues({ probe: value }).trim()).toBe(`probe: ${JSON.stringify(value)}`);
    }
  });

  it('leaves integers, booleans and null as integers, booleans and null', () => {
    expect(stringifyValues({ port: 3000, flag: false, nodePort: null }).trim().split('\n')).toEqual([
      'port: 3000',
      'flag: false',
      'nodePort: null',
    ]);
  });

  it('keeps mapping keys plain', () => {
    expect(stringifyValues({ 'nginx.ingress.kubernetes.io/affinity': 'cookie' }).trim()).toBe(
      'nginx.ingress.kubernetes.io/affinity: "cookie"',
    );
  });

  it('delivers a coercible string to a template as that string', () => {
    // `N` reaches `default "JWT_SECRET" .Values.auth.existingSecretKey` as the
    // string "N", not as the boolean false that would trigger the default -
    // the exact counterexample that made Property 8 fail.
    const result = renderChart({
      auth: { jwtSecret: '', existingSecret: 'shared-jwt', existingSecretKey: 'N' },
    });

    expect(result.status, result.stderr).toBe(0);

    const container = appContainer(result.docs);
    const env = container['env'] as Record<string, unknown>[];
    const entry = env.find((candidate) => candidate['name'] === 'JWT_SECRET');
    const ref = (entry?.['valueFrom'] as Record<string, Record<string, unknown>>)['secretKeyRef'];

    expect(ref).toEqual({ name: 'shared-jwt', key: 'N' });
  });

  it('delivers null and false to a template with their types intact', () => {
    // A string "null" would render a nodePort, and a string "false" is truthy
    // in a template `if`, so it would render the tmp volume and its mount.
    const result = renderChart({
      service: { type: 'NodePort', nodePort: null },
      securityContext: { readOnlyRootFilesystem: false },
    });

    expect(result.status, result.stderr).toBe(0);

    const service = result.docs.find(
      (doc): doc is Record<string, unknown> =>
        typeof doc === 'object' && doc !== null && (doc as Record<string, unknown>)['kind'] === 'Service',
    );
    const ports = (service?.['spec'] as Record<string, unknown>)['ports'] as Record<
      string,
      unknown
    >[];

    expect(Object.keys(ports[0] as Record<string, unknown>)).not.toContain('nodePort');
    expect(appContainer(result.docs)['volumeMounts']).toBeUndefined();
  });
});

describe('values helpers', () => {
  it('loads the chart defaults', () => {
    const defaults = loadDefaultValues();

    expect(defaults['replicaCount']).toBe(1);
    expect(defaults['service']).toMatchObject({ port: 80, targetPort: 3000 });
  });

  it('merges mappings key by key and replaces lists outright', () => {
    const merged = mergeValues(
      { service: { type: 'ClusterIP', port: 80 }, tolerations: [{ key: 'a' }] },
      { service: { port: 8080 }, tolerations: [] },
    );

    expect(merged).toEqual({ service: { type: 'ClusterIP', port: 8080 }, tolerations: [] });
  });

  it('layers a patch over the chart defaults without mutating them', () => {
    const resolved = withDefaults({ config: { basePath: '/other' } });

    expect(resolved['config']).toMatchObject({ basePath: '/other', preservePath: true });
    expect(loadDefaultValues()['config']).toMatchObject({ basePath: '/scrum-poker' });
  });

  it('builds a patch from a dotted path', () => {
    expect(setPath('service.nodePort', 100)).toEqual({ service: { nodePort: 100 } });
  });
});

describe('generators', () => {
  it('produces release names Helm accepts, biased toward the truncation range', () => {
    const samples = fc.sample(releaseNameArb, 200);

    for (const name of samples) {
      expect(name.length).toBeGreaterThanOrEqual(1);
      expect(name.length).toBeLessThanOrEqual(MAX_HELM_RELEASE_NAME_LENGTH);
      expect(name).toMatch(HELM_RELEASE_NAME);
    }
    expect(samples.filter((name) => name.length >= 40).length).toBeGreaterThan(0);
  });

  it('covers all 13 guards', () => {
    const guards = new Set(fc.sample(guardViolationArb, 600).map((violation) => violation.guard));

    expect([...guards].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it('names a values path for every schema violation', () => {
    for (const violation of fc.sample(schemaViolationArb, 200)) {
      expect(violation.path).not.toBe('');
      expect(violation.constraint).toBeTruthy();
    }
  });

  it('spans base64 padding boundaries with secret values', () => {
    const lengths = new Set(fc.sample(secretValueArb, 300).map((value) => value.length % 3));

    expect(lengths.size).toBe(3);
  });

  it('renders every generated valid values document', () => {
    for (const values of fc.sample(validValuesArb, 5)) {
      const result = renderChart(values);

      expect(result.status, `${result.stderr}\n${JSON.stringify(values)}`).toBe(0);
    }
  });
});
