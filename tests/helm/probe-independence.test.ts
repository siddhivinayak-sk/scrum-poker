/**
 * Feature: helm-chart-deployment - Property 10.
 *
 * Property 10: Probe fields and probe blocks are independently controlled.
 *
 * *For any* single probe field among `initialDelaySeconds`, `periodSeconds`,
 * `timeoutSeconds`, `successThreshold`, and `failureThreshold` on either
 * `readinessProbe` or `livenessProbe`, overriding only that field changes only
 * that field's rendered value and leaves every other probe field on both
 * probes at its default; and *for any* combination of `readinessProbe.enabled`
 * and `livenessProbe.enabled`, each probe block is present in the rendered
 * container exactly when its own flag is true.
 *
 * **Validates: Requirements 6.6, 6.7, 6.8**
 *
 * ### Why independence is the thing worth proving
 *
 * The two probes are distinct Kubernetes mechanisms with opposite failure
 * modes: a failed readiness probe removes the pod from Service endpoints, a
 * failed liveness probe restarts the container. A template that read a field
 * from the wrong block - `.Values.readinessProbe.periodSeconds` inside the
 * liveness probe, say - renders perfectly valid YAML, passes `helm lint`, and
 * only shows up in production as a pod that restarts on a schedule nobody
 * configured. The same goes for a shared `if` around both blocks: disabling
 * readiness would silently take liveness with it, so a wedged process would
 * never be restarted.
 *
 * Neither defect is visible in a single rendering, which is why this property
 * is differential: it moves exactly one input and requires everything else to
 * hold still.
 *
 * ### How the expectations are derived
 *
 * Expected values come from `helm/scrum-poker/values.yaml` through
 * `loadDefaultValues`, never from literals copied into this file. A test that
 * hard-coded `periodSeconds: 10` would pass while the chart default drifted
 * away from the documented one; reading the chart's own defaults means the
 * "left at its default" half of the property is anchored to the file
 * Requirements 6.4 and 6.5 actually constrain.
 *
 * Block presence is asserted twice over, against the parsed container and
 * against the raw `helm template` bytes of the Deployment chunk. The parsed
 * check proves the key is absent from the container specification; the raw
 * check proves the template emitted no `readinessProbe:`/`livenessProbe:` line
 * at all, so a disabled probe cannot slip through as an empty or null field
 * that the API server would then persist.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadDefaultValues, renderChart, setPath } from './support/render-chart.js';
import { assertConfig } from './support/generators.js';

/** The `# Source:` path Helm prints above the Deployment chunk. */
const DEPLOYMENT_SOURCE = 'scrum-poker/templates/deployment.yaml';

/** The two probe blocks, by their values key and their container field name. */
const PROBE_NAMES = ['readinessProbe', 'livenessProbe'] as const;
type ProbeName = (typeof PROBE_NAMES)[number];

/** The five numeric fields Requirement 6.6 ties to identically named values. */
const PROBE_FIELDS = [
  'initialDelaySeconds',
  'periodSeconds',
  'timeoutSeconds',
  'successThreshold',
  'failureThreshold',
] as const;
type ProbeField = (typeof PROBE_FIELDS)[number];

/** Requirement 6.9's integer bounds for every probe field. */
const PROBE_FIELD_MIN = 1;
const PROBE_FIELD_MAX = 3600;

/** The `httpGet` block both probes must carry, unchanged by any field override. */
const EXPECTED_HTTP_GET = { path: '/api/health', port: 'http', scheme: 'HTTP' } as const;

type ProbeFieldValues = Record<ProbeField, number>;
type ProbeExpectation = { enabled: boolean } & ProbeFieldValues;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The five field values the chart declares for one probe, read out of
 * `values.yaml` rather than restated here.
 */
function defaultProbeFields(defaults: Record<string, unknown>, probe: ProbeName): ProbeFieldValues {
  const block = defaults[probe];
  if (!isMapping(block)) {
    throw new Error(`values.yaml holds no ${probe} mapping`);
  }
  const fields: Partial<ProbeFieldValues> = {};
  for (const field of PROBE_FIELDS) {
    const value = block[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`values.yaml ${probe}.${field} is not an integer: ${String(value)}`);
    }
    fields[field] = value;
  }
  // Both probes ship enabled (Requirements 6.4, 6.5); the field-override half
  // of the property relies on that to see two rendered blocks per iteration.
  expect(block['enabled'], `values.yaml ${probe}.enabled`).toBe(true);
  return fields as ProbeFieldValues;
}

const chartDefaults = loadDefaultValues();
const defaultProbes: Record<ProbeName, ProbeFieldValues> = {
  readinessProbe: defaultProbeFields(chartDefaults, 'readinessProbe'),
  livenessProbe: defaultProbeFields(chartDefaults, 'livenessProbe'),
};

/** The other probe - the one that must hold still while this one moves. */
function otherProbe(probe: ProbeName): ProbeName {
  return probe === 'readinessProbe' ? 'livenessProbe' : 'readinessProbe';
}

/**
 * The raw text of the document Helm rendered from `deployment.yaml`, recovered
 * byte for byte from the `---` separated stream.
 */
function deploymentChunk(stdout: string): string {
  const matching = stdout
    .split(/^---\s*$/m)
    .filter((chunk) => chunk.includes(`# Source: ${DEPLOYMENT_SOURCE}`));
  expect(
    matching.length,
    `expected exactly one document sourced from ${DEPLOYMENT_SOURCE}\n--- output ---\n${stdout}`,
  ).toBe(1);
  return matching[0] as string;
}

/** The single `scrum-poker` container of the rendered Deployment. */
function appContainer(docs: unknown[]): Record<string, unknown> {
  const deployments = docs.filter((doc) => isMapping(doc) && doc['kind'] === 'Deployment');
  expect(deployments.length, 'expected exactly one rendered Deployment').toBe(1);
  const spec = (deployments[0] as Record<string, unknown>)['spec'];
  const template = isMapping(spec) ? spec['template'] : undefined;
  const podSpec = isMapping(template) ? template['spec'] : undefined;
  const containers = isMapping(podSpec) ? podSpec['containers'] : undefined;
  expect(Array.isArray(containers), 'Deployment renders no containers list').toBe(true);
  const list = containers as unknown[];
  expect(list.length, 'expected exactly one container').toBe(1);
  const container = list[0];
  expect(isMapping(container), 'rendered container is not a mapping').toBe(true);
  return container as Record<string, unknown>;
}

/** Count of top-level probe keys emitted inside the container, from the bytes. */
function rawProbeKeyCount(chunk: string, probe: ProbeName): number {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.trim() === `${probe}:`).length;
}

/**
 * Assert one probe block against its expectation: absent when disabled,
 * otherwise carrying the fixed `httpGet` block and exactly the five expected
 * field values.
 */
function assertProbe(
  container: Record<string, unknown>,
  chunk: string,
  probe: ProbeName,
  expected: ProbeExpectation,
): void {
  const rendered = container[probe];
  const rawCount = rawProbeKeyCount(chunk, probe);

  if (!expected.enabled) {
    expect(probe in container, `${probe} must be absent when ${probe}.enabled is false`).toBe(
      false,
    );
    expect(rawCount, `${probe}: must not appear in the rendered bytes\n${chunk}`).toBe(0);
    return;
  }

  expect(rawCount, `exactly one ${probe}: line expected\n${chunk}`).toBe(1);
  expect(isMapping(rendered), `${probe} is not a mapping: ${String(rendered)}`).toBe(true);
  const block = rendered as Record<string, unknown>;

  expect(block['httpGet'], `${probe}.httpGet`).toEqual({ ...EXPECTED_HTTP_GET });

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (key !== 'httpGet') {
      fields[key] = value;
    }
  }
  const expectedFields: Record<string, number> = {};
  for (const field of PROBE_FIELDS) {
    expectedFields[field] = expected[field];
  }
  // toEqual on the whole set, so a sixth field the chart invented also fails.
  expect(fields, `${probe} numeric fields`).toEqual(expectedFields);
}

/** One field override: which probe, which field, and the value it moves to. */
interface FieldOverride {
  probe: ProbeName;
  field: ProbeField;
  value: number;
}

/**
 * A single field on a single probe, moved to a value inside Requirement 6.9's
 * bounds and different from the chart default.
 *
 * The inequality filter is what keeps the property from passing vacuously: an
 * override equal to the default would satisfy "this field changed" and "every
 * other field stayed" simultaneously even if the template read the wrong
 * value key.
 */
const fieldOverrideArb: fc.Arbitrary<FieldOverride> = fc
  .tuple(fc.constantFrom(...PROBE_NAMES), fc.constantFrom(...PROBE_FIELDS))
  .chain(([probe, field]) =>
    fc
      .integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX })
      .filter((value) => value !== defaultProbes[probe][field])
      .map((value) => ({ probe, field, value })),
  );

/** Five field values, independently generated, for one probe block. */
const probeFieldValuesArb: fc.Arbitrary<ProbeFieldValues> = fc.record({
  initialDelaySeconds: fc.integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX }),
  periodSeconds: fc.integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX }),
  timeoutSeconds: fc.integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX }),
  successThreshold: fc.integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX }),
  failureThreshold: fc.integer({ min: PROBE_FIELD_MIN, max: PROBE_FIELD_MAX }),
});

/** All four enabled combinations, so none is left to chance across iterations. */
const ENABLED_PAIRS: [boolean, boolean][] = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];

const enabledPairArb: fc.Arbitrary<[boolean, boolean]> = fc.constantFrom(...ENABLED_PAIRS);

describe('Property 10: probe fields and probe blocks are independently controlled', () => {
  it('moves only the overridden field and leaves all nine others at their defaults', () => {
    fc.assert(
      fc.property(fieldOverrideArb, ({ probe, field, value }) => {
        const result = renderChart(setPath(`${probe}.${field}`, value));
        expect(result.status, result.stderr).toBe(0);

        const container = appContainer(result.docs);
        const chunk = deploymentChunk(result.stdout);

        // The overridden probe: the named field moves, the other four do not.
        assertProbe(container, chunk, probe, {
          enabled: true,
          ...defaultProbes[probe],
          [field]: value,
        } as ProbeExpectation);

        // The untouched probe: all five fields still at their chart defaults.
        const other = otherProbe(probe);
        assertProbe(container, chunk, other, {
          enabled: true,
          ...defaultProbes[other],
        });
      }),
      assertConfig,
    );
  });

  it('renders each probe block exactly when its own enabled flag is true', () => {
    fc.assert(
      fc.property(
        enabledPairArb,
        probeFieldValuesArb,
        probeFieldValuesArb,
        ([readinessEnabled, livenessEnabled], readinessFields, livenessFields) => {
          const result = renderChart({
            readinessProbe: { enabled: readinessEnabled, ...readinessFields },
            livenessProbe: { enabled: livenessEnabled, ...livenessFields },
          });
          expect(result.status, result.stderr).toBe(0);

          const container = appContainer(result.docs);
          const chunk = deploymentChunk(result.stdout);

          // Each flag gates its own block only: whichever probe survives keeps
          // the full configuration it was given (Requirements 6.7, 6.8).
          assertProbe(container, chunk, 'readinessProbe', {
            enabled: readinessEnabled,
            ...readinessFields,
          });
          assertProbe(container, chunk, 'livenessProbe', {
            enabled: livenessEnabled,
            ...livenessFields,
          });
        },
      ),
      assertConfig,
    );
  });
});
