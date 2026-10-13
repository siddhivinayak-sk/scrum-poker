/**
 * Feature: helm-chart-deployment - shared render helper.
 *
 * Every property test funnels through `renderChart`, so generated values reach
 * `helm template` exactly as an operator's `-f values.yaml` would. A values
 * *file* is used rather than `--set` on purpose: `--set` carries its own type
 * coercion and escaping rules that would make generated annotation keys
 * containing dots or commas untestable.
 *
 * The helper opens no connection to a Kubernetes API server (Requirement 12.2):
 * `helm template` renders locally, and `lookup` returns an empty map offline.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, stringify, type ToStringOptions } from 'yaml';

/** `tests/helm/support` -> `tests/helm` -> `tests` -> repository root. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The chart under test. Nothing in this harness writes inside it. */
export const chartDir = path.join(repoRoot, 'helm', 'scrum-poker');

export const chartValuesFile = path.join(chartDir, 'values.yaml');

/** Release name used when a caller does not supply one. */
export const defaultReleaseName = 'rel';

/** Namespace used when a caller does not supply one. */
export const defaultNamespace = 'scrum-poker-test';

export interface RenderResult {
  /** `helm template` exit status. */
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed YAML documents. Empty when `status !== 0`. */
  docs: unknown[];
}

export interface RenderOptions {
  releaseName?: string;
  namespace?: string;
  /**
   * Observability hook for the per-render temporary work directory.
   *
   * Called once with the absolute path, after the values file has been
   * written into it and before `helm template` is spawned. It exists so the
   * harness
   * self-check can name the one directory this call created and assert it is
   * gone once `renderChart` returns, instead of counting sibling directories
   * in the OS temp dir - a count that other test files rendering in parallel
   * inflate. Purely an observer: it receives no chance to influence the
   * render, and the `finally` cleanup runs whether or not it throws.
   */
  onWorkDir?: (workDir: string) => void;
}

/**
 * Serialisation options for the generated values file.
 *
 * The contract of `renderChart(values)` is that a value's JavaScript type is
 * the type Helm sees: a JS string must arrive as a YAML string, a number as an
 * integer, a boolean as a boolean, `null` as null. The `yaml` package's default
 * `PLAIN` string style breaks the string half of that contract, because it
 * decides whether a plain scalar is safe using **YAML 1.2** core resolution
 * while Helm parses values with a **Go YAML 1.1** parser. Every token below is
 * a plain scalar that `yaml` happily emits unquoted and Helm then reads back as
 * something other than a string:
 *
 *   - `y`, `Y`, `n`, `N`, `yes`, `Yes`, `no`, `No`, `on`, `On`, `off`, `Off`,
 *     `true`, `false` and their case variants -> boolean
 *   - `010` -> octal integer 8; `1_000` -> 1000; `1e3` -> 1000; `:1` -> sexagesimal
 *   - `~`, `null`, `Null`, the empty string -> null
 *
 * That was not a theoretical risk. Property 8 failed seed-dependently on the
 * counterexample `auth.existingSecretKey: "N"`: the harness wrote the bare
 * scalar `existingSecretKey: N`, Helm read it as the boolean `false`, and
 * `default "JWT_SECRET" .Values.auth.existingSecretKey` therefore substituted
 * its default. The chart was right; the harness had lost the string type on the
 * way in.
 *
 * So string *values* are always double-quoted, and `doubleQuotedAsJSON` keeps
 * each one a single-line JSON string literal - valid YAML, no fold-and-rejoin
 * ambiguity around embedded newlines or significant leading and trailing
 * spaces. `lineWidth: 0` disables line folding for the same reason.
 *
 * `defaultKeyType: 'PLAIN'` keeps mapping keys unquoted, so generated
 * annotation and label keys reach the manifest in the form an operator would
 * write them. `plainString` still falls back to a quoted form for any key a
 * plain scalar cannot express, so this is a style preference, not a hole.
 *
 * Nothing here touches non-string scalars: integers, booleans and `null` are
 * emitted by their own stringifiers, so `service.nodePort: null` and
 * `config.preservePath: false` still reach Helm as null and as a boolean.
 */
export const valuesStringifyOptions: ToStringOptions = {
  defaultStringType: 'QUOTE_DOUBLE',
  defaultKeyType: 'PLAIN',
  doubleQuotedAsJSON: true,
  lineWidth: 0,
};

/** Serialise a values patch the way `renderChart` hands it to Helm. */
export function stringifyValues(values: Record<string, unknown>): string {
  return stringify(values ?? {}, valuesStringifyOptions);
}

let resolvedHelm: string | undefined;

/**
 * Absolute path to the `helm` executable.
 *
 * `spawnSync` on Windows does not apply PATHEXT when resolving a bare command
 * name, so the PATH is searched explicitly rather than relying on `shell: true`
 * - which would reintroduce the quoting problems the values file avoids.
 * `HELM_BIN` overrides the search.
 */
export function helmBinary(): string {
  if (resolvedHelm !== undefined) {
    return resolvedHelm;
  }
  const fromEnv = process.env['HELM_BIN'];
  if (fromEnv) {
    resolvedHelm = fromEnv;
    return resolvedHelm;
  }
  if (process.platform !== 'win32') {
    resolvedHelm = 'helm';
    return resolvedHelm;
  }
  const extensions = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `helm${extension}`);
      if (existsSync(candidate)) {
        resolvedHelm = candidate;
        return resolvedHelm;
      }
    }
  }
  resolvedHelm = 'helm';
  return resolvedHelm;
}

/**
 * Parse the `helm template` YAML stream.
 *
 * Helm separates documents with `---` and prefixes each with a `# Source:`
 * comment, so a template that renders nothing yields a comment-only chunk that
 * parses to `null`; those are dropped. A parse error is a chart defect, not a
 * harness one, so it is raised with the offending output attached.
 */
function parseManifestStream(stdout: string): unknown[] {
  const documents = parseAllDocuments(stdout);
  const docs: unknown[] = [];
  for (const document of documents) {
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
 * Render the chart with `values` layered over the chart defaults, the way Helm
 * merges an operator's `-f` file.
 */
export function renderChart(
  values: Record<string, unknown>,
  opts: RenderOptions = {},
): RenderResult {
  const releaseName = opts.releaseName ?? defaultReleaseName;
  const namespace = opts.namespace ?? defaultNamespace;
  const workDir = mkdtempSync(path.join(tmpdir(), 'scrum-poker-helm-'));
  const valuesFile = path.join(workDir, 'values.yaml');
  try {
    writeFileSync(valuesFile, stringifyValues(values), 'utf8');
    opts.onWorkDir?.(workDir);
    const result = spawnSync(
      helmBinary(),
      ['template', releaseName, chartDir, '-f', valuesFile, '--namespace', namespace],
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
    return { status, stdout, stderr, docs: status === 0 ? parseManifestStream(stdout) : [] };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** The chart's declared defaults, parsed from `helm/scrum-poker/values.yaml`. */
export function loadDefaultValues(): Record<string, unknown> {
  const documents = parseAllDocuments(readFileSync(chartValuesFile, 'utf8'));
  const first = documents[0];
  if (!first) {
    throw new Error(`no YAML document found in ${chartValuesFile}`);
  }
  const parsed: unknown = first.toJS({ maxAliasCount: -1 });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${chartValuesFile} does not hold a mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** Narrow to a plain mapping, the shape Helm deep-merges. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `patch` over `base` with Helm's semantics: mappings merge key by
 * key, every other value - lists included - is replaced outright. Neither
 * argument is mutated.
 */
export function mergeValues(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = merged[key];
    merged[key] =
      isMapping(baseValue) && isMapping(patchValue)
        ? mergeValues(baseValue, patchValue)
        : patchValue;
  }
  return merged;
}

/**
 * The fully resolved values document Helm will see for the given patches -
 * useful for computing a property's expected output. Rendering only needs the
 * patch, because Helm merges it over the chart defaults itself.
 */
export function withDefaults(...patches: Record<string, unknown>[]): Record<string, unknown> {
  return patches.reduce<Record<string, unknown>>(
    (resolved, patch) => mergeValues(resolved, patch),
    loadDefaultValues(),
  );
}

/**
 * Build a values patch from a dotted path, e.g.
 * `setPath('service.nodePort', 100)` -> `{ service: { nodePort: 100 } }`.
 */
export function setPath(dottedPath: string, value: unknown): Record<string, unknown> {
  const segments = dottedPath.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error('setPath requires a non-empty dotted path');
  }
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1] as string] = value;
  return root;
}
