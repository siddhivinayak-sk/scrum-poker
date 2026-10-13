/**
 * Feature: helm-chart-deployment - rejected-upgrade revision preservation (task 12.3).
 *
 * Requirement 11.11 is a statement about what does *not* happen: when
 * `values.schema.json` rejects a value during `helm upgrade`, the chart creates
 * or modifies zero cluster resources and the existing release stays at the
 * revision that was in effect before the invocation. An operator who fat-fingers
 * `image.pullPolicy` gets an error and a running release, not an error and a
 * half-moved release.
 *
 * That cannot be observed offline. `helm template` proves the schema rejects the
 * value, which is Property 16's job (task 12.2), but it has no release history
 * and no cluster resources to leave alone. Only a real `helm install` followed by
 * a real, rejected `helm upgrade` shows the revision standing still.
 *
 * Two violation classes are exercised, because schema validation happens in one
 * place but operators arrive there by different routes:
 *
 * - an **enumerated-set** violation (`image.pullPolicy: Sometimes`), Requirement
 *   11.10's error shape;
 * - a **type** violation (`service.port: "eighty"`), Requirement 11.7's.
 *
 * Both must behave identically where it counts: non-zero exit, the offending
 * values path named in the output, release revision unchanged, release history
 * no longer than before, recorded manifest byte-identical, and every live
 * resource untouched.
 *
 * ### No cluster is not a failure
 *
 * The suite probes for `helm`, `kubectl`, a reachable API server, and permission
 * to create a namespace, and skips the whole `describe` loudly when any of that
 * is missing. A host without a cluster has not found a chart defect.
 *
 * ### Footprint
 *
 * One freshly generated namespace per run, unique by random suffix, so a
 * concurrent run cannot collide and no pre-existing release is touched. `afterAll`
 * uninstalls every release and deletes the namespace even when a test above
 * failed. Installs omit `--wait`: all four resources exist the moment
 * `helm install` returns, and waiting on pod readiness would make the suite
 * depend on the image being pullable from whatever cluster is reachable.
 *
 * **Requirements: 11.11**
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartDir, helmBinary, stringifyValues } from './support/render-chart.js';

/** Generous enough for an image-less install on a slow cluster. */
const HELM_TIMEOUT_MS = 180_000;

/** A cluster probe should answer fast or be treated as absent. */
const PROBE_TIMEOUT_MS = 20_000;

/** Vitest per-test budget: an install, a rejected upgrade, and several reads. */
const TEST_TIMEOUT_MS = 420_000;

/**
 * Values applied to every install in this file.
 *
 * The ingress is disabled on purpose: it has no bearing on schema validation,
 * and leaving it on would make the install depend on an IngressClass existing
 * on the reachable cluster. `auth.jwtSecret` is pinned so the Secret's content
 * is fixed across the run, which keeps the "resources unchanged" comparison
 * about the upgrade rather than about `randAlphaNum`.
 */
const BASE_VALUES: Record<string, unknown> = {
  ingress: { enabled: false },
  auth: { jwtSecret: 'schema-rejection-fixed-secret-value', existingSecret: '' },
};

let resolvedKubectl: string | undefined;

/**
 * Absolute path to `kubectl`, resolved the way `helmBinary` resolves `helm`:
 * `spawnSync` on Windows does not apply PATHEXT to a bare command name, so the
 * PATH is searched explicitly rather than falling back to `shell: true`.
 * `KUBECTL_BIN` overrides the search.
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
 * nothing in a generated namespace or values path can be reinterpreted by
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
 * `kubectl` repeats the same connection error once per API-group discovery
 * attempt, so identical lines are collapsed and the output is capped; the cause
 * stays legible without burying the message it is attached to.
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
 * Decide whether a live cluster is usable for these tests. The first failing
 * condition is reported, so a skipped run says why rather than going quiet.
 * Namespace-creation permission counts: a read-only kubeconfig is, for this
 * suite, the same situation as no cluster at all.
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
  console.info(
    `[helm integration] running schema-rejection tests against a live cluster: ${probe.reason}`,
  );
} else {
  console.warn(
    '\n' +
      '='.repeat(78) +
      '\n[helm integration] SKIPPED tests/helm/schema-rejection.integration.test.ts' +
      '\n  Revision preservation on a rejected upgrade (Requirement 11.11) is about what' +
      '\n  a rejected `helm upgrade` leaves behind. Offline there is no release history' +
      '\n  and no cluster resource to leave alone, so the suite is skipped, not failed.' +
      `\n  Reason: ${probe.reason}` +
      '\n' +
      '='.repeat(78) +
      '\n',
  );
}

/** Unique per run, so two concurrent runs never share a namespace. */
const namespace = `sp-schema-it-${randomBytes(4).toString('hex')}`;

/** Releases created by this file, uninstalled in `afterAll`. */
const createdReleases: string[] = [];

/** Temp directories holding the values files, removed in `afterAll`. */
const createdWorkDirs: string[] = [];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Write a values document to a fresh temp file and return its path. The same
 * serialisation the offline harness uses, so a JavaScript string reaches Helm as
 * a YAML string and the type violation below is genuinely a type violation.
 */
function writeValuesFile(values: Record<string, unknown>): string {
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-it-'));
  createdWorkDirs.push(workDir);
  const file = path.join(workDir, 'values.yaml');
  writeFileSync(file, stringifyValues(values), 'utf8');
  return file;
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

/**
 * Attempt an upgrade and return the result without asserting on it - the whole
 * point here is to inspect a failure rather than demand a success.
 */
function attemptHelmUpgrade(releaseName: string, valuesFile: string): CommandResult {
  return run(
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
}

/** Everything `helm` itself knows about a release, as of now. */
interface ReleaseSnapshot {
  /** The revision `helm list` reports. */
  revision: number;
  /** How many records `helm history` holds; a rejected upgrade adds none. */
  historyLength: number;
  /** The manifest Helm has recorded for the release, verbatim. */
  manifest: string;
}

function helmJson(label: string, args: string[]): unknown {
  const result = run(helmBinary(), args, PROBE_TIMEOUT_MS);
  expect(result.status, describeFailure(label, result)).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function releaseSnapshot(releaseName: string): ReleaseSnapshot {
  const listed = helmJson(`helm list for ${releaseName}`, [
    'list',
    '--namespace',
    namespace,
    '--filter',
    `^${releaseName}$`,
    '--output',
    'json',
  ]);
  expect(Array.isArray(listed), '`helm list --output json` returns an array').toBe(true);
  const entries = (listed as unknown[]).filter(isMapping);
  expect(entries.length, `helm list reports exactly one release named ${releaseName}`).toBe(1);
  // helm reports the revision as a string in list output and as a number in
  // history output, so both are normalised through parseInt.
  const revision = Number.parseInt(String(entries[0]?.['revision'] ?? ''), 10);
  expect(Number.isInteger(revision), 'helm list reports an integer revision').toBe(true);

  const history = helmJson(`helm history for ${releaseName}`, [
    'history',
    releaseName,
    '--namespace',
    namespace,
    '--output',
    'json',
  ]);
  expect(Array.isArray(history), '`helm history --output json` returns an array').toBe(true);

  const manifest = run(
    helmBinary(),
    ['get', 'manifest', releaseName, '--namespace', namespace],
    PROBE_TIMEOUT_MS,
  );
  expect(
    manifest.status,
    describeFailure(`helm get manifest ${releaseName}`, manifest),
  ).toBe(0);

  return {
    revision,
    historyLength: (history as unknown[]).length,
    manifest: manifest.stdout,
  };
}

/**
 * The live cluster state belonging to a release, projected down to the parts an
 * upgrade would change.
 *
 * `status`, `resourceVersion`, and `managedFields` are deliberately excluded:
 * controllers rewrite those on their own schedule, so including them would make
 * the comparison flaky for reasons that have nothing to do with the rejected
 * upgrade. `metadata.generation` is kept, because that is the field that moves
 * when something writes to a resource's spec. Secret values are hashed rather
 * than captured, so a failure diff never prints a JWT signing key.
 */
function liveSnapshot(releaseName: string): string {
  const result = run(
    kubectlBinary(),
    [
      'get',
      'deployment,service,configmap,secret',
      '--namespace',
      namespace,
      '--selector',
      `app.kubernetes.io/instance=${releaseName}`,
      '--output',
      'json',
    ],
    PROBE_TIMEOUT_MS,
  );
  expect(
    result.status,
    describeFailure(`kubectl get release resources for ${releaseName}`, result),
  ).toBe(0);

  const parsed: unknown = JSON.parse(result.stdout);
  expect(isMapping(parsed), '`kubectl get -o json` returns a List object').toBe(true);
  const items = isMapping(parsed) ? parsed['items'] : undefined;
  expect(Array.isArray(items), 'the returned List carries an items array').toBe(true);

  const projected = (items as unknown[])
    .filter(isMapping)
    .map((item) => {
      const metadata = isMapping(item['metadata']) ? item['metadata'] : {};
      const data = isMapping(item['data']) ? item['data'] : undefined;
      const hashedData =
        item['kind'] === 'Secret' && data
          ? Object.fromEntries(
              Object.entries(data).map(([key, value]) => [
                key,
                createHash('sha256').update(String(value)).digest('hex').slice(0, 16),
              ]),
            )
          : data;
      return {
        kind: item['kind'],
        name: metadata['name'],
        generation: metadata['generation'],
        labels: metadata['labels'],
        annotations: metadata['annotations'],
        spec: item['spec'],
        data: hashedData,
      };
    })
    .sort((left, right) =>
      `${String(left.kind)}/${String(left.name)}`.localeCompare(
        `${String(right.kind)}/${String(right.name)}`,
      ),
    );

  // A release with nothing deployed would make "unchanged" trivially true, so
  // the Deployment, Service, ConfigMap, and Secret are required to be present.
  expect(
    projected.map((item) => item.kind).sort(),
    'the installed release owns a ConfigMap, a Deployment, a Secret, and a Service',
  ).toEqual(['ConfigMap', 'Deployment', 'Secret', 'Service']);

  return JSON.stringify(projected, null, 2);
}

/**
 * Install a release, attempt an upgrade whose values the schema must reject, and
 * assert that nothing moved.
 *
 * @param releaseName  release to install into the generated namespace
 * @param badValues    the values patch the schema is expected to reject
 * @param offendingPath  the values path the error message must name
 * @param permittedHint  a fragment of the "what is permitted" half of the message
 */
function expectRejectedUpgradeLeavesReleaseAlone(
  releaseName: string,
  badValues: Record<string, unknown>,
  offendingPath: string,
  permittedHint: string,
): void {
  const goodValuesFile = writeValuesFile(BASE_VALUES);
  helmInstall(releaseName, goodValuesFile);

  const releaseBefore = releaseSnapshot(releaseName);
  const liveBefore = liveSnapshot(releaseName);
  expect(releaseBefore.revision, 'a fresh install sits at revision 1').toBe(1);

  const badValuesFile = writeValuesFile({ ...BASE_VALUES, ...badValues });
  const upgrade = attemptHelmUpgrade(releaseName, badValuesFile);

  expect(
    upgrade.status,
    `a schema-violating helm upgrade must fail, but it exited 0:\n${upgrade.stdout}`,
  ).not.toBe(0);

  const output = `${upgrade.stderr}\n${upgrade.stdout}`;
  expect(output, `the rejection names the offending values path ${offendingPath}`).toContain(
    offendingPath,
  );
  expect(output, 'the rejection states what the schema permits').toContain(permittedHint);

  const releaseAfter = releaseSnapshot(releaseName);
  expect(
    releaseAfter.revision,
    'a rejected upgrade leaves the release at the revision in effect before it (Requirement 11.11)',
  ).toBe(releaseBefore.revision);
  expect(
    releaseAfter.historyLength,
    'a rejected upgrade appends no release record, not even a failed one',
  ).toBe(releaseBefore.historyLength);
  expect(
    releaseAfter.manifest,
    'the recorded manifest of a rejected upgrade is byte-identical to the deployed one',
  ).toBe(releaseBefore.manifest);

  expect(
    liveSnapshot(releaseName),
    'a rejected upgrade creates or modifies zero cluster resources (Requirement 11.11)',
  ).toBe(liveBefore);
}

describe.skipIf(!probe.usable)(
  'schema-rejected helm upgrade leaves the deployed release untouched (live cluster)',
  () => {
    beforeAll(() => {
      const result = run(kubectlBinary(), ['create', 'namespace', namespace], PROBE_TIMEOUT_MS);
      expect(result.status, describeFailure(`kubectl create namespace ${namespace}`, result)).toBe(
        0,
      );
    });

    afterAll(() => {
      // Nothing here asserts: cleanup must finish even when a test above failed,
      // and a cleanup error must not mask the real failure.
      for (const releaseName of createdReleases) {
        run(
          helmBinary(),
          [
            'uninstall',
            releaseName,
            '--namespace',
            namespace,
            '--ignore-not-found',
            '--timeout',
            '120s',
          ],
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
      'rejects an upgrade violating an enumerated set and holds the revision (image.pullPolicy)',
      () => {
        expectRejectedUpgradeLeavesReleaseAlone(
          'schema-enum',
          { image: { repository: 'ghcr.io/example/scrum-poker', pullPolicy: 'Sometimes' } },
          'image.pullPolicy',
          'IfNotPresent',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects an upgrade violating a declared type and holds the revision (service.port)',
      () => {
        expectRejectedUpgradeLeavesReleaseAlone(
          'schema-type',
          { service: { port: 'eighty' } },
          'service.port',
          'integer',
        );
      },
      TEST_TIMEOUT_MS,
    );
  },
);
