/**
 * Feature: helm-chart-deployment - Service unit tests (task 8.2).
 *
 * Deterministic example-based tests, not one of the 16 correctness properties.
 * They pin the branch matrix of `templates/service.yaml`, which has three
 * independent switches that interact:
 *
 * | switch                     | branches                                      |
 * |----------------------------|-----------------------------------------------|
 * | `service.type`             | `ClusterIP` / `NodePort` / `LoadBalancer`     |
 * |                            | plus nulled-out, plus schema rejection        |
 * | `service.sessionAffinity`  | `ClientIP` / `None` / `""`                    |
 * | `service.nodePort`         | held vs `null`, gated on the type             |
 *
 * The interaction worth pinning is the third row: `nodePort` renders only when
 * the type is exactly `NodePort` *and* the value is held, so a leftover
 * `service.nodePort` left behind by a type change is silently ignored rather
 * than rendered into a ClusterIP or LoadBalancer Service, where the API server
 * would reject it.
 *
 * The fixed parts of the port entry and the selector are asserted alongside,
 * because they are what makes the Service reach the pod at all: one port named
 * `http` whose `targetPort` is the *string* container-port name, and a
 * selector holding exactly the two selector labels.
 *
 * **Requirements: 3.3, 3.7, 3.8, 3.11, 3.12**
 */
import { describe, expect, it } from 'vitest';
import { renderChart } from './support/render-chart.js';

/** `service.port` default in `values.yaml`. */
const DEFAULT_PORT = 80;

/** `service.sessionAffinityTimeoutSeconds` default in `values.yaml`. */
const DEFAULT_AFFINITY_TIMEOUT = 10800;

/** A NodePort inside the permitted 30000-32767 range. */
const VALID_NODE_PORT = 31000;

/** The exact key set `scrum-poker.selectorLabels` emits. */
const SELECTOR_LABEL_KEYS = ['app.kubernetes.io/instance', 'app.kubernetes.io/name'];

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

/**
 * Render the chart with a `service` patch and return the single Service
 * document. Asserting "exactly one" here means every case below also covers
 * criterion 3.1's resource count for free.
 */
function renderService(service: Record<string, unknown>): Record<string, unknown> {
  const result = renderChart({ service });
  expect(result.status, result.stderr).toBe(0);

  const services = result.docs.filter(isMapping).filter((doc) => doc['kind'] === 'Service');
  expect(services.length, 'exactly one Service renders').toBe(1);
  const doc = services[0] as Record<string, unknown>;
  expect(doc['apiVersion']).toBe('v1');
  return doc;
}

/** The single `spec.ports` entry, with the "exactly one" check applied. */
function soleServicePort(doc: Record<string, unknown>): Record<string, unknown> {
  const ports = getPath(doc, 'spec.ports');
  expect(Array.isArray(ports), 'spec.ports is a list').toBe(true);
  const list = ports as unknown[];
  expect(list.length, 'spec.ports holds exactly one entry').toBe(1);
  expect(isMapping(list[0]), 'the port entry is a mapping').toBe(true);
  return list[0] as Record<string, unknown>;
}

describe('Service: spec.type (Requirement 3.3)', () => {
  it('renders ClusterIP for the chart default', () => {
    const doc = renderService({});

    expect(getPath(doc, 'spec.type')).toBe('ClusterIP');
  });

  it.each(['ClusterIP', 'NodePort', 'LoadBalancer'])('renders the supplied type %s', (type) => {
    // NodePort is supplied with a valid nodePort so guard 10 stays satisfied;
    // the other two types ignore the key entirely.
    const doc = renderService({ type, nodePort: VALID_NODE_PORT });

    expect(getPath(doc, 'spec.type')).toBe(type);
  });

  /**
   * Requirement 3.3's defaulting clause and requirement 11.4's enum are two
   * layers, and only one of them is reachable by the template.
   *
   * Layer 1 is `values.schema.json`, which constrains `service.type` to the
   * enum `ClusterIP` / `NodePort` / `LoadBalancer` (requirements 3.3, 11.4).
   * Helm validates the merged values against that schema *before* any
   * template runs, so an out-of-enum string such as `""` never reaches
   * `service.yaml` at all - it is rejected with a non-zero exit.
   *
   * Layer 2 is the template's `| default "ClusterIP"` pipeline. The value that
   * reaches it is therefore never an out-of-enum string; it is a *missing*
   * one. Writing `service.type: null` in an override is how an operator gets
   * there: Helm's merge deletes a key whose override value is null, the
   * schema does not require `service.type`, so the merged values carry no
   * `service.type` and the pipeline supplies the default. That is the only
   * reachable path to the defaulting clause, so it is what the first case
   * below exercises.
   */
  it('falls back to ClusterIP when the type is nulled out', () => {
    const doc = renderService({ type: null });

    expect(
      getPath(doc, 'spec.type'),
      'the `default "ClusterIP"` pipeline covers a value the operator removed',
    ).toBe('ClusterIP');
  });

  it('rejects an empty type at the schema before any template runs', () => {
    const result = renderChart({ service: { type: '' } });

    expect(result.status, 'an out-of-enum service.type is a schema violation').not.toBe(0);
    expect(result.stderr, 'the message names the offending values path').toContain('service.type');
    expect(result.stdout.trim(), 'a rejected render emits no manifests').toBe('');
  });
});

describe('Service: nodePort gating (Requirements 3.7, 3.11)', () => {
  it('renders nodePort when the type is NodePort and a value is held', () => {
    const doc = renderService({ type: 'NodePort', nodePort: VALID_NODE_PORT });

    expect(soleServicePort(doc)['nodePort']).toBe(VALID_NODE_PORT);
  });

  it('omits nodePort when the type is NodePort and the value is null', () => {
    const doc = renderService({ type: 'NodePort', nodePort: null });

    expect(
      soleServicePort(doc)['nodePort'],
      'a NodePort Service with no requested port lets the cluster allocate one',
    ).toBeUndefined();
  });

  it('omits nodePort for a ClusterIP Service even when a value is held', () => {
    const doc = renderService({ type: 'ClusterIP', nodePort: VALID_NODE_PORT });

    expect(
      soleServicePort(doc)['nodePort'],
      'a leftover service.nodePort is ignored for a non-NodePort type',
    ).toBeUndefined();
  });

  it('omits nodePort for a LoadBalancer Service even when a value is held', () => {
    const doc = renderService({ type: 'LoadBalancer', nodePort: VALID_NODE_PORT });

    expect(soleServicePort(doc)['nodePort']).toBeUndefined();
  });
});

describe('Service: sessionAffinity (Requirements 3.8, 3.12)', () => {
  it('renders ClientIP affinity with the default timeout', () => {
    const doc = renderService({ sessionAffinity: 'ClientIP' });

    expect(getPath(doc, 'spec.sessionAffinity')).toBe('ClientIP');
    expect(getPath(doc, 'spec.sessionAffinityConfig.clientIP.timeoutSeconds')).toBe(
      DEFAULT_AFFINITY_TIMEOUT,
    );
  });

  it('renders ClientIP affinity with an overridden timeout', () => {
    const doc = renderService({ sessionAffinity: 'ClientIP', sessionAffinityTimeoutSeconds: 600 });

    expect(getPath(doc, 'spec.sessionAffinity')).toBe('ClientIP');
    expect(getPath(doc, 'spec.sessionAffinityConfig.clientIP.timeoutSeconds')).toBe(600);
  });

  it.each(['None', ''])('renders None affinity and no affinity config for %o', (affinity) => {
    const doc = renderService({ sessionAffinity: affinity });

    expect(getPath(doc, 'spec.sessionAffinity')).toBe('None');
    expect(
      getPath(doc, 'spec.sessionAffinityConfig'),
      'sessionAffinityConfig is meaningless without ClientIP affinity',
    ).toBeUndefined();
  });

  it('renders None affinity for the chart default', () => {
    const doc = renderService({});

    expect(getPath(doc, 'spec.sessionAffinity')).toBe('None');
    expect(getPath(doc, 'spec.sessionAffinityConfig')).toBeUndefined();
  });

  it('keeps affinity independent of the Service type', () => {
    const doc = renderService({
      type: 'NodePort',
      nodePort: VALID_NODE_PORT,
      sessionAffinity: 'ClientIP',
    });

    expect(getPath(doc, 'spec.type')).toBe('NodePort');
    expect(getPath(doc, 'spec.sessionAffinity')).toBe('ClientIP');
    expect(soleServicePort(doc)['nodePort']).toBe(VALID_NODE_PORT);
  });
});

describe('Service: port entry shape (Requirement 3.4)', () => {
  it('renders one http port whose targetPort is the container-port name', () => {
    const port = soleServicePort(renderService({}));

    expect(port['name']).toBe('http');
    expect(port['port'], 'port carries the integer service.port').toBe(DEFAULT_PORT);
    expect(typeof port['targetPort'], 'targetPort is the string port name, not a number').toBe(
      'string',
    );
    expect(port['targetPort']).toBe('http');
    expect(port['protocol']).toBe('TCP');
  });

  it('carries an overridden service.port as an integer', () => {
    const port = soleServicePort(renderService({ port: 8080 }));

    expect(port['port']).toBe(8080);
    expect(
      port['targetPort'],
      'targetPort tracks the container port name, so service.port does not touch it',
    ).toBe('http');
  });
});

describe('Service: selector and annotations (Requirements 3.6, 3.9)', () => {
  it('selects on exactly the two selector labels and no extra key', () => {
    const selector = getPath(renderService({}), 'spec.selector');

    expect(isMapping(selector), 'spec.selector is a mapping').toBe(true);
    expect(Object.keys(selector as Record<string, unknown>).sort()).toEqual(SELECTOR_LABEL_KEYS);
  });

  it('omits metadata.annotations for an empty annotations mapping', () => {
    const doc = renderService({ annotations: {} });

    expect(
      getPath(doc, 'metadata.annotations'),
      'an empty mapping omits the field rather than rendering {} or null',
    ).toBeUndefined();
  });

  it('renders supplied annotations unchanged', () => {
    const annotations = {
      'service.beta.kubernetes.io/aws-load-balancer-internal': 'true',
      'example.com/owner': 'platform-team',
    };
    const doc = renderService({ type: 'LoadBalancer', annotations });

    expect(getPath(doc, 'metadata.annotations')).toEqual(annotations);
  });
});
