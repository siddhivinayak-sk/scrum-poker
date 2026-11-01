#!/usr/bin/env node
/**
 * Build-output check for the Deferred chat chunk (session-chat R22.19, R20.4).
 *
 * Run in `client/` after a production build that writes the esbuild metafile:
 *
 *   npx ng build --stats-json
 *   node scripts/check-chat-chunk.mjs
 *
 * It is deliberately not an npm script and not part of `npm test` (design C14,
 * R22.6). It uses Node built-ins only and exits with status 1 and a message
 * naming the failed condition unless all of these hold:
 *
 *   1. Find the chunks: exactly one emitted JS file holds each of
 *      `components/chat/chat-panel.component.ts` (the Deferred chat chunk),
 *      `components/chat/chat-panel-importer.ts` (the importer chunk),
 *      `session-poker-page.component.ts` and `retro-board-page.component.ts`
 *      (the board page chunks), and the Deferred chat chunk is a file of its own.
 *   2. Readable specifier: the importer chunk's text holds a match of
 *      CHUNK_SPECIFIER_PATTERN (same source as `src/app/services/chunk-url.ts`)
 *      whose specifier, resolved against the importer chunk's own path, names
 *      the Deferred chat chunk; that file exists in the browser output; and the
 *      importer chunk holds `import.meta.url`, the base the loader resolves
 *      against (R20.13).
 *   3. Not initial: the Deferred chat chunk is outside the closure over
 *      `import-statement` imports of the `main.ts` / polyfills entry outputs,
 *      cross-checked against the `<script>` and `modulepreload` tags of
 *      `index.html`.
 *   4. Static imports already loaded: every `import-statement` import of the
 *      Deferred chat chunk lies in loaded(poker) ∩ loaded(retro), where
 *      loaded(page) = initial ∪ staticClosure(page).
 *
 * The output directory is read from `angular.json`
 * (`projects.client.architect.build.options.outputPath`); when unset, the
 * application builder's default `dist/client` with the `browser` subfolder is
 * used. `stats.json` sits in the output directory, the emitted files in its
 * browser subfolder.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keep this literal identical to `CHUNK_SPECIFIER_PATTERN` in
 * `src/app/services/chunk-url.ts`; `chunk-specifier-parity.spec.ts` asserts
 * that this file contains that pattern's source.
 */
const CHUNK_SPECIFIER_PATTERN = /\bimport\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/;

const PROJECT_NAME = 'client';
const PANEL_INPUT = 'components/chat/chat-panel.component.ts';
const IMPORTER_INPUT = 'components/chat/chat-panel-importer.ts';
const POKER_PAGE_INPUT = 'session-poker-page.component.ts';
const RETRO_PAGE_INPUT = 'retro-board-page.component.ts';

class CheckFailure extends Error {
  /** @param {string} condition @param {string} detail */
  constructor(condition, detail) {
    super(detail);
    this.condition = condition;
  }
}

/** @param {string} condition @param {string} detail @returns {never} */
function fail(condition, detail) {
  throw new CheckFailure(condition, detail);
}

const toPosix = (p) => p.replace(/\\/g, '/');

/** The `client/` directory: the parent of this script's folder. */
function clientDir() {
  return import.meta.dirname ? path.resolve(import.meta.dirname, '..') : process.cwd();
}

/** Output and browser directories from `angular.json`, with builder defaults. */
function resolveOutputDirs(root) {
  let outputPath;
  try {
    const angularJson = JSON.parse(fs.readFileSync(path.join(root, 'angular.json'), 'utf8'));
    outputPath = angularJson?.projects?.[PROJECT_NAME]?.architect?.build?.options?.outputPath;
  } catch (error) {
    fail('setup', `cannot read ${path.join(root, 'angular.json')}: ${error.message}`);
  }
  let base = `dist/${PROJECT_NAME}`;
  let browser = 'browser';
  if (typeof outputPath === 'string') {
    base = outputPath;
  } else if (outputPath && typeof outputPath === 'object') {
    if (typeof outputPath.base === 'string') base = outputPath.base;
    if (typeof outputPath.browser === 'string') browser = outputPath.browser;
  }
  const outDir = path.resolve(root, base);
  return { outDir, browserDir: path.resolve(outDir, browser), browserSub: toPosix(browser) };
}

function readMetafile(outDir) {
  const statsPath = path.join(outDir, 'stats.json');
  if (!fs.existsSync(statsPath)) {
    fail('setup', `${statsPath} not found; run "npx ng build --stats-json" in client/ first`);
  }
  let metafile;
  try {
    metafile = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  } catch (error) {
    fail('setup', `${statsPath} is not valid JSON: ${error.message}`);
  }
  if (!metafile || typeof metafile.outputs !== 'object' || metafile.outputs === null) {
    fail('setup', `${statsPath} has no "outputs" map (expected an esbuild metafile)`);
  }
  return metafile;
}

/**
 * Path of an output key relative to the browser directory. Keys are matched
 * by base name, so a leading dist or browser prefix does not matter.
 */
function makeRelativizer(browserSub) {
  const marker = browserSub && browserSub !== '.' ? `${browserSub.replace(/\/$/, '')}/` : '';
  return (key) => {
    const posix = toPosix(key).replace(/^\.\//, '');
    if (marker) {
      const at = posix.lastIndexOf(marker);
      if (at === 0 || (at > 0 && posix[at - 1] === '/')) return posix.slice(at + marker.length);
    }
    return posix;
  };
}

/** True when a metafile input key names the source file `suffix`. */
function inputMatches(inputKey, suffix) {
  if (inputKey.startsWith('angular:')) return false; // component style virtual modules
  const posix = toPosix(inputKey);
  return posix === suffix || posix.endsWith(`/${suffix}`);
}

/** The single JS output whose inputs hold `suffix`. */
function findOutputByInput(jsOutputs, suffix, label) {
  const matches = jsOutputs.filter(([, out]) =>
    Object.keys(out.inputs ?? {}).some((key) => inputMatches(key, suffix)),
  );
  if (matches.length !== 1) {
    fail(
      '1 (find the chunks)',
      `expected exactly one emitted JS file holding ${suffix} (${label}), found ${matches.length}` +
        (matches.length ? `: ${matches.map(([key]) => key).join(', ')}` : ''),
    );
  }
  return matches[0][0];
}

/** Output key -> keys of its `import-statement` imports. */
function staticImportsOf(outputs, key) {
  return (outputs[key]?.imports ?? [])
    .filter((imp) => imp.kind === 'import-statement' && !imp.external)
    .map((imp) => imp.path);
}

/** Closure over `import-statement` imports, starting set included. */
function staticClosure(outputs, startKeys) {
  const seen = new Set();
  const stack = [...startKeys];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of staticImportsOf(outputs, key)) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/** `src`/`href` values of `<script>` and `<link rel="modulepreload">` tags. */
function htmlScriptRefs(html) {
  const refs = [];
  const tagPattern = /<(script|link)\b[^>]*>/gi;
  let tag;
  while ((tag = tagPattern.exec(html))) {
    const text = tag[0];
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(text);
      return m ? (m[1] ?? m[2] ?? m[3]) : null;
    };
    if (tag[1].toLowerCase() === 'script') {
      const src = attr('src');
      if (src) refs.push(src);
    } else if ((attr('rel') ?? '').toLowerCase() === 'modulepreload') {
      const href = attr('href');
      if (href) refs.push(href);
    }
  }
  return refs
    .filter((ref) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) // local files only
    .map((ref) => ref.split(/[?#]/)[0].replace(/^\.?\//, ''));
}

function run() {
  const root = clientDir();
  const { outDir, browserDir, browserSub } = resolveOutputDirs(root);
  const metafile = readMetafile(outDir);
  const outputs = metafile.outputs;
  const rel = makeRelativizer(browserSub);
  const jsOutputs = Object.entries(outputs).filter(([key]) => /\.m?js$/.test(key));

  // 1. Find the chunks.
  const panelKey = findOutputByInput(jsOutputs, PANEL_INPUT, 'Deferred chat chunk');
  const importerKey = findOutputByInput(jsOutputs, IMPORTER_INPUT, 'importer chunk');
  const pokerKey = findOutputByInput(jsOutputs, POKER_PAGE_INPUT, 'poker board page chunk');
  const retroKey = findOutputByInput(jsOutputs, RETRO_PAGE_INPUT, 'retro board page chunk');
  for (const [otherKey, label] of [
    [importerKey, 'importer chunk'],
    [pokerKey, 'poker board page chunk'],
    [retroKey, 'retro board page chunk'],
  ]) {
    if (otherKey === panelKey) {
      fail(
        '1 (find the chunks)',
        `the Deferred chat chunk is not a separate file: ${PANEL_INPUT} is bundled into the ${label} ${panelKey}`,
      );
    }
  }
  const panelRel = rel(panelKey);
  const importerRel = rel(importerKey);

  // 2. Readable specifier.
  const importerFile = path.join(browserDir, importerRel);
  if (!fs.existsSync(importerFile)) {
    fail('2 (readable specifier)', `importer chunk ${importerRel} is missing from ${browserDir}`);
  }
  const importerText = fs.readFileSync(importerFile, 'utf8');
  const globalPattern = new RegExp(CHUNK_SPECIFIER_PATTERN.source, 'g');
  const specifiers = [...importerText.matchAll(globalPattern)].map((m) => m[2]);
  const resolvedSpecifiers = specifiers.map((spec) => ({
    spec,
    target: path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec)),
  }));
  const panelSpecifier = resolvedSpecifiers.find(({ target }) => target === panelRel);
  if (!panelSpecifier) {
    fail(
      '2 (readable specifier)',
      `importer chunk ${importerRel} holds no relative import() specifier resolving to the Deferred chat chunk ${panelRel}` +
        ` (specifiers found: ${specifiers.length ? specifiers.join(', ') : 'none'})`,
    );
  }
  if (!fs.existsSync(path.join(browserDir, panelSpecifier.target))) {
    fail(
      '2 (readable specifier)',
      `specifier ${panelSpecifier.spec} in ${importerRel} names ${panelSpecifier.target}, which is missing from ${browserDir}`,
    );
  }
  if (!importerText.includes('import.meta.url')) {
    fail(
      '2 (readable specifier)',
      `importer chunk ${importerRel} holds no import.meta.url, so the Chunk_URL has no base to resolve against`,
    );
  }

  // 3. Not initial.
  const entryKeys = jsOutputs
    .filter(([, out]) => {
      const entry = typeof out.entryPoint === 'string' ? toPosix(out.entryPoint) : '';
      return /(^|\/)main\.ts$/.test(entry) || /polyfills/.test(entry);
    })
    .map(([key]) => key);
  if (!entryKeys.some((key) => /(^|\/)main\.ts$/.test(toPosix(outputs[key].entryPoint)))) {
    fail('3 (not initial)', 'no emitted JS file has an entryPoint ending in main.ts');
  }
  const initial = staticClosure(outputs, entryKeys);
  const initialRel = new Set([...initial].map(rel));

  const indexFile = path.join(browserDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    fail('3 (not initial)', `${indexFile} not found, cannot cross-check the initial bundle`);
  }
  const htmlRefs = htmlScriptRefs(fs.readFileSync(indexFile, 'utf8'));
  const strayRefs = htmlRefs.filter((ref) => /\.m?js$/.test(ref) && !initialRel.has(ref));
  if (strayRefs.length) {
    fail(
      '3 (not initial)',
      `index.html loads ${strayRefs.join(', ')}, which the metafile initial closure does not contain; the initial set cannot be trusted`,
    );
  }
  const missingEntries = entryKeys.map(rel).filter((entry) => !htmlRefs.includes(entry));
  if (missingEntries.length) {
    fail('3 (not initial)', `index.html does not load the entry file(s) ${missingEntries.join(', ')}`);
  }
  if (initial.has(panelKey) || htmlRefs.includes(panelRel)) {
    fail('3 (not initial)', `the Deferred chat chunk ${panelRel} is part of the initial bundle`);
  }

  // 4. Static imports already loaded.
  const loadedPoker = new Set([...initial, ...staticClosure(outputs, [pokerKey])]);
  const loadedRetro = new Set([...initial, ...staticClosure(outputs, [retroKey])]);
  const panelImports = staticImportsOf(outputs, panelKey);
  const notLoaded = panelImports
    .map((key) => {
      const missing = [];
      if (!loadedPoker.has(key)) missing.push('poker');
      if (!loadedRetro.has(key)) missing.push('retro');
      return { key, missing };
    })
    .filter(({ missing }) => missing.length > 0);
  if (notLoaded.length) {
    fail(
      '4 (static imports already loaded)',
      `the Deferred chat chunk ${panelRel} statically imports file(s) not loaded by both board pages: ` +
        notLoaded.map(({ key, missing }) => `${rel(key)} (not loaded by ${missing.join(' and ')})`).join(', '),
    );
  }

  console.log('check-chat-chunk: OK');
  console.log(`  Deferred chat chunk: ${panelRel}`);
  console.log(`  importer chunk:      ${importerRel} -> import("${panelSpecifier.spec}")`);
  console.log(`  board page chunks:   poker ${rel(pokerKey)}, retro ${rel(retroKey)}`);
  console.log(`  initial bundle:      ${[...initialRel].sort().join(', ')}`);
  console.log(`  panel static imports (loaded by both pages): ${panelImports.map(rel).join(', ') || 'none'}`);
}

try {
  run();
} catch (error) {
  if (error instanceof CheckFailure) {
    console.error(`check-chat-chunk: FAILED condition ${error.condition}: ${error.message}`);
  } else {
    console.error(`check-chat-chunk: FAILED unexpectedly: ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
}
