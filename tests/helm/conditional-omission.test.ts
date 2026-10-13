/**
 * Feature: helm-chart-deployment
 *
 * Property 5: An empty or absent optional value omits its key rather than
 * rendering empty or null
 *
 * *For any* assignment in which each of `imagePullSecrets`, `podAnnotations`,
 * `nodeSelector`, `tolerations`, `affinity`, `podSecurityContext`,
 * `securityContext`, `resources` and each of its four leaf entries,
 * `service.annotations`, `service.nodePort`, and `ingress.className` is
 * independently empty, absent, or populated, each corresponding field is
 * present in the rendered output exactly when its input is populated, never
 * renders as `null` or as an empty collection, and leaves behind no empty
 * parent key; and `nodePort` is additionally absent whenever `service.type`
 * differs from `NodePort`, regardless of the value `service.nodePort` holds.
 *
 * **Validates: Requirements 2.17, 3.9, 3.11, 7.1, 7.3, 7.4, 7.8, 8.12**
 *
 * The distinction this property defends is not cosmetic. `nodeSelector: {}`,
 * `imagePullSecrets: []`, and `resources: null` are all accepted by the API
 * server and then *persisted* on the live object, so they come back on every
 * subsequent read: a `helm diff` or a GitOps reconciler sees a field the chart
 * never meant to set, and an empty `resources` block is a different object
 * from no block at all. So every assertion below is "the key is not there",
 * not "the key is falsy".
 *
 * ## Reaching an empty or absent input is the hard part
 *
 * Helm *coalesces* an operator's values file over the chart defaults, which
 * means a values patch cannot express every state:
 *
 *   - **A key absent.** `foo: null` in the override *deletes* the chart's
 *     default, so the template's lookup returns nil. That is the state an
 *     operator reaches by nulling a value out, and it works for every key
 *     here.
 *   - **An empty mapping over a populated default.** An override of
 *     `securityContext: {}` or `resources: {}` does *not* arrive as an empty
 *     mapping - both sides are tables, so coalesce recurses and fills the five
 *     `securityContext` defaults and the four resource quantities straight
 *     back in. The render is then indistinguishable from supplying nothing.
 *   - **An empty mapping, list, or string over an already-empty default.**
 *     This one *does* survive, because there is nothing to coalesce in:
 *     `podAnnotations: {}`, `imagePullSecrets: []`, and `ingress.className: ""`
 *     all reach the chart as written.
 *
 * Every state an override cannot express is reached by copying the chart to a
 * temporary directory and editing the copy's `values.yaml` - the pattern
 * `tmp-volume.test.ts` and `name-bounds.test.ts` already use. Nothing under
 * `helm/scrum-poker/` is written to. Where *both* routes can express a state
 * the route is generated as well, so the property covers the operator who
 * nulls a value out and the operator who forks the chart and deletes the key.
 *
 * ## `podAnnotations` shares its parent
 *
 * The Deployment writes `checksum/config` into the same
 * `spec.template.metadata.annotations` mapping that `podAnnotations` merges
 * into, so "omitted" cannot mean "no annotations key" for that one field. It
 * means the parent carries the computed checksum and nothing else - which is
 * also what proves an empty `podAnnotations` adds no stray key and opens no
 * second `annotations` block.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import {
  chartDir,
  defaultNamespace,
  defaultReleaseName,
  helmBinary,
  loadDefaultValues,
  mergeValues,
  renderChart,
  setPath,
  stringifyValues,
  type RenderResult,
} from './support/render-chart.js';
import { annotationMapArb, assertConfig } from './support/generators.js';

/** Dotted manifest path to the Pod specification. */
const POD_PATH = 'spec.template.spec';

/** Dotted manifest path to the one application container. */
const CONTAINER_PATH = 'spec.template.spec.containers.0';

/** Dotted manifest path to the one Service port entry. */
const SERVICE_PORT_PATH = 'spec.ports.0';

/** The annotation the Deployment computes alongside `podAnnotations`. */
const CHECKSUM_ANNOTATION = 'checksum/config';

/* -------------------------------------------------------------------------- */
/* Manifest reading                                                           */
/* -------------------------------------------------------------------------- */

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk a dotted path, stepping into a list on a numeric segment. */
function getPath(root: unknown, dottedPath: string): unknown {
  let cursor: unknown = root;
  for (const segment of dottedPath.split('.')) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
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
 * The single document of the given kind.
 *
 * The "exactly one" check guards against a vacuous pass: a render that emitted
 * no Deployment would otherwise satisfy every absence assertion in this file.
 */
function soleDocument(docs: unknown[], kind: string, context: string): Record<string, unknown> {
  const matches = docs.filter(isMapping).filter((doc) => doc['kind'] === kind);
  expect(matches.length, `${context}: exactly one ${kind} renders`).toBe(1);
  return matches[0] as Record<string, unknown>;
}

/**
 * What a rendered field looks like, as one word.
 *
 * Only `absent` and `populated` are legal outcomes for the fields in this
 * file; the other four exist so a failure says *which* wrong shape appeared -
 * `null` reads very differently from `empty mapping` when diagnosing a
 * template.
 */
type Shape = 'absent' | 'null' | 'empty mapping' | 'empty list' | 'empty string' | 'populated';

function shapeOf(value: unknown): Shape {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'empty list' : 'populated';
  }
  if (isMapping(value)) {
    return Object.keys(value).length === 0 ? 'empty mapping' : 'populated';
  }
  if (value === '') {
    return 'empty string';
  }
  return 'populated';
}

interface Probe {
  shape: Shape;
  value: unknown;
  /** Where in the manifest the field was looked for, for failure messages. */
  where: string;
}

/** Probe one key of one mapping inside the single document of a kind. */
function keyProbe(
  docs: unknown[],
  kind: string,
  parentPath: string,
  key: string,
  context: string,
): Probe {
  const document = soleDocument(docs, kind, context);
  const parent = getPath(document, parentPath);
  if (!isMapping(parent)) {
    throw new Error(
      `${context}: ${kind} ${parentPath} is not a mapping: ${JSON.stringify(parent)}`,
    );
  }
  return {
    shape: shapeOf(parent[key]),
    value: parent[key],
    where: `${kind} ${parentPath}.${key}`,
  };
}

/**
 * Probe `podAnnotations`, which has no key of its own: the operator's entries
 * and the computed `checksum/config` share one `annotations` mapping, so the
 * probed value is that mapping with the checksum removed.
 */
function podAnnotationsProbe(docs: unknown[], context: string): Probe {
  const deployment = soleDocument(docs, 'Deployment', context);
  const annotations = getPath(deployment, 'spec.template.metadata.annotations');
  // The checksum is unconditional, so a missing or non-mapping parent here is
  // a different defect than an omission failure and is reported as itself.
  expect(
    isMapping(annotations),
    `${context}: spec.template.metadata.annotations is not a mapping: ${JSON.stringify(annotations)}`,
  ).toBe(true);
  const mapping = annotations as Record<string, unknown>;
  expect(
    typeof mapping[CHECKSUM_ANNOTATION],
    `${context}: ${CHECKSUM_ANNOTATION} is missing from the pod annotations`,
  ).toBe('string');
  const { [CHECKSUM_ANNOTATION]: _checksum, ...supplied } = mapping;
  return {
    shape: Object.keys(supplied).length === 0 ? 'absent' : 'populated',
    value: supplied,
    where: 'Deployment spec.template.metadata.annotations (beyond the checksum)',
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering, with the chart's own defaults editable                          */
/* -------------------------------------------------------------------------- */

/** An in-place edit of the chart copy's `values.yaml`. */
type DefaultEdit = (values: Record<string, unknown>) => void;

function setIn(root: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segments = dottedPath.split('.');
  const last = segments[segments.length - 1] as string;
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (isMapping(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  cursor[last] = value;
}

function deleteIn(root: Record<string, unknown>, dottedPath: string): void {
  const segments = dottedPath.split('.');
  const last = segments[segments.length - 1] as string;
  let cursor: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isMapping(cursor)) {
      return;
    }
    cursor = cursor[segment];
  }
  if (isMapping(cursor)) {
    delete cursor[last];
  }
}

/**
 * Render with `overrides` as the operator's `-f` file and `edits` applied to
 * the chart's own defaults.
 *
 * With no default edits this is `renderChart` and touches nothing but a
 * temporary values file. With edits the chart is copied to a temporary
 * directory and the copy's `values.yaml` is rewritten, which is the only way
 * to express a default that is genuinely empty or genuinely absent. The chart
 * is a handful of small files, so the copy costs far less than the
 * `helm template` spawn it feeds.
 */
function render(overrides: Record<string, unknown>, edits: DefaultEdit[]): RenderResult {
  if (edits.length === 0) {
    return renderChart(overrides);
  }
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-omit-'));
  try {
    const chartCopy = path.join(workDir, 'scrum-poker');
    cpSync(chartDir, chartCopy, { recursive: true });

    const chartValues = loadDefaultValues();
    for (const edit of edits) {
      edit(chartValues);
    }
    writeFileSync(path.join(chartCopy, 'values.yaml'), stringifyValues(chartValues), 'utf8');

    const valuesFile = path.join(workDir, 'values.yaml');
    writeFileSync(valuesFile, stringifyValues(overrides), 'utf8');

    const result = spawnSync(
      helmBinary(),
      ['template', defaultReleaseName, chartCopy, '-f', valuesFile, '--namespace', defaultNamespace],
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

/* -------------------------------------------------------------------------- */
/* The optional values under test                                             */
/* -------------------------------------------------------------------------- */

/** Which of the three input states a value is placed in. */
type State = 'populated' | 'empty' | 'absent';

/** How that state is expressed: through the operator's file, or by editing
 * the chart's own default. */
type Route = 'override' | 'chart-default';

interface OptionalField {
  /** Dotted values path. */
  valuesPath: string;
  /** Acceptance criterion the omission rule comes from. */
  requirement: string;
  /** The empty literal for this value's type. */
  empty: unknown;
  /**
   * Whether an override holding `empty` reaches the chart unchanged. False for
   * the two mappings with populated defaults, where coalesce refills them.
   */
  emptySurvivesOverride: boolean;
  /** Populated inputs. */
  populatedArb: fc.Arbitrary<unknown>;
  /** One pinned populated input, for the deterministic cases. */
  pinned: unknown;
  /**
   * Whether the rendered value must equal the supplied one exactly. False
   * where coalesce merges chart defaults in alongside the override, leaving
   * the rendered value a superset of what was supplied.
   */
  exact: boolean;
  probe: (docs: unknown[], context: string) => Probe;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ALNUM),
    fc.array(fc.constantFrom(...ALNUM, '-'), { minLength: 0, maxLength: 10 }),
    fc.constantFrom(...ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

/**
 * Non-empty annotation maps. The shared generator is reused for its awkward
 * keys and values, filtered to at least one entry - the empty map is the
 * *other* state this property generates, explicitly - and filtered clear of
 * `checksum/config` so a generated pod-annotation key can never collide with
 * the computed one.
 */
const populatedAnnotationsArb: fc.Arbitrary<Record<string, string>> = annotationMapArb
  .map((map) => {
    const { [CHECKSUM_ANNOTATION]: _dropped, ...rest } = map;
    return rest;
  })
  .filter((map) => Object.keys(map).length > 0);

const populatedNodeSelectorArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  fc.tuple(dnsLabelArb, dnsLabelArb).map(([domain, name]) => `${domain}.example.com/${name}`),
  dnsLabelArb,
  { minKeys: 1, maxKeys: 3 },
);

const populatedTolerationsArb: fc.Arbitrary<Record<string, unknown>[]> = fc.array(
  fc.record({
    key: dnsLabelArb,
    operator: fc.constantFrom('Exists', 'Equal'),
    effect: fc.constantFrom('NoSchedule', 'NoExecute', 'PreferNoSchedule'),
  }),
  { minLength: 1, maxLength: 3 },
);

/**
 * Affinity mappings, including one holding a key no template names:
 * Requirement 11.8 keeps this value open-ended, and `toYaml` has to pass
 * whatever shape arrives through untouched.
 */
const populatedAffinityArb: fc.Arbitrary<Record<string, unknown>> = fc.constantFrom(
  {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: 'kubernetes.io/os', operator: 'In', values: ['linux'] }] },
        ],
      },
    },
  },
  {
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 100,
          podAffinityTerm: {
            topologyKey: 'kubernetes.io/hostname',
            labelSelector: { matchLabels: { 'app.kubernetes.io/name': 'scrum-poker' } },
          },
        },
      ],
    },
  },
  { 'operator.example.com/unknown-term': { nested: { deeper: true } } },
);

const cpuQuantityArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 1, max: 4000 }).map((milli) => `${milli}m`),
  fc.integer({ min: 1, max: 8 }).map(String),
);

const memoryQuantityArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 16, max: 4096 }).map((mebi) => `${mebi}Mi`),
  fc.integer({ min: 1, max: 8 }).map((gibi) => `${gibi}Gi`),
);

/**
 * The eleven values whose presence this property keys on. `resources`' four
 * leaves get their own property below, because their omission rules *compose*
 * with the parent's rather than being independent of it.
 */
const OPTIONAL_FIELDS: OptionalField[] = [
  {
    valuesPath: 'imagePullSecrets',
    requirement: '2.17',
    empty: [],
    emptySurvivesOverride: true,
    populatedArb: fc.array(fc.record({ name: dnsLabelArb }), { minLength: 1, maxLength: 3 }),
    pinned: [{ name: 'regcred' }],
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Deployment', POD_PATH, 'imagePullSecrets', context),
  },
  {
    valuesPath: 'podAnnotations',
    requirement: '2.17',
    empty: {},
    emptySurvivesOverride: true,
    populatedArb: populatedAnnotationsArb,
    pinned: { 'example.com/owner': 'platform', 'example.com/timeout': '3600' },
    exact: true,
    probe: podAnnotationsProbe,
  },
  {
    valuesPath: 'nodeSelector',
    requirement: '2.17',
    empty: {},
    emptySurvivesOverride: true,
    populatedArb: populatedNodeSelectorArb,
    pinned: { 'kubernetes.io/os': 'linux' },
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Deployment', POD_PATH, 'nodeSelector', context),
  },
  {
    valuesPath: 'tolerations',
    requirement: '2.17',
    empty: [],
    emptySurvivesOverride: true,
    populatedArb: populatedTolerationsArb,
    pinned: [{ key: 'dedicated', operator: 'Equal', effect: 'NoSchedule' }],
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Deployment', POD_PATH, 'tolerations', context),
  },
  {
    valuesPath: 'affinity',
    requirement: '2.17',
    empty: {},
    emptySurvivesOverride: true,
    populatedArb: populatedAffinityArb,
    pinned: { 'operator.example.com/unknown-term': { nested: { deeper: true } } },
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Deployment', POD_PATH, 'affinity', context),
  },
  {
    valuesPath: 'podSecurityContext',
    requirement: '7.8',
    empty: {},
    emptySurvivesOverride: true,
    populatedArb: fc.record({ fsGroup: fc.integer({ min: 1, max: 65_535 }) }),
    pinned: { fsGroup: 2000 },
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Deployment', POD_PATH, 'securityContext', context),
  },
  {
    valuesPath: 'securityContext',
    requirement: '7.4',
    empty: {},
    // Coalesce refills the five chart defaults over an override of {}.
    emptySurvivesOverride: false,
    populatedArb: fc.record(
      {
        runAsNonRoot: fc.boolean(),
        runAsUser: fc.integer({ min: 1, max: 65_535 }),
        allowPrivilegeEscalation: fc.boolean(),
        readOnlyRootFilesystem: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    pinned: { runAsUser: 1234 },
    // The chart's five defaults merge in alongside whatever is supplied.
    exact: false,
    probe: (docs, context) =>
      keyProbe(docs, 'Deployment', CONTAINER_PATH, 'securityContext', context),
  },
  {
    valuesPath: 'resources',
    requirement: '7.1, 7.3',
    empty: {},
    // Coalesce refills the four chart quantities over an override of {}.
    emptySurvivesOverride: false,
    populatedArb: fc.oneof(
      fc.record({ requests: fc.record({ cpu: cpuQuantityArb }) }),
      fc.record({ limits: fc.record({ memory: memoryQuantityArb }) }),
      fc.record({
        requests: fc.record({ cpu: cpuQuantityArb, memory: memoryQuantityArb }),
        limits: fc.record({ cpu: cpuQuantityArb, memory: memoryQuantityArb }),
      }),
    ),
    pinned: { requests: { cpu: '250m' } },
    exact: false,
    probe: (docs, context) => keyProbe(docs, 'Deployment', CONTAINER_PATH, 'resources', context),
  },
  {
    valuesPath: 'service.annotations',
    requirement: '3.9',
    empty: {},
    emptySurvivesOverride: true,
    populatedArb: populatedAnnotationsArb,
    pinned: { 'service.beta.kubernetes.io/aws-load-balancer-internal': 'true' },
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Service', 'metadata', 'annotations', context),
  },
  {
    valuesPath: 'ingress.className',
    requirement: '8.12',
    empty: '',
    emptySurvivesOverride: true,
    populatedArb: fc.constantFrom('nginx', 'traefik', 'custom-class'),
    pinned: 'traefik',
    exact: true,
    probe: (docs, context) => keyProbe(docs, 'Ingress', 'spec', 'ingressClassName', context),
  },
];

/* -------------------------------------------------------------------------- */
/* Plans: a state and a route per field                                       */
/* -------------------------------------------------------------------------- */

interface FieldPlan {
  state: State;
  route: Route;
  /** Set when `state` is `populated`. */
  populated?: unknown;
}

/** A plan per field, keyed by values path. */
type Assignment = Record<string, FieldPlan>;

/** Both ways of expressing a state, where the state permits both. */
const BOTH_ROUTES: Route[] = ['override', 'chart-default'];

/** The routes that can express an empty input for this field. */
function emptyRoutes(field: OptionalField): Route[] {
  return field.emptySurvivesOverride ? ['override', 'chart-default'] : ['chart-default'];
}

function fieldPlanArb(field: OptionalField): fc.Arbitrary<FieldPlan> {
  return fc.oneof(
    {
      weight: 2,
      arbitrary: field.populatedArb.map(
        (populated): FieldPlan => ({ state: 'populated', route: 'override', populated }),
      ),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom(...emptyRoutes(field))
        .map((route): FieldPlan => ({ state: 'empty', route })),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom(...BOTH_ROUTES)
        .map((route): FieldPlan => ({ state: 'absent', route })),
    },
  );
}

const assignmentArb: fc.Arbitrary<Assignment> = fc
  .tuple(
    ...(OPTIONAL_FIELDS.map(fieldPlanArb) as [
      fc.Arbitrary<FieldPlan>,
      ...fc.Arbitrary<FieldPlan>[],
    ]),
  )
  .map((plans) =>
    Object.fromEntries(OPTIONAL_FIELDS.map((field, index) => [field.valuesPath, plans[index]!])),
  );

/** Every field in the same state, reached by the first route that can. */
function uniformAssignment(state: State, preferred: Route): Assignment {
  return Object.fromEntries(
    OPTIONAL_FIELDS.map((field) => {
      const routes = state === 'empty' ? emptyRoutes(field) : BOTH_ROUTES;
      const route = routes.includes(preferred) ? preferred : (routes[0] as Route);
      return [
        field.valuesPath,
        state === 'populated'
          ? { state, route: 'override' as Route, populated: field.pinned }
          : { state, route },
      ];
    }),
  );
}

/** Turn an assignment into the override document and the chart-default edits. */
function planRender(assignment: Assignment): {
  overrides: Record<string, unknown>;
  edits: DefaultEdit[];
} {
  let overrides: Record<string, unknown> = {};
  const edits: DefaultEdit[] = [];
  for (const field of OPTIONAL_FIELDS) {
    const plan = assignment[field.valuesPath];
    if (!plan) {
      throw new Error(`no plan for ${field.valuesPath}`);
    }
    if (plan.state === 'populated') {
      overrides = mergeValues(overrides, setPath(field.valuesPath, plan.populated));
      continue;
    }
    if (plan.route === 'override') {
      // `null` deletes the chart default outright; an empty literal only
      // survives where the default is itself empty, which `emptyRoutes` checks.
      const value = plan.state === 'empty' ? field.empty : null;
      overrides = mergeValues(overrides, setPath(field.valuesPath, value));
      continue;
    }
    edits.push((values) => {
      if (plan.state === 'empty') {
        setIn(values, field.valuesPath, field.empty);
      } else {
        deleteIn(values, field.valuesPath);
      }
    });
  }
  return { overrides, edits };
}

/** A short description of an assignment, for failure messages. */
function describeAssignment(assignment: Assignment): string {
  return OPTIONAL_FIELDS.map((field) => {
    const plan = assignment[field.valuesPath] as FieldPlan;
    const via = plan.state === 'populated' ? '' : ` via ${plan.route}`;
    return `${field.valuesPath}=${plan.state}${via}`;
  }).join(', ');
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every leaf of `expected` appears with the same value in `actual`. Used where
 * coalesce leaves the rendered value a superset of the supplied one.
 */
function expectCarries(actual: unknown, expected: unknown, where: string): void {
  if (isMapping(expected)) {
    expect(isMapping(actual), `${where}: expected a mapping, got ${JSON.stringify(actual)}`).toBe(
      true,
    );
    for (const [key, value] of Object.entries(expected)) {
      expectCarries((actual as Record<string, unknown>)[key], value, `${where}.${key}`);
    }
    return;
  }
  expect(actual, `${where}: supplied value did not survive the render`).toEqual(expected);
}

/** Assert Property 5 over one render of one assignment. */
function assertOmission(result: RenderResult, assignment: Assignment, context: string): void {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

  for (const field of OPTIONAL_FIELDS) {
    const plan = assignment[field.valuesPath] as FieldPlan;
    const probe = field.probe(result.docs, context);
    const where =
      `${context}: ${field.valuesPath} (Requirement ${field.requirement}) -> ${probe.where}`;

    if (plan.state === 'populated') {
      expect(probe.shape, `${where} must render for a populated input`).toBe('populated');
      expectCarries(probe.value, plan.populated, where);
      continue;
    }

    // The whole point: not {}, not [], not null, not "" - gone.
    expect(
      probe.shape,
      `${where} must be omitted entirely for an ${plan.state} input supplied via the ` +
        `${plan.route} route, but rendered ${JSON.stringify(probe.value)}`,
    ).toBe('absent');
  }
}

/* -------------------------------------------------------------------------- */
/* Property 5, part 1: the eleven independent optional values                 */
/* -------------------------------------------------------------------------- */

describe('Property 5: an empty or absent optional value omits its key', () => {
  it('renders each optional field exactly when its own input is populated', () => {
    fc.assert(
      fc.property(assignmentArb, (assignment) => {
        const { overrides, edits } = planRender(assignment);
        assertOmission(render(overrides, edits), assignment, describeAssignment(assignment));
      }),
      {
        ...assertConfig,
        examples: [
          // Every field empty, by whichever route can express it.
          [uniformAssignment('empty', 'override')],
          [uniformAssignment('empty', 'chart-default')],
          // Every field absent, both routes.
          [uniformAssignment('absent', 'override')],
          [uniformAssignment('absent', 'chart-default')],
          // Every field populated, so the absence assertions cannot be passing
          // because the chart omits these fields unconditionally.
          [uniformAssignment('populated', 'override')],
        ],
      },
    );
  });

  it('omits every one of them for the chart as committed, and keeps the populated defaults', () => {
    const result = renderChart({});
    const context = 'chart defaults';

    // The chart ships these empty, so a plain render must already omit them.
    for (const valuesPath of [
      'imagePullSecrets',
      'podAnnotations',
      'nodeSelector',
      'tolerations',
      'affinity',
      'podSecurityContext',
      'service.annotations',
    ]) {
      const field = OPTIONAL_FIELDS.find((candidate) => candidate.valuesPath === valuesPath);
      if (!field) {
        throw new Error(`${valuesPath} is missing from OPTIONAL_FIELDS`);
      }
      const probe = field.probe(result.docs, context);
      expect(
        probe.shape,
        `${context}: ${valuesPath} is empty in values.yaml, so ${probe.where} must be omitted, ` +
          `but it rendered ${JSON.stringify(probe.value)}`,
      ).toBe('absent');
    }

    // And the three it ships populated must be there, or the assertions above
    // would hold for a chart that rendered nothing at all.
    for (const valuesPath of ['securityContext', 'resources', 'ingress.className']) {
      const field = OPTIONAL_FIELDS.find((candidate) => candidate.valuesPath === valuesPath);
      if (!field) {
        throw new Error(`${valuesPath} is missing from OPTIONAL_FIELDS`);
      }
      const probe = field.probe(result.docs, context);
      expect(probe.shape, `${context}: ${probe.where} must render`).toBe('populated');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Property 5, part 2: resources and its four leaves                          */
/* -------------------------------------------------------------------------- */

/** The four leaf entries under `resources`, by their path below it. */
const RESOURCE_LEAVES = ['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory'] as const;

type ResourceLeaf = (typeof RESOURCE_LEAVES)[number];

interface LeafPlan {
  state: State;
  route: Route;
  /** Set when `state` is `populated`. */
  quantity?: string;
}

/**
 * Either the whole `resources` mapping is empty or absent, or the four leaves
 * are driven individually. The two are separate cases because an empty parent
 * makes every leaf state unobservable.
 */
type ResourcesPlan =
  | { kind: 'whole'; state: 'empty' | 'absent'; route: Route }
  | { kind: 'leafwise'; leaves: Record<ResourceLeaf, LeafPlan> };

function leafPlanArb(leaf: ResourceLeaf): fc.Arbitrary<LeafPlan> {
  const quantityArb = leaf.endsWith('cpu') ? cpuQuantityArb : memoryQuantityArb;
  return fc.oneof(
    {
      weight: 2,
      arbitrary: quantityArb.map(
        (quantity): LeafPlan => ({ state: 'populated', route: 'override', quantity }),
      ),
    },
    {
      // A leaf is a string, so an empty override survives coalesce: the
      // chart's `with` then has to treat "" as no value.
      weight: 1,
      arbitrary: fc
        .constantFrom(...BOTH_ROUTES)
        .map((route): LeafPlan => ({ state: 'empty', route })),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom(...BOTH_ROUTES)
        .map((route): LeafPlan => ({ state: 'absent', route })),
    },
  );
}

/** The two states the whole `resources` mapping can be emptied into. */
const WHOLE_RESOURCES_STATES: ('empty' | 'absent')[] = ['empty', 'absent'];

const resourcesPlanArb: fc.Arbitrary<ResourcesPlan> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...WHOLE_RESOURCES_STATES), fc.boolean())
      .map(([state, preferOverride]): ResourcesPlan => ({
        kind: 'whole',
        state,
        // An override of {} cannot reach the chart over a populated default,
        // so an empty whole mapping is only expressible by editing the default.
        route: state === 'absent' && preferOverride ? 'override' : 'chart-default',
      })),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        leafPlanArb('requests.cpu'),
        leafPlanArb('requests.memory'),
        leafPlanArb('limits.cpu'),
        leafPlanArb('limits.memory'),
      )
      .map(([requestsCpu, requestsMemory, limitsCpu, limitsMemory]): ResourcesPlan => ({
        kind: 'leafwise',
        leaves: {
          'requests.cpu': requestsCpu,
          'requests.memory': requestsMemory,
          'limits.cpu': limitsCpu,
          'limits.memory': limitsMemory,
        },
      })),
  },
);

function planResourcesRender(plan: ResourcesPlan): {
  overrides: Record<string, unknown>;
  edits: DefaultEdit[];
} {
  let overrides: Record<string, unknown> = {};
  const edits: DefaultEdit[] = [];

  if (plan.kind === 'whole') {
    if (plan.route === 'override') {
      overrides = mergeValues(overrides, setPath('resources', null));
    } else {
      edits.push((values) => {
        if (plan.state === 'empty') {
          setIn(values, 'resources', {});
        } else {
          deleteIn(values, 'resources');
        }
      });
    }
    return { overrides, edits };
  }

  for (const leaf of RESOURCE_LEAVES) {
    const leafPlan = plan.leaves[leaf];
    const valuesPath = `resources.${leaf}`;
    if (leafPlan.state === 'populated') {
      overrides = mergeValues(overrides, setPath(valuesPath, leafPlan.quantity));
      continue;
    }
    if (leafPlan.route === 'override') {
      overrides = mergeValues(overrides, setPath(valuesPath, leafPlan.state === 'empty' ? '' : null));
      continue;
    }
    edits.push((values) => {
      if (leafPlan.state === 'empty') {
        setIn(values, valuesPath, '');
      } else {
        deleteIn(values, valuesPath);
      }
    });
  }
  return { overrides, edits };
}

function describeResourcesPlan(plan: ResourcesPlan): string {
  if (plan.kind === 'whole') {
    return `resources=${plan.state} via ${plan.route}`;
  }
  return RESOURCE_LEAVES.map((leaf) => {
    const leafPlan = plan.leaves[leaf];
    const detail =
      leafPlan.state === 'populated' ? `populated "${leafPlan.quantity}"` : `${leafPlan.state} via ${leafPlan.route}`;
    return `${leaf}=${detail}`;
  }).join(', ');
}

/** Assert the composed omission rules for `resources` over one render. */
function assertResourcesOmission(
  result: RenderResult,
  plan: ResourcesPlan,
  context: string,
): void {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

  const deployment = soleDocument(result.docs, 'Deployment', context);
  const container = getPath(deployment, CONTAINER_PATH);
  expect(isMapping(container), `${context}: the application container is a mapping`).toBe(true);
  const resources = (container as Record<string, unknown>)['resources'];

  const populatedLeaves =
    plan.kind === 'whole'
      ? []
      : RESOURCE_LEAVES.filter((leaf) => plan.leaves[leaf].state === 'populated');

  // Requirement 7.3 - and the parent-key half of Property 5: with no leaf
  // holding a value there is nothing to say, so the whole field goes.
  expect(
    shapeOf(resources),
    `${context}: ${populatedLeaves.length} of the four resource entries hold a value, so ` +
      `container resources must be ${populatedLeaves.length === 0 ? 'omitted entirely' : 'rendered'}, ` +
      `but it rendered ${JSON.stringify(resources)}`,
  ).toBe(populatedLeaves.length === 0 ? 'absent' : 'populated');

  for (const block of ['requests', 'limits'] as const) {
    const populatedInBlock = populatedLeaves.filter((leaf) => leaf.startsWith(`${block}.`));
    const rendered = isMapping(resources) ? resources[block] : undefined;
    expect(
      shapeOf(rendered),
      `${context}: ${populatedInBlock.length} entries under resources.${block} hold a value, so ` +
        `the block must be ${populatedInBlock.length === 0 ? 'omitted' : 'rendered'}, but it ` +
        `rendered ${JSON.stringify(rendered)}`,
    ).toBe(populatedInBlock.length === 0 ? 'absent' : 'populated');
  }

  // Requirement 7.1 - each of the four entries, present exactly when it holds
  // a value, and carrying that value as a string.
  for (const leaf of RESOURCE_LEAVES) {
    const rendered = getPath(resources, leaf);
    const leafPlan = plan.kind === 'whole' ? undefined : plan.leaves[leaf];
    const expected = leafPlan?.state === 'populated' ? leafPlan.quantity : undefined;
    if (expected === undefined) {
      expect(
        shapeOf(rendered),
        `${context}: resources.${leaf} holds no value, so it must be omitted, but it rendered ` +
          `${JSON.stringify(rendered)}`,
      ).toBe('absent');
      continue;
    }
    expect(rendered, `${context}: resources.${leaf} must render its quantity as a string`).toBe(
      expected,
    );
  }
}

describe('Property 5: resources composes its omission rules with its four leaves', () => {
  it('renders resources, each block, and each leaf exactly when a value reaches it', () => {
    fc.assert(
      fc.property(resourcesPlanArb, (plan) => {
        const { overrides, edits } = planResourcesRender(plan);
        assertResourcesOmission(render(overrides, edits), plan, describeResourcesPlan(plan));
      }),
      {
        ...assertConfig,
        examples: [
          // The whole mapping, both states and both expressible routes.
          [{ kind: 'whole', state: 'empty', route: 'chart-default' } as ResourcesPlan],
          [{ kind: 'whole', state: 'absent', route: 'chart-default' } as ResourcesPlan],
          [{ kind: 'whole', state: 'absent', route: 'override' } as ResourcesPlan],
          // All four leaves nulled out by an operator: every block empties, so
          // nothing may be left behind under the container.
          [
            {
              kind: 'leafwise',
              leaves: {
                'requests.cpu': { state: 'absent', route: 'override' },
                'requests.memory': { state: 'absent', route: 'override' },
                'limits.cpu': { state: 'absent', route: 'override' },
                'limits.memory': { state: 'absent', route: 'override' },
              },
            } as ResourcesPlan,
          ],
          // One block emptied, the other left populated.
          [
            {
              kind: 'leafwise',
              leaves: {
                'requests.cpu': { state: 'absent', route: 'override' },
                'requests.memory': { state: 'absent', route: 'override' },
                'limits.cpu': { state: 'populated', route: 'override', quantity: '500m' },
                'limits.memory': { state: 'populated', route: 'override', quantity: '512Mi' },
              },
            } as ResourcesPlan,
          ],
          // A single leaf survives; the other three go, including one emptied
          // rather than deleted.
          [
            {
              kind: 'leafwise',
              leaves: {
                'requests.cpu': { state: 'populated', route: 'override', quantity: '100m' },
                'requests.memory': { state: 'empty', route: 'override' },
                'limits.cpu': { state: 'absent', route: 'override' },
                'limits.memory': { state: 'absent', route: 'chart-default' },
              },
            } as ResourcesPlan,
          ],
          // All four populated, so the assertions above are not passing on a
          // container that renders no resources at all.
          [
            {
              kind: 'leafwise',
              leaves: {
                'requests.cpu': { state: 'populated', route: 'override', quantity: '100m' },
                'requests.memory': { state: 'populated', route: 'override', quantity: '128Mi' },
                'limits.cpu': { state: 'populated', route: 'override', quantity: '500m' },
                'limits.memory': { state: 'populated', route: 'override', quantity: '512Mi' },
              },
            } as ResourcesPlan,
          ],
        ],
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Property 5, part 3: nodePort is gated on the Service type as well          */
/* -------------------------------------------------------------------------- */

const SERVICE_TYPES = ['ClusterIP', 'NodePort', 'LoadBalancer'] as const;

/**
 * `service.nodePort` defaults to null, so "empty" and "absent" are the same
 * input here; the generated routes are the two ways to express it, plus a
 * populated value inside the range guard 10 permits.
 */
type NodePortPlan =
  | { state: 'populated'; value: number }
  | { state: 'absent'; route: Route };

const nodePortPlanArb: fc.Arbitrary<NodePortPlan> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 30_000, max: 32_767 })
      .map((value): NodePortPlan => ({ state: 'populated', value })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(...BOTH_ROUTES)
      .map((route): NodePortPlan => ({ state: 'absent', route })),
  },
);

describe('Property 5: nodePort renders only for a NodePort Service', () => {
  it('omits nodePort for every other type, whatever service.nodePort holds', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVICE_TYPES),
        nodePortPlanArb,
        (serviceType, plan) => {
          let overrides: Record<string, unknown> = setPath('service.type', serviceType);
          const edits: DefaultEdit[] = [];
          if (plan.state === 'populated') {
            overrides = mergeValues(overrides, setPath('service.nodePort', plan.value));
          } else if (plan.route === 'override') {
            overrides = mergeValues(overrides, setPath('service.nodePort', null));
          } else {
            edits.push((values) => deleteIn(values, 'service.nodePort'));
          }

          const context =
            `service.type="${serviceType}", service.nodePort=` +
            (plan.state === 'populated' ? String(plan.value) : `absent via ${plan.route}`);
          const result = render(overrides, edits);
          expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

          const service = soleDocument(result.docs, 'Service', context);
          const ports = getPath(service, 'spec.ports');
          expect(Array.isArray(ports), `${context}: spec.ports is a list`).toBe(true);
          expect((ports as unknown[]).length, `${context}: exactly one port entry renders`).toBe(1);

          const entry = getPath(service, SERVICE_PORT_PATH);
          expect(isMapping(entry), `${context}: the port entry is a mapping`).toBe(true);
          // Anti-vacuous: the entry the nodePort assertion reads is a real one.
          expect((entry as Record<string, unknown>)['port'], `${context}: port renders`).toBe(80);

          const shouldRender = serviceType === 'NodePort' && plan.state === 'populated';
          const rendered = (entry as Record<string, unknown>)['nodePort'];
          expect(
            shapeOf(rendered),
            `${context} (Requirements 3.11, 3.7): nodePort must be ` +
              `${shouldRender ? 'rendered' : 'omitted'}, but it rendered ${JSON.stringify(rendered)}`,
          ).toBe(shouldRender ? 'populated' : 'absent');
          if (shouldRender && plan.state === 'populated') {
            expect(rendered, `${context}: nodePort value`).toBe(plan.value);
          }
        },
      ),
      {
        ...assertConfig,
        examples: [
          // A leftover nodePort under each non-NodePort type - the case
          // Requirement 3.11 names.
          ['ClusterIP', { state: 'populated', value: 30_123 } as NodePortPlan],
          ['LoadBalancer', { state: 'populated', value: 32_767 } as NodePortPlan],
          // The range boundaries, under the type that honours them.
          ['NodePort', { state: 'populated', value: 30_000 } as NodePortPlan],
          ['NodePort', { state: 'populated', value: 32_767 } as NodePortPlan],
          // No value at all, under the type that would have used one.
          ['NodePort', { state: 'absent', route: 'override' } as NodePortPlan],
          ['NodePort', { state: 'absent', route: 'chart-default' } as NodePortPlan],
        ],
      },
    );
  });
});
