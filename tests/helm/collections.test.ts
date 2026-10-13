/**
 * Feature: helm-chart-deployment - task 10.4.
 *
 * Property 6: Operator-supplied collections reach the manifest with count,
 * order, and content preserved
 *
 * *For any* generated `imagePullSecrets` list, `podAnnotations` map,
 * `nodeSelector` map, `tolerations` list, `affinity` mapping, `ingress.hosts`
 * list of host entries each holding a `paths` list, and `ingress.tls` list, the
 * rendered output contains the same number of entries in the same order as
 * supplied, every key and value survives unchanged, every rendered ingress path
 * entry carries the supplied `pathType` or `Prefix` when none was supplied, and
 * every rendered ingress backend names the `scrum-poker.fullname` Service and
 * the port number held in `service.port`.
 *
 * **Validates: Requirements 2.9, 2.12, 2.13, 8.4, 8.5, 8.9, 11.8**
 *
 * ### What can actually go wrong here
 *
 * Every collection in this property is rendered by a `toYaml` under a `with`,
 * or by a `range` in the ingress. Three failure modes survive that construction
 * and each drives an input class below:
 *
 *   - **Count and order.** A map is iterated in sorted key order by Helm, but a
 *     *list* must keep the operator's order: `imagePullSecrets`, `tolerations`,
 *     `ingress.hosts`, each host's `paths`, and `ingress.tls` are all
 *     order-significant, so lists are generated with 1-4 entries and compared
 *     element by element rather than as sets.
 *   - **Type and quoting loss.** `toYaml` has to re-quote any scalar that a
 *     YAML 1.1 parser would resolve to something other than a string. A pull
 *     secret named `y`, a node-selector value of `010`, a TLS host of
 *     `*.example.com` (where a bare `*` is an alias indicator), and annotation
 *     values holding `:`, `,`, quotes, or a newline are all in the input space
 *     for exactly that reason. Assertions compare *parsed* YAML, so a lost pair
 *     of quotes shows up as a boolean or a number where a string belongs.
 *   - **Structure the chart never names.** Requirement 11.8 keeps
 *     `podAnnotations`, `nodeSelector`, and `affinity` open-ended, so the
 *     affinity generator includes a nested shape with a key no template
 *     mentions, and a deterministic case below supplies more entries than the
 *     chart documents.
 *
 * The pod-template annotations are the one collection that is not compared
 * wholesale: the Deployment also writes `checksum/config` into that same
 * mapping, so the expectation is the union of the supplied keys with that one
 * computed key - which is also what proves `podAnnotations` merges *into* the
 * existing key rather than opening a second `annotations` block.
 *
 * ### Why `config.preservePath` is false throughout the property
 *
 * Guard 13 (task 13.3) requires every ingress path to equal the normalised
 * `config.basePath` whenever `ingress.enabled` and `config.preservePath` are
 * both true. This property needs ingress paths to vary freely - that is the
 * point of Requirement 8.5 - so it renders with `config.preservePath: false`,
 * which leaves the paths unconstrained and keeps the property valid once the
 * guard lands. The deterministic default-values case further down keeps
 * `preservePath` true, where the committed base path and ingress path already
 * agree.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renderChart, type RenderResult } from './support/render-chart.js';
import { annotationMapArb, assertConfig, hostsArb } from './support/generators.js';

/** `ingress.hosts` entry shape, as `hostsArb` produces it. */
type HostEntry = { host: string; paths: { path: string; pathType?: string }[] };

/** `ingress.tls` entry shape (Requirement 8.9). */
type TlsEntry = { secretName: string; hosts: string[] };

/** The `pathType` the ingress substitutes for a path entry that holds none. */
const DEFAULT_PATH_TYPE = 'Prefix';

/** The annotation the Deployment computes alongside `podAnnotations`. */
const CHECKSUM_ANNOTATION = 'checksum/config';

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

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

const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ALNUM),
    fc.array(fc.constantFrom(...ALNUM, '-'), { maxLength: 10 }),
    fc.constantFrom(...ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

const dnsNameArb: fc.Arbitrary<string> = fc
  .array(dnsLabelArb, { minLength: 2, maxLength: 3 })
  .map((labels) => labels.join('.'));

/** A `domain/name` or `domain.name` key, the shape a node-selector label uses. */
const dottedKeyArb: fc.Arbitrary<string> = fc
  .tuple(fc.array(dnsLabelArb, { minLength: 1, maxLength: 3 }), dnsLabelArb, fc.boolean())
  .map(([domain, name, withPrefix]) =>
    withPrefix ? `${domain.join('.')}/${name}` : `${domain.join('.')}.${name}`,
  );

/**
 * Plain scalars a YAML 1.1 parser resolves to a boolean, a number, or null.
 * Every one of these is a legal DNS-1123 name or label value, so each is a
 * value an operator can really supply - and each is a value `toYaml` has to
 * re-quote on the way out.
 */
const AMBIGUOUS_SCALARS = ['y', 'n', 'no', 'on', 'off', 'true', 'false', '010', '1e3'] as const;

const pullSecretNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: dnsLabelArb },
  { weight: 2, arbitrary: dnsNameArb },
  { weight: 1, arbitrary: fc.constantFrom(...AMBIGUOUS_SCALARS, 'regcred') },
);

/** 1-4 pull-secret references; order is what the kubelet tries them in. */
const imagePullSecretsArb: fc.Arbitrary<{ name: string }[]> = fc.array(
  fc.record({ name: pullSecretNameArb }),
  { minLength: 1, maxLength: 4 },
);

const nodeSelectorValueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: dnsLabelArb },
  { weight: 1, arbitrary: fc.constantFrom(...AMBIGUOUS_SCALARS, '') },
);

/** 1-4 node labels with dotted keys and type-ambiguous values. */
const nodeSelectorArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  dottedKeyArb,
  nodeSelectorValueArb,
  { minKeys: 1, maxKeys: 4 },
);

/**
 * Three toleration shapes: the match-everything form, a keyed `Equal` form
 * whose `value`, `effect`, and `tolerationSeconds` are independently present,
 * and a form carrying a field no template names.
 */
const tolerationArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant<Record<string, unknown>>({ operator: 'Exists' }),
  fc.record(
    {
      key: dottedKeyArb,
      operator: fc.constant('Equal'),
      value: nodeSelectorValueArb,
      effect: fc.constantFrom('NoSchedule', 'NoExecute', 'PreferNoSchedule'),
      tolerationSeconds: fc.integer({ min: 0, max: 3600 }),
    },
    { requiredKeys: ['key', 'operator'] },
  ),
  fc.record({
    key: dottedKeyArb,
    operator: fc.constant('Exists'),
    effect: fc.constantFrom('NoSchedule', 'NoExecute'),
    'example.com/unknown-field': fc.constantFrom(...AMBIGUOUS_SCALARS),
  }),
);

/** 1-3 tolerations; the list is order-significant, so it is compared in order. */
const tolerationsArb: fc.Arbitrary<Record<string, unknown>[]> = fc.array(tolerationArb, {
  minLength: 1,
  maxLength: 3,
});

/**
 * Affinity mappings. The first two are the real node- and pod-affinity shapes,
 * nested deeply enough that a `toYaml` indentation slip would not parse back.
 * The third carries a key the chart never mentions, which is the
 * `additionalProperties: true` guarantee of Requirement 11.8.
 */
const affinityArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({
    nodeAffinity: fc.record({
      requiredDuringSchedulingIgnoredDuringExecution: fc.record({
        nodeSelectorTerms: fc.array(
          fc.record({
            matchExpressions: fc.array(
              fc.record({
                key: dottedKeyArb,
                operator: fc.constantFrom('In', 'NotIn'),
                values: fc.array(nodeSelectorValueArb, { minLength: 1, maxLength: 3 }),
              }),
              { minLength: 1, maxLength: 2 },
            ),
          }),
          { minLength: 1, maxLength: 2 },
        ),
      }),
    }),
  }),
  fc.record({
    podAntiAffinity: fc.record({
      preferredDuringSchedulingIgnoredDuringExecution: fc.array(
        fc.record({
          weight: fc.integer({ min: 1, max: 100 }),
          podAffinityTerm: fc.record({
            topologyKey: dottedKeyArb,
            labelSelector: fc.record({
              matchLabels: fc.dictionary(dottedKeyArb, dnsLabelArb, { minKeys: 1, maxKeys: 2 }),
            }),
          }),
        }),
        { minLength: 1, maxLength: 2 },
      ),
    }),
  }),
  fc.record({
    'example.com/future-affinity': fc.record({
      enabled: fc.boolean(),
      weight: fc.integer({ min: 1, max: 10 }),
      zones: fc.array(dnsLabelArb, { minLength: 1, maxLength: 3 }),
    }),
  }),
);

/**
 * 1-3 TLS entries. Wildcard hosts are in the space deliberately: a bare
 * leading `*` is a YAML alias indicator, so it only survives if `toYaml`
 * quotes it.
 */
const tlsArb: fc.Arbitrary<TlsEntry[]> = fc.array(
  fc.record({
    secretName: fc.oneof(
      { weight: 3, arbitrary: dnsLabelArb },
      { weight: 1, arbitrary: fc.constantFrom(...AMBIGUOUS_SCALARS) },
    ),
    hosts: fc.array(
      fc.oneof(
        { weight: 3, arbitrary: dnsNameArb },
        { weight: 1, arbitrary: dnsNameArb.map((name) => `*.${name}`) },
      ),
      { minLength: 1, maxLength: 3 },
    ),
  }),
  { minLength: 1, maxLength: 3 },
);

interface CollectionsSample {
  imagePullSecrets: { name: string }[];
  podAnnotations: Record<string, string>;
  nodeSelector: Record<string, string>;
  tolerations: Record<string, unknown>[];
  affinity: Record<string, unknown>;
  hosts: HostEntry[];
  tls: TlsEntry[];
  servicePort: number;
}

/**
 * One sample drives one render. Every collection in the property travels
 * together because they land in three different documents from one values
 * document, and a single `helm template` spawn covers all of them - at roughly
 * 100-300 ms a spawn, generating them separately would multiply the cost
 * without adding coverage.
 */
const collectionsArb: fc.Arbitrary<CollectionsSample> = fc.record({
  imagePullSecrets: imagePullSecretsArb,
  podAnnotations: annotationMapArb,
  nodeSelector: nodeSelectorArb,
  tolerations: tolerationsArb,
  affinity: affinityArb,
  hosts: hostsArb,
  tls: tlsArb,
  servicePort: fc.integer({ min: 1, max: 65_535 }),
});

function valuesFor(sample: CollectionsSample): Record<string, unknown> {
  return {
    imagePullSecrets: sample.imagePullSecrets,
    podAnnotations: sample.podAnnotations,
    nodeSelector: sample.nodeSelector,
    tolerations: sample.tolerations,
    affinity: sample.affinity,
    service: { port: sample.servicePort },
    // See the file header: keeps guard 13 out of the way of varying paths.
    config: { preservePath: false },
    ingress: { enabled: true, hosts: sample.hosts, tls: sample.tls },
  };
}

/** The single document of the given kind, with the "exactly one" check applied. */
function soleDoc(result: RenderResult, kind: string, context: string): Record<string, unknown> {
  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);
  const docs = result.docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === kind,
  );
  expect(docs.length, `${context}: expected exactly one ${kind}`).toBe(1);
  return docs[0] as Record<string, unknown>;
}

/** `spec.template.spec` of the rendered Deployment. */
function podSpec(deployment: Record<string, unknown>, context: string): Record<string, unknown> {
  const spec = getPath(deployment, 'spec.template.spec');
  expect(isMapping(spec), `${context}: Deployment holds no pod spec`).toBe(true);
  return spec as Record<string, unknown>;
}

/** A list-valued field, narrowed with its "is a list" check. */
function listAt(root: unknown, dottedPath: string, context: string): unknown[] {
  const value = getPath(root, dottedPath);
  expect(
    Array.isArray(value),
    `${context}: ${dottedPath} is not a list: ${JSON.stringify(value)}`,
  ).toBe(true);
  return value as unknown[];
}

/**
 * Assert every collection of one render against the sample that produced it.
 * Kept as one function so the property body and the deterministic cases below
 * check the same things.
 */
function assertCollectionsPreserved(sample: CollectionsSample, context: string): void {
  const result = renderChart(valuesFor(sample));
  const deployment = soleDoc(result, 'Deployment', context);
  const service = soleDoc(result, 'Service', context);
  const ingress = soleDoc(result, 'Ingress', context);

  const fullname = getPath(service, 'metadata.name');
  expect(typeof fullname, `${context}: Service name is not a string`).toBe('string');
  expect(
    getPath(deployment, 'metadata.name'),
    `${context}: Deployment and Service disagree on scrum-poker.fullname`,
  ).toBe(fullname);

  const pod = podSpec(deployment, context);

  // Requirement 2.9 - count, order, and each entry's name.
  const renderedPullSecrets = listAt(pod, 'imagePullSecrets', context);
  expect(renderedPullSecrets.length, `${context}: imagePullSecrets entry count`).toBe(
    sample.imagePullSecrets.length,
  );
  expect(renderedPullSecrets, `${context}: imagePullSecrets order or content`).toEqual(
    sample.imagePullSecrets,
  );

  // Requirement 2.12 - every supplied pair reaches the pod template unchanged,
  // alongside the computed checksum and nothing else.
  const annotations = getPath(deployment, 'spec.template.metadata.annotations');
  expect(isMapping(annotations), `${context}: pod template holds no annotations`).toBe(true);
  const annotationMap = annotations as Record<string, unknown>;
  for (const [key, value] of Object.entries(sample.podAnnotations)) {
    expect(annotationMap[key], `${context}: podAnnotations[${JSON.stringify(key)}]`).toBe(value);
  }
  expect(
    typeof annotationMap[CHECKSUM_ANNOTATION],
    `${context}: ${CHECKSUM_ANNOTATION} is missing, so podAnnotations replaced it`,
  ).toBe('string');
  expect(Object.keys(annotationMap).sort(), `${context}: pod annotation key set`).toEqual(
    [...new Set([CHECKSUM_ANNOTATION, ...Object.keys(sample.podAnnotations)])].sort(),
  );

  // Requirement 2.13 - nodeSelector, tolerations, and affinity pass through.
  expect(getPath(pod, 'nodeSelector'), `${context}: nodeSelector content`).toEqual(
    sample.nodeSelector,
  );
  const renderedTolerations = listAt(pod, 'tolerations', context);
  expect(renderedTolerations.length, `${context}: tolerations entry count`).toBe(
    sample.tolerations.length,
  );
  expect(renderedTolerations, `${context}: tolerations order or content`).toEqual(
    sample.tolerations,
  );
  expect(getPath(pod, 'affinity'), `${context}: affinity content`).toEqual(sample.affinity);

  // Requirement 8.9 - one tls element per supplied entry, in order, each
  // carrying its secretName and hosts list unchanged.
  const renderedTls = listAt(ingress, 'spec.tls', context);
  expect(renderedTls.length, `${context}: ingress.tls entry count`).toBe(sample.tls.length);
  expect(renderedTls, `${context}: ingress.tls order or content`).toEqual(sample.tls);

  // Requirements 8.4, 8.5 - one rule per host entry in order, one path per
  // path entry in order, the supplied pathType or Prefix, and a backend naming
  // the fullname Service and the service.port number.
  const rules = listAt(ingress, 'spec.rules', context);
  expect(rules.length, `${context}: ingress rule count`).toBe(sample.hosts.length);

  sample.hosts.forEach((hostEntry, hostIndex) => {
    const rule = rules[hostIndex];
    const where = `${context}: rule ${hostIndex}`;
    expect(isMapping(rule), `${where} is not a mapping`).toBe(true);
    const ruleMap = rule as Record<string, unknown>;

    if (hostEntry.host === '') {
      expect(
        ruleMap['host'],
        `${where}: an empty host must render no host field so the rule matches every host`,
      ).toBeUndefined();
    } else {
      expect(ruleMap['host'], `${where}: host value`).toBe(hostEntry.host);
    }

    const paths = listAt(ruleMap, 'http.paths', where);
    expect(paths.length, `${where}: path entry count`).toBe(hostEntry.paths.length);

    hostEntry.paths.forEach((pathEntry, pathIndex) => {
      const rendered = paths[pathIndex];
      const at = `${where}, path ${pathIndex}`;
      expect(isMapping(rendered), `${at} is not a mapping`).toBe(true);
      const renderedPath = rendered as Record<string, unknown>;

      expect(renderedPath['path'], `${at}: path value`).toBe(pathEntry.path);
      expect(renderedPath['pathType'], `${at}: pathType`).toBe(
        pathEntry.pathType ?? DEFAULT_PATH_TYPE,
      );
      expect(getPath(renderedPath, 'backend.service.name'), `${at}: backend Service name`).toBe(
        fullname,
      );
      const portNumber = getPath(renderedPath, 'backend.service.port.number');
      expect(
        typeof portNumber,
        `${at}: backend port number is not an integer: ${JSON.stringify(portNumber)}`,
      ).toBe('number');
      expect(portNumber, `${at}: backend port number`).toBe(sample.servicePort);
    });
  });
}

/**
 * A deterministic sample pinning the awkward corners in one render: a pull
 * secret and a node-selector value that are YAML-ambiguous, an annotation
 * value holding a newline and one holding a colon, a path entry with no
 * `pathType`, an empty host beside a named one, and a wildcard TLS host.
 */
const PINNED_SAMPLE: CollectionsSample = {
  imagePullSecrets: [{ name: 'regcred' }, { name: 'y' }, { name: 'registry.example.com' }],
  podAnnotations: {
    'example.com/multiline': 'line1\nline2',
    'example.com/colon': 'key: value',
    'prometheus.io/scrape': 'true',
  },
  nodeSelector: { 'kubernetes.io/os': 'linux', 'example.com/tier': '010' },
  tolerations: [
    { operator: 'Exists' },
    { key: 'example.com/dedicated', operator: 'Equal', value: 'no', effect: 'NoSchedule' },
  ],
  affinity: { 'example.com/future-affinity': { enabled: true, weight: 3, zones: ['a', 'b'] } },
  hosts: [
    { host: '', paths: [{ path: '/scrum-poker' }] },
    {
      host: 'poker.example.com',
      paths: [
        { path: '/', pathType: 'Exact' },
        { path: '/retro', pathType: 'ImplementationSpecific' },
      ],
    },
  ],
  tls: [
    { secretName: 'poker-tls', hosts: ['poker.example.com', '*.example.com'] },
    { secretName: 'y', hosts: ['alt.example.com'] },
  ],
  servicePort: 8080,
};

describe('Property 6: operator collections keep their count, order, and content', () => {
  it('preserves every supplied collection through to the rendered manifest', () => {
    fc.assert(
      fc.property(collectionsArb, (sample) => {
        assertCollectionsPreserved(sample, `sample ${JSON.stringify(sample)}`);
      }),
      { ...assertConfig, examples: [[PINNED_SAMPLE]] },
    );
  });

  it('carries unbounded operator-specific entries under the open-ended keys (Requirement 11.8)', () => {
    // podAnnotations, nodeSelector, and affinity accept an unbounded number of
    // cluster-specific entries, so this case supplies far more than the chart
    // documents and asserts every one of them arrives.
    const podAnnotations = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`example.com/annotation-${index}`, `value-${index}`]),
    );
    const nodeSelector = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`example.com/label-${index}`, `node-${index}`]),
    );

    assertCollectionsPreserved(
      {
        ...PINNED_SAMPLE,
        podAnnotations,
        nodeSelector,
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    { key: 'example.com/tier', operator: 'In', values: ['a', 'b', 'c'] },
                    { key: 'example.com/zone', operator: 'NotIn', values: ['d'] },
                  ],
                },
              ],
            },
          },
          'example.com/unmodelled': { nested: { deeply: ['one', 'two'] } },
        },
      },
      'unbounded entries',
    );
  });

  it('renders one rule, one path, and the default pathType for the committed defaults', () => {
    // The committed defaults keep config.preservePath true with a base path
    // that already equals the ingress path, so this case stays valid under
    // guard 13 as well.
    const result = renderChart({});
    const ingress = soleDoc(result, 'Ingress', 'committed defaults');
    const deployment = soleDoc(result, 'Deployment', 'committed defaults');
    const fullname = getPath(soleDoc(result, 'Service', 'committed defaults'), 'metadata.name');

    const rules = listAt(ingress, 'spec.rules', 'committed defaults');
    expect(rules.length, 'the default ingress.hosts holds exactly one entry').toBe(1);
    const rule = rules[0] as Record<string, unknown>;
    expect(rule['host'], 'the default host is empty, so no host field renders').toBeUndefined();

    const paths = listAt(rule, 'http.paths', 'committed defaults');
    expect(paths.length).toBe(1);
    expect(paths[0]).toEqual({
      path: '/scrum-poker',
      pathType: DEFAULT_PATH_TYPE,
      backend: { service: { name: fullname, port: { number: 80 } } },
    });

    expect(
      getPath(ingress, 'spec.tls'),
      'the default ingress.tls is empty, so no tls list renders',
    ).toBeUndefined();

    const pod = podSpec(deployment, 'committed defaults');
    expect(pod['imagePullSecrets']).toBeUndefined();
    expect(pod['nodeSelector']).toBeUndefined();
    expect(pod['tolerations']).toBeUndefined();
    expect(pod['affinity']).toBeUndefined();
    expect(
      Object.keys(getPath(deployment, 'spec.template.metadata.annotations') as Record<string, unknown>),
      'with no podAnnotations the checksum is the only pod annotation',
    ).toEqual([CHECKSUM_ANNOTATION]);
  });
});
