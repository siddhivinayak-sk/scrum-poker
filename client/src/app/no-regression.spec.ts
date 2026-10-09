import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';

import { CONNECTION_LABEL, ConnectionState } from '@shared/types';
import { LobbyComponent } from './components/lobby/lobby.component';
import { SessionPokerPageComponent } from './components/session-poker-page/session-poker-page.component';
import { IssueListPanelComponent } from './components/issue-list-panel/issue-list-panel.component';
import { CardDeckComponent } from './components/card-deck/card-deck.component';
import { RetroBoardPageComponent } from './components/retro-board/retro-board-page.component';
import { RetroToolbarComponent } from './components/retro-board/retro-toolbar.component';
import { RetroColumnComponent } from './components/retro-board/retro-column.component';
import { RetroCardComponent } from './components/retro-board/retro-card.component';
import { ConnectionStatusComponent } from './components/connection-status/connection-status.component';
import { UserMenuComponent } from './components/user-menu/user-menu.component';
import { ToastService } from './services/toast.service';

/**
 * Property 28, client half — "Pre-existing names and routes survive".
 *
 * The server half lives in `server/src/__tests__/isolation.spec.ts` and covers
 * the WebSocket event names, the REST route table and the retro/poker import
 * scan. This file carries the complement R13.7 and R13.8 ask for: the ARIA
 * surface and the key bindings of the eight named components, frozen as they
 * stood before this feature and re-checked against the components as they stand
 * now.
 *
 * ## How the surface is read
 *
 * The runner performs no layout and, more to the point, rendering all eight
 * pages would mean standing up eight sets of service doubles — which is what the
 * per-component specs already do. Instead each component's *compiled template
 * constants* are read: `ɵcmp.consts` holds, for every element in the template
 * (embedded `@if` and `@for` views included), its static attributes as
 * name/value pairs and the names of everything bound to it. Asserting against
 * that is a declaration-level check in the same spirit as `testing/declared-css.ts`.
 *
 * One gap is worth naming: a binding written as `[attr.aria-label]="expr"` does
 * *not* appear in the constants — only interpolated attributes
 * (`aria-label="... {{ expr }}"`), property bindings and event bindings do. The
 * dynamic `aria-label` / `aria-pressed` names on the card deck, the issue rows,
 * the retro column header and the feelings strip are therefore asserted by
 * rendering, in `accessibility.spec.ts`, `issue-list-panel.layout.spec.ts`,
 * `retro-column.dnd.spec.ts` and `retro-toolbar.compact.spec.ts`. What is frozen
 * here is everything the constants do expose.
 *
 * **Validates: Requirements 13.7, 13.8**
 */

// ---------------------------------------------------------------------------
// Compiled-template surface reader
// ---------------------------------------------------------------------------

/**
 * Section markers Angular writes into an element's attribute array. Everything
 * before the first marker is a static name/value pair.
 */
const MARKER_NAMESPACE = 0;
const MARKER_CLASSES = 1;
const MARKER_STYLES = 2;
const MARKER_BINDINGS = 3;
const MARKER_TEMPLATE = 4;
const MARKER_I18N = 6;
/** Sentinel for "no marker seen yet", i.e. still in the static-attribute run. */
const SECTION_STATIC = -1;

export interface TemplateSurface {
  /** Static attribute name to the set of values the template declares for it. */
  readonly staticAttributes: ReadonlyMap<string, ReadonlySet<string>>;
  /** Names of interpolated attributes, property bindings and event bindings. */
  readonly bound: ReadonlySet<string>;
}

interface CompiledTemplateDef {
  readonly consts?: unknown[] | (() => unknown[]);
}

/**
 * Reads a compiled component's template constants into a flat surface.
 *
 * Pairs are consumed defensively: a section that holds name/value pairs stops
 * pairing as soon as the next slot is a marker number, so a `[style.x]` binding
 * sitting between the styles and bindings sections cannot swallow the marker
 * that follows it.
 */
export function templateSurfaceOf(component: unknown): TemplateSurface {
  const def = (component as { readonly ɵcmp?: CompiledTemplateDef }).ɵcmp;
  if (def === undefined) {
    throw new Error('not a compiled Angular component');
  }
  const raw = typeof def.consts === 'function' ? def.consts() : def.consts;
  if (!Array.isArray(raw)) {
    throw new Error('component declares no template constants');
  }

  const staticAttributes = new Map<string, Set<string>>();
  const bound = new Set<string>();

  for (const entry of raw) {
    if (!Array.isArray(entry)) {
      continue;
    }
    let section: number = SECTION_STATIC;
    let index = 0;
    while (index < entry.length) {
      const slot = entry[index];
      if (typeof slot === 'number') {
        section = slot;
        index += 1;
        continue;
      }
      const name = String(slot);
      const paired = typeof entry[index + 1] === 'string';

      if (section === SECTION_STATIC) {
        if (paired) {
          const values = staticAttributes.get(name) ?? new Set<string>();
          values.add(String(entry[index + 1]));
          staticAttributes.set(name, values);
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }

      if (
        section === MARKER_BINDINGS ||
        section === MARKER_TEMPLATE ||
        section === MARKER_I18N
      ) {
        bound.add(name);
        index += 1;
        continue;
      }

      if (section === MARKER_STYLES) {
        index += paired ? 2 : 1;
        continue;
      }

      // Classes, namespace URIs and projectAs selectors carry nothing this
      // check reads.
      if (section === MARKER_CLASSES || section === MARKER_NAMESPACE) {
        index += 1;
        continue;
      }
      index += 1;
    }
  }

  return { staticAttributes, bound };
}

// ---------------------------------------------------------------------------
// The frozen pre-change ARIA and key-binding inventory
// ---------------------------------------------------------------------------

interface ComponentSurface {
  /** The name R13.7 uses for this component. */
  readonly label: string;
  readonly component: unknown;
  /** ARIA attributes and roles declared with a literal value. */
  readonly staticAria: readonly (readonly [string, string])[];
  /** ARIA attributes carrying an interpolated value. */
  readonly interpolatedAria: readonly string[];
  /** Key bindings, as the template declares them. */
  readonly keyBindings: readonly string[];
}

/**
 * Everything below was present before this feature. Names this feature *adds*
 * are deliberately absent, so adding one cannot make the check pass by accident:
 *
 *   - Poker_Session_Page: `aria-label="Export estimates"` (R1.1) and the
 *     interaction blocker's `role="status"` / `aria-live="polite"` (R11.9).
 *   - Retro_Board_Page: `aria-label="End session"` (R9.1), the end-session
 *     `role="alertdialog"` / `aria-modal="true"` /
 *     `aria-label="End session confirmation"` (R9.3) and the same interaction
 *     blocker.
 *   - Retro_Column: `[attr.aria-label]="column().name"` (R7.7).
 *   - Issue_List_Panel: `[attr.aria-label]="titleAccessibleName(issue)"` (R2.2).
 */
const FROZEN_SURFACES: readonly ComponentSurface[] = [
  {
    label: 'Lobby_Page',
    component: LobbyComponent,
    staticAria: [
      ['role', 'main'],
      ['aria-label', 'Start a new game'],
      ['aria-label', 'Create a retrospective board'],
      ['aria-label', 'Session ID or URL'],
      ['aria-describedby', 'join-error'],
      ['aria-label', 'Join session'],
      ['aria-hidden', 'true'],
      ['role', 'alert'],
      ['aria-live', 'polite'],
    ],
    interpolatedAria: [],
    keyBindings: ['keydown.enter'],
  },
  {
    label: 'Poker_Session_Page',
    component: SessionPokerPageComponent,
    staticAria: [
      ['aria-label', 'Back to Lobby'],
      ['aria-label', 'End session'],
      ['aria-label', 'Copy session link to clipboard'],
      ['aria-controls', 'qr-panel'],
      ['aria-label', 'Toggle QR code display'],
      ['aria-hidden', 'true'],
      ['role', 'dialog'],
      ['aria-label', 'QR code for session link'],
      ['aria-controls', 'history-overlay'],
      ['aria-label', 'Toggle session history'],
      ['role', 'complementary'],
      ['aria-label', 'Session history overlay'],
      ['aria-label', 'Close session history'],
      ['role', 'alertdialog'],
      ['aria-label', 'End session confirmation'],
    ],
    interpolatedAria: [],
    keyBindings: [],
  },
  {
    label: 'Issue_List_Panel',
    component: IssueListPanelComponent,
    staticAria: [
      ['role', 'complementary'],
      ['aria-label', 'Issue list'],
      ['aria-label', 'New issue title'],
      ['aria-label', 'Bulk import issues'],
      ['role', 'list'],
      ['role', 'listitem'],
      ['aria-hidden', 'true'],
    ],
    interpolatedAria: [],
    keyBindings: ['keydown.enter'],
  },
  {
    label: 'Card_Deck',
    component: CardDeckComponent,
    staticAria: [
      ['role', 'radiogroup'],
      ['aria-label', 'Estimation cards'],
      ['role', 'status'],
      ['aria-live', 'polite'],
      ['aria-atomic', 'true'],
    ],
    interpolatedAria: [],
    keyBindings: ['keydown.enter', 'keydown.space'],
  },
  {
    label: 'Retro_Board_Page',
    component: RetroBoardPageComponent,
    staticAria: [
      ['aria-label', 'Back to Lobby'],
      ['aria-label', 'Copy session link'],
      ['aria-label', 'Sprint context'],
      ['role', 'region'],
      ['aria-label', 'Retrospective columns'],
    ],
    // `aria-label="Your remaining votes: {{ votesRemaining() }}"`.
    interpolatedAria: ['aria-label'],
    keyBindings: [],
  },
  {
    label: 'Retro_Toolbar',
    component: RetroToolbarComponent,
    staticAria: [
      ['role', 'toolbar'],
      ['aria-label', 'Board actions'],
      ['aria-label', 'Reveal Cards'],
      ['aria-label', 'Enable Voting'],
      ['aria-label', 'Complete Retrospective'],
      ['aria-label', 'Export CSV'],
      ['aria-label', 'Import CSV'],
      ['aria-label', 'Screenshot'],
      ['aria-label', 'Add Column'],
      ['aria-label', 'Board Settings'],
      ['aria-hidden', 'true'],
      ['role', 'dialog'],
      ['aria-label', 'Add column'],
      ['aria-label', 'Column name'],
      ['aria-label', 'Board settings'],
    ],
    interpolatedAria: [],
    keyBindings: ['keydown.enter', 'keydown.escape'],
  },
  {
    label: 'Retro_Column',
    component: RetroColumnComponent,
    staticAria: [
      ['aria-label', 'Add Card'],
      ['aria-label', 'Delete Column'],
      ['aria-live', 'polite'],
      ['role', 'alertdialog'],
      ['aria-label', 'Confirm delete column'],
    ],
    interpolatedAria: [],
    keyBindings: [],
  },
  {
    label: 'Retro_Card',
    component: RetroCardComponent,
    staticAria: [
      ['aria-label', 'Card text'],
      ['aria-label', 'Vote'],
      ['aria-label', 'Comments'],
      ['aria-label', 'Insert emoji'],
      ['aria-label', 'Delete card'],
      ['aria-label', 'Delete comment'],
      ['aria-label', 'Add a comment'],
      ['aria-label', 'Add comment'],
    ],
    // `aria-label="Vote count: {{ card().votes }}"`.
    interpolatedAria: ['aria-label'],
    keyBindings: ['keydown.enter'],
  },
];

/** One checkable claim about one component, for the property's generator. */
type Claim =
  | { readonly kind: 'static'; readonly label: string; readonly component: unknown; readonly name: string; readonly value: string }
  | { readonly kind: 'interpolated'; readonly label: string; readonly component: unknown; readonly name: string }
  | { readonly kind: 'key'; readonly label: string; readonly component: unknown; readonly name: string };

const FROZEN_CLAIMS: readonly Claim[] = FROZEN_SURFACES.flatMap((surface) => [
  ...surface.staticAria.map(
    ([name, value]): Claim => ({
      kind: 'static',
      label: surface.label,
      component: surface.component,
      name,
      value,
    })
  ),
  ...surface.interpolatedAria.map(
    (name): Claim => ({
      kind: 'interpolated',
      label: surface.label,
      component: surface.component,
      name,
    })
  ),
  ...surface.keyBindings.map(
    (name): Claim => ({
      kind: 'key',
      label: surface.label,
      component: surface.component,
      name,
    })
  ),
]);

/** Describes a claim for failure output, without reaching into the component. */
function describeClaim(claim: Claim): string {
  switch (claim.kind) {
    case 'static':
      return `${claim.label}: ${claim.name}="${claim.value}"`;
    case 'interpolated':
      return `${claim.label}: interpolated ${claim.name}`;
    case 'key':
      return `${claim.label}: (${claim.name})`;
  }
}

/** Whether the component as it stands now still honours the claim. */
function holds(claim: Claim): boolean {
  const surface = templateSurfaceOf(claim.component);
  switch (claim.kind) {
    case 'static':
      return surface.staticAttributes.get(claim.name)?.has(claim.value) ?? false;
    case 'interpolated':
    case 'key':
      return surface.bound.has(claim.name);
  }
}

// ---------------------------------------------------------------------------
// Property 28 (client half)
//
// Feature: poker-retro-ux-improvements, Property 28: For any accessible name
// present before this feature on the eight listed components, that name is still
// present.
// ---------------------------------------------------------------------------

describe('R13.7/R13.8: pre-existing ARIA surface and key bindings survive', () => {
  it('R13.7/R13.8: any frozen claim drawn at random still holds', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FROZEN_CLAIMS), (claim) => {
        expect({ claim: describeClaim(claim), present: holds(claim) }).toEqual({
          claim: describeClaim(claim),
          present: true,
        });
      }),
      { numRuns: 100 }
    );
  });

  it('R13.7/R13.8: every frozen claim holds, with none left to the draw', () => {
    // 100 draws from ~70 constants leaves real coverage to chance, so the whole
    // inventory is walked once as well. The failures are reported together so a
    // regression names every attribute it dropped, not just the first.
    const missing = FROZEN_CLAIMS.filter((claim) => !holds(claim)).map(describeClaim);
    expect(missing).toEqual([]);
  });

  it('R13.7: the surface reader is not vacuous — it finds nothing that was never declared', () => {
    // A reader that reported every name as present would make the two checks
    // above meaningless.
    for (const surface of FROZEN_SURFACES) {
      const read = templateSurfaceOf(surface.component);
      expect(read.staticAttributes.get('aria-label')?.has('no such label')).toBeFalsy();
      expect(read.bound.has('keydown.f13')).toBe(false);
      // And it does read *something* from every one of the eight.
      expect(read.staticAttributes.size).toBeGreaterThan(0);
    }
  });

  it('R13.7: the retro board page still exposes a connection-status accessible name', () => {
    // Before this feature the retro header carried
    // `[attr.aria-label]="'Connection status: ' + connectionState()"` inline.
    // R11.3 replaced the inline span with `<app-connection-status>`, so the name
    // is now declared by the child component — still present on the page, just
    // delivered one level down. `ConnectionStatusComponent` is asserted to be a
    // declared dependency of the page, and the label text it exposes is covered
    // by `connection-status/connection-status.property.spec.ts`.
    const dependencies = (RetroBoardPageComponent as { ɵcmp?: { dependencies?: unknown } })
      .ɵcmp?.dependencies;
    const resolved =
      typeof dependencies === 'function'
        ? (dependencies as () => unknown[])()
        : (dependencies as unknown[] | undefined);
    expect(resolved ?? []).toContain(ConnectionStatusComponent);

    const indicator = templateSurfaceOf(ConnectionStatusComponent);
    expect(indicator.staticAttributes.get('role')?.has('status')).toBe(true);

    const states: ConnectionState[] = ['connected', 'disconnected', 'reconnecting'];
    for (const state of states) {
      expect(CONNECTION_LABEL[state].length).toBeGreaterThan(0);
    }
  });

  it('R13.7: the user menu keeps its pre-existing ARIA surface and gains only optional inputs', () => {
    const surface = templateSurfaceOf(UserMenuComponent);
    expect(surface.staticAttributes.get('aria-haspopup')?.has('true')).toBe(true);
    expect(surface.staticAttributes.get('role')?.has('menu')).toBe(true);
    expect(surface.staticAttributes.get('role')?.has('menuitem')).toBe(true);
    expect(surface.staticAttributes.get('aria-label')?.has('User menu')).toBe(true);
    expect(surface.staticAttributes.get('aria-label')?.has('Logout')).toBe(true);

    // The two inputs this feature adds are additive; neither existed before, and
    // their defaults reproduce the poker page's behaviour (asserted in
    // `user-menu.component.property.spec.ts`).
    const inputs = (UserMenuComponent as { ɵcmp?: { inputs?: Record<string, unknown> } }).ɵcmp
      ?.inputs;
    expect(Object.keys(inputs ?? {})).toEqual(
      expect.arrayContaining(['user', 'showRoleSwitch'])
    );
  });
});

// ---------------------------------------------------------------------------
// The one documented departure from "existing assertions stay unchanged"
// ---------------------------------------------------------------------------

describe('R13.18: the connection toasts are the single documented removal', () => {
  /**
   * The two notifications R11.14 and R11.26 forbid. Before this feature a drop
   * raised the first immediately and every retry raised the second; tasks 24.3
   * and 24.4 removed both, and task 24.11 replaces the two WS-service test cases
   * that asserted them. This list is the exception made explicit: it is the only
   * pre-existing observable behaviour R13 does not get to keep.
   */
  const SUPERSEDED_BY_R11 = [
    'Connection lost. Attempting to reconnect...',
    'Reconnecting... (attempt 1)',
  ] as const;

  let toast: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    toast = new ToastService();
  });

  afterEach(() => {
    toast.ngOnDestroy();
    vi.useRealTimers();
  });

  it('R13.18: the information the removed toasts carried is still conveyed, by the indicator', () => {
    // The exception is justified rather than merely declared: every connection
    // state the removed toasts announced still has a text label, which the
    // indicator shows and exposes as its accessible name. Nothing a user could
    // previously learn from the toasts has become unobservable.
    const states: ConnectionState[] = ['connected', 'disconnected', 'reconnecting'];
    const labels = states.map((state) => CONNECTION_LABEL[state]);

    expect(new Set(labels).size).toBe(states.length);
    for (const superseded of SUPERSEDED_BY_R11) {
      expect(labels).not.toContain(superseded);
    }
  });

  it('R13.7: ToastService.show keeps its two-argument behaviour unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('error' as const, 'warning' as const, 'info' as const),
        fc.string({ minLength: 1 }),
        (type, message) => {
          const service = new ToastService();
          try {
            service.show(type, message);

            const [only] = service.toasts();
            expect(only.type).toBe(type);
            expect(only.message).toBe(message);
            // No third argument means no tag, exactly as before.
            expect(only.tag).toBeUndefined();

            // And the 5-second auto-dismiss is untouched.
            vi.advanceTimersByTime(4999);
            expect(service.toasts().length).toBe(1);
            vi.advanceTimersByTime(1);
            expect(service.toasts().length).toBe(0);
          } finally {
            service.ngOnDestroy();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('R13.7: dismissByTag is additive — it leaves untagged toasts alone', () => {
    toast.show('error', 'tagged one', { tag: 'connection' });
    toast.show('info', 'untagged');
    toast.show('warning', 'tagged two', { tag: 'connection' });

    toast.dismissByTag('connection');

    expect(toast.toasts().map((entry) => entry.message)).toEqual(['untagged']);

    // A tag with nothing behind it is a no-op rather than a clear-all.
    toast.dismissByTag('connection');
    expect(toast.toasts().map((entry) => entry.message)).toEqual(['untagged']);
  });
});
