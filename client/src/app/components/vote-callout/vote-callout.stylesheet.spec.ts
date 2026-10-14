/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { EXIT_REMOVAL_DEADLINE_MS } from './callout-animation';

/**
 * Source scans for the vote callout stylesheet, layer styles and dependencies
 * (vote-reveal-fun-callouts, R5.1, R5.2, R5.4, R5.7, R5.11, R5.14, R7.3, R7.4, R7.7, R8.1, R8.2,
 * R9.9, R13.8).
 *
 * The test DOM neither interpolates keyframes nor lays out boxes, so these facts are read from the
 * source text. The reduced-motion stylesheet rules are covered by Property 12 in
 * `callout-animation.property.spec.ts` and are not repeated here.
 *
 * Vitest runs with `process.cwd()` set to `client/`.
 */

// ---------------------------------------------------------------------------
// Source access
// ---------------------------------------------------------------------------

const CLIENT = process.cwd();
const SRC = join(CLIENT, 'src');
const CALLOUT_DIR = join(SRC, 'app', 'components', 'vote-callout');
const THIS_FILE = 'vote-callout.stylesheet.spec.ts';

const read = (path: string): string => readFileSync(path, 'utf8');

/** Every file under `dir`, skipping tool caches and dependency folders. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const allSrcFiles = walk(SRC).filter((file) => !file.endsWith(THIS_FILE));
const calloutFiles = readdirSync(CALLOUT_DIR)
  .filter((name) => name.endsWith('.ts') && name !== THIS_FILE)
  .map((name) => join(CALLOUT_DIR, name));
const calloutSourceFiles = calloutFiles.filter((file) => !file.endsWith('.spec.ts'));
const keyframesPath = join(CALLOUT_DIR, 'vote-callout.keyframes.scss');
const layerPath = join(CALLOUT_DIR, 'vote-callout-layer.component.ts');

// ---------------------------------------------------------------------------
// Stylesheet parsing (plain text, no SCSS toolchain)
// ---------------------------------------------------------------------------

interface CssBlock {
  readonly header: string;
  readonly body: string;
}

interface Declaration {
  readonly property: string;
  readonly value: string;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Splits `css` into its top-level `header { body }` blocks, honouring nested braces. */
function topLevelBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let depth = 0;
  let headerStart = 0;
  let bodyStart = -1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blocks.push({
          header: squash(css.slice(headerStart, bodyStart - 1)),
          body: css.slice(bodyStart, i),
        });
        headerStart = i + 1;
      }
    }
  }
  return blocks;
}

/** Declarations written directly in `body` (nested blocks are not descended into). */
function declarationsOf(body: string): Declaration[] {
  let flat = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0) flat += ch;
  }
  return flat
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes(':'))
    .map((part) => {
      const idx = part.indexOf(':');
      return {
        property: part.slice(0, idx).trim().toLowerCase(),
        value: squash(part.slice(idx + 1)),
      };
    });
}

const valueOf = (decls: readonly Declaration[], property: string): string | undefined =>
  decls.find((d) => d.property === property)?.value;

/** The CSS held in a component's `styles: [ `...` ]` template literal. */
function componentStyles(source: string): string {
  const match = /styles:\s*\[\s*`([\s\S]*?)`\s*,?\s*\]/.exec(source);
  return match ? stripComments(match[1]) : '';
}

const px = (value: string | undefined): number => {
  const match = /^(-?[\d.]+)px$/.exec(value ?? '');
  return match ? Number(match[1]) : Number.NaN;
};

// ---------------------------------------------------------------------------
// Keyframes model
// ---------------------------------------------------------------------------

const keyframesCss = stripComments(read(keyframesPath));
const keyframesBlocks = topLevelBlocks(keyframesCss);

interface Frame {
  readonly stops: readonly number[];
  readonly decls: readonly Declaration[];
}

const keyframes = new Map<string, Frame[]>();
for (const block of keyframesBlocks) {
  const match = /^@keyframes\s+([\w-]+)$/.exec(block.header);
  if (!match) continue;
  keyframes.set(
    match[1],
    topLevelBlocks(block.body).map((frame) => ({
      stops: frame.header.split(',').map((stop) => {
        const word = stop.trim().toLowerCase();
        if (word === 'from') return 0;
        if (word === 'to') return 100;
        return Number.parseFloat(word);
      }),
      decls: declarationsOf(frame.body),
    }))
  );
}

function framesOf(name: string): readonly Frame[] {
  const frames = keyframes.get(name);
  if (!frames) throw new Error(`@keyframes ${name} is missing from vote-callout.keyframes.scss`);
  return frames;
}

function frameAt(name: string, stop: number): Frame {
  const frame = framesOf(name).find((f) => f.stops.includes(stop));
  if (!frame) throw new Error(`@keyframes ${name} has no ${stop}% frame`);
  return frame;
}

const transformAt = (name: string, stop: number): string =>
  valueOf(frameAt(name, stop).decls, 'transform') ?? '';

const numbersIn = (value: string, pattern: RegExp): number[] =>
  [...value.matchAll(pattern)].map((m) => Number(m[1]));

const SCALE = /scale\(\s*(-?[\d.]+)\s*\)/g;
const ROTATE = /rotate\(\s*(-?[\d.]+)deg\s*\)/g;
const TRANSLATE_Y_PERCENT = /translateY\(\s*(-?[\d.]+)%\s*\)/g;

/** Components of every `translate3d(x, y, z)` in `value`, in pixels. */
function translate3dOf(value: string): Array<readonly [number, number, number]> {
  return [
    ...value.matchAll(
      /translate3d\(\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*\)/g
    ),
  ].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
}

// Custom properties declared on the layer in the keyframes file (the token block).
const tokenBlock = keyframesBlocks.find((b) => b.header === '.vote-callout-layer');
const tokens = new Map<string, string>(
  declarationsOf(tokenBlock?.body ?? '')
    .filter((d) => d.property.startsWith('--'))
    .map((d) => [d.property, d.value])
);

function ms(token: string): number {
  const match = /^(\d+(?:\.\d+)?)ms$/.exec(tokens.get(token) ?? '');
  if (!match) throw new Error(`token ${token} is not a millisecond value`);
  return Number(match[1]);
}

const ruleDecls = (header: string): readonly Declaration[] => {
  const block = keyframesBlocks.find((b) => b.header === header);
  if (!block) throw new Error(`no rule ${header} in vote-callout.keyframes.scss`);
  return declarationsOf(block.body);
};

const ALLOWED_ANIMATED = new Set(['transform', 'opacity', 'filter']);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vote callout stylesheet: motion bands (R5)', () => {
  it('finds every keyframe set the choreography depends on', () => {
    for (const name of [
      'callout-pop-in',
      'callout-slide-in',
      'callout-idle',
      'callout-pop-out',
      'callout-fade-in',
      'callout-fade-out',
    ]) {
      expect(keyframes.has(name), name).toBe(true);
    }
    expect(tokens.size).toBeGreaterThan(0);
  });

  it('animates only transform, opacity and filter in every keyframe (R5.11)', () => {
    for (const [name, frames] of keyframes) {
      for (const frame of frames) {
        for (const decl of frame.decls) {
          expect(ALLOWED_ANIMATED.has(decl.property), `${name}: ${decl.property}`).toBe(true);
        }
      }
    }
  });

  it('transitions, where declared anywhere in the callout styles, name only transform, opacity or filter (R5.11)', () => {
    const sheets = [keyframesCss, ...calloutSourceFiles.map((f) => componentStyles(read(f)))];
    for (const sheet of sheets) {
      const rules: CssBlock[] = [];
      const collect = (css: string): void => {
        for (const block of topLevelBlocks(css)) {
          rules.push(block);
          if (block.header.startsWith('@media')) collect(block.body);
        }
      };
      collect(sheet);
      for (const rule of rules) {
        for (const decl of declarationsOf(rule.body)) {
          if (decl.property === 'transition-property') {
            for (const name of decl.value.split(',')) {
              expect(ALLOWED_ANIMATED.has(name.trim()) || name.trim() === 'none', name).toBe(true);
            }
          } else if (decl.property === 'transition') {
            for (const part of decl.value.split(/,(?![^(]*\))/)) {
              const name = part.trim().split(/\s+/)[0];
              expect(ALLOWED_ANIMATED.has(name) || name === 'none', name).toBe(true);
            }
          }
        }
      }
    }
  });

  it('every animation rule names a keyframe set that exists', () => {
    const sheets = [keyframesCss, ...calloutSourceFiles.map((f) => componentStyles(read(f)))];
    let checked = 0;
    for (const sheet of sheets) {
      for (const match of sheet.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
        for (const token of match[1].split(/[\s,]+/)) {
          if (token.startsWith('callout-')) {
            checked++;
            expect(keyframes.has(token), token).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('near entrance scales 0.4-0.6, overshoots once to 1.05-1.12, rests at 1 within 0.005, in 300-600 ms (R5.1)', () => {
    const start = numbersIn(transformAt('callout-pop-in', 0), SCALE);
    expect(start).toHaveLength(1);
    expect(start[0]).toBeGreaterThanOrEqual(0.4);
    expect(start[0]).toBeLessThanOrEqual(0.6);

    const scales = framesOf('callout-pop-in').map((frame) => ({
      stop: Math.max(...frame.stops),
      scale: numbersIn(valueOf(frame.decls, 'transform') ?? '', SCALE)[0],
    }));
    const overshoots = scales.filter((s) => s.scale > 1);
    expect(overshoots).toHaveLength(1);
    expect(overshoots[0].scale).toBeGreaterThanOrEqual(1.05);
    expect(overshoots[0].scale).toBeLessThanOrEqual(1.12);
    expect(overshoots[0].stop).toBeLessThan(100);

    const rest = numbersIn(transformAt('callout-pop-in', 100), SCALE);
    expect(Math.abs(rest[0] - 1)).toBeLessThanOrEqual(0.005);

    expect(valueOf(frameAt('callout-pop-in', 100).decls, 'opacity')).toBe('1');
    expect(ms('--callout-entrance-ms')).toBeGreaterThanOrEqual(300);
    expect(ms('--callout-entrance-ms')).toBeLessThanOrEqual(600);
  });

  it('far entrance starts at least 100% of its width off the edge at 6-15 deg and settles at 0 (R5.2)', () => {
    const start = transformAt('callout-slide-in', 0);
    const offset = /translateX\(\s*calc\(\s*(\d+)%\s*\+\s*var\(--callout-edge-gap\)\s*\)\s*\)/.exec(start);
    expect(offset, start).not.toBeNull();
    expect(Number((offset as RegExpExecArray)[1])).toBeGreaterThanOrEqual(100);

    const startRotation = numbersIn(start, ROTATE);
    expect(startRotation).toHaveLength(1);
    expect(Math.abs(startRotation[0])).toBeGreaterThanOrEqual(6);
    expect(Math.abs(startRotation[0])).toBeLessThanOrEqual(15);

    const end = transformAt('callout-slide-in', 100);
    expect(end).toMatch(/translateX\(\s*0(?:px|%)?\s*\)/);
    expect(numbersIn(end, ROTATE)).toEqual([0]);

    expect(ms('--callout-entrance-ms')).toBeGreaterThanOrEqual(300);
    expect(ms('--callout-entrance-ms')).toBeLessThanOrEqual(600);
  });

  it('keeps the name stagger step within 40-90 ms (R5.3)', () => {
    expect(ms('--callout-stagger')).toBeGreaterThanOrEqual(40);
    expect(ms('--callout-stagger')).toBeLessThanOrEqual(90);
  });

  it('idle loops every 1.5-4 s with 1-4 px and 0.3-1.5 deg amplitude, starting and ending at rest (R5.4, R5.5, R5.15)', () => {
    expect(ms('--callout-idle-ms')).toBeGreaterThanOrEqual(1500);
    expect(ms('--callout-idle-ms')).toBeLessThanOrEqual(4000);

    const translations = framesOf('callout-idle').flatMap((frame) =>
      translate3dOf(valueOf(frame.decls, 'transform') ?? '')
    );
    const rotations = framesOf('callout-idle').flatMap((frame) =>
      numbersIn(valueOf(frame.decls, 'transform') ?? '', ROTATE)
    );
    const translationAmplitude = Math.max(...translations.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));
    const rotationAmplitude = Math.max(...rotations.map(Math.abs));
    expect(translationAmplitude).toBeGreaterThanOrEqual(1);
    expect(translationAmplitude).toBeLessThanOrEqual(4);
    expect(rotationAmplitude).toBeGreaterThanOrEqual(0.3);
    expect(rotationAmplitude).toBeLessThanOrEqual(1.5);

    // Rest at both ends: the handoff from the entrance and the settled state have no offset.
    for (const stop of [0, 100]) {
      const transform = transformAt('callout-idle', stop);
      expect(translate3dOf(transform)).toEqual([[0, 0, 0]]);
      expect(numbersIn(transform, ROTATE)).toEqual([0]);
    }
  });

  it('idle runs a finite number of iterations that ends inside 30 s (R5.5)', () => {
    const iterations = Number(tokens.get('--callout-idle-iterations'));
    expect(Number.isInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThan(0);
    expect(iterations * ms('--callout-idle-ms')).toBeLessThan(30_000);

    const idleRule = valueOf(ruleDecls('.vote-callout-layer .callout--idle'), 'animation') ?? '';
    expect(idleRule).toContain('callout-idle');
    expect(idleRule).toContain('var(--callout-idle-iterations)');
    expect(idleRule).not.toMatch(/\binfinite\b/);
  });

  it('exit shrinks to at most 0.3, rotates at least 12 deg, drops at least 50%, fades to 0 in 250-450 ms (R5.7)', () => {
    const end = transformAt('callout-pop-out', 100);
    const scale = numbersIn(end, SCALE);
    const rotate = numbersIn(end, ROTATE);
    const drop = numbersIn(end, TRANSLATE_Y_PERCENT);
    expect(scale).toHaveLength(1);
    expect(scale[0]).toBeLessThanOrEqual(0.3);
    expect(Math.abs(rotate[0])).toBeGreaterThanOrEqual(12);
    expect(drop[0]).toBeGreaterThanOrEqual(50);
    expect(valueOf(frameAt('callout-pop-out', 100).decls, 'opacity')).toBe('0');

    expect(ms('--callout-exit-ms')).toBeGreaterThanOrEqual(250);
    expect(ms('--callout-exit-ms')).toBeLessThanOrEqual(450);
    // The exit has to finish before the 700 ms removal deadline fires (R5.17).
    expect(ms('--callout-exit-ms')).toBeLessThan(EXIT_REMOVAL_DEADLINE_MS);

    const exitRule = valueOf(ruleDecls('.vote-callout-layer .callout--exiting'), 'animation') ?? '';
    expect(exitRule).toContain('callout-pop-out');
    expect(exitRule).toContain('forwards');
  });

  it('exit starts from the captured live transform and opacity (R5.16)', () => {
    const start = frameAt('callout-pop-out', 0).decls;
    expect(valueOf(start, 'transform')).toMatch(/var\(--callout-exit-from/);
    expect(valueOf(start, 'opacity')).toMatch(/var\(--callout-exit-opacity/);
  });

  it('declares monotone easing tokens, with overshoot kept in the keyframes (R5.1)', () => {
    for (const token of ['--callout-ease-out', '--callout-ease-in']) {
      const match = /^cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(
        tokens.get(token) ?? ''
      );
      expect(match, token).not.toBeNull();
      const [y1, y2] = [Number((match as RegExpExecArray)[2]), Number((match as RegExpExecArray)[4])];
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(1);
      expect(y2).toBeGreaterThanOrEqual(0);
      expect(y2).toBeLessThanOrEqual(1);
    }
  });

  it('uses a 16 px edge gap token (R7.7)', () => {
    expect(tokens.get('--callout-edge-gap')).toBe('16px');
  });
});

describe('vote callout layer styles: placement, layering and size caps (R7, R8)', () => {
  const layerCss = componentStyles(read(layerPath));
  const layerBlocks = topLevelBlocks(layerCss);
  const layerRule = layerBlocks.find((b) => b.header === '.vote-callout-layer');
  const layerDecls = declarationsOf(layerRule?.body ?? '');
  const narrowMedia = layerBlocks.find((b) =>
    /^@media\s*\(\s*max-width\s*:\s*767\.98px\s*\)$/.test(b.header)
  );
  const narrowDecls = declarationsOf(
    topLevelBlocks(narrowMedia?.body ?? '').find((b) => b.header === '.vote-callout-layer')?.body ?? ''
  );

  it('finds the layer rule and its narrow-viewport override', () => {
    expect(layerRule).toBeDefined();
    expect(narrowMedia).toBeDefined();
    expect(narrowDecls.length).toBeGreaterThan(0);
  });

  it('is fixed, isolated in one stacking context at z-index 900 (R7.3, R7.4)', () => {
    expect(valueOf(layerDecls, 'position')).toBe('fixed');
    expect(valueOf(layerDecls, 'z-index')).toBe('900');
    expect(valueOf(layerDecls, 'isolation')).toBe('isolate');
  });

  it('sits below the history backdrop, dialogs, countdown and toast, and above page sections (R7.3, R7.4)', () => {
    const zIndex = Number(valueOf(layerDecls, 'z-index'));
    // The documented ladder of the session page: dialogs 1000, history backdrop 999, countdown 9999, toast 10000.
    for (const above of [999, 1000, 9999, 10000]) expect(zIndex).toBeLessThan(above);
    // Content sections of the session page stay below 100 (settings 50, QR 100 are modal-ish overlays).
    expect(zIndex).toBeGreaterThan(100);
  });

  it('declares no z-index anywhere in the callout sources except the layer itself (R7.3)', () => {
    const stripSource = (text: string): string =>
      stripComments(text).replace(/^\s*\/\/.*$/gm, '');
    const hits: string[] = [];
    for (const file of calloutSourceFiles) {
      for (const match of stripSource(read(file)).matchAll(/z-index\s*:\s*([^;]+);|zIndex|style\.z-index/g)) {
        hits.push(`${file.slice(CALLOUT_DIR.length + 1)}: ${match[0]}`);
      }
    }
    expect(hits).toEqual(['vote-callout-layer.component.ts: z-index: 900;']);
    expect(/z-index|zIndex/.test(keyframesCss)).toBe(false);
  });

  it('anchors 16 px from the edge with an 8 px gap between panels (R7.6, R7.7)', () => {
    expect(valueOf(layerDecls, 'right')).toBe('16px');
    expect(valueOf(layerDecls, 'bottom')).toBe('16px');
    expect(valueOf(layerDecls, 'gap')).toBe('8px');
    expect(px(valueOf(layerDecls, 'gap'))).toBeGreaterThanOrEqual(8);
  });

  it('caps width at 360 px or the viewport less 16 px, and height at 40 vh (R7.7)', () => {
    expect(valueOf(layerDecls, 'max-width')).toBe('min(360px, calc(100vw - 16px))');
    expect(valueOf(layerDecls, 'max-height')).toBe('40vh');
  });

  it('narrows to the viewport less 32 px and 45 vh below 768 px, scrolling instead of growing (R8.1, R8.2)', () => {
    expect(valueOf(narrowDecls, 'max-width')).toBe('calc(100vw - 32px)');
    expect(valueOf(narrowDecls, 'max-height')).toBe('45vh');
    expect(valueOf(narrowDecls, 'overflow-y')).toBe('auto');
    expect(valueOf(narrowDecls, 'left')).toBe('16px');
    expect(valueOf(narrowDecls, 'right')).toBe('16px');
  });

  it('passes pointer events through the layer and panels and takes them only on controls (R7.2)', () => {
    expect(valueOf(layerDecls, 'pointer-events')).toBe('none');

    let panels = 0;
    let controls = 0;
    for (const file of calloutSourceFiles.filter((f) => f.endsWith('.component.ts'))) {
      for (const rule of topLevelBlocks(componentStyles(read(file)))) {
        const decls = declarationsOf(rule.body);
        const pointer = valueOf(decls, 'pointer-events');
        if (pointer === 'auto') {
          controls++;
          // Control size minimums (R9.9): 32 px each way, and 44 px for the text input (R8.7).
          expect(px(valueOf(decls, 'min-height')), rule.header).toBeGreaterThanOrEqual(
            rule.header.includes('input') ? 44 : 32
          );
          if (!rule.header.includes('input')) {
            expect(px(valueOf(decls, 'min-width')), rule.header).toBeGreaterThanOrEqual(32);
          }
        } else if (rule.header === '.callout' || rule.header === '.unsent-note') {
          panels++;
          expect(pointer, rule.header).toBe('none');
        }
      }
    }
    expect(panels).toBeGreaterThanOrEqual(3);
    expect(controls).toBeGreaterThanOrEqual(4);
  });

  it('caps each callout panel at 40 vh, and the near panel also at 360 px and the narrow width limit (R7.7, R8.1)', () => {
    for (const file of ['near-average-callout.component.ts', 'far-from-average-prompt.component.ts']) {
      const blocks = topLevelBlocks(componentStyles(read(join(CALLOUT_DIR, file))));
      const panel = blocks.find((b) => b.header === '.callout');
      const decls = declarationsOf(panel?.body ?? '');
      expect(valueOf(decls, 'max-height'), file).toBe('40vh');
      expect(valueOf(decls, 'overflow-y'), file).toBe('auto');
    }

    const nearBlocks = topLevelBlocks(
      componentStyles(read(join(CALLOUT_DIR, 'near-average-callout.component.ts')))
    );
    const nearPanel = declarationsOf(nearBlocks.find((b) => b.header === '.callout')?.body ?? '');
    expect(valueOf(nearPanel, 'max-width')).toBe('min(360px, calc(100vw - 16px))');
    const nearNarrow = nearBlocks.find((b) => /^@media\s*\(\s*max-width\s*:\s*767\.98px\s*\)$/.test(b.header));
    const nearNarrowPanel = declarationsOf(
      topLevelBlocks(nearNarrow?.body ?? '').find((b) => b.header === '.callout')?.body ?? ''
    );
    expect(valueOf(nearNarrowPanel, 'max-width')).toBe('calc(100vw - 32px)');
  });
});

describe('vote callout dependencies and imports (R5.14, R13.8)', () => {
  const pkg = JSON.parse(read(join(CLIENT, 'package.json'))) as Record<
    string,
    Record<string, string> | undefined
  >;
  const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
    (section) => Object.keys(pkg[section] ?? {})
  );

  const ANIMATION_PACKAGES = new Set([
    '@angular/animations',
    'gsap',
    'animejs',
    'anime.js',
    'framer-motion',
    'motion',
    'popmotion',
    'lottie-web',
    'ngx-lottie',
    'velocity-animate',
    'web-animations-js',
    'animate.css',
    'react-spring',
    '@motionone/dom',
  ]);

  it('has no @angular/animations or third-party animation library in package.json (R5.14)', () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => ANIMATION_PACKAGES.has(name))).toEqual([]);
  });

  it('has no animation package imported by any source file under components/vote-callout (R5.14)', () => {
    const importedPackages = new Set<string>();
    for (const file of calloutFiles) {
      for (const match of read(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('@shared/')) continue;
        const parts = specifier.split('/');
        importedPackages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
      }
    }
    expect(importedPackages.size).toBeGreaterThan(0);
    expect([...importedPackages].filter((name) => ANIMATION_PACKAGES.has(name))).toEqual([]);
  });

  it('has no legacy animation DSL import or provider anywhere in client/src (R5.14)', () => {
    const legacy =
      /@angular\/animations|BrowserAnimationsModule|NoopAnimationsModule|provideAnimations(?:Async)?\b|provideNoopAnimations\b|AnimationBuilder\b/;
    const offenders = allSrcFiles
      .filter((file) => /\.(ts|html|scss|css|json)$/.test(file))
      .filter((file) => legacy.test(read(file)))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('imports the keyframes stylesheet exactly once, from styles.scss', () => {
    const referencing = allSrcFiles
      .filter((file) => /\.(ts|html|scss|css)$/.test(file) && !file.endsWith('.spec.ts'))
      .filter((file) => /vote-callout\.keyframes/.test(read(file)))
      .map((file) => file.slice(SRC.length + 1));
    expect(referencing).toEqual(['styles.scss']);

    const stylesheet = read(join(SRC, 'styles.scss'));
    expect(stylesheet.match(/@(?:use|import|forward)\s+['"][^'"]*vote-callout\.keyframes['"]/g)).toHaveLength(1);

    const angularJson = join(CLIENT, 'angular.json');
    if (existsSync(angularJson)) expect(read(angularJson)).not.toMatch(/vote-callout\.keyframes/);
  });

  it('defines each callout keyframe set once, in the keyframes stylesheet only', () => {
    const definitions: string[] = [];
    for (const file of allSrcFiles.filter((f) => /\.(ts|scss|css)$/.test(f) && !f.endsWith('.spec.ts'))) {
      for (const match of read(file).matchAll(/@keyframes\s+(callout-[\w-]+)/g)) {
        definitions.push(`${file.slice(SRC.length + 1).replace(/\\/g, '/')}#${match[1]}`);
      }
    }
    const inKeyframesFile = definitions.filter((d) =>
      d.startsWith('app/components/vote-callout/vote-callout.keyframes.scss#')
    );
    expect(inKeyframesFile).toHaveLength(definitions.length);
    expect(new Set(definitions).size).toBe(definitions.length);
    expect(definitions.length).toBe(keyframes.size);
  });

  it('uses no `any` annotation or cast in the files added for the feature (R13.8)', () => {
    const added = [
      ...calloutFiles,
      join(SRC, 'app', 'services', 'callout-copy-store.service.ts'),
      join(SRC, 'app', 'services', 'callout-persistence.service.ts'),
      join(CLIENT, '..', 'shared', 'callout-copy.ts'),
    ].filter((file) => existsSync(file));
    expect(added.length).toBeGreaterThanOrEqual(calloutFiles.length);

    const offenders: string[] = [];
    for (const file of added) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false);
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          offenders.push(`${file.slice(CLIENT.length + 1)}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
