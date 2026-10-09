import { describe, expect, it } from 'vitest';
import {
  CAPTURE_COLOR_PROPERTIES,
  hasUnrenderableColor,
  normaliseColorValue,
} from './retro-capture-mode';

/**
 * html2canvas 1.4.1 parses exactly four colour functions - rgb, rgba, hsl and hsla -
 * and throws on any other name, which aborts the entire capture rather than
 * degrading one colour. Chrome serialises a computed color-mix() as color(srgb ...),
 * so every mixed design token reached the renderer in a rejected form and the board
 * screenshot failed with a generic message.
 *
 * The screenshot service spec mocks html2canvas, so it cannot observe this class of
 * defect at all. These tests cover the parsing and rewriting layer directly.
 */

/** Stands in for the browser resolver, which needs a real canvas. */
const FAKE_RESOLVED = new Map<string, string>([
  ['color-mix(in srgb, #ffffff 15%, transparent)', 'rgba(255, 255, 255, 0.15)'],
  ['color(srgb 0.4 0.49 0.92)', '#667eea'],
  ['oklch(0.7 0.1 250)', '#6a9bd1'],
  ['color-mix(in srgb, #b3261e 80%, #1a1a1a)', '#92231c'],
]);

const resolve = (value: string): string | null => FAKE_RESOLVED.get(value) ?? null;

describe('hasUnrenderableColor', () => {
  it('flags every colour function the renderer rejects', () => {
    for (const value of [
      'color-mix(in srgb, #ffffff 15%, transparent)',
      'color(srgb 0.4 0.49 0.92)',
      'oklch(0.7 0.1 250)',
      'oklab(0.7 0.1 0.2)',
      'lab(50% 40 59.5)',
      'lch(50% 40 30)',
      'hwb(194 0% 0%)',
    ]) {
      expect(hasUnrenderableColor(value), value).toBe(true);
    }
  });

  it('accepts the four functions the renderer supports, plus literals and keywords', () => {
    for (const value of [
      'rgb(102, 126, 234)',
      'rgba(255, 255, 255, 0.15)',
      'hsl(229, 76%, 66%)',
      'hsla(229, 76%, 66%, 0.5)',
      '#667eea',
      'transparent',
      'currentcolor',
      'none',
      'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    ]) {
      expect(hasUnrenderableColor(value), value).toBe(false);
    }
  });

  it('does not mistake a longer function name for a shorter one it ends with', () => {
    // oklab ends with lab and oklch ends with lch; neither may be matched as the
    // short name, and a custom property whose name merely ends in color is not a
    // colour function call at all.
    expect(hasUnrenderableColor('oklab(0.7 0.1 0.2)')).toBe(true);
    expect(hasUnrenderableColor('var(--my-color)')).toBe(false);
    expect(hasUnrenderableColor('var(--text-on-primary)')).toBe(false);
    expect(hasUnrenderableColor('')).toBe(false);
  });
});

describe('normaliseColorValue', () => {
  it('rewrites a standalone unrenderable colour into a renderable one', () => {
    expect(
      normaliseColorValue('color-mix(in srgb, #ffffff 15%, transparent)', resolve),
    ).toBe('rgba(255, 255, 255, 0.15)');
    expect(normaliseColorValue('color(srgb 0.4 0.49 0.92)', resolve)).toBe('#667eea');
  });

  it('leaves an already renderable value untouched', () => {
    for (const value of [
      'rgb(102, 126, 234)',
      'rgba(0, 0, 0, 0.4)',
      '#667eea',
      'transparent',
    ]) {
      expect(normaliseColorValue(value, resolve), value).toBe(value);
    }
  });

  it('rewrites a colour embedded in a composite value, keeping the rest intact', () => {
    // The real declarations this has to survive: a focus ring and a tinted
    // destructive hover, where the colour is one token inside a larger value.
    expect(
      normaliseColorValue(
        '0 0 0 2px color-mix(in srgb, #ffffff 15%, transparent)',
        resolve,
      ),
    ).toBe('0 0 0 2px rgba(255, 255, 255, 0.15)');

    expect(
      normaliseColorValue(
        'linear-gradient(180deg, #ffffff 0%, color-mix(in srgb, #ffffff 15%, transparent) 100%)',
        resolve,
      ),
    ).toBe('linear-gradient(180deg, #ffffff 0%, rgba(255, 255, 255, 0.15) 100%)');
  });

  it('rewrites every occurrence when one value carries several', () => {
    expect(
      normaliseColorValue(
        'color(srgb 0.4 0.49 0.92) color-mix(in srgb, #ffffff 15%, transparent)',
        resolve,
      ),
    ).toBe('#667eea rgba(255, 255, 255, 0.15)');
  });

  it('leaves a call it cannot resolve in place and keeps scanning past it', () => {
    // An unresolvable call must not abort the pass, or one unknown colour would
    // still take the whole capture down.
    expect(
      normaliseColorValue(
        'oklch(99 99 99) and color(srgb 0.4 0.49 0.92)',
        resolve,
      ),
    ).toBe('oklch(99 99 99) and #667eea');
  });

  it('terminates on an unbalanced value rather than looping', () => {
    expect(normaliseColorValue('color-mix(in srgb, #fff 15%', resolve)).toBe(
      'color-mix(in srgb, #fff 15%',
    );
  });
});

describe('CAPTURE_COLOR_PROPERTIES', () => {
  it('covers every property html2canvas reads a colour out of', () => {
    // Missing one means a colour slips through in that property and the capture
    // fails with the same generic message.
    for (const property of [
      'background-color',
      'background-image',
      'color',
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
      'outline-color',
      'text-decoration-color',
      'box-shadow',
      'text-shadow',
      '-webkit-text-stroke-color',
    ]) {
      expect(CAPTURE_COLOR_PROPERTIES, property).toContain(property);
    }
  });
});

describe('the round-trip trap', () => {
  // The first attempt at this fix resolved colours through the canvas fillStyle
  // getter. Per the HTML specification that getter serialises by CSS rules, so a
  // wide-gamut value comes back out as color(srgb ...) unchanged. The rewrite then
  // compared equal to the input, reported no change, and the whole pass became a
  // silent no-op while every capture kept failing with the same message.

  it('treats a resolver that returns a still-unrenderable value as a failure', () => {
    const roundTrip = (value: string): string => value;

    const input = 'color(srgb 1 1 1 / 0.15)';
    // Unchanged output, and crucially not a pretend success.
    expect(normaliseColorValue(input, roundTrip)).toBe(input);
    expect(hasUnrenderableColor(normaliseColorValue(input, roundTrip))).toBe(true);
  });

  it('rejects a resolver that swaps one unrenderable function for another', () => {
    const sideways = (): string => 'oklch(0.7 0.1 250)';

    expect(
      normaliseColorValue('color-mix(in srgb, #ffffff 15%, transparent)', sideways),
    ).toBe('color-mix(in srgb, #ffffff 15%, transparent)');
  });

  it('accepts a resolver that returns a genuinely renderable value', () => {
    const resolved = (): string => 'rgba(255, 255, 255, 0.15)';

    const output = normaliseColorValue(
      'color(srgb 1 1 1 / 0.15)',
      resolved,
    );
    expect(output).toBe('rgba(255, 255, 255, 0.15)');
    expect(hasUnrenderableColor(output)).toBe(false);
  });
});
