/**
 * Feature: helm-chart-deployment - shared generators for the 16 correctness
 * properties. Written once here and reused, per the design's generator table.
 *
 * Every generator produces a *values patch*: a partial values document meant to
 * be handed straight to `renderChart`, because Helm merges a `-f` file over the
 * chart defaults itself. Use `withDefaults` from `./render-chart.ts` when a
 * property needs the fully resolved document to compute its expectation.
 */
import fc from 'fast-check';

/** Minimum iterations per property, per the design. */
export const NUM_RUNS = 100;

/** Shared `fc.assert` parameters. Spread and override where a property needs more. */
export const assertConfig = { numRuns: NUM_RUNS } as const;

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
/** Hyphen-heavy so a 63-character truncation boundary frequently lands on `-`. */
const RELEASE_INNER = [...ALNUM, '-', '-', '-'];

/**
 * Helm itself validates the release name before any template runs: it must
 * match `^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$` and
 * hold at most 53 characters. The design's table describes 1-80 characters
 * biased toward trailing hyphens; anything outside Helm's rule is rejected by
 * Helm rather than by the chart, so it would exercise nothing. The generator
 * therefore stays inside Helm's rule and chases the same target a different
 * way: names are biased toward 40-53 characters - long enough that
 * `fullname` + a `-config` or `-secret` suffix crosses 63 - and are dense in
 * hyphens, so truncation lands on a hyphen often and `trimSuffix "-"` is
 * exercised.
 */
export const MAX_HELM_RELEASE_NAME_LENGTH = 53;

/** Smallest release name length that forces fullname truncation (Requirement 12.14). */
export const LONG_RELEASE_NAME_LENGTH = 40;

function releaseNameOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc.integer({ min, max }).chain((length) => {
    if (length === 1) {
      return fc.constantFrom(...ALNUM);
    }
    return fc
      .tuple(
        fc.constantFrom(...ALNUM),
        fc.array(fc.constantFrom(...RELEASE_INNER), {
          minLength: length - 2,
          maxLength: length - 2,
        }),
        fc.constantFrom(...ALNUM),
      )
      .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);
  });
}

/** Release names Helm accepts, biased toward the lengths that force truncation. */
export const releaseNameArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: releaseNameOfLength(LONG_RELEASE_NAME_LENGTH, MAX_HELM_RELEASE_NAME_LENGTH),
  },
  { weight: 3, arbitrary: releaseNameOfLength(15, LONG_RELEASE_NAME_LENGTH - 1) },
  { weight: 1, arbitrary: releaseNameOfLength(1, 14) },
);

/** A DNS-1123 label, used for overrides, service-account names, and hosts. */
const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ALNUM),
    fc.array(fc.constantFrom(...ALNUM, '-'), { minLength: 0, maxLength: 12 }),
    fc.constantFrom(...ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

/** Annotation keys the ingress template computes; operator keys must win. */
export const COMPUTED_INGRESS_ANNOTATION_KEYS = [
  'nginx.ingress.kubernetes.io/affinity',
  'nginx.ingress.kubernetes.io/session-cookie-name',
  'nginx.ingress.kubernetes.io/rewrite-target',
  'nginx.ingress.kubernetes.io/proxy-read-timeout',
  'nginx.ingress.kubernetes.io/proxy-send-timeout',
] as const;

const dottedAnnotationKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(dnsLabelArb, { minLength: 1, maxLength: 3 }),
    dnsLabelArb,
    fc.boolean(),
  )
  .map(([domainSegments, name, withPrefix]) =>
    withPrefix ? `${domainSegments.join('.')}/${name}` : `${domainSegments.join('.')}.${name}`,
  );

const annotationKeyArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: dottedAnnotationKeyArb },
  { weight: 1, arbitrary: fc.constantFrom(...COMPUTED_INGRESS_ANNOTATION_KEYS) },
);

/**
 * Annotation values are always strings in Kubernetes. The classes below are the
 * ones that break naive quoting: numeric-looking values, values holding `:`,
 * `,`, or quotes, and values holding a newline.
 */
const annotationValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 86_400 }).map(String),
  fc.constantFrom('true', 'false', 'null', 'yes', 'no', '~', ''),
  fc.constantFrom(
    'cookie',
    '/',
    'http://example.com:8080/path',
    'a,b,c',
    'key: value',
    '"quoted"',
    "it's",
    '{{ not a template }}',
    '$1',
    'line1\nline2',
  ),
  fc.string({ minLength: 1, maxLength: 24 }),
);

/** Maps with dotted keys, awkward values, and keys that collide with computed ones. */
export const annotationMapArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  annotationKeyArb,
  annotationValueArb,
  { minKeys: 0, maxKeys: 5 },
);

const INGRESS_PATH_TYPES = ['Prefix', 'Exact', 'ImplementationSpecific'] as const;

const ingressPathArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('/', '/scrum-poker', '/app', '/a/b', '/retro'),
  fc.array(dnsLabelArb, { minLength: 1, maxLength: 3 }).map((segments) => `/${segments.join('/')}`),
);

const ingressPathEntryArb: fc.Arbitrary<{ path: string; pathType?: string }> = fc.record(
  {
    path: ingressPathArb,
    pathType: fc.constantFrom(...INGRESS_PATH_TYPES),
  },
  // `pathType` absent exercises the `Prefix` fallback.
  { requiredKeys: ['path'] },
);

/** 1-4 host entries, each with 1-3 paths, mixed empty and non-empty hosts. */
export const hostsArb: fc.Arbitrary<{ host: string; paths: { path: string; pathType?: string }[] }[]> =
  fc.array(
    fc.record({
      // An empty host makes the rule match every incoming host.
      host: fc.oneof(
        { weight: 1, arbitrary: fc.constant('') },
        {
          weight: 2,
          arbitrary: fc
            .array(dnsLabelArb, { minLength: 2, maxLength: 3 })
            .map((labels) => labels.join('.')),
        },
      ),
      paths: fc.array(ingressPathEntryArb, { minLength: 1, maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 4 },
  );

/**
 * Base paths the chart accepts: empty (cluster root), `/`, multi-segment
 * prefixes, and a value at the 64-character schema boundary. Values the chart
 * must reject live in `malformedBasePathArb`, keeping the positive and negative
 * input spaces separable.
 */
export const basePathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant('/') },
  {
    weight: 4,
    arbitrary: fc
      .array(dnsLabelArb, { minLength: 1, maxLength: 3 })
      .map((segments) => `/${segments.join('/')}`)
      .filter((value) => value.length <= 64),
  },
  { weight: 1, arbitrary: fc.constant(`/${'a'.repeat(63)}`) },
);

/** Base paths that violate the leading-slash (guard 6) or trailing-slash (guard 7) rules. */
export const malformedBasePathArb: fc.Arbitrary<{ value: string; guard: 6 | 7 }> = fc.oneof(
  fc
    .array(dnsLabelArb, { minLength: 1, maxLength: 3 })
    .map((segments) => ({ value: segments.join('/'), guard: 6 as const })),
  fc
    .array(dnsLabelArb, { minLength: 1, maxLength: 3 })
    .map((segments) => ({ value: `/${segments.join('/')}/`, guard: 7 as const })),
);

const SECRET_ASCII = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ...'-_.+/=@#$%^&*()[]{}<>|\\~`!?,;: \'"'.split(''),
];
const SECRET_NON_ASCII = ['e\u0301', 'u\u0308', '\u00df', '\u6f22', '\u00e9', '\uD83D\uDE42'];

/**
 * Secret values across length classes that straddle base64 padding boundaries
 * (lengths not divisible by 3 pad, lengths divisible by 3 do not), plus
 * non-ASCII values whose UTF-8 byte length exceeds their character length.
 * Capped at the schema's 256-character limit for `auth.jwtSecret`.
 */
export const secretValueArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .constantFrom(1, 2, 3, 4, 5, 6, 7, 8, 31, 32, 33, 63, 64, 65, 128, 256)
      .chain((length) =>
        fc.string({ unit: fc.constantFrom(...SECRET_ASCII), minLength: length, maxLength: length }),
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(1, 2, 3, 4, 5, 16, 32)
      .chain((length) =>
        fc.string({
          unit: fc.constantFrom(...SECRET_NON_ASCII),
          minLength: length,
          maxLength: length,
        }),
      ),
  },
);

const envVarNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), {
      minLength: 0,
      maxLength: 16,
    }),
  )
  .map(([first, rest]) => `${first}${rest.join('')}`);

const quantityArb = (unit: 'cpu' | 'memory'): fc.Arbitrary<string> =>
  unit === 'cpu'
    ? fc.oneof(
        fc.integer({ min: 1, max: 4000 }).map((milli) => `${milli}m`),
        fc.integer({ min: 1, max: 8 }).map(String),
      )
    : fc.oneof(
        fc.integer({ min: 16, max: 4096 }).map((mebi) => `${mebi}Mi`),
        fc.integer({ min: 1, max: 8 }).map((gibi) => `${gibi}Gi`),
      );

const resourceBlockArb = fc.record(
  { cpu: quantityArb('cpu'), memory: quantityArb('memory') },
  { requiredKeys: [] },
);

/** Empty, absent, or populated - the three states Property 5 cares about. */
const resourcesArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({}) },
  {
    weight: 3,
    arbitrary: fc.record(
      { requests: resourceBlockArb, limits: resourceBlockArb },
      { requiredKeys: [] },
    ),
  },
);

const probeArb = fc.record(
  {
    enabled: fc.boolean(),
    initialDelaySeconds: fc.integer({ min: 1, max: 120 }),
    periodSeconds: fc.integer({ min: 1, max: 300 }),
    timeoutSeconds: fc.integer({ min: 1, max: 60 }),
    successThreshold: fc.integer({ min: 1, max: 1 }),
    failureThreshold: fc.integer({ min: 1, max: 10 }),
  },
  { requiredKeys: [] },
);

const emptyOr = <T>(empty: T, populated: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  fc.oneof({ weight: 1, arbitrary: fc.constant(empty) }, { weight: 3, arbitrary: populated });

const serviceArb: fc.Arbitrary<Record<string, unknown>> = fc
  .constantFrom('ClusterIP', 'NodePort', 'LoadBalancer')
  .chain((type) =>
    fc.record(
      {
        type: fc.constant(type),
        port: fc.integer({ min: 1, max: 65_535 }),
        targetPort: fc.integer({ min: 1, max: 65_535 }),
        // Always null or in range, so guard 10 never trips on valid values.
        nodePort: fc.oneof(fc.constant(null), fc.integer({ min: 30_000, max: 32_767 })),
        sessionAffinity: fc.constantFrom('ClientIP', 'None', ''),
        sessionAffinityTimeoutSeconds: fc.integer({ min: 1, max: 86_400 }),
        annotations: emptyOr<Record<string, string>>({}, annotationMapArb),
      },
      { requiredKeys: [] },
    ),
  );

/**
 * `config` and `ingress` are generated together because guard 13 couples them:
 * when the ingress is enabled and `config.preservePath` is true, every ingress
 * path must equal the normalised base path.
 */
const routingArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    basePathArb,
    fc.boolean(),
    fc.boolean(),
    hostsArb,
    fc.constantFrom('production', 'development'),
    fc.oneof(fc.constant(''), fc.constantFrom('nginx', 'traefik')),
    emptyOr<Record<string, string>>({}, annotationMapArb),
    fc.record({ affinity: fc.boolean(), cookieName: fc.oneof(fc.constant(''), dnsLabelArb) }, {
      requiredKeys: [],
    }),
    emptyOr<{ secretName: string; hosts: string[] }[]>(
      [],
      fc.array(
        fc.record({
          secretName: dnsLabelArb,
          hosts: fc.array(
            fc.array(dnsLabelArb, { minLength: 2, maxLength: 3 }).map((labels) => labels.join('.')),
            { minLength: 1, maxLength: 2 },
          ),
        }),
        { minLength: 1, maxLength: 2 },
      ),
    ),
  )
  .map(
    ([
      basePath,
      preservePath,
      ingressEnabled,
      hosts,
      nodeEnv,
      className,
      annotations,
      websocket,
      tls,
    ]) => {
      const normalizedBasePath = basePath === '' ? '/' : basePath;
      const alignedHosts =
        ingressEnabled && preservePath
          ? hosts.map((host) => ({
              ...host,
              paths: host.paths.map((entry) => ({ ...entry, path: normalizedBasePath })),
            }))
          : hosts;
      return {
        config: { nodeEnv, basePath, preservePath },
        ingress: {
          enabled: ingressEnabled,
          className,
          annotations,
          hosts: alignedHosts,
          tls,
          websocket,
        },
      };
    },
  );

const authArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  // Guard 9: jwtSecret and existingSecret are mutually exclusive.
  fc.constant({ jwtSecret: '', existingSecret: '' }),
  secretValueArb.map((jwtSecret) => ({ jwtSecret, existingSecret: '' })),
  fc
    .tuple(dnsLabelArb, fc.oneof(fc.constant('JWT_SECRET'), envVarNameArb))
    .map(([existingSecret, existingSecretKey]) => ({
      jwtSecret: '',
      existingSecret,
      existingSecretKey,
    })),
);

/**
 * Complete, schema-valid values documents. Every optional block is
 * independently empty, absent, or populated - `fc.record` with no required keys
 * omits blocks outright, and `emptyOr` supplies the empty variant.
 */
export const validValuesArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.record(
      {
        // Guard 1 permits >= 1 and guard 2 forbids autoscaling; the chart
        // supports exactly one replica, so pin it.
        replicaCount: fc.constant(1),
        image: fc.record(
          {
            repository: fc
              .array(dnsLabelArb, { minLength: 1, maxLength: 3 })
              .map((segments) => segments.join('/')),
            tag: fc.oneof(fc.constant(''), dnsLabelArb),
            pullPolicy: fc.constantFrom('Always', 'IfNotPresent', 'Never'),
          },
          { requiredKeys: [] },
        ),
        imagePullSecrets: emptyOr<{ name: string }[]>(
          [],
          fc.array(fc.record({ name: dnsLabelArb }), { minLength: 1, maxLength: 3 }),
        ),
        nameOverride: fc.oneof(fc.constant(''), dnsLabelArb),
        fullnameOverride: fc.oneof(fc.constant(''), dnsLabelArb),
        serviceAccount: fc.record(
          {
            create: fc.boolean(),
            name: fc.oneof(fc.constant(''), dnsLabelArb),
            annotations: emptyOr<Record<string, string>>({}, annotationMapArb),
          },
          { requiredKeys: [] },
        ),
        podAnnotations: emptyOr<Record<string, string>>({}, annotationMapArb),
        podSecurityContext: emptyOr<Record<string, unknown>>(
          {},
          fc.record({ fsGroup: fc.integer({ min: 1, max: 65_535 }) }),
        ),
        securityContext: emptyOr<Record<string, unknown>>(
          {},
          fc.record(
            {
              runAsNonRoot: fc.boolean(),
              runAsUser: fc.integer({ min: 1, max: 65_535 }),
              allowPrivilegeEscalation: fc.boolean(),
              readOnlyRootFilesystem: fc.boolean(),
            },
            { requiredKeys: [] },
          ),
        ),
        tmpVolume: fc.record(
          { sizeLimit: fc.constantFrom('16Mi', '64Mi', '128Mi', '1Gi') },
          { requiredKeys: [] },
        ),
        service: serviceArb,
        deploymentStrategy: fc.record(
          { type: fc.constantFrom('Recreate', 'RollingUpdate') },
          { requiredKeys: [] },
        ),
        extraEnv: emptyOr<{ name: string; value: string }[]>(
          [],
          fc.array(
            fc.record({ name: envVarNameArb, value: fc.string({ maxLength: 24 }) }),
            { minLength: 1, maxLength: 3 },
          ),
        ),
        resources: resourcesArb,
        readinessProbe: probeArb,
        livenessProbe: probeArb,
        nodeSelector: emptyOr<Record<string, string>>(
          {},
          fc.dictionary(dottedAnnotationKeyArb, dnsLabelArb, { minKeys: 1, maxKeys: 3 }),
        ),
        tolerations: emptyOr<Record<string, unknown>[]>(
          [],
          fc.array(
            fc.record({
              key: dnsLabelArb,
              operator: fc.constantFrom('Exists', 'Equal'),
              effect: fc.constantFrom('NoSchedule', 'NoExecute', 'PreferNoSchedule'),
            }),
            { minLength: 1, maxLength: 3 },
          ),
        ),
        affinity: fc.constant({}),
        autoscaling: fc.constant({ enabled: false }),
        auth: authArb,
      },
      { requiredKeys: [] },
    ),
    // Both routing blocks absent is itself a valid state worth rendering.
    fc.oneof({ weight: 1, arbitrary: fc.constant({}) }, { weight: 5, arbitrary: routingArb }),
  )
  .map(([blocks, routing]) => ({ ...blocks, ...routing }));

/** A values patch that violates exactly one of the 13 cross-field guards. */
export interface GuardViolation {
  /** Guard number, 1-13, as numbered in the design. */
  guard: number;
  /** Values path the guard's message must name. */
  valuesPath: string;
  /** Second values path, for guard 9's mutual-exclusion message. */
  alsoNames?: string;
  /** Zero-based `ingress.hosts` index the message must name, for guards 12-13. */
  hostIndex?: number;
  /** Patch to render. */
  values: Record<string, unknown>;
}

const guardViolations: fc.Arbitrary<GuardViolation>[] = [
  // Guard 1: replicaCount present, integer, >= 1.
  fc
    .oneof(
      fc.integer({ min: -8, max: 0 }),
      fc.constant(null),
      fc.constant('two'),
      fc.constant(1.5),
      fc.constant(true),
    )
    .map((replicaCount) => ({ guard: 1, valuesPath: 'replicaCount', values: { replicaCount } })),

  // Guard 2: autoscaling must stay disabled.
  fc.constant({
    guard: 2,
    valuesPath: 'autoscaling.enabled',
    values: { autoscaling: { enabled: true } },
  }),

  // Guard 3: image.repository non-empty.
  fc.constant({
    guard: 3,
    valuesPath: 'image.repository',
    values: { image: { repository: '' } },
  }),

  // Guard 4: image.pullPolicy within the permitted set.
  fc
    .constantFrom('always', 'ifNotPresent', 'NEVER', 'Sometimes', '', 'Latest')
    .map((pullPolicy) => ({
      guard: 4,
      valuesPath: 'image.pullPolicy',
      values: { image: { pullPolicy } },
    })),

  // Guard 5: deploymentStrategy.type within the permitted set.
  fc.constantFrom('recreate', 'Rolling', 'rollingUpdate', '', 'OnDelete').map((type) => ({
    guard: 5,
    valuesPath: 'deploymentStrategy.type',
    values: { deploymentStrategy: { type } },
  })),

  // Guard 6: config.basePath requires a leading slash.
  malformedBasePathArb
    .filter((candidate) => candidate.guard === 6)
    .map((candidate) => ({
      guard: 6,
      valuesPath: 'config.basePath',
      values: { config: { basePath: candidate.value }, ingress: { enabled: false } },
    })),

  // Guard 7: config.basePath rejects a trailing slash beyond a single character.
  malformedBasePathArb
    .filter((candidate) => candidate.guard === 7)
    .map((candidate) => ({
      guard: 7,
      valuesPath: 'config.basePath',
      values: { config: { basePath: candidate.value }, ingress: { enabled: false } },
    })),

  // Guard 8: every extraEnv entry needs a non-empty name.
  fc
    .tuple(
      fc.array(fc.record({ name: envVarNameArb, value: fc.string({ maxLength: 8 }) }), {
        maxLength: 2,
      }),
      fc.string({ maxLength: 8 }),
    )
    .map(([valid, value]) => ({
      guard: 8,
      valuesPath: 'extraEnv',
      values: { extraEnv: [...valid, { name: '', value }] },
    })),

  // Guard 9: auth.jwtSecret and auth.existingSecret are mutually exclusive.
  fc.tuple(secretValueArb, dnsLabelArb).map(([jwtSecret, existingSecret]) => ({
    guard: 9,
    valuesPath: 'auth.jwtSecret',
    alsoNames: 'auth.existingSecret',
    values: { auth: { jwtSecret, existingSecret } },
  })),

  // Guard 10: service.nodePort must sit in 30000-32767 for type NodePort.
  fc
    .oneof(fc.integer({ min: 1, max: 29_999 }), fc.integer({ min: 32_768, max: 65_535 }))
    .map((nodePort) => ({
      guard: 10,
      valuesPath: 'service.nodePort',
      values: { service: { type: 'NodePort', nodePort } },
    })),

  // Guard 11: an enabled ingress needs at least one host entry.
  fc.constant({
    guard: 11,
    valuesPath: 'ingress.hosts',
    values: { ingress: { enabled: true, hosts: [] } },
  }),

  // Guard 12: every host entry needs at least one path entry.
  fc.integer({ min: 0, max: 2 }).chain((hostIndex) =>
    fc
      .array(
        fc
          .array(dnsLabelArb, { minLength: 2, maxLength: 3 })
          .map((labels) => labels.join('.')),
        { minLength: hostIndex, maxLength: hostIndex },
      )
      .map((leadingHosts) => ({
        guard: 12,
        valuesPath: 'ingress.hosts',
        hostIndex,
        values: {
          config: { basePath: '/scrum-poker', preservePath: true },
          ingress: {
            enabled: true,
            hosts: [
              ...leadingHosts.map((host) => ({
                host,
                paths: [{ path: '/scrum-poker', pathType: 'Prefix' }],
              })),
              { host: '', paths: [] },
            ],
          },
        },
      })),
  ),

  // Guard 13: base path must equal the ingress path when preservePath is true.
  fc
    .tuple(basePathArb, ingressPathArb)
    .filter(([basePath, ingressPath]) => (basePath === '' ? '/' : basePath) !== ingressPath)
    .map(([basePath, ingressPath]) => ({
      guard: 13,
      valuesPath: 'config.basePath',
      hostIndex: 0,
      values: {
        config: { basePath, preservePath: true },
        ingress: {
          enabled: true,
          hosts: [{ host: '', paths: [{ path: ingressPath, pathType: 'Prefix' }] }],
        },
      },
    })),
];

/** One (guard id, violating value) pair per guard, for Property 15. */
export const guardViolationArb: fc.Arbitrary<GuardViolation> = fc.oneof(...guardViolations);

/** A values patch that violates exactly one declared `values.schema.json` constraint. */
export interface SchemaViolation {
  /** Dot-notation values path the rejection message should name. */
  path: string;
  /**
   * The violating value. For `constraint: 'required'` this is `null`, which is
   * how a values file *deletes* a chart default: Helm's coalesce drops the key
   * rather than setting a null, so the member of the top-level `required` set
   * named by `path` goes missing from the merged document.
   */
  value: unknown;
  /** Which kind of constraint it violates. */
  constraint:
    | 'type'
    | 'enum'
    | 'minimum'
    | 'maximum'
    | 'minLength'
    | 'maxLength'
    | 'pattern'
    | 'required';
}

/**
 * Every case here was run against the committed `values.schema.json` and
 * confirmed to be rejected, rather than inferred from the design's sketch of
 * it. Two kinds of case did not survive that check:
 *
 *   - **Empty resource leaves.** `resources.requests.cpu: ""` and
 *     `resources.limits.cpu: ""` are *accepted*: the schema types each leaf
 *     `["string","null"]` with no `minLength`, deliberately, because an
 *     operator drops a leaf by emptying or nulling it and the templates then
 *     omit it (Requirement 7.1). A non-string leaf is still rejected, so the
 *     leaf constraint is exercised by a type violation instead.
 *   - **`deploymentStrategy.type`.** The schema types it as a string only and
 *     leaves the permitted set to guard 5, so a value like `recreate` is
 *     rejected a layer later with a different message shape. It stays out of
 *     this list and lives in `guardViolationArb` instead.
 */
const schemaViolations: SchemaViolation[] = [
  { path: 'replicaCount', value: 'one', constraint: 'type' },
  { path: 'replicaCount', value: 1.5, constraint: 'type' },

  // `required`: nulling a key deletes it from the merged values, so the
  // member of the top-level `required` set goes absent (Requirement 11.9).
  { path: 'replicaCount', value: null, constraint: 'required' },
  { path: 'image', value: null, constraint: 'required' },
  { path: 'service', value: null, constraint: 'required' },
  { path: 'config', value: null, constraint: 'required' },

  { path: 'image.repository', value: '', constraint: 'minLength' },
  { path: 'image.repository', value: 42, constraint: 'type' },
  { path: 'image.repository', value: 'r'.repeat(254), constraint: 'maxLength' },
  { path: 'image.tag', value: 't'.repeat(129), constraint: 'maxLength' },
  { path: 'image.tag', value: 7, constraint: 'type' },
  { path: 'image.pullPolicy', value: 'Sometimes', constraint: 'enum' },
  { path: 'image.pullPolicy', value: '', constraint: 'enum' },

  { path: 'service.type', value: 'Internal', constraint: 'enum' },
  { path: 'service.port', value: 0, constraint: 'minimum' },
  { path: 'service.port', value: 65_536, constraint: 'maximum' },
  { path: 'service.port', value: 'eighty', constraint: 'type' },
  { path: 'service.targetPort', value: 0, constraint: 'minimum' },
  { path: 'service.targetPort', value: 70_000, constraint: 'maximum' },
  { path: 'service.nodePort', value: 100, constraint: 'minimum' },
  { path: 'service.nodePort', value: 40_000, constraint: 'maximum' },
  { path: 'service.nodePort', value: 'none', constraint: 'type' },
  { path: 'service.sessionAffinity', value: 'Session', constraint: 'enum' },
  { path: 'service.sessionAffinityTimeoutSeconds', value: 0, constraint: 'minimum' },
  { path: 'service.sessionAffinityTimeoutSeconds', value: 90_000, constraint: 'maximum' },

  { path: 'config.nodeEnv', value: 'staging', constraint: 'enum' },
  { path: 'config.basePath', value: 'scrum-poker', constraint: 'pattern' },
  { path: 'config.basePath', value: `/${'a'.repeat(70)}`, constraint: 'maxLength' },
  { path: 'config.basePath', value: 5, constraint: 'type' },
  { path: 'config.preservePath', value: 'true', constraint: 'type' },

  { path: 'auth.jwtSecret', value: 's'.repeat(257), constraint: 'maxLength' },
  { path: 'auth.existingSecret', value: 's'.repeat(254), constraint: 'maxLength' },
  { path: 'auth.existingSecretKey', value: 'k'.repeat(254), constraint: 'maxLength' },

  { path: 'securityContext.runAsNonRoot', value: 'yes', constraint: 'type' },
  { path: 'securityContext.readOnlyRootFilesystem', value: 1, constraint: 'type' },
  { path: 'securityContext.runAsUser', value: 0, constraint: 'minimum' },
  { path: 'securityContext.runAsUser', value: 70_000, constraint: 'maximum' },
  { path: 'securityContext.runAsUser', value: 'root', constraint: 'type' },

  // Nullable leaves: empty and null pass by design, a non-string does not.
  { path: 'resources', value: 'none', constraint: 'type' },
  { path: 'resources.requests.cpu', value: 128, constraint: 'type' },
  { path: 'resources.requests.memory', value: 128, constraint: 'type' },
  { path: 'resources.limits.cpu', value: true, constraint: 'type' },
  { path: 'resources.limits.memory', value: 256, constraint: 'type' },

  { path: 'tmpVolume.sizeLimit', value: '', constraint: 'minLength' },
  { path: 'tmpVolume.sizeLimit', value: 64, constraint: 'type' },

  { path: 'readinessProbe.enabled', value: 'true', constraint: 'type' },
  { path: 'readinessProbe.periodSeconds', value: 0, constraint: 'minimum' },
  { path: 'readinessProbe.periodSeconds', value: 3_601, constraint: 'maximum' },
  { path: 'readinessProbe.timeoutSeconds', value: '10', constraint: 'type' },
  { path: 'livenessProbe.failureThreshold', value: 0, constraint: 'minimum' },
  { path: 'livenessProbe.initialDelaySeconds', value: 5_000, constraint: 'maximum' },
];

/** One (property path, violating value) pair per declared schema constraint, for Property 16. */
export const schemaViolationArb: fc.Arbitrary<SchemaViolation> =
  fc.constantFrom(...schemaViolations);
