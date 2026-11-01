/**
 * Pure Chunk_URL helpers for the Panel_Chunk_Loader (design "The importer and
 * the Chunk_URL", R20.13, R20.18).
 *
 * The Angular application builder rewrites the specifier of
 * `import('./chat-panel.component')` to the emitted chunk file, relative to the
 * chunk that holds the call, for example `import("./chunk-EVDY74SK.js")`. The
 * loader reads that specifier from the compiled importer's source text and
 * resolves it against the importer module's `import.meta.url`, so a
 * Cache_Busted_Import names the same file, origin and `BASE_PATH` prefix as the
 * initial attempt.
 *
 * Every function here returns `null` instead of throwing; `null` selects the
 * R20.18 fallback (retry by calling the importer unchanged).
 *
 * `client/scripts/check-chat-chunk.mjs` (R22.19) embeds the same pattern
 * source; `chunk-specifier-parity.spec.ts` keeps the two in step.
 */

/** First relative specifier of an import() call in a function's source text. */
export const CHUNK_SPECIFIER_PATTERN = /\bimport\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/;

/**
 * The relative module specifier of the first `import()` call in the source of
 * `importer`, or `null` when the source cannot be read or holds no relative
 * literal specifier (for example `import(variable)`).
 */
export function readChunkSpecifier(importer: () => unknown): string | null {
  let source: string;
  try {
    source = Function.prototype.toString.call(importer);
  } catch {
    return null;
  }
  const match = CHUNK_SPECIFIER_PATTERN.exec(source);
  return match?.[2] ?? null;
}

/**
 * The absolute Chunk_URL: the specifier of `importer` resolved against
 * `baseUrl` (the importer module's `import.meta.url`), or `null` when the
 * specifier cannot be read or the URL cannot be built.
 */
export function resolveChunkUrl(importer: () => unknown, baseUrl: string): string | null {
  const specifier = readChunkSpecifier(importer);
  if (specifier === null) {
    return null;
  }
  try {
    return new URL(specifier, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * `url` with `retry=<n>` added to its query string: `?retry=n` when `url` has
 * no query, `&retry=n` when it already holds a `?`. Any `#fragment` is kept at
 * the end.
 */
export function withRetryParam(url: string, n: number): string {
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}retry=${n}${fragment}`;
}
