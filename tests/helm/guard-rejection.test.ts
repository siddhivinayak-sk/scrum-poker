/**
 * Feature: helm-chart-deployment - task 13.5, Property 15.
 *
 * Property 15: Every guard rejects cleanly, names its value, and emits nothing
 *
 * *For any* values document that violates exactly one of the 13 cross-field
 * guards - a `replicaCount` below 1 or non-integer, `autoscaling.enabled`
 * true, an empty `image.repository`, an out-of-set `image.pullPolicy` or
 * `deploymentStrategy.type`, a `config.basePath` without a leading `/` or with
 * a trailing `/`, an `extraEnv` entry with a missing or empty `name`, both
 * `auth.jwtSecret` and `auth.existingSecret` non-empty, an out-of-range
 * `service.nodePort` with `service.type` of `NodePort`, an enabled ingress
 * with zero host entries, a host entry with an absent or empty `paths` list,
 * or a base-path mismatch - rendering exits with a non-zero status, writes a
 * message naming the offending value path, and emits zero Kubernetes resource
 * manifests on standard output.
 *
 * **Validates: Requirements 2.16, 3.10, 4.9, 4.10, 4.12, 5.11, 8.14, 9.6, 9.7, 10.7, 10.8**
 *
 * ## Two layers reject, and only one invariant spans both
 *
 * The chart validates twice. `values.schema.json` runs *before* any template,
 * so a violation it can express on a single field never reaches the guard that
 * repeats the same rule - an out-of-range `service.nodePort` or an
 * out-of-set `image.pullPolicy` is rejected by the schema, with a JSON-schema
 * message, not by guard 10 or guard 4. The guards are the second layer: they
 * carry the cross-field semantics the schema cannot express, and they still
 * hold when the schema is bypassed (a vendored copy of the templates, or a
 * release installed with schema validation skipped).
 *
 * So the property asserts, for every generated violation, only what holds of
 * both layers:
 *
 *   1. `helm template` exits non-zero;
 *   2. zero manifests reach standard output;
 *   3. the error message names the offending `values` path.
 *
 * Message *wording* is then asserted per layer, after the layer is identified
 * from the output - never assumed. `EXPECTED_LAYER` records which layer owns
 * each guard today, so the layer-specific half of the assertion can never go
 * vacuous: were the schema to stop pre-empting guard 10, or a guard to start
 * firing where the schema used to, the attribution assertion fails rather than
 * the test quietly checking nothing.
 *
 * ## Why "emits nothing" is the load-bearing half
 *
 * A non-zero exit alone would be satisfied by a chart that streamed half its
 * manifests and then aborted - and `helm install` would have handed that
 * partial stream to the API server. Absence of output is therefore checked two
 * ways that share no code path: `result.docs`, which the harness empties on a
 * failed render, and an independent parse of the raw `stdout` the harness
 * captured. The second one carries the claim; the first would pass by
 * construction.
 *
 * Nothing here contacts a Kubernetes API server: `helm template` renders
 * locally (Requirement 12.2).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import { renderChart } from './support/render-chart.js';
import { assertConfig, guardViolationArb, type GuardViolation } from './support/generators.js';

/** Helm's banner for a values document `values.schema.json` rejected. */
const SCHEMA_REJECTION_BANNER = /values don't meet the specifications of the schema/;

/** How Helm reports a `fail` raised from inside a template - the guard shape. */
const TEMPLATE_EXECUTION_ERROR = /execution error at \(scrum-poker[/\\]templates[/\\]/;

/**
 * Any trace of a rendered resource in the raw output: the `# Source:` header
 * Helm writes per template, or the first line of a Kubernetes object.
 */
const MANIFEST_TOKEN = /^(?:# Source:|apiVersion:|kind:)/m;

/** The JSON-schema reason phrases, as a single alternation. */
const SCHEMA_CONSTRAINT_EVIDENCE =
  /Invalid type\. Expected:|must be one of the following:|Must be (?:greater|less) than or equal to|String length must be (?:greater|less) than or equal to|Does not match pattern|is required/;

type Layer = 'schema' | 'guard';

/**
 * Which layer rejects each guard's violating values today.
 *
 * Guards 1, 3, 4, 6 and 10 restate a rule `values.schema.json` can express on
 * a single field - `minimum`, `minLength`, `enum`, `pattern`, numeric bounds -
 * so layer 1 always speaks first and the guard never runs on these inputs.
 * The remaining guards are either cross-field (9, 13), list-shaped (8, 11, 12),
 * or deliberately left out of the schema (2's `enabled` is a plain boolean;
 * 5's `deploymentStrategy.type` is typed a string with the permitted set left
 * to the guard; 7's trailing-slash rule is not expressible in the `^$|^/`
 * pattern), so layer 2 owns them.
 */
const EXPECTED_LAYER: Record<number, Layer> = {
  1: 'schema',
  2: 'guard',
  3: 'schema',
  4: 'schema',
  5: 'guard',
  6: 'schema',
  7: 'guard',
  8: 'guard',
  9: 'guard',
  10: 'schema',
  11: 'guard',
  12: 'guard',
  13: 'guard',
};

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The shape of an error line that names a values path.
 *
 * Both layers write `<path>: <reason>`, and both decorate the path with list
 * indices or a sub-key before the colon - `extraEnv[0].name:` from guard 8,
 * `ingress.hosts[0]:` from guard 12, `image.repository:` from the schema. The
 * optional decoration is therefore part of the pattern, and the colon is
 * required so a message about some neighbouring path cannot satisfy it.
 */
function pathNamingPattern(valuesPath: string): RegExp {
  const escaped = escapeForRegExp(valuesPath);
  return new RegExp(`(?:^|[\\s-])${escaped}(?:\\[\\d+\\]|\\.[A-Za-z0-9_-]+)*:`);
}

/**
 * Helm reports an absent member of the top-level `required` set as
 * `- (root): <name> is required`, which names the path without a colon after
 * it. That is how a values file *deleting* a key is reported, and guard 1's
 * `replicaCount: null` case takes exactly that route.
 */
function requiredNamingPattern(valuesPath: string): RegExp {
  return new RegExp(`${escapeForRegExp(valuesPath)} is required`);
}

/** Parse the raw stdout independently of the harness's own `docs` shortcut. */
function documentsInStdout(stdout: string): unknown[] {
  const docs: unknown[] = [];
  for (const document of parseAllDocuments(stdout)) {
    const value: unknown = document.toJS({ maxAliasCount: -1 });
    if (value !== null && value !== undefined) {
      docs.push(value);
    }
  }
  return docs;
}

function describeViolation(violation: GuardViolation): string {
  return `guard ${violation.guard} (${violation.valuesPath}) with ${JSON.stringify(violation.values)}`;
}

/** Assert Property 15 over a single violating values document, from one render. */
function assertGuardRejectsCleanly(violation: GuardViolation): void {
  const context = describeViolation(violation);
  const result = renderChart(violation.values);
  const message = result.stderr;

  // 1. Non-zero exit.
  expect(
    result.status,
    `${context}: the chart accepted it - helm exited 0\n${result.stdout.slice(0, 400)}`,
  ).not.toBe(0);

  // 2. Zero manifests. `docs` is emptied by the harness on a failed render, so
  // the independent parse of raw stdout is what carries the claim.
  expect(result.docs, `${context}: documents survived a rejected render`).toEqual([]);
  expect(
    result.stdout,
    `${context}: a resource reached stdout despite the rejection\n${result.stdout.slice(0, 400)}`,
  ).not.toMatch(MANIFEST_TOKEN);
  expect(
    documentsInStdout(result.stdout),
    `${context}: stdout parsed to a manifest despite the rejection`,
  ).toEqual([]);

  // 3. The message names the offending values path - the half that holds of
  // both validation layers.
  const namesPath =
    pathNamingPattern(violation.valuesPath).test(message) ||
    requiredNamingPattern(violation.valuesPath).test(message);
  expect(
    namesPath,
    `${context}: no error line names the values path\n${message}`,
  ).toBe(true);

  // The rejection came from validation, not from an unrelated template crash.
  const isSchemaLayer = SCHEMA_REJECTION_BANNER.test(message);
  const isGuardLayer = TEMPLATE_EXECUTION_ERROR.test(message);
  expect(
    isSchemaLayer || isGuardLayer,
    `${context}: rejected, but not by either validation layer\n${message}`,
  ).toBe(true);
  expect(
    isSchemaLayer && isGuardLayer,
    `${context}: reported as both a schema rejection and a guard failure\n${message}`,
  ).toBe(false);

  const layer: Layer = isSchemaLayer ? 'schema' : 'guard';
  expect(
    layer,
    `${context}: expected the ${EXPECTED_LAYER[violation.guard]} layer to reject it\n${message}`,
  ).toBe(EXPECTED_LAYER[violation.guard]);

  if (layer === 'schema') {
    // Layer 1 states the JSON-schema constraint on the line naming the path.
    const offendingLine = message
      .split('\n')
      .find(
        (line) =>
          pathNamingPattern(violation.valuesPath).test(line) ||
          requiredNamingPattern(violation.valuesPath).test(line),
      );
    expect(
      offendingLine as string,
      `${context}: the line naming the path states no schema constraint\n${message}`,
    ).toMatch(SCHEMA_CONSTRAINT_EVIDENCE);
    return;
  }

  // Layer 2: the guard message opens with the values path, in the
  // "<values.path>: <what is wrong> (<what is permitted>)" shape every guard
  // follows, so an operator can read the fix off the message.
  expect(
    message,
    `${context}: the guard message does not open with the values path\n${message}`,
  ).toMatch(new RegExp(`\\): ${escapeForRegExp(violation.valuesPath)}(?:\\[\\d+\\]|\\.[A-Za-z0-9_-]+)*:`));

  // Guard 9 names both halves of the mutual exclusion (Requirement 5.11).
  if (violation.alsoNames !== undefined) {
    expect(
      message,
      `${context}: the message does not also name ${violation.alsoNames}\n${message}`,
    ).toContain(violation.alsoNames);
  }

  // Guards 12 and 13 name the zero-based ingress.hosts index, because with
  // several host entries the operator needs to know which one is at fault
  // (Requirements 9.7, 9.3).
  if (violation.hostIndex !== undefined) {
    expect(
      message,
      `${context}: the message does not name ingress.hosts[${violation.hostIndex}]\n${message}`,
    ).toMatch(new RegExp(`ingress\\.hosts\\[${violation.hostIndex}\\]`));
  }
}

/** One deterministic case per guard, so a sampling run cannot miss a guard. */
const perGuardExamples: [GuardViolation][] = [
  [{ guard: 1, valuesPath: 'replicaCount', values: { replicaCount: 0 } }],
  // The route an operator takes to delete a default: null, which Helm's
  // coalesce drops, so the key goes absent from the merged document.
  [{ guard: 1, valuesPath: 'replicaCount', values: { replicaCount: null } }],
  [{ guard: 1, valuesPath: 'replicaCount', values: { replicaCount: 1.5 } }],
  [{ guard: 2, valuesPath: 'autoscaling.enabled', values: { autoscaling: { enabled: true } } }],
  [{ guard: 3, valuesPath: 'image.repository', values: { image: { repository: '' } } }],
  [{ guard: 4, valuesPath: 'image.pullPolicy', values: { image: { pullPolicy: 'always' } } }],
  [
    {
      guard: 5,
      valuesPath: 'deploymentStrategy.type',
      values: { deploymentStrategy: { type: 'recreate' } },
    },
  ],
  [
    {
      guard: 6,
      valuesPath: 'config.basePath',
      values: { config: { basePath: 'scrum-poker' }, ingress: { enabled: false } },
    },
  ],
  [
    {
      guard: 7,
      valuesPath: 'config.basePath',
      values: { config: { basePath: '/scrum-poker/' }, ingress: { enabled: false } },
    },
  ],
  [{ guard: 8, valuesPath: 'extraEnv', values: { extraEnv: [{ name: '', value: 'x' }] } }],
  [
    {
      guard: 9,
      valuesPath: 'auth.jwtSecret',
      alsoNames: 'auth.existingSecret',
      values: { auth: { jwtSecret: 'a-signing-key', existingSecret: 'jwt-keys' } },
    },
  ],
  [
    {
      guard: 10,
      valuesPath: 'service.nodePort',
      values: { service: { type: 'NodePort', nodePort: 100 } },
    },
  ],
  [{ guard: 11, valuesPath: 'ingress.hosts', values: { ingress: { enabled: true, hosts: [] } } }],
  [
    {
      // A second host entry is the one that is short, so the index in the
      // message has to be read rather than guessed.
      guard: 12,
      valuesPath: 'ingress.hosts',
      hostIndex: 1,
      values: {
        config: { basePath: '/scrum-poker', preservePath: true },
        ingress: {
          enabled: true,
          hosts: [
            { host: 'poker.example.com', paths: [{ path: '/scrum-poker', pathType: 'Prefix' }] },
            { host: '', paths: [] },
          ],
        },
      },
    },
  ],
  [
    {
      guard: 13,
      valuesPath: 'config.basePath',
      hostIndex: 0,
      values: {
        config: { basePath: '/scrum-poker', preservePath: true },
        ingress: {
          enabled: true,
          hosts: [{ host: '', paths: [{ path: '/elsewhere', pathType: 'Prefix' }] }],
        },
      },
    },
  ],
];

describe('Property 15: every guard rejects cleanly, names its value, and emits nothing', () => {
  it('rejects a violating values document with no manifest and a message naming the path', () => {
    fc.assert(
      fc.property(guardViolationArb, (violation) => {
        assertGuardRejectsCleanly(violation);
      }),
      { ...assertConfig, examples: perGuardExamples },
    );
  });

  it('accepts the chart defaults, so every rejection above came from the violating value', () => {
    // Non-vacuity: a chart that failed to render at all would satisfy every
    // assertion above.
    const result = renderChart({});

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(documentsInStdout(result.stdout).length).toBeGreaterThan(0);
  });
});
