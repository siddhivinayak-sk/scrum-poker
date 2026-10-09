import { describe, expect, it } from 'vitest';
import { FeelingsStripComponent } from '../feelings-strip/feelings-strip.component';
import { RetroBoardPageComponent } from './retro-board-page.component';
import { RetroCardComponent } from './retro-card.component';
import { RetroColumnComponent } from './retro-column.component';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { hasUnrenderableColor } from '../../services/retro-capture-mode';
import { rulesOf } from '../../testing/declared-css';

/**
 * The board screenshot is rasterised by html2canvas 1.4.1, whose colour parser is an
 * allow-list of exactly rgb, rgba, hsl and hsla. It throws on any other function
 * name, and that throw aborts the entire capture rather than degrading one colour.
 *
 * Chrome serialises a computed color-mix() as color(srgb ...), so every mixed design
 * token reached the renderer in a rejected form and the screenshot failed for every
 * board. The washes, scrims and blends are therefore declared as statically
 * precomputed rgba() tokens in styles.scss instead.
 *
 * This test is the guard. It reads the real compiled stylesheet of every component
 * inside the captured subtree, so reintroducing a mix anywhere fails here rather
 * than silently breaking the feature in a browser - which is what happened before,
 * because retro-screenshot.service.spec.ts mocks html2canvas and can never observe
 * a parse failure.
 */

/** Every component rendered inside the captured .retro-board subtree. */
const CAPTURED_SURFACES = [
  { name: 'RetroBoardPageComponent', component: RetroBoardPageComponent },
  { name: 'RetroToolbarComponent', component: RetroToolbarComponent },
  { name: 'RetroColumnComponent', component: RetroColumnComponent },
  { name: 'RetroCardComponent', component: RetroCardComponent },
  { name: 'FeelingsStripComponent', component: FeelingsStripComponent },
] as const;

describe('every colour inside the captured board is renderable by html2canvas', () => {
  for (const { name, component } of CAPTURED_SURFACES) {
    it('declares no unparseable colour function anywhere in ' + name, () => {
      const offenders: string[] = [];

      for (const rule of rulesOf(component)) {
        for (const [property, value] of rule.declarations) {
          if (hasUnrenderableColor(value)) {
            offenders.push(rule.selectors.join(', ') + ' { ' + property + ': ' + value + ' }');
          }
        }
      }

      expect(offenders, offenders.join(String.fromCharCode(10))).toEqual([]);
    });
  }

  it('scans a non-trivial number of declarations, so an empty pass means something', () => {
    // Guards the guard: a selector or parser change that silently stopped
     // returning rules would make every assertion above vacuously true.
    const declarationCount = CAPTURED_SURFACES.reduce(
      (total, { component }) =>
        total +
        rulesOf(component).reduce((count, rule) => count + rule.declarations.size, 0),
      0,
    );

    expect(declarationCount).toBeGreaterThan(300);
  });

  it('still catches a mix if one is reintroduced', () => {
    // The detector itself has to work, or the scan above proves nothing.
    expect(hasUnrenderableColor('color-mix(in srgb, var(--text-primary) 8%, transparent)')).toBe(
      true,
    );
    expect(hasUnrenderableColor('rgba(26, 26, 46, 0.08)')).toBe(false);
    expect(hasUnrenderableColor('var(--wash-neutral-weak)')).toBe(false);
  });
});
