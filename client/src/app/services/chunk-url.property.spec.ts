import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readChunkSpecifier, resolveChunkUrl, withRetryParam } from './chunk-url';

// Feature: session-chat, Property 40: The Chunk_URL is resolved from the importer's source
// **Validates: Requirements 20.13, 20.18**

const RUNS = { numRuns: 200 };

/**
 * A real function whose `Function.prototype.toString` text is `source`, as a
 * bundled importer would be. It is never called, so its `import()` never runs.
 */
function fnWithSource(source: string): () => unknown {
  return new Function(`return ${source}`)() as () => unknown;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const NAME_CHARS = [...ALNUM, '-', '_', '.'];

const alnumArb = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom(...ALNUM), minLength, maxLength });

/**
 * File name of a relative specifier: letters, digits, `-`, `_`, `.`. It starts
 * with a letter or digit so it is never the dot segment `.` or `..`.
 */
const fileNameArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ unit: fc.constantFrom(...UPPER_ALNUM), minLength: 8, maxLength: 8 })
    .map((hash) => `chunk-${hash}.js`),
  fc
    .tuple(fc.constantFrom(...ALNUM), fc.string({ unit: fc.constantFrom(...NAME_CHARS), maxLength: 20 }))
    .map(([first, rest]) => first + rest),
);

/** Number of `../` steps (0 means a `./` specifier) plus the file name. */
const specifierArb = fc
  .record({ up: fc.integer({ min: 0, max: 3 }), name: fileNameArb })
  .map(({ up, name }) => ({ up, name, specifier: (up === 0 ? './' : '../'.repeat(up)) + name }));

const quoteArb = fc.constantFrom('"', "'", '`');
const wsArb = fc.string({ unit: fc.constantFrom(' ', '\t', '\n'), maxLength: 3 });

/** Code before the import() call that holds no relative literal import() specifier. */
const beforeArb = fc
  .shuffledSubarray(
    [
      'const a = 1;',
      'void 0;',
      '/* lazy */',
      'let s = "abc";',
      'const m = "import(";',
      'if (false) { import(u); }',
      'if (false) { import("@angular/core"); }',
      "if (false) { import('/abs/chunk.js'); }",
    ],
    { maxLength: 3 },
  )
  .map((parts) => parts.join(' '));

/** Code after the import() call; one variant holds a later relative import() that must not win. */
const afterArb = fc.constantFrom(
  '',
  '.then(t=>t.ChatPanelComponent)',
  '.then((m) => m.ChatPanelComponent)',
  '.then(function (m) { return import("./later-chunk.js"); })',
);

const importerArb = fc
  .record({
    spec: specifierArb,
    quote: quoteArb,
    ws1: wsArb,
    ws2: wsArb,
    before: beforeArb,
    after: afterArb,
    form: fc.constantFrom('concise', 'block', 'function'),
  })
  .map(({ spec, quote, ws1, ws2, before, after, form }) => {
    const call = `import(${ws1}${quote}${spec.specifier}${quote}${ws2})${after}`;
    const source =
      form === 'concise'
        ? `() => ${call}`
        : form === 'block'
          ? `(u) => { ${before} return ${call}; }`
          : `function (u) { ${before} return ${call}; }`;
    return { ...spec, source };
  });

const originArb = fc.constantFrom(
  'https://host.example',
  'http://localhost:4200',
  'https://a.b.example:8443',
  'http://127.0.0.1:3000',
);

/** Path segments of a BASE_PATH prefix (possibly none). */
const basePathArb = fc.array(
  fc.tuple(alnumArb(1, 6), fc.constantFrom('', '-x')).map(([s, tail]) => s + tail),
  { maxLength: 3 },
);

/** The importer module's URL: origin, optional BASE_PATH, optional file, optional query and fragment. */
const baseUrlArb = fc
  .record({
    origin: originArb,
    segments: basePathArb,
    file: fc.option(
      fc
        .tuple(fc.constantFrom('main', 'chunk'), fc.string({ unit: fc.constantFrom(...UPPER_ALNUM), minLength: 8, maxLength: 8 }))
        .map(([kind, hash]) => `${kind}-${hash}.js`),
      { nil: '' },
    ),
    query: fc.option(alnumArb(1, 5).map((v) => `?v=${v}`), { nil: '' }),
    fragment: fc.option(alnumArb(1, 5).map((v) => `#${v}`), { nil: '' }),
  })
  .map(({ origin, segments, file, query, fragment }) => {
    const dir = segments.length === 0 ? '/' : `/${segments.join('/')}/`;
    return { origin, segments, url: `${origin}${dir}${file}${query}${fragment}` };
  });

/** Sources with no relative literal import() specifier. */
const nonMatchingSourceArb = fc.constantFrom(
  '(u) => import(u)',
  '(u) => import(`${u}`)',
  '() => import("@angular/core")',
  "() => import('chat-panel')",
  '() => import("/abs/chunk-X.js")',
  '() => import("https://cdn.example/chunk-X.js")',
  '() => import(".hidden.js")',
  '() => require("./chunk-X.js")',
  '() => 1',
  'function () { return 42; }',
  '(u) => { const m = "import("; return import(u); }',
);

describe('Property 40: The Chunk_URL is resolved from the importer\'s source', () => {
  it('resolveChunkUrl equals new URL(specifier, base).href, on the base origin and path prefix', () => {
    fc.assert(
      fc.property(importerArb, baseUrlArb, (imp, base) => {
        const importer = fnWithSource(imp.source);

        expect(readChunkSpecifier(importer)).toBe(imp.specifier);

        const resolved = resolveChunkUrl(importer, base.url);
        expect(resolved).toBe(new URL(imp.specifier, base.url).href);

        // Independent expectation: same origin, directory of the base minus `up`
        // segments (clamped at the root), then the file name; no query or fragment.
        const kept = base.segments.slice(0, Math.max(0, base.segments.length - imp.up));
        const parsed = new URL(resolved as string);
        expect(parsed.origin).toBe(base.origin);
        expect(parsed.pathname).toBe(`/${[...kept, imp.name].join('/')}`);
        expect(parsed.search).toBe('');
        expect(parsed.hash).toBe('');
        if (imp.up === 0) {
          expect(parsed.pathname.startsWith(new URL(base.url).pathname.replace(/[^/]*$/, ''))).toBe(true);
        }

        // The Cache_Busted_Import names the same file as the Chunk_URL.
        const busted = new URL(withRetryParam(resolved as string, 1));
        expect(busted.origin).toBe(parsed.origin);
        expect(busted.pathname).toBe(parsed.pathname);
        expect(busted.search).toBe('?retry=1');
      }),
      RUNS,
    );
  });

  it('withRetryParam adds retry=n with ? or &, keeping origin, path, every query parameter and the fragment', () => {
    const paramArb = fc.tuple(
      fc.oneof(alnumArb(1, 5), fc.constant('retry')),
      fc.string({ unit: fc.constantFrom(...ALNUM, '-', '_', '.'), maxLength: 5 }),
    );
    const urlArb = fc
      .record({
        origin: originArb,
        segments: basePathArb,
        file: fc.constantFrom('chunk-EVDY74SK.js', 'chunk-A.js', ''),
        params: fc.option(fc.array(paramArb, { minLength: 1, maxLength: 3 }), { nil: null }),
        fragment: fc.option(
          fc.string({ unit: fc.constantFrom(...ALNUM, '?', '#', '&', '='), maxLength: 6 }).map((f) => `#${f}`),
          { nil: '' },
        ),
      })
      .map(({ origin, segments, file, params, fragment }) => {
        const dir = segments.length === 0 ? '/' : `/${segments.join('/')}/`;
        const query = params === null ? '' : `?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
        return { beforeHash: `${origin}${dir}${file}${query}`, hasQuery: params !== null, fragment };
      });

    fc.assert(
      fc.property(urlArb, fc.integer({ min: 1, max: 10_000 }), (u, n) => {
        const url = u.beforeHash + u.fragment;
        const out = withRetryParam(url, n);

        // String-level rules of R20.13.
        expect(out.startsWith(u.beforeHash)).toBe(true);
        expect(out.slice(u.beforeHash.length)).toBe(`${u.hasQuery ? '&' : '?'}retry=${n}${u.fragment}`);

        // URL semantics.
        const before = new URL(url);
        const after = new URL(out);
        expect(after.origin).toBe(before.origin);
        expect(after.pathname).toBe(before.pathname);
        expect(after.hash).toBe(before.hash);
        expect([...after.searchParams]).toEqual([...before.searchParams, ['retry', String(n)]]);
      }),
      RUNS,
    );
  });

  it('returns null without throwing when no relative import() specifier can be read or resolved', () => {
    const nonFunctionArb = fc.constantFrom<unknown>({}, { toString: () => '() => import("./chunk-X.js")' }, []);
    const invalidBaseArb = fc.constantFrom('not a url', '', '/poker/main-ABC.js', 'chunk-X.js', '//');

    fc.assert(
      fc.property(nonMatchingSourceArb, baseUrlArb, (source, base) => {
        const importer = fnWithSource(source);
        expect(() => resolveChunkUrl(importer, base.url)).not.toThrow();
        expect(readChunkSpecifier(importer)).toBeNull();
        expect(resolveChunkUrl(importer, base.url)).toBeNull();
      }),
      RUNS,
    );

    fc.assert(
      fc.property(nonFunctionArb, baseUrlArb, (value, base) => {
        const notAFunction = value as () => unknown;
        expect(readChunkSpecifier(notAFunction)).toBeNull();
        expect(resolveChunkUrl(notAFunction, base.url)).toBeNull();
      }),
      RUNS,
    );

    fc.assert(
      fc.property(importerArb, invalidBaseArb, (imp, base) => {
        const importer = fnWithSource(imp.source);
        expect(() => resolveChunkUrl(importer, base)).not.toThrow();
        expect(resolveChunkUrl(importer, base)).toBeNull();
      }),
      RUNS,
    );
  });
});
