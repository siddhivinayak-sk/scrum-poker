/**
 * Feature: helm-chart-deployment
 *
 * Property 11: The tmp volume and its mount appear and disappear together
 *
 * *For any* `securityContext.readOnlyRootFilesystem` value and *any*
 * `tmpVolume.sizeLimit` value, the rendered Pod contains an `emptyDir` volume
 * named `tmp` with that `sizeLimit` and a container `volumeMount` of the same
 * name at `/tmp` when the flag is `true`, and contains neither the volume nor
 * the mount when the flag is anything else - the two never appear apart.
 *
 * **Validates: Requirements 7.6, 7.7**
 *
 * The two halves sit in different parts of the Pod specification - `volumes`
 * under `spec.template.spec`, `volumeMounts` under the container - so they are
 * exactly the kind of pair that drifts apart under editing. Either half alone
 * is a defect with teeth: a read-only root filesystem with no writable `/tmp`
 * crash-loops the Node.js process on EROFS, and a volume with no mount is dead
 * weight the API server happily stores. So the pairing is asserted as its own
 * equality, *before* the expectation keyed on the flag, which keeps a
 * half-rendered Pod reporting "pairing broken" rather than a confusing
 * `sizeLimit` mismatch.
 *
 * ## Expressing "the flag is anything else"
 *
 * `false` reaches the chart through an ordinary `-f` override. The other two
 * states need more care, because Helm *coalesces* a values file over the chart
 * defaults:
 *
 *   - **Key absent.** Writing `readOnlyRootFilesystem: null` in the override
 *     deletes the chart's default rather than setting a null, so the template's
 *     field lookup returns nil. That is the state an operator reaches by
 *     commenting the line out.
 *   - **Empty or nil `securityContext`.** An override of `securityContext: {}`
 *     does *not* reach the chart as an empty mapping - coalesce fills the
 *     defaults back in, so the render is indistinguishable from supplying
 *     nothing. The only way to express it is to change the default itself, so
 *     those cases copy the chart to a temporary directory and rewrite the
 *     copy's `values.yaml`. Nothing under `helm/scrum-poker/` is touched.
 *
 * The nil variant is worth its own case: an operator who writes
 * `securityContext:` with nothing indented under it leaves the key nil, and a
 * field lookup on nil aborts a Helm render outright unless the template guards
 * it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import {
  chartDir,
  chartValuesFile,
  defaultNamespace,
  defaultReleaseName,
  helmBinary,
  renderChart,
  stringifyValues,
  withDefaults,
  type RenderResult,
} from './support/render-chart.js';
import { assertConfig } from './support/generators.js';

/** The volume and mount name the chart renders (Requirement 7.6). */
const TMP_NAME = 'tmp';

/** The container path the scratch volume is mounted on (Requirement 7.6). */
const TMP_MOUNT_PATH = '/tmp';

/** `tmpVolume.sizeLimit` default in `values.yaml` (Requirement 7.6). */
const DEFAULT_SIZE_LIMIT = '64Mi';

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
 * How the copied chart's `values.yaml` declares `securityContext`.
 *
 * `empty-mapping` writes `securityContext: {}`, `nil` writes the key with a
 * null value, and `absent` removes the key outright.
 */
type SecurityContextDefault = 'empty-mapping' | 'nil' | 'absent';

/**
 * Render a copy of the chart whose `values.yaml` declares `securityContext` in
 * the given state, with `values` layered over it as an operator's `-f` file.
 *
 * The copy exists because Helm's coalesce makes an override of `{}` or `null`
 * indistinguishable from supplying nothing: the chart defaults come back. The
 * chart is a handful of small files, so copying it costs far less than the
 * `helm template` spawn it feeds.
 */
function renderWithSecurityContextDefault(
  variant: SecurityContextDefault,
  values: Record<string, unknown> = {},
): RenderResult {
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-sc-'));
  try {
    const chartCopy = path.join(workDir, 'scrum-poker');
    cpSync(chartDir, chartCopy, { recursive: true });

    const documents = parseAllDocuments(readFileSync(chartValuesFile, 'utf8'));
    const first = documents[0];
    if (!first) {
      throw new Error(`no YAML document found in ${chartValuesFile}`);
    }
    const chartValues = first.toJS({ maxAliasCount: -1 }) as Record<string, unknown>;
    if (variant === 'absent') {
      delete chartValues['securityContext'];
    } else {
      chartValues['securityContext'] = variant === 'nil' ? null : {};
    }
    writeFileSync(path.join(chartCopy, 'values.yaml'), stringifyValues(chartValues), 'utf8');

    const valuesFile = path.join(workDir, 'values.yaml');
    writeFileSync(valuesFile, stringifyValues(values), 'utf8');

    const result = spawnSync(
      helmBinary(),
      [
        'template',
        defaultReleaseName,
        chartCopy,
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
    const stderr = result.stderr ?? '';
    return { status, stdout, stderr, docs: status === 0 ? parseManifestStream(stdout) : [] };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** The single Deployment in the stream, with the "exactly one" check applied. */
function soleDeployment(docs: unknown[], context: string): Record<string, unknown> {
  const deployments = docs.filter(isMapping).filter((doc) => doc['kind'] === 'Deployment');
  // Guards against a vacuous pass: a render that emitted no Deployment would
  // otherwise satisfy every absence assertion below.
  expect(deployments.length, `${context}: exactly one Deployment renders`).toBe(1);
  return deployments[0] as Record<string, unknown>;
}

/** The single application container, with the "exactly one" check applied. */
function soleContainer(podSpec: Record<string, unknown>, context: string): Record<string, unknown> {
  const containers = podSpec['containers'];
  expect(Array.isArray(containers), `${context}: spec.containers is a list`).toBe(true);
  const mappings = (containers as unknown[]).filter(isMapping);
  expect(mappings.length, `${context}: exactly one container renders`).toBe(1);
  return mappings[0] as Record<string, unknown>;
}

/**
 * A `volumes` or `volumeMounts` field, normalised to a list or `undefined`.
 *
 * A present-but-empty list and a null both fail here rather than being read as
 * "absent": the chart omits the key, and `volumes: []` is a value the API
 * server stores and then surfaces on every subsequent read.
 */
function collectionOrAbsent(value: unknown, where: string): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  expect(Array.isArray(value), `${where} rendered as ${JSON.stringify(value)}, not a list`).toBe(
    true,
  );
  const list = value as unknown[];
  expect(list.length, `${where} rendered as an empty list instead of being omitted`).toBeGreaterThan(
    0,
  );
  return list;
}

function entriesNamed(list: unknown[] | undefined, name: string): Record<string, unknown>[] {
  return (list ?? []).filter(isMapping).filter((entry) => entry['name'] === name);
}

interface TmpExpectation {
  /** Whether the volume/mount pair should be rendered at all. */
  present: boolean;
  /** Resolved `tmpVolume.sizeLimit`, required when `present`. */
  sizeLimit?: string;
}

/** Assert Property 11 over a single render. */
function assertTmpPairing(
  result: RenderResult,
  expected: TmpExpectation,
  context: string,
): void {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

  const deployment = soleDeployment(result.docs, context);
  const podSpec = getPath(deployment, 'spec.template.spec');
  expect(isMapping(podSpec), `${context}: spec.template.spec is a mapping`).toBe(true);
  const container = soleContainer(podSpec as Record<string, unknown>, context);

  const volumes = collectionOrAbsent(
    (podSpec as Record<string, unknown>)['volumes'],
    `${context}: spec.template.spec.volumes`,
  );
  const mounts = collectionOrAbsent(
    container['volumeMounts'],
    `${context}: container volumeMounts`,
  );

  const tmpVolumes = entriesNamed(volumes, TMP_NAME);
  const tmpMounts = entriesNamed(mounts, TMP_NAME);

  // The pairing itself, independent of what the flag says it should be.
  expect(
    tmpMounts.length,
    `${context}: the volume and its mount came apart - ${tmpVolumes.length} "${TMP_NAME}" ` +
      `volume(s) but ${tmpMounts.length} "${TMP_NAME}" mount(s)`,
  ).toBe(tmpVolumes.length);

  if (!expected.present) {
    expect(
      tmpVolumes.length,
      `${context}: readOnlyRootFilesystem is not true, so neither half may render`,
    ).toBe(0);
    return;
  }

  expect(tmpVolumes.length, `${context}: exactly one "${TMP_NAME}" volume renders`).toBe(1);
  const [volume] = tmpVolumes;
  const [mount] = tmpMounts;
  if (!volume || !mount) {
    throw new Error(`${context}: the "${TMP_NAME}" volume/mount pair is missing after the count check`);
  }

  const emptyDir = volume['emptyDir'];
  expect(
    isMapping(emptyDir),
    `${context}: the "${TMP_NAME}" volume is not an emptyDir: ${JSON.stringify(volume)}`,
  ).toBe(true);
  expect(
    (emptyDir as Record<string, unknown>)['sizeLimit'],
    `${context}: sizeLimit must come from tmpVolume.sizeLimit, as a string`,
  ).toBe(expected.sizeLimit);

  expect(mount['mountPath'], `${context}: the mount must land on ${TMP_MOUNT_PATH}`).toBe(
    TMP_MOUNT_PATH,
  );
}

/**
 * The three states of `securityContext.readOnlyRootFilesystem` an operator can
 * reach through a values file. `null` deletes the chart's default, which is the
 * state reached by commenting the line out.
 */
const readOnlyRootArb: fc.Arbitrary<boolean | null> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<boolean | null>(true) },
  { weight: 2, arbitrary: fc.constant<boolean | null>(false) },
  { weight: 1, arbitrary: fc.constant<boolean | null>(null) },
);

/**
 * The rest of `securityContext`, varied independently so the property shows
 * that only `readOnlyRootFilesystem` decides the volume. `fc.record` with no
 * required keys omits fields outright, which exercises the defaults coming
 * through coalesce alongside them.
 */
const otherSecurityContextFieldsArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    runAsNonRoot: fc.boolean(),
    runAsUser: fc.integer({ min: 1, max: 65_535 }),
    allowPrivilegeEscalation: fc.boolean(),
  },
  { requiredKeys: [] },
);

/**
 * Quantity strings for `tmpVolume.sizeLimit`. The chart quotes the value, so
 * the plain-decimal and `1e3`-free forms below must come back as *strings*
 * rather than as numbers - `sizeLimit: 1000000` unquoted parses to an integer,
 * which is not a valid quantity in the Kubernetes API. The schema constrains
 * the value to a non-empty string, so no empty or absent variant is generated.
 */
const sizeLimitArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('16Mi', DEFAULT_SIZE_LIMIT, '128Mi', '1Gi') },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 4096 }).map((mebi) => `${mebi}Mi`) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 64 }).map((gibi) => `${gibi}Gi`) },
  // Quantity forms whose rendering would change type if the chart stopped
  // quoting: bare decimal bytes, and the decimal SI suffixes.
  { weight: 1, arbitrary: fc.constantFrom('1000000', '500M', '64Ki', '1G') },
);

describe('Property 11: the tmp volume and its mount appear and disappear together', () => {
  it('renders both halves or neither, keyed on securityContext.readOnlyRootFilesystem', () => {
    fc.assert(
      fc.property(
        readOnlyRootArb,
        otherSecurityContextFieldsArb,
        sizeLimitArb,
        (readOnlyRootFilesystem, otherFields, sizeLimit) => {
          const values = {
            securityContext: { ...otherFields, readOnlyRootFilesystem },
            tmpVolume: { sizeLimit },
          };

          // Resolved the way Helm merges a -f file over the defaults, so the
          // expectation is read from the same document the chart sees rather
          // than from the patch.
          const resolvedFlag = getPath(
            withDefaults(values),
            'securityContext.readOnlyRootFilesystem',
          );

          assertTmpPairing(
            renderChart(values),
            { present: resolvedFlag === true, sizeLimit },
            `readOnlyRootFilesystem=${JSON.stringify(readOnlyRootFilesystem)}, ` +
              `sizeLimit="${sizeLimit}", other fields ${JSON.stringify(otherFields)}`,
          );
        },
      ),
      {
        ...assertConfig,
        examples: [
          // The three flag states against the chart's default size.
          [true, {}, DEFAULT_SIZE_LIMIT],
          [false, {}, DEFAULT_SIZE_LIMIT],
          [null, {}, DEFAULT_SIZE_LIMIT],
          // A size that would come back as a number if the chart dropped the
          // quotes, paired with the flag that renders it.
          [true, {}, '1000000'],
          // The flag true while every other securityContext field is set the
          // opposite way from the chart default, so nothing but the flag can
          // be driving the volume.
          [true, { runAsNonRoot: false, allowPrivilegeEscalation: true, runAsUser: 1 }, '1Gi'],
          // The flag false while the rest of the context stays at its
          // hardened default.
          [false, { runAsNonRoot: true, allowPrivilegeEscalation: false, runAsUser: 1000 }, '1Gi'],
        ],
      },
    );
  });

  it('renders both halves for the chart as committed', () => {
    assertTmpPairing(
      renderChart({}),
      { present: true, sizeLimit: DEFAULT_SIZE_LIMIT },
      'chart defaults (readOnlyRootFilesystem: true, sizeLimit: 64Mi)',
    );
  });
});

describe('Property 11: an empty, nil, or absent securityContext renders neither half', () => {
  // Each variant is only reachable by changing the chart default: an override
  // of {} or null coalesces the defaults straight back in.
  const variants: SecurityContextDefault[] = ['empty-mapping', 'nil', 'absent'];

  it.each(variants)('omits the volume and the mount for a %s securityContext', (variant) => {
    const result = renderWithSecurityContextDefault(variant, {
      tmpVolume: { sizeLimit: '128Mi' },
    });
    const context = `values.yaml securityContext: ${variant}`;

    assertTmpPairing(result, { present: false }, context);

    // Proves the values.yaml edit actually landed. Without this a copy that
    // silently kept the chart's five default entries would still render the
    // volume, and the assertion above would be the one to fail - with a
    // message pointing at the chart rather than at this harness.
    const deployment = soleDeployment(result.docs, context);
    const podSpec = getPath(deployment, 'spec.template.spec') as Record<string, unknown>;
    expect(
      soleContainer(podSpec, context)['securityContext'],
      `${context}: the container securityContext field is omitted too`,
    ).toBeUndefined();
  });

  it('still renders both halves when only the flag is re-enabled over an empty default', () => {
    // The flag, not the shape of the surrounding mapping, is what decides:
    // an emptied-out chart default plus an operator who asks for a read-only
    // root filesystem gets the scratch volume back.
    assertTmpPairing(
      renderWithSecurityContextDefault('empty-mapping', {
        securityContext: { readOnlyRootFilesystem: true },
        tmpVolume: { sizeLimit: '128Mi' },
      }),
      { present: true, sizeLimit: '128Mi' },
      'values.yaml securityContext: empty-mapping, override readOnlyRootFilesystem: true',
    );
  });
});
