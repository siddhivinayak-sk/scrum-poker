/**
 * Feature: helm-chart-deployment - task 7.8, Property 9.
 *
 * Property 9: Probe paths are invariant under base path.
 *
 * *For any* valid `config.basePath` value, including the empty string and
 * multi-segment prefixes, both the readiness and liveness probe `path` fields
 * render as the literal string `/api/health`, and the rendered output contains
 * exactly two occurrences of that path when both probes are enabled.
 *
 * **Validates: Requirements 6.3**
 *
 * ### Why this is the property worth having
 *
 * `server.ts` registers `app.get('/api/health', ...)` on the root app *before*
 * mounting the application router at the public path, so the health endpoint
 * answers at that fixed location whatever `BASE_PATH` holds. A probe path that
 * interpolated `config.basePath` would therefore 404 on every non-root
 * deployment, and kubelet would restart a healthy pod on a loop. The failure
 * is invisible with the chart defaults - `/scrum-poker` happens to be served -
 * and only shows up once an operator moves the prefix, which is exactly the
 * axis this property sweeps.
 *
 * `port` and `scheme` are asserted alongside the path because the same three
 * lines carry the rest of Requirements 6.1 and 6.2: `port` references the
 * container port *by name*, so moving `service.targetPort` can never
 * desynchronise the probes from the port, and it must stay a string - a bare
 * `http` is fine, but the same field rendered unquoted for a name such as `y`
 * or `on` would be read back as a boolean and rejected by the API server.
 *
 * ### Reading the raw bytes as well as the parsed tree
 *
 * The occurrence count in the design is a statement about the rendered
 * document, so it is counted in the raw `helm template` output. The raw view
 * also catches the case the parsed tree hides: `port: http` and `port: "http"`
 * both parse to the string `'http'`, and only one of them is robust to a port
 * name the YAML 1.1 parser resolves to a non-string.
 *
 * Every case that moves `config.basePath` also disables the ingress. Guard 13
 * couples `config.basePath` to the ingress paths whenever `ingress.enabled`
 * and `config.preservePath` are both true, and this property is about the
 * probes, not that guard - `tests/helm` covers guard 13 separately.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renderChart, type RenderResult } from './support/render-chart.js';
import { assertConfig, basePathArb } from './support/generators.js';

/** The fixed location the application serves its health endpoint at. */
const HEALTH_PATH = '/api/health';

/** The container port name both probes reference. */
const PORT_NAME = 'http';

/** The two probe fields the Deployment renders, in template order. */
const PROBE_KEYS = ['readinessProbe', 'livenessProbe'] as const;

/** The only keys an `httpGet` block of this chart is allowed to carry. */
const EXPECTED_HTTP_GET_KEYS = ['path', 'port', 'scheme'] as const;

type ProbeKey = (typeof PROBE_KEYS)[number];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The single application container of the single rendered Deployment. */
function scrumPokerContainer(docs: unknown[]): Record<string, unknown> {
  const deployments = docs.filter((doc) => isMapping(doc) && doc['kind'] === 'Deployment');
  expect(deployments.length, 'expected exactly one rendered Deployment').toBe(1);

  const spec = (deployments[0] as Record<string, unknown>)['spec'];
  const template = isMapping(spec) ? spec['template'] : undefined;
  const podSpec = isMapping(template) ? template['spec'] : undefined;
  const containers = isMapping(podSpec) ? podSpec['containers'] : undefined;
  expect(Array.isArray(containers), 'Deployment pod spec holds no containers list').toBe(true);

  const named = (containers as unknown[]).filter(
    (container) => isMapping(container) && container['name'] === 'scrum-poker',
  );
  expect(named.length, 'expected exactly one container named scrum-poker').toBe(1);
  return named[0] as Record<string, unknown>;
}

/** The `httpGet` block of one probe, which must be present and a mapping. */
function httpGet(container: Record<string, unknown>, probe: ProbeKey): Record<string, unknown> {
  const block = container[probe];
  expect(isMapping(block), `container carries no ${probe}`).toBe(true);

  const get = (block as Record<string, unknown>)['httpGet'];
  expect(isMapping(get), `${probe} carries no httpGet block`).toBe(true);
  return get as Record<string, unknown>;
}

/**
 * Assert the three `httpGet` fields of one probe.
 *
 * Deliberately strict about the key set: an `httpGet` that grew an `host` or
 * `httpHeaders` entry would change where the probe actually connects, which is
 * the thing this property exists to pin down.
 */
function assertProbeHttpGet(
  container: Record<string, unknown>,
  probe: ProbeKey,
  basePath: string,
): void {
  const get = httpGet(container, probe);

  expect(Object.keys(get).sort(), `${probe}.httpGet keys`).toEqual([...EXPECTED_HTTP_GET_KEYS]);

  // The literal path, byte for byte - not the base path, not the base path
  // with the health route appended, not a stray trailing slash.
  expect(get['path'], `${probe} path with config.basePath "${basePath}"`).toBe(HEALTH_PATH);
  // A string port, holding the container port *name*.
  expect(typeof get['port'], `${probe} port parses as a string`).toBe('string');
  expect(get['port'], `${probe} port`).toBe(PORT_NAME);
  expect(get['scheme'], `${probe} scheme`).toBe('HTTP');
}

/** Every occurrence of `needle` in `haystack`, counted without overlap. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The raw lines of every `httpGet` block in the rendered output, one array per
 * block, with indentation stripped.
 *
 * Scoped to the block rather than filtered by key name: `port:` also appears
 * under `Service.spec.ports`, and `path:` under the Ingress rules, so a
 * document-wide filter would mix those in. A block runs from its `httpGet:`
 * line to the first following line indented no further than it.
 */
function rawHttpGetBlocks(stdout: string): string[][] {
  const lines = stdout.split(/\r?\n/);
  const blocks: string[][] = [];
  for (const [index, line] of lines.entries()) {
    const opener = /^(\s*)httpGet:\s*$/.exec(line);
    if (opener === null) {
      continue;
    }
    const openerIndent = (opener[1] as string).length;
    const block: string[] = [];
    for (const candidate of lines.slice(index + 1)) {
      if (candidate.trim() === '') {
        continue;
      }
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= openerIndent) {
        break;
      }
      block.push(candidate.trim());
    }
    blocks.push(block);
  }
  return blocks;
}

/** The assertions that hold for a render with both probes enabled. */
function assertProbePathsInvariant(result: RenderResult, basePath: string): void {
  expect(result.status, result.stderr).toBe(0);

  const container = scrumPokerContainer(result.docs);
  for (const probe of PROBE_KEYS) {
    assertProbeHttpGet(container, probe, basePath);
  }

  // Exactly two occurrences in the rendered document, one per probe. A base
  // path that leaked into a probe would either move an occurrence away from
  // this string or add a third.
  expect(
    countOccurrences(result.stdout, HEALTH_PATH),
    `occurrences of ${HEALTH_PATH} with config.basePath "${basePath}"`,
  ).toBe(2);

  // And the rendered bytes of both blocks, quoting included: two blocks, each
  // holding exactly these three lines. The quotes matter for `port` and
  // `scheme`, which are strings in the Kubernetes API.
  const expectedBlock = [
    `path: "${HEALTH_PATH}"`,
    `port: "${PORT_NAME}"`,
    'scheme: "HTTP"',
  ];
  expect(rawHttpGetBlocks(result.stdout)).toEqual([expectedBlock, expectedBlock]);
}

describe('Property 9: probe paths are invariant under base path', () => {
  it('renders both probe paths as the literal health endpoint for any config.basePath', () => {
    fc.assert(
      fc.property(basePathArb, fc.boolean(), (basePath, preservePath) => {
        // The ingress is disabled throughout, so guard 13 - which requires the
        // ingress paths to agree with the base path - stays out of a property
        // about the probes. preservePath is swept anyway: it is the other half
        // of the routing configuration, and it must not reach the probes
        // either.
        const result = renderChart({
          config: { basePath, preservePath },
          ingress: { enabled: false },
        });

        assertProbePathsInvariant(result, basePath);
      }),
      {
        ...assertConfig,
        // The three shapes Requirement 6.3 names explicitly, pinned as
        // examples so no seed can skip them.
        examples: [
          ['', true],
          ['/', true],
          ['/scrum-poker', true],
          ['/a/b/c', false],
        ],
      },
    );
  });
});

/**
 * The same assertions at the chart defaults, where `config.basePath` is
 * `/scrum-poker` and the ingress is enabled. Cheap, deterministic, and it
 * proves the property is not an artefact of disabling the ingress.
 */
describe('probe paths at the chart defaults', () => {
  const result = renderChart({});

  it('renders both probes against the health endpoint on the named port over HTTP', () => {
    assertProbePathsInvariant(result, '/scrum-poker');
  });
});
