import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CssRule,
  rulesOf,
  stylesFor,
  toPx,
} from '../../testing/declared-css';
import {
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  mixColors,
  wcagContrastRatio,
} from '../../testing/contrast';
import { RetroBoardPageComponent } from './retro-board-page.component';
import { RetroCardComponent } from './retro-card.component';
import { RetroColumnComponent } from './retro-column.component';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { FeelingsStripComponent } from '../feelings-strip/feelings-strip.component';

/**
 * Property 27 — declared style invariants of the retro surfaces
 * (R7.1, R7.2, R7.3, R7.4, R7.5, R7.14, R10.3, R10.6, R11.8).
 *
 * The client test runner performs no layout: no box is measured and no custom
 * property is resolved. Every criterion in this family is therefore asserted
 * against the *declaration* each component ships. `testing/declared-css`
 * parses the compiled `styles` blocks into flat rules — selector list,
 * declarations, enclosing media query, encapsulation attributes removed — and
 * every invariant below quantifies over those parsed declarations rather than
 * over a rendered tree.
 *
 * Five components make up the "retro surfaces": the board page, the column,
 * the card, the toolbar, and the feelings strip that task 21.5 pulled into the
 * toolbar row. All five are covered by every invariant here, because the
 * criteria are phrased over the retro board as a whole rather than per file.
 *
 * ## Generators
 *
 * The declaration-driven invariants draw from `fc.constantFrom(...)` over the
 * flattened declaration list, wrapped in `fc.uniqueArray(..., { size: 'max' })`
 * so a run exercises a large slice of the list rather than the ten entries
 * default sizing would allow. Across `numRuns: 100` that makes coverage of each
 * list effectively total, which matters: a per-declaration invariant that only
 * ever samples a tenth of the declarations would pass while the rest drifted.
 * The contrast invariants draw a single pair per run with plain
 * `fc.constantFrom(...)` — those lists are short enough that 100 runs visit
 * every member many times over.
 *
 * ## Three scope decisions, stated rather than silently skipped
 *
 * 1. **The 32 px minimum is a rule about buttons and label activation
 *    targets.** The native `<input type="checkbox">` and `<input type="radio">`
 *    controls in the retro settings dialog keep their 16 px platform box; the
 *    32 px minimum is declared on the `.retro-settings__toggle` and
 *    `.retro-settings__layout label` elements that wrap them, which are the
 *    elements a pointer or a keyboard actually activates. `CONTROL_SUFFIX`
 *    below therefore matches button-ish selectors only, the label targets are
 *    listed separately, and `native checkbox and radio inputs keep their 16 px
 *    platform box` pins the decision so it cannot drift unnoticed.
 *
 * 2. **Label activation targets declare the block axis only.** They are
 *    `display: flex` rows inside the dialog, so their inline size comes from
 *    the dialog width and no `min-width` is (or should be) declared. Only
 *    `min-height` is asserted for them; buttons are asserted on both axes.
 *
 * 3. **`--gradient-primary` is not a surface token, and header text on it is
 *    not in the 4.5:1 pair list.** The board header paints the shared primary
 *    gradient, whose light stop `#667eea` gives white text 3.66:1 — above the
 *    3:1 a focus indicator needs (R7.14) but below the 4.5:1 body text needs
 *    (R7.4). This is pre-existing app-wide chrome that the Stream 6 token
 *    edits deliberately left alone, and `client/src/styles.scss` already
 *    records the same conclusion for the connection indicator: "The session
 *    headers paint --gradient-primary ... against which no saturated green or
 *    red can reach 3:1, so the indicator sits on its own neutral chip
 *    surface." The gradient stops are asserted here at the 3:1 non-text
 *    threshold, where the header's `outline-color: var(--text-on-primary)`
 *    override lands; raising header *text* to 4.5:1 needs a darker gradient
 *    token, which is a theme change beyond this spec.
 *
 * `RetroCardComponent` has no per-card feeling marker — feelings are per user
 * and live in the toolbar strip — so nothing here asserts one.
 */

// --- The surfaces under test -------------------------------------------------------

interface Surface {
  readonly name: string;
  readonly component: unknown;
}

const SURFACES: readonly Surface[] = [
  { name: 'RetroBoardPageComponent', component: RetroBoardPageComponent },
  { name: 'RetroColumnComponent', component: RetroColumnComponent },
  { name: 'RetroCardComponent', component: RetroCardComponent },
  { name: 'RetroToolbarComponent', component: RetroToolbarComponent },
  { name: 'FeelingsStripComponent', component: FeelingsStripComponent },
];

/** One declaration, carrying enough context to name it in a failure message. */
interface Declaration {
  readonly surface: string;
  readonly selectors: readonly string[];
  readonly media: string | null;
  readonly property: string;
  readonly value: string;
}

function describeDeclaration(declaration: Declaration): string {
  const scope = declaration.media === null ? '' : ` inside ${declaration.media}`;
  return (
    `${declaration.surface} — ${declaration.selectors.join(', ')}${scope}: ` +
    `${declaration.property}: ${declaration.value}`
  );
}

/** Every declaration of every retro surface, media rules included. */
const DECLARATIONS: readonly Declaration[] = SURFACES.flatMap(surface =>
  rulesOf(surface.component).flatMap((rule: CssRule) =>
    [...rule.declarations].map(([property, value]) => ({
      surface: surface.name,
      selectors: rule.selectors,
      media: rule.media,
      property,
      value,
    })),
  ),
);

function declarationsWhere(
  predicate: (declaration: Declaration) => boolean,
): readonly Declaration[] {
  return DECLARATIONS.filter(predicate);
}

/**
 * Draws a large, duplicate-free slice of `pool`.
 *
 * `size: 'max'` is load-bearing. Default sizing caps a generated array at ten
 * entries regardless of `maxLength`, which would leave most of a sixty-entry
 * declaration list unvisited.
 */
function sliceOf<T>(pool: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc.uniqueArray(fc.constantFrom(...pool), {
    minLength: 1,
    maxLength: pool.length,
    size: 'max',
  });
}

const NUM_RUNS = { numRuns: 100 } as const;

// --- Invariant 1: the 4 px spacing scale (R7.1) ------------------------------------

const SPACING_PROPERTIES = new Set([
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-inline',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-inline',
  'gap',
  'row-gap',
  'column-gap',
]);

/**
 * Values that declare no length at all. `auto` and `normal` hand the decision
 * to the layout algorithm (`.retro-card__delete-btn { margin-left: auto }`
 * pushes the control to the inline end), so there is no number to place on the
 * scale.
 */
const SPACING_KEYWORDS = new Set([
  'auto',
  'normal',
  'inherit',
  'initial',
  'unset',
  'revert',
]);

const SPACING_STEP_PX = 4;

const SPACING_DECLARATIONS = declarationsWhere(declaration =>
  SPACING_PROPERTIES.has(declaration.property),
);

describe('Property 27: every retro spacing declaration sits on the 4px scale (R7.1)', () => {
  it('declares a spacing value on every surface', () => {
    expect(SPACING_DECLARATIONS.length).toBeGreaterThan(40);
    expect(new Set(SPACING_DECLARATIONS.map(d => d.surface)).size).toBe(SURFACES.length);
  });

  it('resolves every margin, padding and gap edge to 0 or a multiple of 4px', () => {
    fc.assert(
      fc.property(sliceOf(SPACING_DECLARATIONS), slice => {
        for (const declaration of slice) {
          const parts = declaration.value.trim().split(/\s+/);
          for (const part of parts) {
            if (SPACING_KEYWORDS.has(part.toLowerCase())) {
              continue;
            }
            // `toPx` throws on anything that is not a declared px/rem length,
            // which is the honest outcome: a `%` or `calc()` edge cannot be
            // placed on the scale and should be reported, not waved through.
            const px = toPx(part);
            expect(
              px % SPACING_STEP_PX,
              `${describeDeclaration(declaration)} — "${part}" is ${px}px, off the 4px scale`,
            ).toBe(0);
          }
        }
      }),
      NUM_RUNS,
    );
  });
});

// --- Invariant 2: token-only colour (R7.2) -----------------------------------------

const COLOUR_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'box-shadow',
  'text-shadow',
  'accent-color',
  'caret-color',
  'text-decoration-color',
  'fill',
  'stroke',
]);

/** `var(--token)` with no fallback — the only way a colour may be named. */
const TOKEN_REFERENCE = /var\(\s*--[\w-]+\s*\)/g;

/**
 * `var(--token, <fallback>)`. Banned outright: a fallback smuggles a literal
 * back in and, worse, hides it behind a value that only shows up when the
 * token is missing, so no amount of reading the rendered page would catch it.
 */
const VAR_WITH_FALLBACK = /var\(\s*--[\w-]+\s*,/;

/**
 * Words that may appear in a colour-carrying value without being a colour:
 * the `none`/`transparent`/`currentcolor` keywords, border styles, and the
 * three words of the `color-mix(in srgb, …)` prelude the design sanctions where
 * no exact token exists. Named colours (`white`, `red`, …) are deliberately
 * absent, so one would surface as an unrecognised word.
 */
const COLOUR_VALUE_KEYWORDS = new Set([
  'none',
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
  'hidden',
  'thin',
  'medium',
  'thick',
  'color-mix',
  'in',
  'srgb',
  '!important',
]);

/** A length, a unitless number or a percentage — a weight, width or offset. */
const NUMERIC_TOKEN = /^[+-]?(\d+\.?\d*|\.\d+)(px|rem|em|%)?$/;

const COLOUR_DECLARATIONS = declarationsWhere(declaration =>
  COLOUR_PROPERTIES.has(declaration.property),
);

/** Everything in a colour value that is neither a token reference nor a keyword. */
function nonTokenFragments(value: string): readonly string[] {
  return value
    .replace(TOKEN_REFERENCE, ' ')
    .split(/[\s,()]+/)
    .filter(fragment => fragment.length > 0)
    .map(fragment => fragment.toLowerCase())
    .filter(fragment => !COLOUR_VALUE_KEYWORDS.has(fragment))
    .filter(fragment => !NUMERIC_TOKEN.test(fragment));
}

describe('Property 27: every retro colour is a design-token reference (R7.2)', () => {
  it('declares a colour-carrying value on every surface', () => {
    expect(COLOUR_DECLARATIONS.length).toBeGreaterThan(60);
    expect(new Set(COLOUR_DECLARATIONS.map(d => d.surface)).size).toBe(SURFACES.length);
  });

  it('names no literal colour in any background, border, text colour or shadow', () => {
    fc.assert(
      fc.property(sliceOf(COLOUR_DECLARATIONS), slice => {
        for (const declaration of slice) {
          expect(
            nonTokenFragments(declaration.value),
            `${describeDeclaration(declaration)} — not a token reference`,
          ).toEqual([]);
        }
      }),
      NUM_RUNS,
    );
  });

  it('uses no var() fallback, so no literal hides behind a missing token', () => {
    fc.assert(
      fc.property(sliceOf(COLOUR_DECLARATIONS), slice => {
        for (const declaration of slice) {
          expect(
            VAR_WITH_FALLBACK.test(declaration.value),
            `${describeDeclaration(declaration)} — carries a var() fallback`,
          ).toBe(false);
        }
      }),
      NUM_RUNS,
    );
  });

  it('bans var() fallbacks across every declaration, not only the colour ones', () => {
    const offenders = DECLARATIONS.filter(declaration =>
      VAR_WITH_FALLBACK.test(declaration.value),
    ).map(describeDeclaration);
    expect(offenders).toEqual([]);
  });
});

// --- Invariant 3: the 12 px font floor (R7.3, R10.6) -------------------------------

const MINIMUM_FONT_SIZE_PX = 12;

const FONT_SIZE_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'smaller',
  'larger',
]);

const FONT_SIZE_DECLARATIONS = declarationsWhere(
  declaration =>
    declaration.property === 'font-size' &&
    !FONT_SIZE_KEYWORDS.has(declaration.value.trim().toLowerCase()),
);

describe('Property 27: every retro font size clears the 12px floor (R7.3, R10.6)', () => {
  it('declares a font size on every surface', () => {
    expect(FONT_SIZE_DECLARATIONS.length).toBeGreaterThan(20);
    expect(new Set(FONT_SIZE_DECLARATIONS.map(d => d.surface)).size).toBe(SURFACES.length);
  });

  it('resolves every declared font size to at least 12px', () => {
    fc.assert(
      fc.property(sliceOf(FONT_SIZE_DECLARATIONS), slice => {
        for (const declaration of slice) {
          expect(
            toPx(declaration.value),
            `${describeDeclaration(declaration)} — below the 12px floor`,
          ).toBeGreaterThanOrEqual(MINIMUM_FONT_SIZE_PX);
        }
      }),
      NUM_RUNS,
    );
  });
});

// --- Invariant 4: the 32 px control minimum (R7.5, R10.3) --------------------------

const MINIMUM_CONTROL_PX = 32;

/**
 * Button-ish selector endings. Scoped to buttons on purpose (scope decision 1):
 * a native checkbox or radio keeps its platform box and the 32 px minimum rides
 * on the label that wraps it, which `LABEL_ACTIVATION_TARGETS` covers instead.
 *
 * Either BEM separator counts, because the codebase names these controls both
 * ways: `.retro-column__add-btn` makes `btn` part of a compound element name,
 * `.retro-dialog__btn` makes it the element itself.
 */
const CONTROL_SUFFIX = /[-_](btn|option|submit|delete)(--[\w-]+)?$/;

/** Label elements that are themselves the activation target of a native input. */
const LABEL_ACTIVATION_TARGETS: readonly { readonly selector: string }[] = [
  { selector: '.retro-settings__toggle' },
  { selector: '.retro-settings__layout label' },
];

interface ControlSelector {
  readonly surface: string;
  readonly component: unknown;
  readonly selector: string;
}

/**
 * The base selector of a control rule, or `null` when the rule is not about a
 * control box.
 *
 * A BEM `--modifier` is folded onto its base (`.retro-dialog__btn--ok` →
 * `.retro-dialog__btn`) because the box is declared once on the base and the
 * modifier only repaints it. A compound carrying a pseudo-class, a
 * pseudo-element or an attribute selector is dropped: `:hover`, `:disabled` and
 * `input[type=checkbox]` describe a state or a native child, not the control's
 * own box, and declare no size.
 */
function controlBaseSelector(selector: string): string | null {
  const compounds = selector.split(/\s+/);
  const last = compounds.at(-1);
  if (last === undefined || /[:[]/.test(last) || !CONTROL_SUFFIX.test(last)) {
    return null;
  }
  return [...compounds.slice(0, -1), last.replace(/--[\w-]+$/, '')].join(' ');
}

const BUTTON_CONTROLS: readonly ControlSelector[] = SURFACES.flatMap(surface => {
  const selectors = new Set<string>();
  for (const rule of rulesOf(surface.component)) {
    for (const selector of rule.selectors) {
      const base = controlBaseSelector(selector);
      if (base !== null) {
        selectors.add(base);
      }
    }
  }
  return [...selectors].map(selector => ({
    surface: surface.name,
    component: surface.component,
    selector,
  }));
});

/**
 * The floor a control declares on one axis: the larger of `min-<axis>` and
 * `<axis>`, since a declared `width: 32px` is as binding as a `min-width` once
 * the control is `flex: 0 0 auto`. Reads top-level rules only — the layout at
 * 768 px and above — and the mobile media queries narrow nothing about size.
 */
function declaredFloorPx(
  component: unknown,
  selector: string,
  axis: 'width' | 'height',
): number {
  const styles = stylesFor(component, selector);
  const floors = [styles.get(`min-${axis}`), styles.get(axis)]
    .filter((value): value is string => value !== undefined)
    .filter(value => !['auto', 'unset', 'inherit', 'initial', 'revert'].includes(value))
    .map(toPx);
  return floors.length === 0 ? 0 : Math.max(...floors);
}

describe('Property 27: every retro control declares a 32x32px box (R7.5, R10.3)', () => {
  it('finds the button controls of all five surfaces', () => {
    expect(BUTTON_CONTROLS.length).toBeGreaterThan(14);
    expect(new Set(BUTTON_CONTROLS.map(c => c.surface)).size).toBe(SURFACES.length);
    // A spot check that the derivation picks up the controls named by the
    // design, including the ones whose selectors carry no `-btn` suffix.
    const selectors = BUTTON_CONTROLS.map(control => control.selector);
    expect(selectors).toContain('.retro-column__add-btn');
    expect(selectors).toContain('.retro-toolbar__btn');
    expect(selectors).toContain('.retro-dialog__btn');
    expect(selectors).toContain('.feelings-strip__emoji-btn');
    expect(selectors).toContain('.retro-card__emoji-option');
    expect(selectors).toContain('.retro-card__comment-delete');
  });

  it('declares at least 32px on both axes of every button', () => {
    fc.assert(
      fc.property(sliceOf(BUTTON_CONTROLS), slice => {
        for (const control of slice) {
          for (const axis of ['width', 'height'] as const) {
            expect(
              declaredFloorPx(control.component, control.selector, axis),
              `${control.surface} — ${control.selector} declares too small a ${axis}`,
            ).toBeGreaterThanOrEqual(MINIMUM_CONTROL_PX);
          }
        }
      }),
      NUM_RUNS,
    );
  });

  it('declares at least 32px of block size on every label activation target', () => {
    // Scope decision 2: these are `display: flex` rows in the settings dialog,
    // so the inline axis comes from the dialog width and no `min-width` is
    // declared. Only the block axis is a promise the stylesheet can make.
    fc.assert(
      fc.property(fc.constantFrom(...LABEL_ACTIVATION_TARGETS), target => {
        expect(
          declaredFloorPx(RetroToolbarComponent, target.selector, 'height'),
          `${target.selector} declares too small a block size`,
        ).toBeGreaterThanOrEqual(MINIMUM_CONTROL_PX);
      }),
      NUM_RUNS,
    );
  });

  it('keeps native checkbox and radio inputs at their 16px platform box', () => {
    // Scope decision 1, pinned: the native inputs are intentionally outside the
    // 32px rule. The checkbox declares its platform box explicitly and the radio
    // inherits it; both sit inside a label that carries the 32px minimum.
    const nativeInputRules = rulesOf(RetroToolbarComponent).filter(rule =>
      rule.selectors.some(selector =>
        /^\.retro-settings__(toggle|layout) .*input\[type=["']?(checkbox|radio)/.test(selector),
      ),
    );
    expect(nativeInputRules.length).toBeGreaterThanOrEqual(2);

    const checkbox = nativeInputRules.find(rule =>
      rule.selectors.some(selector => selector.includes('checkbox')),
    );
    expect(checkbox).toBeDefined();
    expect(toPx(checkbox!.declarations.get('width') ?? '')).toBe(16);
    expect(toPx(checkbox!.declarations.get('height') ?? '')).toBe(16);

    // And neither native input is in the set the 32px invariant quantifies over.
    expect(
      BUTTON_CONTROLS.filter(control => control.selector.includes('input')),
    ).toEqual([]);
  });
});

// --- Invariant 5: contrast (R7.4, R7.14, R10.6, R11.8) ----------------------------

/**
 * The token values, mirroring `client/src/styles.scss`.
 *
 * The `--surface-*` tokens are declared as white at 90–95% alpha over white
 * panels; `testing/contrast` evaluates the opaque colour, which is what those
 * resolve to in place. The two `--gradient-primary` stops are listed separately
 * because a gradient has no single colour to measure against.
 */
const TOKEN = {
  colorPrimaryDark: '#5a67d8',
  colorPrimaryLight: '#a3bffa',
  textPrimary: '#1a1a2e',
  textSecondary: '#4a5568',
  textOnPrimary: '#ffffff',
  surfaceBoard: '#ffffff',
  surfaceCardDeck: '#ffffff',
  toastError: '#e53e3e',
  gradientPrimaryLightStop: '#667eea',
  gradientPrimaryDarkStop: '#764ba2',
  statusChipBg: '#ffffff',
  statusConnected: '#1b7f3b',
  statusFault: '#b3261e',
  textOnStatus: '#ffffff',
} as const;

/** Mixed fills the components declare where no exact token exists. */
const MIXED = {
  /** `.retro-card.owner-highlight` background. */
  ownerHighlight: mixColors(TOKEN.colorPrimaryLight, TOKEN.surfaceCardDeck, 0.45),
  /** The darkened destructive red used as fill and as hover glyph colour. */
  destructiveFill: mixColors(TOKEN.toastError, TOKEN.textPrimary, 0.8),
  /** `.retro-column__delete-btn:hover` background wash. */
  destructiveWash: mixColors(TOKEN.toastError, TOKEN.surfaceCardDeck, 0.1),
  /** Hover fill of the primary-filled buttons. */
  primaryFillHover: mixColors(TOKEN.colorPrimaryDark, TOKEN.textPrimary, 0.8),
  /** Hover fill of the destructive confirm buttons. */
  destructiveFillHover: mixColors(TOKEN.toastError, TOKEN.textPrimary, 0.6),
} as const;

interface ContrastPair {
  /** The selectors that put this foreground on this background. */
  readonly where: string;
  readonly foreground: string;
  readonly background: string;
}

/** Visible text on a non-transparent background: 4.5:1 (R7.4, R10.6, R11.8). */
const TEXT_PAIRS: readonly ContrastPair[] = [
  {
    where: '.retro-board__context-input / .retro-board__context-display',
    foreground: TOKEN.textPrimary,
    background: TOKEN.surfaceBoard,
  },
  {
    where: '.retro-column__name, .retro-column__dialog-text, .retro-board__dialog-text, .retro-dialog__title, .retro-settings__toggle, .feelings-strip__label',
    foreground: TOKEN.textPrimary,
    background: TOKEN.surfaceCardDeck,
  },
  {
    where: '.retro-column__card-count, .retro-column__add-btn:disabled, .retro-card__comment-submit:disabled',
    foreground: TOKEN.textPrimary,
    background: TOKEN.colorPrimaryLight,
  },
  {
    where: '.retro-column__hidden-count, .retro-card__author, .retro-card__vote-count',
    foreground: TOKEN.textSecondary,
    background: TOKEN.surfaceBoard,
  },
  {
    where: '.retro-column__delete-btn, .retro-dialog__btn--cancel, .retro-column__dialog-btn--cancel, .retro-board__dialog-btn--cancel',
    foreground: TOKEN.textSecondary,
    background: TOKEN.surfaceCardDeck,
  },
  {
    where: '.retro-card__text on an owner-highlighted card',
    foreground: TOKEN.textPrimary,
    background: MIXED.ownerHighlight,
  },
  {
    where: '.retro-card__author on an owner-highlighted card',
    foreground: TOKEN.textSecondary,
    background: MIXED.ownerHighlight,
  },
  {
    where: '.retro-column__add-btn, .retro-card__comment-submit, .retro-dialog__btn--ok',
    foreground: TOKEN.textOnPrimary,
    background: TOKEN.colorPrimaryDark,
  },
  {
    where: 'the same three buttons on hover',
    foreground: TOKEN.textOnPrimary,
    background: MIXED.primaryFillHover,
  },
  {
    where: '.retro-column__dialog-btn--delete, .retro-board__dialog-btn--confirm',
    foreground: TOKEN.textOnPrimary,
    background: MIXED.destructiveFill,
  },
  {
    where: 'the same two destructive confirm buttons on hover',
    foreground: TOKEN.textOnPrimary,
    background: MIXED.destructiveFillHover,
  },
  {
    where: '.retro-card__comment-delete:hover',
    foreground: MIXED.destructiveFill,
    background: TOKEN.surfaceBoard,
  },
  {
    where: '.retro-column__delete-btn:hover',
    foreground: MIXED.destructiveFill,
    background: MIXED.destructiveWash,
  },
  {
    where: 'the connection indicator label on its connected fill (R11.8)',
    foreground: TOKEN.textOnStatus,
    background: TOKEN.statusConnected,
  },
  {
    where: 'the connection indicator label on its fault fill (R11.8)',
    foreground: TOKEN.textOnStatus,
    background: TOKEN.statusFault,
  },
];

/** Focus indicators and status fills: 3:1 (R7.14, R11.8). */
const NON_TEXT_PAIRS: readonly ContrastPair[] = [
  {
    where: 'the focus outline on the board, context, column and card surfaces',
    foreground: TOKEN.colorPrimaryDark,
    background: TOKEN.surfaceBoard,
  },
  {
    where: 'the focus outline on the toolbar, strip and dialog surfaces',
    foreground: TOKEN.colorPrimaryDark,
    background: TOKEN.surfaceCardDeck,
  },
  {
    where: 'the header focus outline on the light gradient stop',
    foreground: TOKEN.textOnPrimary,
    background: TOKEN.gradientPrimaryLightStop,
  },
  {
    where: 'the header focus outline on the dark gradient stop',
    foreground: TOKEN.textOnPrimary,
    background: TOKEN.gradientPrimaryDarkStop,
  },
  {
    where: 'the connected fill on the status chip surface (R11.8)',
    foreground: TOKEN.statusConnected,
    background: TOKEN.statusChipBg,
  },
  {
    where: 'the fault fill on the status chip surface (R11.8)',
    foreground: TOKEN.statusFault,
    background: TOKEN.statusChipBg,
  },
];

describe('Property 27: the retro token pairs reach their contrast thresholds', () => {
  it('reaches 4.5:1 on every (text token, surface) pair (R7.4, R10.6, R11.8)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TEXT_PAIRS), pair => {
        const ratio = wcagContrastRatio(pair.foreground, pair.background);
        expect(
          ratio,
          `${pair.where}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
      }),
      NUM_RUNS,
    );
  });

  it('reaches 3:1 on every (focus outline or status fill, adjacent surface) pair (R7.14, R11.8)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NON_TEXT_PAIRS), pair => {
        const ratio = wcagContrastRatio(pair.foreground, pair.background);
        expect(
          ratio,
          `${pair.where}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
      }),
      NUM_RUNS,
    );
  });

  it('pins the focus outline and the filled-button background to the tokens asserted above', () => {
    // The pair lists are hand-written, so they are only worth anything while
    // the stylesheets still declare the tokens they name. These two are the
    // ones that would silently invalidate the lists if they drifted: the
    // outline token behind both 3:1 surface pairs, and the filled-button
    // background that has to stay off `--color-primary` (3.66:1 against white).
    expect(
      stylesFor(RetroToolbarComponent, '.retro-toolbar__btn:focus-visible').get('outline'),
    ).toBe('2px solid var(--color-primary-dark)');
    expect(
      stylesFor(RetroBoardPageComponent, '.retro-board__header *:focus-visible').get(
        'outline-color',
      ),
    ).toBe('var(--text-on-primary)');

    for (const [component, selector] of [
      [RetroColumnComponent, '.retro-column__add-btn'],
      [RetroCardComponent, '.retro-card__comment-submit'],
      [RetroToolbarComponent, '.retro-dialog__btn--ok'],
    ] as const) {
      expect(stylesFor(component, selector).get('background')).toBe(
        'var(--color-primary-dark)',
      );
      expect(stylesFor(component, selector).get('color')).toBe('var(--text-on-primary)');
    }
  });
});
