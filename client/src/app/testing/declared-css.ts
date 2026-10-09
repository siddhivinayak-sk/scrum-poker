/**
 * Declared-CSS helpers for tests.
 *
 * The client test runner performs no layout: no box is measured, no custom
 * property is resolved and every `getComputedStyle` read echoes the authored
 * value back. Criteria phrased in rendered pixels therefore have to be asserted
 * against the *declaration* a component ships instead.
 *
 * These functions parse a compiled component's `styles` blocks into flat rules
 * — selector list, declarations, enclosing at-rule — and expose them by
 * selector, so a spec can ask "what `max-height` does `.retro-toolbar` declare
 * below 768px?" and then do arithmetic over the answer.
 *
 * Pure module: no Angular imports beyond the compiled-definition shape it
 * reads, no test-framework import, no DOM access. Failures surface as thrown
 * `Error`s naming the missing selector or property, which the calling spec
 * reports as an ordinary test failure.
 */

/** Shape of the compiled component definition these helpers read. */
interface StyledComponentDef {
  readonly styles: readonly string[];
}

/** One flattened style rule, with the media query it sits inside (if any). */
export interface CssRule {
  /** Canonical selectors: the component-scoping attributes removed. */
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
  /** Normalised at-rule prelude, or `null` for a top-level rule. */
  readonly media: string | null;
}

/** Media-query needles, matched against the normalised at-rule prelude. */
export const MOBILE_MEDIA = 'max-width: 767px';
export const REDUCED_MOTION_MEDIA = 'prefers-reduced-motion: reduce';

/** Browsers resolve `rem` against the root font size, which the app leaves at 16px. */
export const ROOT_FONT_SIZE_PX = 16;

function compiledStyles(component: unknown): readonly string[] {
  const styles = (component as { readonly ɵcmp?: StyledComponentDef }).ɵcmp?.styles;
  if (styles === undefined) {
    throw new Error('not a compiled Angular component, or it declares no styles');
  }
  return styles;
}

/**
 * Collapses whitespace, drops comments and the `@charset` the compiler prepends,
 * and tightens the block punctuation so the brace walk below sees a flat string.
 * Spacing *inside* declarations and media preludes is left alone, so values stay
 * readable in failure output.
 */
export function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/@charset[^;]*;/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([;{}])\s*/g, '$1')
    .trim();
}

/** Index of the `}` closing the block that opens at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') {
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return css.length - 1;
}

/**
 * Undoes the compiler's view encapsulation so a rule can be queried by the
 * selector as authored: `.foo[_ngcontent-%COMP%]` reads back as `.foo`, and the
 * compound carrying `[_nghost-%COMP%]` reads back with its `:host` prefix
 * (`[_nghost-%COMP%]` → `:host`, `.x[_nghost-%COMP%]` → `:host.x`). `::ng-deep`
 * is already gone from the compiled output, so `:host ::ng-deep *` arrives as
 * `:host *`.
 */
export function canonicalSelector(selector: string): string {
  const HOST_MARK = '\u0001';
  return selector
    .replace(/\[_nghost[^\]]*\]/g, HOST_MARK)
    .replace(/\[_ngcontent[^\]]*\]/g, '')
    .trim()
    .split(/\s+/)
    .map(compound =>
      compound.includes(HOST_MARK)
        ? `:host${compound.split(HOST_MARK).join('')}`
        : compound,
    )
    .join(' ')
    .trim();
}

function parseDeclarations(body: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const fragment of body.split(';')) {
    const separator = fragment.indexOf(':');
    if (separator === -1) {
      continue;
    }
    declarations.set(
      fragment.slice(0, separator).trim(),
      fragment.slice(separator + 1).trim(),
    );
  }
  return declarations;
}

function parseRules(css: string, media: string | null, out: CssRule[]): void {
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) {
      return;
    }
    const close = matchingBrace(css, open);
    const prelude = css.slice(cursor, open).trim();
    const body = css.slice(open + 1, close);

    if (prelude.startsWith('@')) {
      parseRules(body, prelude, out);
    } else if (prelude.length > 0) {
      out.push({
        selectors: prelude.split(',').map(canonicalSelector),
        declarations: parseDeclarations(body),
        media,
      });
    }
    cursor = close + 1;
  }
}

const ruleCache = new Map<unknown, readonly CssRule[]>();

/** Every rule a component declares, in source order, media rules included. */
export function rulesOf(component: unknown): readonly CssRule[] {
  const cached = ruleCache.get(component);
  if (cached) {
    return cached;
  }
  const rules: CssRule[] = [];
  parseRules(normalizeCss(compiledStyles(component).join('\n')), null, rules);
  ruleCache.set(component, rules);
  return rules;
}

/**
 * The declarations a component applies to `selector`, cascaded in source order.
 *
 * Without `mediaNeedle` only top-level rules are read — the layout at 768px and
 * above. With one, the matching media rules are merged on top of the top-level
 * ones, which is what the narrower viewport resolves to.
 */
export function stylesFor(
  component: unknown,
  selector: string,
  mediaNeedle?: string,
): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rulesOf(component)) {
    if (rule.media !== null) {
      if (mediaNeedle === undefined || !rule.media.includes(mediaNeedle)) {
        continue;
      }
    }
    if (!rule.selectors.includes(selector)) {
      continue;
    }
    for (const [property, value] of rule.declarations) {
      merged.set(property, value);
    }
  }
  return merged;
}

/** A declared value, or a throw naming what was missing. */
export function declared(
  component: unknown,
  selector: string,
  property: string,
  mediaNeedle?: string,
): string {
  const value = stylesFor(component, selector, mediaNeedle).get(property);
  if (value === undefined) {
    const scope = mediaNeedle === undefined ? '' : ` within (${mediaNeedle})`;
    throw new Error(`${selector} declares no ${property}${scope}`);
  }
  return value;
}

/** A declared length in px. `rem` is resolved against the untouched root size. */
export function toPx(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '0') {
    return 0;
  }
  if (trimmed.endsWith('px')) {
    return Number.parseFloat(trimmed);
  }
  if (trimmed.endsWith('rem')) {
    return Number.parseFloat(trimmed) * ROOT_FONT_SIZE_PX;
  }
  throw new Error(`not a declared length: "${value}"`);
}

export interface EdgesPx {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Resolves a 1–4 value box shorthand (`padding`, `margin`) into its four edges. */
export function edgesPx(shorthand: string): EdgesPx {
  const parts = shorthand.trim().split(/\s+/).map(toPx);
  const [a, b = a, c = a, d = b] = parts;
  return { top: a, right: b, bottom: c, left: d };
}

/** The width of a `border` shorthand: its first length token. */
export function borderWidthPx(shorthand: string): number {
  const token = shorthand
    .trim()
    .split(/\s+/)
    .find(candidate => /^[\d.]+(px|rem)$/.test(candidate));
  if (token === undefined) {
    throw new Error(`no border width in "${shorthand}"`);
  }
  return toPx(token);
}

/** `font-size` x unitless `line-height`: the declared line box of a text element. */
export function lineBoxPx(
  component: unknown,
  selector: string,
  mediaNeedle?: string,
): number {
  const fontSizePx = toPx(declared(component, selector, 'font-size', mediaNeedle));
  const lineHeight = Number.parseFloat(
    declared(component, selector, 'line-height', mediaNeedle),
  );
  if (!Number.isFinite(lineHeight)) {
    throw new Error(`${selector} declares a non-numeric line-height`);
  }
  return fontSizePx * lineHeight;
}
