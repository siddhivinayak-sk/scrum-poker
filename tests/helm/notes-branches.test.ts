/**
 * Feature: helm-chart-deployment - NOTES.txt branch unit tests (task 11.3).
 *
 * Deterministic example-based tests, not one of the 16 correctness properties.
 * Property 14 (task 11.2) owns the URL-composition rule; this file pins the
 * four *other* branches of `templates/NOTES.txt`, each of which is a plain
 * on/off switch rather than a composition rule:
 *
 * | branch                | switch                                            |
 * |-----------------------|---------------------------------------------------|
 * | host placeholder      | `ingress.hosts[0].host` empty vs held             |
 * | port-forward command  | `ingress.enabled` false vs true                   |
 * | secret-read command   | `auth.existingSecret` empty vs non-empty          |
 * | replica warning       | `replicaCount > 1` *and* affinity not `ClientIP`  |
 *
 * The interaction worth pinning is the last row: it is the only branch with a
 * two-term condition, so it needs all four corners of the matrix, not two.
 *
 * ## Why these tests shell out to `helm install --dry-run=client`
 *
 * `NOTES.txt` is not a manifest. Helm collects it into `release.Info.Notes`
 * instead of the manifest stream, which means the shared `renderChart` helper
 * never sees it - `helm template` drops it, and asking for it explicitly with
 * `helm template -s templates/NOTES.txt` fails outright with "could not find
 * template", because the selector matches against the manifest stream it was
 * already excluded from. The one command that prints it is
 * `helm install <release> <chart> --dry-run=client`, whose output ends in a
 * `NOTES:` section.
 *
 * `--dry-run=client` renders the chart locally and writes no release storage,
 * but Helm 3.15 still queries the API server for its version on the way in, so
 * a render takes a few seconds and needs a reachable cluster. `--kube-version`
 * would remove the query, but that flag exists on `helm template` and
 * `helm lint` only, not on `helm install`. That cluster contact is why this
 * file carries no Requirement 12.2 obligation and the property tests, which
 * must stay offline, keep going through `renderChart` instead.
 *
 * The spawn therefore lives here rather than in `support/render-chart.ts`, but
 * it reuses that module's `helmBinary()` (explicit PATHEXT resolution, because
 * `spawnSync` on Windows will not find `helm.exe` from a bare command name),
 * `chartDir`, and `stringifyValues` (which keeps a JS string a YAML string on
 * the way in) rather than reimplementing any of the three.
 *
 * **Requirements: 5.10, 9.5, 10.3**
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartDir, helmBinary, stringifyValues } from './support/render-chart.js';

/** `service.port` default in `values.yaml`. */
const DEFAULT_PORT = 80;

/** `config.basePath` default in `values.yaml`. */
const DEFAULT_BASE_PATH = '/scrum-poker';

/** The literal the host segment falls back to when no host is configured. */
const HOST_PLACEHOLDER = '<your-ingress-host>';

interface NotesOptions {
  releaseName?: string;
  namespace?: string;
  /**
   * Render against a temp-dir copy of the chart with `values.schema.json`
   * removed.
   *
   * Needed only by the `replicaCount > 1` cases. The chart documents
   * `replicaCount: 1` as its only supported value and guard 1 plus the schema
   * are free to say so, yet the NOTES warning branch exists precisely for the
   * operator who overrides it anyway - so the branch has to stay reachable in
   * a test even once task 12.1's schema lands. Dropping the schema from a
   * throwaway copy keeps the workspace chart untouched: nothing here writes
   * inside `helm/scrum-poker/`.
   */
  withoutSchema?: boolean;
}

interface NotesResult {
  status: number;
  stdout: string;
  stderr: string;
  /** The text after the `NOTES:` marker, trailing whitespace trimmed. */
  notes: string;
}

/**
 * Pull the `NOTES:` section out of `helm install --dry-run=client` output.
 *
 * Helm prints the release summary, then `HOOKS:`, then `MANIFEST:`, then
 * `NOTES:` last, so everything after the marker line is the rendered notes.
 * The marker is matched anchored to its own line so a `NOTES:` occurring
 * inside a rendered manifest value could not be mistaken for it.
 */
function extractNotes(stdout: string): string {
  const match = /^NOTES:\r?\n/m.exec(stdout);
  if (!match) {
    throw new Error(`no NOTES: section in helm output:\n${stdout}`);
  }
  return stdout.slice(match.index + match[0].length).trimEnd();
}

/** Render the chart's post-install notes with `values` over the defaults. */
function renderNotes(
  values: Record<string, unknown> = {},
  opts: NotesOptions = {},
): NotesResult {
  const releaseName = opts.releaseName ?? 'rel';
  const namespace = opts.namespace ?? 'scrum-poker-test';
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-notes-'));
  try {
    let renderedChart = chartDir;
    if (opts.withoutSchema) {
      renderedChart = path.join(workDir, 'scrum-poker');
      cpSync(chartDir, renderedChart, { recursive: true });
      rmSync(path.join(renderedChart, 'values.schema.json'), { force: true });
    }

    const valuesFile = path.join(workDir, 'values.yaml');
    writeFileSync(valuesFile, stringifyValues(values), 'utf8');

    const result = spawnSync(
      helmBinary(),
      [
        'install',
        releaseName,
        renderedChart,
        '-f',
        valuesFile,
        '--namespace',
        namespace,
        '--dry-run=client',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    if (result.error) {
      throw new Error(
        `failed to run ${helmBinary()}: ${result.error.message}. ` +
          'Install Helm 3.8 or newer, or point HELM_BIN at the executable.',
      );
    }
    const status = result.status ?? 1;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    expect(
      status,
      `helm install --dry-run=client failed\n${stderr}` +
        (stderr.includes('cluster unreachable')
          ? '\nHelm queries the API server for its version even for a client-side ' +
            'dry run, so these tests need a reachable kubeconfig context.'
          : ''),
    ).toBe(0);
    return { status, stdout, stderr, notes: extractNotes(stdout) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** How many times `needle` appears in `haystack`, non-overlapping. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    throw new Error('countOccurrences requires a non-empty needle');
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

/** Notes lines with surrounding whitespace stripped, blank lines dropped. */
function notesLines(notes: string): string[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The single line containing `needle`, with "exactly one" asserted. */
function soleLineContaining(notes: string, needle: string): string {
  const matches = notesLines(notes).filter((line) => line.includes(needle));
  expect(matches.length, `exactly one line contains "${needle}"\n--- notes ---\n${notes}`).toBe(1);
  return matches[0] as string;
}

describe('NOTES: host placeholder (Requirement 9.8)', () => {
  it('renders the placeholder in the host segment for the default empty host', () => {
    const { notes } = renderNotes();

    expect(soleLineContaining(notes, 'http://')).toBe(`http://${HOST_PLACEHOLDER}${DEFAULT_BASE_PATH}`);
  });

  it('states that a hostless rule matches every incoming host', () => {
    const { notes } = renderNotes();

    expect(
      notes,
      'the placeholder alone does not tell the operator what the rendered rule does',
    ).toContain('matches every incoming');
    expect(notes, 'and it names the value that pins the rule').toContain('ingress.hosts[0].host');
  });

  it('renders the configured host and drops the placeholder when a host is held', () => {
    const { notes } = renderNotes({
      ingress: { hosts: [{ host: 'poker.example.com', paths: [{ path: DEFAULT_BASE_PATH }] }] },
    });

    expect(soleLineContaining(notes, 'http://')).toBe(`http://poker.example.com${DEFAULT_BASE_PATH}`);
    expect(notes).not.toContain(HOST_PLACEHOLDER);
    expect(
      notes,
      'the hostless explanation belongs to the placeholder branch only',
    ).not.toContain('matches every incoming');
  });

  it('keeps the placeholder out of the port-forward branch entirely', () => {
    const { notes } = renderNotes({ ingress: { enabled: false } });

    expect(
      notes,
      'with no ingress there is no rule to pin, so neither the placeholder nor its ' +
        'explanation applies',
    ).not.toContain(HOST_PLACEHOLDER);
    expect(notes).not.toContain('matches every incoming');
  });
});

describe('NOTES: port-forward command (Requirement 9.5)', () => {
  it('renders exactly one port-forward command when the ingress is disabled', () => {
    const { notes } = renderNotes({ ingress: { enabled: false } }, { namespace: 'poker-ns' });

    expect(countOccurrences(notes, 'kubectl port-forward')).toBe(1);
    expect(soleLineContaining(notes, 'kubectl port-forward')).toBe(
      `kubectl port-forward --namespace poker-ns svc/rel-scrum-poker 8080:${DEFAULT_PORT}`,
    );
  });

  it('names the Service port rather than the container port', () => {
    const { notes } = renderNotes({ ingress: { enabled: false }, service: { port: 8081 } });

    expect(
      soleLineContaining(notes, 'kubectl port-forward').endsWith('8080:8081'),
      'the remote half of the forward is service.port; the local half is fixed at 8080',
    ).toBe(true);
  });

  it('tracks the rendered Service name through fullnameOverride', () => {
    const { notes } = renderNotes({ ingress: { enabled: false }, fullnameOverride: 'poker-x' });

    expect(soleLineContaining(notes, 'kubectl port-forward')).toContain('svc/poker-x ');
  });

  it('points at localhost and emits no second URL', () => {
    const { notes } = renderNotes({ ingress: { enabled: false } });

    expect(notes).toContain('localhost');
    expect(
      notes,
      'exactly one URL is printed per render, and the disabled-ingress branch prints none',
    ).not.toContain('http://');
    expect(notes).not.toContain('Open the application at');
  });

  it('reports the base path the forwarded port serves, normalising an empty one', () => {
    const configured = renderNotes({ ingress: { enabled: false } });
    expect(configured.notes).toContain(`under ${DEFAULT_BASE_PATH}`);

    const rootPath = renderNotes({ ingress: { enabled: false }, config: { basePath: '' } });
    expect(
      rootPath.notes,
      'an empty config.basePath serves the cluster root, which reads as / not as nothing',
    ).toContain('under /');
  });

  it('renders no port-forward command when the ingress is enabled', () => {
    const { notes } = renderNotes();

    expect(countOccurrences(notes, 'kubectl port-forward')).toBe(0);
    expect(notes).toContain('Open the application at');
  });
});

describe('NOTES: secret-read command (Requirement 5.10)', () => {
  it('renders the read command once for the default empty auth.existingSecret', () => {
    const { notes } = renderNotes({}, { namespace: 'poker-ns' });

    expect(countOccurrences(notes, 'kubectl get secret')).toBe(1);
    expect(soleLineContaining(notes, 'kubectl get secret')).toBe(
      'kubectl get secret rel-scrum-poker-secret -n poker-ns ' +
        '-o jsonpath="{.data.JWT_SECRET}" | base64 -d',
    );
  });

  it('names the Secret the chart actually rendered', () => {
    const { notes, stdout } = renderNotes({ fullnameOverride: 'poker-x' });

    expect(
      stdout,
      'the Secret has to be in the manifest for the command to read anything back',
    ).toContain('name: "poker-x-secret"');
    expect(soleLineContaining(notes, 'kubectl get secret')).toContain('secret poker-x-secret -n ');
  });

  it('still renders the command when auth.jwtSecret supplies the key explicitly', () => {
    const { notes } = renderNotes({ auth: { jwtSecret: 'an-explicitly-supplied-signing-key' } });

    expect(
      countOccurrences(notes, 'kubectl get secret'),
      'the chart rendered a Secret either way, so the read command still applies',
    ).toBe(1);
  });

  it('omits the command when auth.existingSecret names a pre-existing Secret', () => {
    const { notes, stdout } = renderNotes({ auth: { existingSecret: 'my-jwt-secret' } });

    expect(
      stdout,
      'a non-empty auth.existingSecret renders no Secret of the chart own',
    ).not.toContain('kind: Secret');
    expect(
      countOccurrences(notes, 'kubectl get secret'),
      'there is no chart-rendered Secret to read, so the branch is skipped',
    ).toBe(0);
    expect(notes).not.toContain('JWT_SECRET');
  });

  it('omits the command for an existing Secret with the ingress disabled too', () => {
    const { notes } = renderNotes({
      ingress: { enabled: false },
      auth: { existingSecret: 'my-jwt-secret' },
    });

    expect(
      countOccurrences(notes, 'kubectl get secret'),
      'the secret branch is independent of the URL branch above it',
    ).toBe(0);
    expect(countOccurrences(notes, 'kubectl port-forward')).toBe(1);
  });
});

describe('NOTES: replica warning (Requirement 10.3)', () => {
  /** Both terms of the warning condition, and both of its outcomes. */
  const matrix = [
    { replicaCount: 1, sessionAffinity: 'None', warned: false },
    { replicaCount: 1, sessionAffinity: 'ClientIP', warned: false },
    { replicaCount: 2, sessionAffinity: 'ClientIP', warned: false },
    { replicaCount: 2, sessionAffinity: 'None', warned: true },
  ] as const;

  it.each(matrix)(
    'replicaCount=$replicaCount, sessionAffinity=$sessionAffinity -> warned=$warned',
    ({ replicaCount, sessionAffinity, warned }) => {
      const { notes } = renderNotes(
        { replicaCount, service: { sessionAffinity } },
        { withoutSchema: replicaCount > 1 },
      );

      expect(countOccurrences(notes, 'WARNING:')).toBe(warned ? 1 : 0);
    },
  );

  it('names both offending values and the two ways out', () => {
    const { notes } = renderNotes(
      { replicaCount: 3, service: { sessionAffinity: 'None' } },
      { withoutSchema: true },
    );

    const warning = soleLineContaining(notes, 'WARNING:');
    expect(warning).toContain('replicaCount is 3');
    expect(warning).toContain('service.sessionAffinity is not ClientIP');
    expect(notes, 'the warning explains why, not just that').toContain('memory of each');
    expect(notes).toContain('Set replicaCount to 1');
    expect(notes).toContain('set service.sessionAffinity to ClientIP');
  });

  it('warns for an emptied-out sessionAffinity, which the Service renders as None', () => {
    const { notes } = renderNotes(
      { replicaCount: 2, service: { sessionAffinity: '' } },
      { withoutSchema: true },
    );

    expect(
      countOccurrences(notes, 'WARNING:'),
      'an empty affinity is not ClientIP, so session state is still split across pods',
    ).toBe(1);
  });

  it('is independent of the ingress and secret branches', () => {
    const { notes } = renderNotes(
      {
        replicaCount: 2,
        service: { sessionAffinity: 'None' },
        ingress: { enabled: false },
        auth: { existingSecret: 'my-jwt-secret' },
      },
      { withoutSchema: true },
    );

    expect(countOccurrences(notes, 'WARNING:')).toBe(1);
    expect(countOccurrences(notes, 'kubectl port-forward')).toBe(1);
    expect(countOccurrences(notes, 'kubectl get secret')).toBe(0);
  });
});

describe('NOTES: the release header every branch shares', () => {
  it('names the release and the namespace it was installed into', () => {
    const { notes } = renderNotes({}, { releaseName: 'poker-prod', namespace: 'poker-ns' });

    expect(notesLines(notes)[0]).toBe(
      'Scrum Poker is installed as release poker-prod in namespace poker-ns.',
    );
  });
});
