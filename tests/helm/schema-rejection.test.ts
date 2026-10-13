/**
 * Feature: helm-chart-deployment
 *
 * Property 16: Every schema constraint rejects before any template runs
 *
 * *For any* values document that violates a declared `values.schema.json`
 * constraint - a wrong JSON type, a value outside an enumerated set, a number
 * outside its declared bounds, a string past its maximum length, a
 * `config.basePath` failing the leading-slash pattern, or an absent member of
 * the top-level `required` set - `helm template` exits non-zero, writes a
 * message naming the offending property path together with the constraint it
 * failed, and emits zero Kubernetes resource manifests.
 *
 * **Validates: Requirements 1.13, 4.8, 5.12, 6.9, 6.10, 7.9, 10.2, 11.7, 11.9, 11.10**
 *
 * ## Why "before rendering" is the interesting half
 *
 * A non-zero exit on its own would be satisfied by a chart that renders half a
 * manifest stream and then aborts - and `helm install` would have fed that
 * partial stream to the API server. So each iteration checks the *absence* of
 * output two ways that do not share a code path: `result.docs`, which the
 * harness empties on a failed render, and an independent parse of the raw
 * `stdout` the harness captured. The second one is what actually carries the
 * claim; the first would pass vacuously by construction.
 *
 * ## Keeping the schema layer apart from the guard layer
 *
 * The chart rejects bad values twice: `values.schema.json` first, then the
 * `scrum-poker.validate` cross-field guards during template execution. Both
 * exit non-zero, so "it failed" cannot tell them apart. The schema layer is
 * identified positively - Helm's `values don't meet the specifications of the
 * schema` banner plus a JSON-schema constraint phrase on the line naming the
 * path - and the guard layer is excluded explicitly: a guard aborts from
 * inside a template, which Helm reports as `execution error at
 * (scrum-poker/templates/...)`. A violation that reached a guard would
 * therefore fail this property rather than pass it by accident.
 *
 * ## Cases this property does *not* make
 *
 * `resources.*.cpu: ""` and `resources.*.memory: null` are **accepted** by the
 * committed schema, on purpose: an operator drops a resource leaf by emptying
 * or nulling it and the templates omit the leaf that carries no value
 * (Requirement 7.1, asserted by `conditional-omission.test.ts`). The resource
 * leaves are exercised here through a non-string value instead, which the
 * `["string","null"]` type does reject. `deploymentStrategy.type` is likewise
 * absent: the schema types it as a string and leaves the permitted set to
 * guard 5, so it belongs to Property 15.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import { renderChart, setPath } from './support/render-chart.js';
import {
  assertConfig,
  schemaViolationArb,
  type SchemaViolation,
} from './support/generators.js';

/** Helm's banner for a values document the chart's JSON schema rejected. */
const SCHEMA_REJECTION_BANNER = /values don't meet the specifications of the schema/;

/**
 * How Helm reports a `fail` raised from inside a template - the shape the
 * `scrum-poker.validate` guards produce. Its presence means the render got
 * past the schema, which this property forbids.
 */
const TEMPLATE_EXECUTION_ERROR = /execution error at \(scrum-poker[/\\]templates[/\\]/;

/**
 * Any trace of a rendered resource in the raw output: a document header Helm
 * writes per template, or the first line of a Kubernetes object.
 */
const MANIFEST_TOKEN = /^(?:# Source:|apiVersion:|kind:)/m;

/** The JSON-schema phrase Helm emits for each kind of constraint. */
const CONSTRAINT_EVIDENCE: Record<SchemaViolation['constraint'], RegExp> = {
  type: /Invalid type\. Expected: .+, given: .+/,
  enum: /must be one of the following:/,
  minimum: /Must be greater than or equal to -?\d+/,
  maximum: /Must be less than or equal to -?\d+/,
  minLength: /String length must be greater than or equal to \d+/,
  maxLength: /String length must be less than or equal to \d+/,
  pattern: /Does not match pattern/,
  required: /is required/,
};

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The error line that must name the offending path.
 *
 * Helm reports a constraint failure as `- <path>: <reason>` and an absent
 * required member as `- (root): <name> is required`, so the two are matched
 * differently - but both must name the path, which is the half Requirements
 * 11.7, 11.9 and 11.10 are about.
 */
function pathNamingLine(violation: SchemaViolation): RegExp {
  const path = escapeForRegExp(violation.path);
  return violation.constraint === 'required'
    ? new RegExp(`${path} is required`)
    : new RegExp(`(?:^|[\\s-])${path}:`);
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

/** Assert Property 16 over a single violating values document. */
function assertRejectedBeforeRendering(violation: SchemaViolation): void {
  const values = setPath(violation.path, violation.value);
  const context = `${violation.path} = ${JSON.stringify(violation.value) ?? 'null'} (${violation.constraint})`;
  const result = renderChart(values);

  expect(
    result.status,
    `${context}: the schema accepted it - helm exited 0\n${result.stdout.slice(0, 400)}`,
  ).not.toBe(0);

  const message = result.stderr;

  // Positively the schema layer, not the cross-field guards that reject the
  // same kinds of value one layer later with a different message shape.
  expect(message, `${context}: not reported as a schema rejection\n${message}`).toMatch(
    SCHEMA_REJECTION_BANNER,
  );
  expect(
    message,
    `${context}: a template ran before the values were rejected\n${message}`,
  ).not.toMatch(TEMPLATE_EXECUTION_ERROR);

  // The message names the offending path, and names the constraint on that
  // same line - so a message about some other path cannot satisfy both.
  const offendingLine = message
    .split('\n')
    .find((line) => pathNamingLine(violation).test(line));
  expect(
    offendingLine,
    `${context}: no error line names the values path\n${message}`,
  ).toBeDefined();
  expect(
    offendingLine as string,
    `${context}: the line naming the path does not state the ${violation.constraint} constraint`,
  ).toMatch(CONSTRAINT_EVIDENCE[violation.constraint]);

  // Nothing was rendered. `docs` is emptied by the harness on a failed render,
  // so the raw stdout carries the claim.
  expect(result.docs, `${context}: documents survived a rejected render`).toEqual([]);
  expect(
    result.stdout,
    `${context}: a resource reached stdout despite the rejection\n${result.stdout.slice(0, 400)}`,
  ).not.toMatch(MANIFEST_TOKEN);
  expect(
    documentsInStdout(result.stdout),
    `${context}: stdout parsed to a manifest despite the rejection`,
  ).toEqual([]);
}

describe('Property 16: every schema constraint rejects before any template runs', () => {
  it('rejects a violating values document with no manifest and a message naming the path', () => {
    fc.assert(
      fc.property(schemaViolationArb, (violation) => {
        assertRejectedBeforeRendering(violation);
      }),
      {
        ...assertConfig,
        examples: [
          // One case per constraint kind, so a sampling run that happened to
          // miss a kind still exercises it.
          [{ path: 'replicaCount', value: 'one', constraint: 'type' }],
          [{ path: 'image.pullPolicy', value: 'Sometimes', constraint: 'enum' }],
          [{ path: 'service.nodePort', value: 100, constraint: 'minimum' }],
          [{ path: 'service.port', value: 65_536, constraint: 'maximum' }],
          [{ path: 'tmpVolume.sizeLimit', value: '', constraint: 'minLength' }],
          [{ path: 'auth.jwtSecret', value: 's'.repeat(257), constraint: 'maxLength' }],
          [{ path: 'config.basePath', value: 'scrum-poker', constraint: 'pattern' }],
          // An absent member of the top-level required set, reached the way an
          // operator reaches it: a values file that nulls the key.
          [{ path: 'image', value: null, constraint: 'required' }],
          [{ path: 'replicaCount', value: null, constraint: 'required' }],
          // The resource leaves, whose empty and null states are accepted by
          // design - a non-string is what the type rejects.
          [{ path: 'resources.requests.cpu', value: 128, constraint: 'type' }],
          [{ path: 'resources.limits.cpu', value: true, constraint: 'type' }],
        ] as [SchemaViolation][],
      },
    );
  });

  it('accepts the chart defaults, so every rejection above came from the violating value', () => {
    // Requirement 11.1, and the non-vacuity check for this property: a chart
    // that failed to render at all would satisfy every assertion above.
    const result = renderChart({});

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(documentsInStdout(result.stdout).length).toBeGreaterThan(0);
  });
});
