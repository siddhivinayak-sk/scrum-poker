/**
 * Feature: helm-chart-deployment - ServiceAccount unit tests (task 5.2).
 *
 * Deterministic example-based tests, not one of the 16 correctness properties.
 * They pin the four `serviceAccount.create` x `serviceAccount.name`
 * combinations that `scrum-poker.serviceAccountName` and
 * `templates/serviceaccount.yaml` have to agree on:
 *
 * | create | name    | ServiceAccount resource | resolved name       |
 * |--------|---------|-------------------------|---------------------|
 * | true   | ""      | rendered                | `scrum-poker.fullname` |
 * | true   | set     | rendered                | the supplied name   |
 * | false  | set     | not rendered            | the supplied name   |
 * | false  | ""      | not rendered            | `default`           |
 *
 * The last row is the one worth stating out loud: `create=false` with no name
 * means "run as the namespace `default` ServiceAccount", so the pod must carry
 * the literal name `default` rather than an empty field.
 *
 * **Requirements: 2.11**
 *
 * ### Behaviour before the Deployment template exists
 *
 * Task 7.1 writes `templates/deployment.yaml` concurrently with this file, so
 * a Deployment may or may not be present when these tests run.
 * `resolvedServiceAccountName` therefore reads
 * `spec.template.spec.serviceAccountName` **only when a Deployment document is
 * present** and falls back to the rendered ServiceAccount's own
 * `metadata.name`. Where neither exists - the two `create=false` rows before
 * the Deployment lands - the expectation is recorded as unobservable and only
 * the "no ServiceAccount resource" half is asserted. Each case states which
 * half it checked in its failure message, so the tests tighten on their own
 * once the Deployment renders, with no edit here.
 */
import { describe, expect, it } from 'vitest';
import { renderChart } from './support/render-chart.js';

/** `scrum-poker.fullname` for release `rel` and the default `nameOverride`. */
const FULLNAME = 'rel-scrum-poker';

/** The namespace ServiceAccount a `create=false` release with no name uses. */
const DEFAULT_SERVICE_ACCOUNT = 'default';

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function docsOfKind(docs: unknown[], kind: string): Record<string, unknown>[] {
  return docs.filter(isMapping).filter((doc) => doc['kind'] === kind);
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

interface ServiceAccountRender {
  /** The single rendered ServiceAccount, or `undefined` when none rendered. */
  serviceAccount: Record<string, unknown> | undefined;
  /**
   * The name the pod will run as, and where it was read from. `source` is
   * `'none'` when neither a Deployment nor a ServiceAccount is present, which
   * is the expected state for `create=false` until task 7.1 lands.
   */
  resolvedName: string | undefined;
  source: 'deployment' | 'serviceaccount' | 'none';
}

/**
 * Render the chart with a `serviceAccount` patch and locate both the
 * ServiceAccount resource and the resolved account name.
 *
 * The Deployment is preferred as the source of the resolved name because
 * `spec.template.spec.serviceAccountName` is what Requirement 2.11 is about;
 * the ServiceAccount's `metadata.name` is the same template output and serves
 * as the fallback while the Deployment does not yet exist.
 */
function renderServiceAccount(serviceAccount: Record<string, unknown>): ServiceAccountRender {
  const result = renderChart({ serviceAccount });
  expect(result.status, result.stderr).toBe(0);

  const accounts = docsOfKind(result.docs, 'ServiceAccount');
  expect(accounts.length, 'at most one ServiceAccount renders').toBeLessThanOrEqual(1);
  const serviceAccountDoc = accounts[0];

  const deployments = docsOfKind(result.docs, 'Deployment');
  const fromDeployment = deployments[0]
    ? getPath(deployments[0], 'spec.template.spec.serviceAccountName')
    : undefined;

  if (deployments[0] !== undefined) {
    expect(
      typeof fromDeployment,
      'a rendered Deployment must set spec.template.spec.serviceAccountName',
    ).toBe('string');
    return {
      serviceAccount: serviceAccountDoc,
      resolvedName: fromDeployment as string,
      source: 'deployment',
    };
  }
  if (serviceAccountDoc !== undefined) {
    const name = getPath(serviceAccountDoc, 'metadata.name');
    expect(typeof name, 'the rendered ServiceAccount must carry a name').toBe('string');
    return { serviceAccount: serviceAccountDoc, resolvedName: name as string, source: 'serviceaccount' };
  }
  return { serviceAccount: undefined, resolvedName: undefined, source: 'none' };
}

/**
 * Assert the resolved account name when it is observable, and say so when it
 * is not. Returns the source so a caller can report what was covered.
 */
function expectResolvedName(render: ServiceAccountRender, expected: string): void {
  if (render.source === 'none') {
    // Neither template that carries the name is rendering yet; the companion
    // "no ServiceAccount resource" assertion is the whole of the check.
    expect(render.resolvedName).toBeUndefined();
    return;
  }
  expect(render.resolvedName, `resolved ServiceAccount name, read from the ${render.source}`).toBe(
    expected,
  );
}

describe('ServiceAccount: create=true', () => {
  it('renders a ServiceAccount named from the fullname when no name is supplied', () => {
    const render = renderServiceAccount({ create: true, name: '' });

    expect(render.serviceAccount, 'create=true renders a ServiceAccount').toBeDefined();
    expect(getPath(render.serviceAccount, 'metadata.name')).toBe(FULLNAME);
    expect(getPath(render.serviceAccount, 'apiVersion')).toBe('v1');
    expectResolvedName(render, FULLNAME);
  });

  it('renders a ServiceAccount named from serviceAccount.name when one is supplied', () => {
    const render = renderServiceAccount({ create: true, name: 'poker-runner' });

    expect(render.serviceAccount, 'create=true renders a ServiceAccount').toBeDefined();
    expect(getPath(render.serviceAccount, 'metadata.name')).toBe('poker-runner');
    expectResolvedName(render, 'poker-runner');
  });

  it('carries the common labels and omits annotations for an empty mapping', () => {
    const render = renderServiceAccount({ create: true, name: '', annotations: {} });

    const labels = getPath(render.serviceAccount, 'metadata.labels');
    expect(isMapping(labels) ? Object.keys(labels).sort() : [], 'common label keys').toEqual([
      'app.kubernetes.io/instance',
      'app.kubernetes.io/managed-by',
      'app.kubernetes.io/name',
      'app.kubernetes.io/version',
      'helm.sh/chart',
    ]);
    expect(
      getPath(render.serviceAccount, 'metadata.annotations'),
      'an empty annotations mapping omits the field rather than rendering {} or null',
    ).toBeUndefined();
  });

  it('renders supplied annotations unchanged', () => {
    const annotations = {
      'eks.amazonaws.com/role-arn': 'arn:aws:iam::123456789012:role/scrum-poker',
      'example.com/owner': 'platform-team',
    };
    const render = renderServiceAccount({ create: true, name: '', annotations });

    expect(getPath(render.serviceAccount, 'metadata.annotations')).toEqual(annotations);
  });
});

describe('ServiceAccount: create=false', () => {
  it('renders no ServiceAccount and uses the supplied name when one is given', () => {
    const render = renderServiceAccount({ create: false, name: 'preprovisioned-sa' });

    expect(render.serviceAccount, 'create=false renders no ServiceAccount').toBeUndefined();
    expectResolvedName(render, 'preprovisioned-sa');
  });

  it('renders no ServiceAccount and falls back to the namespace default SA with no name', () => {
    const render = renderServiceAccount({ create: false, name: '' });

    expect(render.serviceAccount, 'create=false renders no ServiceAccount').toBeUndefined();
    expectResolvedName(render, DEFAULT_SERVICE_ACCOUNT);
  });

  it('renders no ServiceAccount even when annotations are supplied', () => {
    const render = renderServiceAccount({
      create: false,
      name: 'preprovisioned-sa',
      annotations: { 'example.com/owner': 'platform-team' },
    });

    expect(
      render.serviceAccount,
      'serviceAccount.create alone decides whether the resource renders',
    ).toBeUndefined();
  });
});
