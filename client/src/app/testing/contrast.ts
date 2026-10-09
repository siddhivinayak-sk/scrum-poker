/**
 * WCAG 2.1 contrast helpers for tests.
 *
 * The client test environment performs no layout and computes no CSS custom
 * properties, so contrast criteria cannot be asserted against live computed
 * styles. These pure functions operate on the *declared* colour values taken
 * from the design-token table instead, letting specs prove contrast criteria
 * (R7.4, R7.14, R10.6, R11.8) without a renderer.
 *
 * Pure module: no Angular imports, no DOM access, no shared mutable state.
 */

/** Minimum contrast ratio for normal body text at WCAG 2.1 Level AA. */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

/**
 * Minimum contrast ratio for large text, focus indicators, and other
 * non-text user-interface components at WCAG 2.1 Level AA.
 */
export const WCAG_AA_NON_TEXT_CONTRAST = 3;

/** An sRGB colour as red, green and blue channels, each in the range 0–1. */
export type SrgbChannels = readonly [number, number, number];

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FUNCTIONAL =
  /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*(?:[,/]\s*[0-9.%]+\s*)?\)$/i;

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

/**
 * Parse a declared colour value into sRGB channels in the range 0–1.
 *
 * Accepts `#rgb`, `#rrggbb`, `rgb(r, g, b)` and `rgba(r, g, b, a)`. The alpha
 * component of a functional notation is ignored: contrast is always computed
 * against the opaque colour, which is how the token table declares them.
 *
 * @throws Error when the value is not a supported opaque colour notation.
 */
export function parseColor(value: string): SrgbChannels {
  const trimmed = value.trim();

  const short = HEX_SHORT.exec(trimmed);
  if (short) {
    return [
      parseInt(`${short[1]}${short[1]}`, 16) / 255,
      parseInt(`${short[2]}${short[2]}`, 16) / 255,
      parseInt(`${short[3]}${short[3]}`, 16) / 255,
    ];
  }

  const long = HEX_LONG.exec(trimmed);
  if (long) {
    return [
      parseInt(long[1], 16) / 255,
      parseInt(long[2], 16) / 255,
      parseInt(long[3], 16) / 255,
    ];
  }

  const functional = RGB_FUNCTIONAL.exec(trimmed);
  if (functional) {
    return [
      clamp01(Number(functional[1]) / 255),
      clamp01(Number(functional[2]) / 255),
      clamp01(Number(functional[3]) / 255),
    ];
  }

  throw new Error(
    `Unsupported colour value: "${value}". Expected #rgb, #rrggbb, rgb() or rgba().`,
  );
}

/** Format sRGB channels (0–1 each) back into a `#rrggbb` string. */
export function formatHex(channels: SrgbChannels): string {
  return `#${channels
    .map((channel) =>
      Math.round(clamp01(channel) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Linearise one sRGB channel (0–1) per the WCAG 2.1 definition. */
export function linearizeChannel(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance of a declared colour value per WCAG 2.1, in the range
 * 0 (black) through 1 (white).
 */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/**
 * Contrast ratio between two declared colour values per WCAG 2.1.
 *
 * The result is always at least 1 (identical colours) and at most 21
 * (black against white), and is symmetric in its arguments.
 */
export function wcagContrastRatio(colorA: string, colorB: string): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether two declared colour values reach the given minimum contrast ratio.
 *
 * @param minimum Defaults to the Level AA body-text threshold of 4.5:1.
 */
export function meetsContrastRatio(
  colorA: string,
  colorB: string,
  minimum: number = WCAG_AA_TEXT_CONTRAST,
): boolean {
  return wcagContrastRatio(colorA, colorB) >= minimum;
}

/**
 * Mix two declared colour values in sRGB space, mirroring CSS
 * `color-mix(in srgb, colorA <ratio>%, colorB)`.
 *
 * @param ratioOfA Weight of `colorA` in the range 0–1; the remainder is `colorB`.
 */
export function mixColors(
  colorA: string,
  colorB: string,
  ratioOfA: number,
): string {
  const weightA = clamp01(ratioOfA);
  const [ar, ag, ab] = parseColor(colorA);
  const [br, bg, bb] = parseColor(colorB);
  return formatHex([
    ar * weightA + br * (1 - weightA),
    ag * weightA + bg * (1 - weightA),
    ab * weightA + bb * (1 - weightA),
  ]);
}

/**
 * Mix a declared colour value with white, as the card gradients and tinted
 * surfaces do via `color-mix(in srgb, <accent> <ratio>%, #ffffff)`.
 *
 * @param ratio Weight of `color` in the range 0–1; the remainder is white.
 */
export function mixWithWhite(color: string, ratio: number): string {
  return mixColors(color, '#ffffff', ratio);
}
