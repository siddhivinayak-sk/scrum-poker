/**
 * Feature: helm-chart-deployment - task 11.2, Property 14.
 *
 * Property 14: The post-install URL is composed without a trailing separator.
 *
 * *For any* `ingress.tls` list, *any* `ingress.hosts[0].host` value, and *any*
 * valid `config.basePath` value, the rendered notes contain exactly one
 * application URL whose scheme is `https` when `ingress.tls` holds at least one
 * entry and `http` otherwise, whose host segment is the supplied host or a
 * placeholder accompanied by a statement that the rule matches every incoming
 * host when the supplied host is empty, and which ends without a trailing `/`
 * when `config.basePath` is empty.
 *
 * **Validates: Requirements 9.4, 9.8**
 *
 * ### Why this is the property worth having
 *
 * The URL in the notes is the one instruction an operator acts on immediately
 * after `helm install`, and it is assembled from three values that are each
 * free to move independently: the scheme follows `ingress.tls`, the host comes
 * from `ingress.hosts[0]`, and the path is `config.basePath` appended verbatim.
 * "Verbatim" is the whole point - the application mounts its router at
 * `BASE_PATH` and `config.basePath` is empty for a cluster-root deployment, so
 * a template that helpfully joined the segments with a `/` would print
 * `http://host/` for a root install and `http://host//scrum-poker` for a
 * prefixed one. Both still resolve in a browser, which is exactly why the
 * defect would survive a manual read; the property pins the composition to
 * exact string equality instead.
 *
 * The empty-host case carries a second obligation (Requirement 9.8): an ingress
 * rule with no host matches every incoming host, so there is no host to print.
 * The notes must say so rather than silently rendering `http:///scrum-poker`.
 *
 * ### Why this test spawns `helm install` rather than `helm template`
 *
 * `NOTES.txt` is not a manifest. Helm collects it into `release.Info.Notes`
 * instead of the manifest stream, so it never appears in `helm template`
 * output, and `helm template -s templates/NOTES.txt` fails outright with
 * "could not find template" because the selector only matches files that
 * reached that stream. The one command that prints it is
 * `helm install <release> <chart> --dry-run=client`, which renders entirely on
 * the client and opens no connection to an API server (Requirement 12.2), then
 * prints the notes under a `NOTES:` marker after the manifest.
 *
 * That is why this file carries its own `renderNotes` rather than using the
 * shared `renderChart`: the subprocess argv differs. Everything else is shared
 * - `helmBinary` for the Windows PATHEXT resolution `spawnSync` will not do on
 * its own, `chartDir` for the chart under test, and `stringifyValues` for the
 * YAML 1.1-safe serialisation that keeps a generated string a string on the way
 * into Helm.
 *
 * ### Staying inside the chart's other rules
 *
 * Guard 13 requires every ingress `path` to equal the normalised
 * `config.basePath` whenever `ingress.enabled` and `config.preservePath` are
 * both true, so every generated case aligns its ingress paths with the base
 * path it sweeps. `config.preservePath` is still swept across both values: the
 * notes must not depend on it, and aligning the paths unconditionally means the
 * same values document renders either way.
 *
 * `config.basePath` comes from the shared `basePathArb`, which stays inside the
 * values-schema bounds (leading `/`, no trailing `/`, at most 64 characters)
 * while covering the empty string, a bare `/`, and multi-segment prefixes.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chartDir,
  defaultNamespace,
  defaultReleaseName,
  helmBinary,
  stringifyValues,
} from './support/render-chart.js';
import { assertConfig, basePathArb } from './support/generators.js';

/** The literal the template substitutes for an empty `ingress.hosts[0].host`. */
const HOST_PLACEHOLDER = '<your-ingress-host>';

interface NotesResult {
  /** `helm install --dry-run=client` exit status. */
  status: number;
  stdout: string;
  stderr: string;
  /** The text Helm printed under the `NOTES:` marker, trailing blank lines trimmed. */
  notes: string;
}

/**
 * The `NOTES:` section of a `helm install --dry-run=client` run.
 *
 * The marker is matched as a whole line and the *last* such line wins: the
 * notes are the final section Helm prints, after `MANIFEST:`, so anything that
 * looked like the marker inside a rendered manifest cannot shadow the real one.
 * An absent marker yields an empty string rather than throwing, so the
 * assertion that fails is the caller's one about the URL, naming the values
 * that produced it.
 */
function extractNotes(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const marker = lines.lastIndexOf('NOTES:');
  if (marker === -1) {
    return '';
  }
  return lines.slice(marker + 1).join('\n').replace(/\s+$/, '');
}

/**
 * Render the chart's notes with `values` layered over the chart defaults.
 *
 * Mirrors `renderChart`: a values *file* rather than `--set`, so generated
 * values carrying dots or commas survive, and a per-call temp directory removed
 * in a `finally`.
 */
function renderNotes(
  values: Record<string, unknown>,
  opts: { releaseName?: string; namespace?: string } = {},
): NotesResult {
  const releaseName = opts.releaseName ?? defaultReleaseName;
  const namespace = opts.namespace ?? defaultNamespace;
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-notes-'));
  const valuesFile = path.join(workDir, 'values.yaml');
  try {
    writeFileSync(valuesFile, stringifyValues(values), 'utf8');
    const result = spawnSync(
      helmBinary(),
      [
        'install',
        releaseName,
        chartDir,
        '--dry-run=client',
        '-f',
        valuesFile,
        '--namespace',
        namespace,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    if (result.error) {
      throw new Error(
        `failed to run ${helmBinary()}: ${result.error.message}. ` +
          'Install Helm 3.8 or newer, or point HELM_BIN at the executable.',
      );
    }
    const stdout = result.stdout ?? '';
    return {
      status: result.status ?? 1,
      stdout,
      stderr: result.stderr ?? '',
      notes: extractNotes(stdout),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The notes with every run of whitespace collapsed to one space.
 *
 * Prose in `NOTES.txt` is hard-wrapped to fit a terminal, so the sentence
 * Requirement 9.8 asks for straddles a line break. Searching the raw text for
 * it would make the assertion a test of where the template happens to wrap,
 * which is not the obligation; collapsing first keeps it a test of what the
 * template says.
 */
function flattenProse(notes: string): string {
  return notes.replace(/\s+/g, ' ').trim();
}

/** Every `http://`- or `https://`-prefixed token in the notes. */
function urlTokens(notes: string): string[] {
  return notes.match(/https?:\/\/\S*/g) ?? [];
}

/**
 * Lines that are nothing but a URL.
 *
 * The template prints the resolved URL on its own indented line, so a URL that
 * only ever appeared inside prose - or a second one on the port-forward line -
 * would not be counted here, and the token count below catches that case.
 */
function urlLines(notes: string): string[] {
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S*$/.test(line));
}

interface NotesCase {
  /** `ingress.tls`; a non-empty list selects the `https` scheme. */
  tls: { secretName: string; hosts: string[] }[];
  /** `ingress.hosts[0].host`; the empty string means the rule matches every host. */
  host: string;
  /** Additional host entries after the first, which must not reach the URL. */
  extraHosts: string[];
  basePath: string;
  preservePath: boolean;
}

/** The values patch one case renders with. */
function valuesFor(testCase: NotesCase): Record<string, unknown> {
  // Guard 13 compares each ingress path against the normalised base path, so
  // align them. An empty base path normalises to `/`.
  const normalizedBasePath = testCase.basePath === '' ? '/' : testCase.basePath;
  const paths = [{ path: normalizedBasePath, pathType: 'Prefix' }];
  return {
    config: { basePath: testCase.basePath, preservePath: testCase.preservePath },
    ingress: {
      enabled: true,
      tls: testCase.tls,
      hosts: [
        { host: testCase.host, paths },
        ...testCase.extraHosts.map((host) => ({ host, paths })),
      ],
    },
  };
}

/** The URL the notes must print for a case, composed the way Requirement 9.4 states. */
function expectedUrl(testCase: NotesCase): string {
  const scheme = testCase.tls.length > 0 ? 'https' : 'http';
  const host = testCase.host === '' ? HOST_PLACEHOLDER : testCase.host;
  return `${scheme}://${host}${testCase.basePath}`;
}

/** Every assertion Property 14 makes about one render. */
function assertUrlComposition(testCase: NotesCase, result: NotesResult): void {
  const label = JSON.stringify(testCase);
  expect(result.status, `${label}\n${result.stderr}`).toBe(0);
  expect(result.notes, `notes section missing for ${label}`).not.toBe('');

  const url = expectedUrl(testCase);

  // Exactly one URL, on a line of its own, equal byte for byte to the
  // composition of scheme, host, and base path. Equality rather than
  // `toContain` is what rules out a trailing separator, a doubled `//`, or a
  // second host leaking in from `ingress.hosts[1]`.
  expect(urlLines(result.notes), `URL lines for ${label}`).toEqual([url]);

  // And exactly one URL *anywhere* in the notes, so a second one hidden in
  // prose - the port-forward branch, say, firing alongside the ingress branch -
  // fails here rather than passing the line check above.
  expect(urlTokens(result.notes), `URL tokens for ${label}`).toEqual([url]);

  // The scheme follows `ingress.tls` and nothing else.
  const scheme = testCase.tls.length > 0 ? 'https' : 'http';
  expect(url.startsWith(`${scheme}://`), `scheme for ${label}`).toBe(true);

  // Requirement 9.4: no trailing separator when the base path is empty. The
  // `/` base path is the one case where a trailing `/` is correct, because it
  // is the value itself appended verbatim.
  if (testCase.basePath === '') {
    expect(url.endsWith('/'), `empty base path must not append a separator: ${url}`).toBe(false);
  }

  // Requirement 9.8: an empty host renders the placeholder and says why.
  if (testCase.host === '') {
    expect(url.includes(HOST_PLACEHOLDER), `placeholder host for ${label}`).toBe(true);
    expect(flattenProse(result.notes), `every-host statement for ${label}`).toContain(
      'matches every incoming host',
    );
  } else {
    expect(result.notes, `placeholder must not appear for ${label}`).not.toContain(
      HOST_PLACEHOLDER,
    );
  }
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

/** A DNS-1123 label, built the way the shared generators build theirs. */
const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ALNUM),
    fc.array(fc.constantFrom(...ALNUM, '-'), { minLength: 0, maxLength: 8 }),
    fc.constantFrom(...ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

/** A multi-label host name, the shape an operator pins `ingress.hosts[0].host` to. */
const dnsHostArb: fc.Arbitrary<string> = fc
  .array(dnsLabelArb, { minLength: 2, maxLength: 3 })
  .map((labels) => labels.join('.'));

/** Empty or a one-to-two entry `ingress.tls` list; only emptiness decides the scheme. */
const tlsArb: fc.Arbitrary<{ secretName: string; hosts: string[] }[]> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<{ secretName: string; hosts: string[] }[]>([]) },
  {
    weight: 1,
    arbitrary: fc.array(
      fc.record({
        secretName: fc.constantFrom('tls-secret', 'scrum-poker-tls'),
        hosts: fc.array(dnsHostArb, { minLength: 1, maxLength: 2 }),
      }),
      { minLength: 1, maxLength: 2 },
    ),
  },
);

const notesCaseArb: fc.Arbitrary<NotesCase> = fc.record({
  tls: tlsArb,
  // Both halves of Requirement 9.8's split, with the empty host weighted so it
  // is not a rarity across 100 runs.
  host: fc.oneof(
    { weight: 1, arbitrary: fc.constant('') },
    { weight: 2, arbitrary: dnsHostArb },
  ),
  extraHosts: fc.array(dnsHostArb, { minLength: 0, maxLength: 2 }),
  basePath: basePathArb,
  preservePath: fc.boolean(),
});

/** The combinations Requirements 9.4 and 9.8 name, pinned so no seed can skip them. */
const examples: [NotesCase][] = [
  // Empty base path: no trailing separator, both schemes, both host states.
  [{ tls: [], host: '', extraHosts: [], basePath: '', preservePath: true }],
  [{ tls: [], host: 'poker.example.com', extraHosts: [], basePath: '', preservePath: true }],
  [
    {
      tls: [{ secretName: 'tls-secret', hosts: ['poker.example.com'] }],
      host: 'poker.example.com',
      extraHosts: [],
      basePath: '',
      preservePath: false,
    },
  ],
  // A bare `/` base path, which is appended verbatim and so does end in `/`.
  [{ tls: [], host: 'poker.example.com', extraHosts: [], basePath: '/', preservePath: true }],
  [{ tls: [], host: '', extraHosts: [], basePath: '/', preservePath: true }],
  // Multi-segment prefixes, the chart default among them.
  [
    {
      tls: [],
      host: 'poker.example.com',
      extraHosts: [],
      basePath: '/scrum-poker',
      preservePath: true,
    },
  ],
  [
    {
      tls: [{ secretName: 'tls-secret', hosts: ['poker.example.com'] }],
      host: '',
      extraHosts: ['other.example.com'],
      basePath: '/a/b/c',
      preservePath: true,
    },
  ],
];

describe('Property 14: the post-install URL is composed without a trailing separator', () => {
  it('prints exactly one URL equal to scheme, host, and base path concatenated', () => {
    fc.assert(
      fc.property(notesCaseArb, (testCase) => {
        assertUrlComposition(testCase, renderNotes(valuesFor(testCase)));
      }),
      { ...assertConfig, examples },
    );
  });
});

/**
 * The same assertions at the chart defaults, where the ingress is enabled with
 * a single empty-host entry at `/scrum-poker` and no TLS. Cheap, deterministic,
 * and it proves the property is not an artefact of the generated values patch.
 */
describe('post-install URL at the chart defaults', () => {
  const defaultCase: NotesCase = {
    tls: [],
    host: '',
    extraHosts: [],
    basePath: '/scrum-poker',
    preservePath: true,
  };

  it('resolves to the placeholder host under the default base path over http', () => {
    const result = renderNotes({});

    expect(result.status, result.stderr).toBe(0);
    expect(urlLines(result.notes)).toEqual([`http://${HOST_PLACEHOLDER}/scrum-poker`]);
    assertUrlComposition(defaultCase, result);
  });
});
