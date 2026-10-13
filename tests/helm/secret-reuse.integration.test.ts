/**
 * Feature: helm-chart-deployment - JWT secret reuse integration tests (task 4.4).
 *
 * These are **not** offline property tests, and they cannot be. The reuse
 * behaviour lives entirely in `scrum-poker.jwtSecret`'s middle precedence
 * step, which calls Helm's `lookup`. `lookup` returns an empty map whenever
 * there is no live API connection, so under `helm template` and client-side
 * `helm lint` the helper always falls through to `randAlphaNum 32`. Observing
 * reuse therefore requires a real `helm install` followed by a real
 * `helm upgrade` against a real cluster.
 *
 * Two behaviours are pinned:
 *
 * - **Requirement 5.7** - install, read `JWT_SECRET`, upgrade with the same
 *   values, and the stored value is byte-identical. Tokens issued before the
 *   upgrade stay verifiable after it.
 * - **Requirement 5.8** - install with generation, then upgrade supplying a
 *   non-empty `auth.jwtSecret`, and the explicit value replaces the generated
 *   one. An operator's explicit input outranks anything already stored.
 *
 * ### No cluster is not a failure
 *
 * Most hosts that run this harness have no cluster. The suite probes for one
 * before doing anything (`helm`, `kubectl`, `kubectl cluster-info`, and
 * permission to create a namespace) and skips the whole `describe` when any
 * part of that is missing, printing the reason. It never reports a failure
 * merely because there is nothing to talk to.
 *
 * ### Footprint
 *
 * Everything lands in one freshly generated namespace whose name is unique per
 * run, so a concurrent run cannot collide and an existing release cannot be
 * touched. `afterAll` uninstalls both releases and deletes the namespace, and
 * runs even when a test fails midway. Installs deliberately omit `--wait`:
 * the Secret exists the moment `helm install` returns, and waiting on pod
 * readiness would make the suite depend on the image being pullable from the
 * cluster.
 *
 * **Requirements: 5.7, 5.8**
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartDir, helmBinary, renderChart } from './support/render-chart.js';

/** Generous enough for an image-less install on a slow cluster. */
const HELM_TIMEOUT_MS = 180_000;

/** A cluster probe should answer fast or be treated as absent. */
const PROBE_TIMEOUT_MS = 20_000;

/** Vitest per-test budget: two helm operations plus two kubectl reads. */
const TEST_TIMEOUT_MS = 420_000;

/**
 * Values applied to every install and upgrade in this file.
 *
 * The ingress is disabled on purpose. It is irrelevant to secret resolution,
 * and leaving it on would make the install depend on an IngressClass existing
 * on whatever cluster happens to be reachable.
 */
const BASE_VALUES: Record<string, unknown> = {
  ingress: { enabled: false },
};

let resolvedKubectl: string | undefined;

/**
 * Absolute path to `kubectl`, resolved the same way `helmBinary` resolves
 * `helm`: `spawnSync` on Windows does not apply PATHEXT to a bare command
 * name, so the PATH is searched explicitly rather than falling back to
 * `shell: true`. `KUBECTL_BIN` overrides the search.
 */
function kubectlBinary(): string {
  if (resolvedKubectl !== undefined) {
    return resolvedKubectl;
  }
  const fromEnv = process.env['KUBECTL_BIN'];
  if (fromEnv) {
    resolvedKubectl = fromEnv;
    return resolvedKubectl;
  }
  if (process.platform !== 'win32') {
    resolvedKubectl = 'kubectl';
    return resolvedKubectl;
  }
  const extensions = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `kubectl${extension}`);
      if (existsSync(candidate)) {
        resolvedKubectl = candidate;
        return resolvedKubectl;
      }
    }
  }
  resolvedKubectl = 'kubectl';
  return resolvedKubectl;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the executable itself could not be spawned. */
  spawnError?: string;
}

/**
 * Run a command without a shell, so arguments reach the process verbatim and
 * nothing in a generated namespace or secret value can be reinterpreted by
 * `cmd.exe` or `/bin/sh`.
 */
function run(binary: string, args: string[], timeoutMs: number): CommandResult {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 1, stdout: '', stderr: '', spawnError: result.error.message };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Summarise a failed command for an assertion message or a skip reason.
 *
 * `kubectl` repeats the same connection error once per API group discovery
 * attempt, so identical lines are collapsed and the output is capped. The
 * cause stays legible without burying the message it is attached to.
 */
function describeFailure(label: string, result: CommandResult): string {
  if (result.spawnError) {
    return `${label} could not be started: ${result.spawnError}`;
  }
  const lines = [result.stderr, result.stdout]
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // klog lines carry a timestamp and pid, so they never dedupe against each
  // other; drop them and keep the human-readable summary kubectl prints last.
  const klogPrefix = /^[EWIF]\d{4} \d{2}:\d{2}:\d{2}\./;
  const meaningful = lines.filter((line) => !klogPrefix.test(line));
  const chosen = meaningful.length > 0 ? meaningful : lines;
  const detail = [...new Set(chosen)].slice(0, 4).join('\n');
  return `${label} exited ${result.status}${detail ? `:\n${detail}` : ''}`;
}

interface Probe {
  usable: boolean;
  reason: string;
}

/**
 * Decide whether a live cluster is usable for these tests.
 *
 * Four things have to hold, and the first one that does not is reported so a
 * skipped run says why it skipped rather than going quiet. Namespace-creation
 * permission is part of the probe because a read-only kubeconfig is, for this
 * suite's purposes, the same situation as no cluster: nothing can be observed,
 * and that is not a defect in the chart.
 */
function probeCluster(): Probe {
  const helmCheck = run(helmBinary(), ['version', '--short'], PROBE_TIMEOUT_MS);
  if (helmCheck.status !== 0) {
    return { usable: false, reason: describeFailure('`helm version`', helmCheck) };
  }
  const kubectlCheck = run(kubectlBinary(), ['version', '--client=true'], PROBE_TIMEOUT_MS);
  if (kubectlCheck.status !== 0) {
    return { usable: false, reason: describeFailure('`kubectl version --client`', kubectlCheck) };
  }
  const clusterCheck = run(
    kubectlBinary(),
    ['cluster-info', '--request-timeout=10s'],
    PROBE_TIMEOUT_MS,
  );
  if (clusterCheck.status !== 0) {
    return {
      usable: false,
      reason: `no reachable Kubernetes cluster - ${describeFailure('`kubectl cluster-info`', clusterCheck)}`,
    };
  }
  const permissionCheck = run(
    kubectlBinary(),
    ['auth', 'can-i', 'create', 'namespace', '--request-timeout=10s'],
    PROBE_TIMEOUT_MS,
  );
  if (permissionCheck.status !== 0 || !permissionCheck.stdout.includes('yes')) {
    return {
      usable: false,
      reason:
        'the current kubeconfig context may not create namespaces, so these tests cannot isolate themselves - ' +
        describeFailure('`kubectl auth can-i create namespace`', permissionCheck),
    };
  }
  return { usable: true, reason: `cluster reachable (helm ${helmCheck.stdout.trim()})` };
}

const probe = probeCluster();

if (probe.usable) {
  console.info(`[helm integration] running secret-reuse tests against a live cluster: ${probe.reason}`);
} else {
  console.warn(
    '\n' +
      '='.repeat(78) +
      '\n[helm integration] SKIPPED tests/helm/secret-reuse.integration.test.ts' +
      '\n  JWT secret reuse (Requirements 5.7, 5.8) depends on Helm `lookup`, which' +
      '\n  returns an empty map without a live API connection. These tests cannot be' +
      '\n  observed offline, so the suite is skipped rather than failed.' +
      `\n  Reason: ${probe.reason}` +
      '\n' +
      '='.repeat(78) +
      '\n',
  );
}

/** Unique per run, so two concurrent runs never share a namespace. */
const namespace = `sp-jwt-it-${randomBytes(4).toString('hex')}`;

/** Releases created by this file, uninstalled in `afterAll`. */
const createdReleases: string[] = [];

/** Temp directories holding the values files, removed in `afterAll`. */
const createdWorkDirs: string[] = [];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Write a values document to a fresh temp file and return its path. */
function writeValuesFile(values: Record<string, unknown>): string {
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-it-'));
  createdWorkDirs.push(workDir);
  const file = path.join(workDir, 'values.yaml');
  writeValuesFileAt(file, values);
  return file;
}

function writeValuesFileAt(file: string, values: Record<string, unknown>): void {
  writeFileSync(file, stringify(values), 'utf8');
}

/**
 * The Secret name the chart will render for this release.
 *
 * Read from an offline `helm template` of the very same chart and values
 * rather than hard-coded, so a change to `scrum-poker.secretName` or
 * `scrum-poker.fullname` cannot silently point these tests at a name the
 * chart no longer uses.
 */
function renderedSecretName(releaseName: string, values: Record<string, unknown>): string {
  const render = renderChart(values, { releaseName, namespace });
  expect(render.status, render.stderr).toBe(0);
  const secrets = render.docs.filter(isMapping).filter((doc) => doc['kind'] === 'Secret');
  expect(secrets.length, 'the chart renders exactly one Secret for a generated JWT value').toBe(1);
  const metadata = secrets[0]?.['metadata'];
  const name = isMapping(metadata) ? metadata['name'] : undefined;
  expect(typeof name, 'the rendered Secret carries a metadata.name').toBe('string');
  return name as string;
}

function helmInstall(releaseName: string, valuesFile: string): void {
  createdReleases.push(releaseName);
  const result = run(
    helmBinary(),
    [
      'install',
      releaseName,
      chartDir,
      '--namespace',
      namespace,
      '--values',
      valuesFile,
      '--timeout',
      '120s',
    ],
    HELM_TIMEOUT_MS,
  );
  expect(result.status, describeFailure(`helm install ${releaseName}`, result)).toBe(0);
}

function helmUpgrade(releaseName: string, valuesFile: string): void {
  const result = run(
    helmBinary(),
    [
      'upgrade',
      releaseName,
      chartDir,
      '--namespace',
      namespace,
      '--values',
      valuesFile,
      '--timeout',
      '120s',
    ],
    HELM_TIMEOUT_MS,
  );
  expect(result.status, describeFailure(`helm upgrade ${releaseName}`, result)).toBe(0);
}

/** The release revision Helm currently reports, used to prove an upgrade ran. */
function releaseRevision(releaseName: string): number {
  const result = run(
    kubectlBinary(),
    [
      'get',
      'secrets',
      '--namespace',
      namespace,
      '--selector',
      `owner=helm,name=${releaseName}`,
      '--output',
      'jsonpath={.items[*].metadata.labels.version}',
    ],
    PROBE_TIMEOUT_MS,
  );
  expect(result.status, describeFailure(`kubectl get helm release secrets for ${releaseName}`, result)).toBe(0);
  const revisions = result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
  expect(revisions.length, `at least one Helm release record exists for ${releaseName}`).toBeGreaterThan(0);
  return Math.max(...revisions);
}

/** The decoded `JWT_SECRET` stored in the cluster under `secretName`. */
function storedJwtSecret(secretName: string): string {
  const result = run(
    kubectlBinary(),
    [
      'get',
      'secret',
      secretName,
      '--namespace',
      namespace,
      '--output',
      'jsonpath={.data.JWT_SECRET}',
    ],
    PROBE_TIMEOUT_MS,
  );
  expect(result.status, describeFailure(`kubectl get secret ${secretName}`, result)).toBe(0);
  const encoded = result.stdout.trim();
  expect(encoded.length, `Secret ${secretName} holds a non-empty JWT_SECRET key`).toBeGreaterThan(0);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

describe.skipIf(!probe.usable)('JWT secret resolution across helm upgrade (live cluster)', () => {
  beforeAll(() => {
    const result = run(
      kubectlBinary(),
      ['create', 'namespace', namespace],
      PROBE_TIMEOUT_MS,
    );
    expect(result.status, describeFailure(`kubectl create namespace ${namespace}`, result)).toBe(0);
  });

  afterAll(() => {
    // Nothing here asserts: cleanup must finish even when a test above failed,
    // and a cleanup error must not mask the real failure.
    for (const releaseName of createdReleases) {
      run(
        helmBinary(),
        ['uninstall', releaseName, '--namespace', namespace, '--ignore-not-found', '--timeout', '120s'],
        HELM_TIMEOUT_MS,
      );
    }
    run(
      kubectlBinary(),
      ['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false'],
      HELM_TIMEOUT_MS,
    );
    for (const workDir of createdWorkDirs) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it(
    'preserves a generated JWT_SECRET across an upgrade with unchanged values',
    () => {
      const releaseName = 'jwt-reuse';
      const values = { ...BASE_VALUES, auth: { jwtSecret: '', existingSecret: '' } };
      const valuesFile = writeValuesFile(values);
      const secretName = renderedSecretName(releaseName, values);

      helmInstall(releaseName, valuesFile);
      const afterInstall = storedJwtSecret(secretName);

      // Requirement 5.6: generation produces 32 alphanumeric characters. Worth
      // asserting here because it is the precondition that makes the reuse
      // assertion below meaningful - a 0-length or constant value would pass
      // an equality check for the wrong reason.
      expect(afterInstall, 'a generated JWT_SECRET is 32 alphanumeric characters').toMatch(
        /^[A-Za-z0-9]{32}$/,
      );

      const revisionBefore = releaseRevision(releaseName);
      helmUpgrade(releaseName, valuesFile);
      const revisionAfter = releaseRevision(releaseName);
      expect(revisionAfter, 'the upgrade produced a new release revision').toBeGreaterThan(
        revisionBefore,
      );

      const afterUpgrade = storedJwtSecret(secretName);
      expect(
        afterUpgrade,
        'an upgrade with unchanged values must reuse the stored JWT_SECRET, or every token ' +
          'issued before the upgrade stops verifying',
      ).toBe(afterInstall);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'replaces a generated JWT_SECRET when an upgrade supplies an explicit auth.jwtSecret',
    () => {
      const releaseName = 'jwt-explicit';
      const generatingValues = { ...BASE_VALUES, auth: { jwtSecret: '', existingSecret: '' } };
      const valuesFile = writeValuesFile(generatingValues);
      const secretName = renderedSecretName(releaseName, generatingValues);

      helmInstall(releaseName, valuesFile);
      const generated = storedJwtSecret(secretName);
      expect(generated, 'a generated JWT_SECRET is 32 alphanumeric characters').toMatch(
        /^[A-Za-z0-9]{32}$/,
      );

      // Deliberately not 32 characters and not alphanumeric-only, so it cannot
      // be confused with a generated value and exercises base64 round-tripping
      // of a value an operator might realistically paste in.
      const explicit = `explicit-jwt-${randomBytes(6).toString('hex')}/+=`;
      expect(explicit).not.toBe(generated);

      const explicitValues = {
        ...BASE_VALUES,
        auth: { jwtSecret: explicit, existingSecret: '' },
      };
      // Reuse the same file path: the upgrade differs from the install only in
      // this one value, which is the whole point of the test.
      writeValuesFileAt(valuesFile, explicitValues);
      helmUpgrade(releaseName, valuesFile);

      const afterUpgrade = storedJwtSecret(secretName);
      expect(
        afterUpgrade,
        'a non-empty auth.jwtSecret outranks the value already stored in the namespace',
      ).toBe(explicit);
      expect(afterUpgrade).not.toBe(generated);
    },
    TEST_TIMEOUT_MS,
  );
});
