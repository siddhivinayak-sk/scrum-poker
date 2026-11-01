import { describe, it, expect } from 'vitest';
import { readChunkSpecifier, resolveChunkUrl, withRetryParam } from './chunk-url';

// Feature: session-chat, unit examples for the Chunk_URL helpers (R20.13, R20.18).
// Property 40 lives in chunk-url.property.spec.ts.

/**
 * A real function whose `Function.prototype.toString` text is `source`, as a
 * bundled importer would be. It is never called, so its `import()` never runs.
 */
function fnWithSource(source: string): () => unknown {
  return new Function(`return ${source}`)() as () => unknown;
}

describe('readChunkSpecifier', () => {
  it('reads the specifier the builder wrote into the importer', () => {
    const importer = fnWithSource('()=>import("./chunk-EVDY74SK.js").then(t=>t.ChatPanelComponent)');
    expect(readChunkSpecifier(importer)).toBe('./chunk-EVDY74SK.js');
  });

  it('accepts single quotes, backticks, ../ and whitespace inside the parentheses', () => {
    expect(readChunkSpecifier(fnWithSource("() => import( '../chunk-A.js' )"))).toBe('../chunk-A.js');
    expect(readChunkSpecifier(fnWithSource('() => import(`./chunk-B.js`)'))).toBe('./chunk-B.js');
  });

  it('returns null when there is no relative literal specifier', () => {
    expect(readChunkSpecifier(fnWithSource('(u) => import(u)'))).toBeNull();
    expect(readChunkSpecifier(fnWithSource('() => import("@angular/core")'))).toBeNull();
    expect(readChunkSpecifier(() => 1)).toBeNull();
  });

  it('returns null when the source cannot be read', () => {
    const notAFunction = {} as unknown as () => unknown;
    expect(readChunkSpecifier(notAFunction)).toBeNull();
  });
});

describe('resolveChunkUrl', () => {
  const importer = fnWithSource('()=>import("./chunk-X.js")');

  it('resolves against the importer module URL, keeping the BASE_PATH prefix', () => {
    expect(resolveChunkUrl(importer, 'https://host.example/poker/main-ABC.js')).toBe(
      'https://host.example/poker/chunk-X.js',
    );
  });

  it('returns null when the base URL is invalid or the specifier is unreadable', () => {
    expect(resolveChunkUrl(importer, 'not a url')).toBeNull();
    expect(resolveChunkUrl(fnWithSource('(u) => import(u)'), 'https://host.example/')).toBeNull();
  });
});

describe('withRetryParam', () => {
  it('adds ?retry=n when the URL has no query', () => {
    expect(withRetryParam('https://h/a/chunk.js', 1)).toBe('https://h/a/chunk.js?retry=1');
  });

  it('adds &retry=n when the URL already holds a query', () => {
    expect(withRetryParam('https://h/chunk.js?v=2', 3)).toBe('https://h/chunk.js?v=2&retry=3');
  });

  it('keeps the fragment at the end', () => {
    expect(withRetryParam('https://h/chunk.js#x', 2)).toBe('https://h/chunk.js?retry=2#x');
    expect(withRetryParam('https://h/chunk.js?v=1#x?y', 4)).toBe('https://h/chunk.js?v=1&retry=4#x?y');
  });
});
