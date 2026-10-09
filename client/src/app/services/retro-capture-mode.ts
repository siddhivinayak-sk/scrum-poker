/**
 * Transient capture-mode DOM substitution for board screenshots (design Stream 5).
 *
 * `html2canvas` rasterises a `<textarea>` by reading its `value` and drawing it with
 * its own simplified text layout: it reproduces neither the control's soft wrapping
 * nor its `scrollTop` clipping, so card text spills outside the card box and scrolled
 * out content is drawn from the top. Ancestors that keep `overflow: auto` clip cards
 * that lie outside the visible scroll area on top of that.
 *
 * Capture mode therefore rewrites the board for the duration of one render:
 *
 * 1. every card text area is shadowed by a static `<div>` carrying the **complete**
 *    value, styled from the live control's own computed declarations, so the browser
 *    wraps it with its real text layout (R4.1, R4.2, R4.11, R4.12, R4.13);
 * 2. every scroll container is unclipped so nothing outside a scroll viewport is lost;
 * 3. the root is marked `data-retro-capture="true"` for capture-only CSS.
 *
 * Every step pushes exactly one undo closure onto a log that `restore()` replays in
 * reverse, which is what returns the board to its prior element count, attribute
 * values, computed styles and scroll offsets whether the capture succeeded, failed or
 * timed out (R4.3). A board with zero cards produces a log holding only the root
 * marker, and no step reads the column layout, so both layouts take the same path
 * (R4.7).
 */

import { measureLineCount } from './retro-card-height';

/** One reversible DOM change. */
export interface Mutation {
  /** Returns the element(s) this mutation touched to their pre-capture state. */
  undo(): void;
}

/** Handle returned by {@link enterCaptureMode}. */
export interface CaptureModeHandle {
  /** Replays the undo log in reverse. Safe to call more than once. */
  restore(): void;
}

/** Attribute marking the board root while a capture is in progress. */
export const CAPTURE_ROOT_ATTRIBUTE = 'data-retro-capture';

/** Class added to the static stand-in for a card text area. */
export const CAPTURE_CLONE_CLASS = 'retro-card__text--capture';

/** The live card text areas that get shadowed by a static clone. */
export const CARD_TEXT_SELECTOR = 'textarea.retro-card__text';

/** Everything that clips content behind an `overflow` viewport during a capture. */
export const SCROLL_CONTAINER_SELECTORS = [
  '.retro-board__columns',
  '.retro-column__cards',
  '.retro-card__text',
] as const;

/**
 * Average glyph advance as a fraction of the font size, used only by the DOM-free
 * wrap that sizes the clone before it is attached. Mirrors `RetroCardComponent`.
 */
const AVERAGE_CHAR_WIDTH_RATIO = 0.5;

/** Stand-in content width when the element reports no layout. */
const FALLBACK_AVAILABLE_WIDTH_PX = 200;

/** Stand-in line height when `line-height` computes to `normal`. */
const FALLBACK_LINE_HEIGHT_RATIO = 1.4;

/** Stand-in font size when `font-size` cannot be parsed. */
const FALLBACK_FONT_SIZE_PX = 13.6;

/** Parses a `<number>px` computed value. Returns `NaN` for anything else. */
function parsePx(raw: string): number {
  if (!raw.endsWith('px')) {
    return Number.NaN;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function orZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Sum of the top and bottom padding of `computed`. */
function verticalPaddingPx(computed: CSSStyleDeclaration): number {
  return orZero(parsePx(computed.paddingTop)) + orZero(parsePx(computed.paddingBottom));
}

/** Sum of the left and right padding of `computed`. */
function inlinePaddingPx(computed: CSSStyleDeclaration): number {
  return orZero(parsePx(computed.paddingLeft)) + orZero(parsePx(computed.paddingRight));
}

/** Font size of `computed`, falling back to the card text area's own `0.85rem`. */
function fontSizePx(computed: CSSStyleDeclaration): number {
  return positiveOr(parsePx(computed.fontSize), FALLBACK_FONT_SIZE_PX);
}

/** Line height of `computed`; `normal` and other keywords resolve to `1.4 × font-size`. */
function lineHeightPx(computed: CSSStyleDeclaration): number {
  return positiveOr(
    parsePx(computed.lineHeight),
    fontSizePx(computed) * FALLBACK_LINE_HEIGHT_RATIO,
  );
}

/**
 * The `padding` shorthand, recomposed from the longhands when the shorthand itself
 * computes to the empty string.
 */
function paddingDeclaration(computed: CSSStyleDeclaration): string {
  if (computed.padding !== '') {
    return computed.padding;
  }
  const longhands = [
    computed.paddingTop,
    computed.paddingRight,
    computed.paddingBottom,
    computed.paddingLeft,
  ];
  return longhands.every(part => part === '') ? '' : longhands.map(part => part || '0px').join(' ');
}

/**
 * Pure: the declarations the static clone carries, copied from the live text area.
 *
 * Font family, font size, line height and colour are reproduced verbatim so the
 * captured text matches the live board's typography (R4.12). Padding and width are
 * reproduced so each rendered line is at most the card's content width (R4.11).
 * `pre-wrap` / `anywhere` reproduce the control's own wrapping, `overflow: visible`
 * plus the supplied height let the box contain every wrapped line (R4.2, R4.13).
 */
export function captureTextStyle(
  computed: CSSStyleDeclaration,
  heightPx: number,
): Record<string, string> {
  return {
    'font-family': computed.fontFamily,
    'font-size': computed.fontSize,
    'line-height': computed.lineHeight,
    color: computed.color,
    padding: paddingDeclaration(computed),
    width: computed.width,
    'box-sizing': computed.boxSizing || 'border-box',
    display: 'block',
    margin: '0px',
    'white-space': 'pre-wrap',
    'overflow-wrap': 'anywhere',
    overflow: 'visible',
    height: `${heightPx}px`,
  };
}

/**
 * Height the clone needs to show every wrapped line: the greedy wrap's line count at
 * the live content width, times the live line height, plus the live vertical padding.
 *
 * Deliberately unclamped — the clamp that bounds the *live* card at 12 lines is what
 * makes it scroll, and a scrolling clone would clip exactly the text the capture is
 * meant to include (R4.2, R4.13).
 */
function cloneHeightPx(
  value: string,
  computed: CSSStyleDeclaration,
  contentWidthPx: number,
): number {
  const availableWidthPx = positiveOr(contentWidthPx, FALLBACK_AVAILABLE_WIDTH_PX);
  const lineCount = measureLineCount(value, {
    availableWidthPx,
    charWidthPx: fontSizePx(computed) * AVERAGE_CHAR_WIDTH_RATIO,
  });
  return lineCount * lineHeightPx(computed) + verticalPaddingPx(computed);
}

/** `root` plus its descendants matching `selector`. */
function collect<T extends HTMLElement>(root: HTMLElement, selector: string): T[] {
  const matches = Array.from(root.querySelectorAll<T>(selector));
  if (root.matches(selector)) {
    matches.unshift(root as unknown as T);
  }
  return matches;
}

/** Restores an inline declaration to the exact string it held, removing it when empty. */
function writeInline(element: HTMLElement, property: string, value: string): void {
  if (value === '') {
    element.style.removeProperty(property);
  } else {
    element.style.setProperty(property, value);
  }
}

/**
 * Step 1: shadow every card text area with a static, fully styled `<div>` sibling and
 * hide the control itself.
 */
function substituteCardText(root: HTMLElement, log: Mutation[]): void {
  for (const textArea of collect<HTMLTextAreaElement>(root, CARD_TEXT_SELECTOR)) {
    const parent = textArea.parentNode;
    if (!parent) {
      continue;
    }

    const computed = getComputedStyle(textArea);
    const scrollTop = textArea.scrollTop;
    const scrollLeft = textArea.scrollLeft;
    const inlineDisplay = textArea.style.display;
    const contentWidthPx = textArea.clientWidth - inlinePaddingPx(computed);

    const clone = document.createElement('div');
    clone.className = `retro-card__text ${CAPTURE_CLONE_CLASS}`;
    // `textContent` of the full value, never the clipped rendering (R4.2).
    clone.textContent = textArea.value;
    const declarations = captureTextStyle(
      computed,
      cloneHeightPx(textArea.value, computed, contentWidthPx),
    );
    for (const [property, value] of Object.entries(declarations)) {
      if (value !== '') {
        clone.style.setProperty(property, value);
      }
    }

    parent.insertBefore(clone, textArea.nextSibling);
    textArea.style.setProperty('display', 'none');

    log.push({
      undo: () => {
        clone.remove();
        writeInline(textArea, 'display', inlineDisplay);
        textArea.scrollTop = scrollTop;
        textArea.scrollLeft = scrollLeft;
      },
    });
  }
}

/**
 * Step 2: unclip every scroll container so content outside a scroll viewport is laid
 * out, and record the five values needed to put each one back.
 *
 * The clones inserted by step 1 carry `.retro-card__text` as well, so they are skipped
 * here — their height is what contains the wrapped text (R4.13).
 */
function unclipScrollContainers(root: HTMLElement, log: Mutation[]): void {
  const containers = collect<HTMLElement>(root, SCROLL_CONTAINER_SELECTORS.join(', '));

  for (const container of containers) {
    if (container.classList.contains(CAPTURE_CLONE_CLASS)) {
      continue;
    }

    const overflow = container.style.overflow;
    const maxHeight = container.style.maxHeight;
    const height = container.style.height;
    const scrollTop = container.scrollTop;
    const scrollLeft = container.scrollLeft;

    container.style.setProperty('overflow', 'visible');
    container.style.setProperty('max-height', 'none');
    container.style.setProperty('height', 'auto');

    log.push({
      undo: () => {
        writeInline(container, 'overflow', overflow);
        writeInline(container, 'max-height', maxHeight);
        writeInline(container, 'height', height);
        container.scrollTop = scrollTop;
        container.scrollLeft = scrollLeft;
      },
    });
  }
}

/**
 * Colour functions the renderer cannot parse.
 *
 * html2canvas 1.4.1 carries a SUPPORTED_COLOR_FUNCTIONS table holding exactly rgb,
 * rgba, hsl and hsla, and it throws on any other function name. Chrome serialises a
 * computed color-mix() into the color(srgb ...) form, and every wide-gamut space
 * serialises as its own function, so a single such declaration anywhere inside the
 * captured subtree aborts the whole capture rather than degrading that one colour.
 */
const UNRENDERABLE_COLOR_FUNCTIONS = [
  'color-mix',
  'oklch',
  'oklab',
  'color',
  'lch',
  'lab',
  'hwb',
] as const;

/** Computed properties html2canvas reads a colour out of. */
export const CAPTURE_COLOR_PROPERTIES = [
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
] as const;

/** True when `raw` names a colour function the renderer would reject. */
export function hasUnrenderableColor(raw: string): boolean {
  return findUnrenderableCall(raw, 0) !== null;
}

/** Identifier characters, used so oklab( is not matched as lab(. */
function isIdentifierChar(character: string): boolean {
  return /[-A-Za-z0-9_]/.test(character);
}

/**
 * Locates the next unrenderable colour call at or after `from`, returning its name
 * bounds and the index just past its balanced closing parenthesis.
 */
function findUnrenderableCall(
  raw: string,
  from: number,
): { start: number; end: number } | null {
  for (let index = from; index < raw.length; index += 1) {
    if (raw[index] !== '(') {
      continue;
    }
    for (const name of UNRENDERABLE_COLOR_FUNCTIONS) {
      const start = index - name.length;
      if (start < 0 || raw.slice(start, index) !== name) {
        continue;
      }
      // A preceding identifier character means this is a longer name, so the
      // lab of oklab and the color of  --my-color are both skipped.
      if (start > 0 && isIdentifierChar(raw[start - 1])) {
        continue;
      }
      let depth = 0;
      for (let scan = index; scan < raw.length; scan += 1) {
        if (raw[scan] === '(') {
          depth += 1;
        } else if (raw[scan] === ')') {
          depth -= 1;
          if (depth === 0) {
            return { start, end: scan + 1 };
          }
        }
      }
      // Unbalanced value: nothing safe to rewrite.
      return null;
    }
  }
  return null;
}

/** Lazily created scratch context used to resolve colours. */
let conversionContext: CanvasRenderingContext2D | null | undefined;

function colorConversionContext(): CanvasRenderingContext2D | null {
  if (conversionContext === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    conversionContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  return conversionContext;
}

/** Serialises one opaque or translucent pixel as a function the renderer parses. */
function rgbaLiteral(red: number, green: number, blue: number, alpha: number): string {
  if (alpha >= 255) {
    return 'rgb(' + red + ', ' + green + ', ' + blue + ')';
  }
  const opacity = Math.round((alpha / 255) * 1000) / 1000;
  return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + opacity + ')';
}

/**
 * Resolves any colour the browser itself can parse into an rgb() or rgba() literal,
 * or returns null when it cannot be resolved.
 *
 * The fillStyle getter is deliberately NOT used to produce the result. Per the HTML
 * specification it serialises the current colour by CSS rules, so a wide-gamut value
 * comes back out as color(srgb ...) - precisely the form the renderer rejects - and a
 * round trip through it changes nothing while appearing to succeed. The colour is
 * therefore rasterised into a single pixel and read back as bytes, which can only be
 * integers and so can always be written as rgb() or rgba().
 *
 * The getter is still used for parse detection: the setter ignores a value it cannot
 * parse, leaving the previous one in place, so the value is applied over two
 * different seeds. Agreeing results mean it parsed, differing results mean both
 * assignments were ignored.
 */
export function toRenderableColor(value: string): string | null {
  const context = colorConversionContext();
  if (!context) {
    return null;
  }

  context.fillStyle = '#000000';
  context.fillStyle = value;
  const overBlack = context.fillStyle;
  context.fillStyle = '#ffffff';
  context.fillStyle = value;
  const overWhite = context.fillStyle;
  if (typeof overBlack !== 'string' || overBlack !== overWhite) {
    return null;
  }

  try {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return rgbaLiteral(pixel[0], pixel[1], pixel[2], pixel[3]);
  } catch {
    // getImageData can be refused, for instance by anti-fingerprinting measures.
    // Fall back to the serialised form, which is still an improvement whenever it
     // happens to be a legacy colour the renderer accepts.
    return hasUnrenderableColor(overBlack) ? null : overBlack;
  }
}

/**
 * Rewrites every unrenderable colour call inside a possibly composite value, so a
 * gradient or a box-shadow is normalised in place rather than discarded.
 *
 * `resolve` defaults to the browser-backed resolver and is injectable so the pure
 * rewriting logic can be exercised without a canvas.
 *
 * Returns `raw` unchanged when nothing needed rewriting or a call could not be
 * resolved, which keeps the caller from recording a pointless mutation.
 */
export function normaliseColorValue(
  raw: string,
  resolve: (value: string) => string | null = toRenderableColor,
): string {
  let result = raw;
  let cursor = 0;

  for (;;) {
    const call = findUnrenderableCall(result, cursor);
    if (!call) {
      return result;
    }
    const original = result.slice(call.start, call.end);
    const resolved = resolve(original);
    // A resolver that hands back a value still carrying an unrenderable function
     // has not resolved anything. Treating that as success is what made an earlier
     // version of this a silent no-op, so it counts as a failure here.
    if (resolved === null || hasUnrenderableColor(resolved)) {
      // Leave it alone and keep scanning past it.
      cursor = call.end;
      continue;
    }
    result = result.slice(0, call.start) + resolved + result.slice(call.end);
    cursor = call.start + resolved.length;
  }
}

/**
 * Step 3: pin every colour the renderer cannot parse to an equivalent it can.
 *
 * Runs after the card clones exist so they are normalised too, and writes the
 * resolved value inline. Each write records the prior inline string, so restore()
 * removes the override and leaves the authored stylesheet in charge again (R4.3).
 */
function normaliseColors(root: HTMLElement, log: Mutation[]): void {
  const unresolved: { property: string; value: string }[] = [];

  for (const element of collect<HTMLElement>(root, '*')) {
    const computed = getComputedStyle(element);

    for (const property of CAPTURE_COLOR_PROPERTIES) {
      const computedValue = computed.getPropertyValue(property);
      if (computedValue === '' || !hasUnrenderableColor(computedValue)) {
        continue;
      }
      const normalised = normaliseColorValue(computedValue);
      if (normalised === computedValue) {
        unresolved.push({ property, value: computedValue });
        continue;
      }

      const inlineValue = element.style.getPropertyValue(property);
      element.style.setProperty(property, normalised);
      log.push({ undo: () => writeInline(element, property, inlineValue) });
    }
  }

  if (unresolved.length > 0) {
    // The renderer aborts on the first one it meets, so anything left here is a
     // capture failure waiting to happen and is worth naming precisely.
    console.warn(
      'Board capture: ' + unresolved.length + ' colour declaration(s) could not be',
      'converted to a renderable form:',
      unresolved,
    );
  }
}

/** Step 4: mark the root so capture-only CSS applies. */
function markRoot(root: HTMLElement, log: Mutation[]): void {
  const previous = root.getAttribute(CAPTURE_ROOT_ATTRIBUTE);
  root.setAttribute(CAPTURE_ROOT_ATTRIBUTE, 'true');

  log.push({
    undo: () => {
      if (previous === null) {
        root.removeAttribute(CAPTURE_ROOT_ATTRIBUTE);
      } else {
        root.setAttribute(CAPTURE_ROOT_ATTRIBUTE, previous);
      }
    },
  });
}

/**
 * Swap every card text area for a styled static `<div>`, unclip the scroll containers,
 * mark the root, and record one undo closure per mutation.
 *
 * The returned `restore()` replays that log in reverse, so the board ends up with the
 * element count, attribute values, computed styles and scroll offsets it held
 * immediately before the call (R4.3).
 */
export function enterCaptureMode(root: HTMLElement): CaptureModeHandle {
  const log: Mutation[] = [];

  substituteCardText(root, log);
  unclipScrollContainers(root, log);
  normaliseColors(root, log);
  markRoot(root, log);

  let restored = false;
  return {
    restore: () => {
      if (restored) {
        return;
      }
      restored = true;
      for (let index = log.length - 1; index >= 0; index -= 1) {
        log[index].undo();
      }
      log.length = 0;
    },
  };
}
