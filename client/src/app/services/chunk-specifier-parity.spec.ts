/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_SPECIFIER_PATTERN } from './chunk-url';

/**
 * Specifier-pattern parity (R22.19, R20.13).
 *
 * `client/scripts/check-chat-chunk.mjs` embeds its own copy of
 * `CHUNK_SPECIFIER_PATTERN`, because it runs under plain Node and cannot import
 * the TypeScript source. This test keeps the two in step: the script's text must
 * contain the pattern source the Panel_Chunk_Loader uses at runtime.
 * Vitest runs with `process.cwd()` = `client/`.
 */

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'check-chat-chunk.mjs');

describe('CHUNK_SPECIFIER_PATTERN parity with check-chat-chunk.mjs', () => {
  it('the build-output check script contains the same pattern source', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain(CHUNK_SPECIFIER_PATTERN.source);
  });
});
