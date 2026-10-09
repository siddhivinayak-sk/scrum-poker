import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { Subject } from 'rxjs';
import { CardDeckComponent } from './card-deck.component';
import {
  DECK_PADDING_TOP_PX,
  SELECTION_LIFT_PX,
  SELECTION_SCALE,
  requiredHeadroomPx,
  isSelectionContained,
} from './card-deck-geometry';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { VotingRound, ExtendedCardValue } from '@shared/types';

/**
 * Stream 3 — contained card selection elevation (R3.1, R3.6–R3.10).
 *
 * The client test runner performs no layout: `getBoundingClientRect()` and the
 * computed-style cascade are inert here. So this file asserts two things that
 * are observable without layout:
 *
 *   1. the *declared* CSS, read from the compiled component definition, against
 *      the geometry constants the component interpolates into it — which is
 *      what keeps the stylesheet and `card-deck-geometry.ts` from drifting;
 *   2. the DOM state the component drives (selected class, `aria-pressed`,
 *      announcement text) across successive selections and resets.
 *
 * Measured pixel geometry is covered by `card-deck-geometry.property.spec.ts`.
 */

/** Shape of the compiled component definition this file reads. */
interface StyledComponentDef {
  readonly styles: readonly string[];
}

/** The component's compiled stylesheet, as emitted by the Angular compiler. */
function compiledStyles(): readonly string[] {
  const def = (CardDeckComponent as unknown as { ɵcmp: StyledComponentDef }).ɵcmp;
  return def.styles;
}

/**
 * Collapses whitespace and strips it around CSS punctuation, so a declaration
 * can be matched as a stable substring regardless of source formatting or of
 * the component-scoping attributes the compiler injects into selectors.
 */
function normalizeCss(css: string): string {
  return css
    .replace(/\s+/g, ' ')
    .replace(/\s*([:;{},])\s*/g, '$1')
    .trim();
}

/** Body of the first `@media <condition>` block, brace-matched. */
function mediaBlock(normalized: string, condition: string): string {
  const start = normalized.indexOf(`@media ${condition}`);
  if (start === -1) {
    return '';
  }
  const open = normalized.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < normalized.length; i++) {
    if (normalized[i] === '{') {
      depth++;
    } else if (normalized[i] === '}') {
      depth--;
      if (depth === 0) {
        return normalized.slice(open + 1, i);
      }
    }
  }
  return '';
}

const VOTING_ROUND: VotingRound = {
  id: 'round-1',
  storyDescription: 'Containment',
  status: 'voting',
  selections: new Map(),
  startedAt: new Date().toISOString(),
};

describe('CardDeckComponent — contained selection elevation', () => {
  let css: string;

  beforeEach(() => {
    css = normalizeCss(compiledStyles().join('\n'));
  });

  describe('declared values match the geometry constants (R3.1, R3.4)', () => {
    it('exposes a non-empty compiled stylesheet to assert against', () => {
      expect(compiledStyles().length).toBeGreaterThan(0);
      expect(css.length).toBeGreaterThan(0);
    });

    it('declares the selected transform from SELECTION_LIFT_PX and SELECTION_SCALE', () => {
      expect(css).toContain(
        `transform:translateY(-${SELECTION_LIFT_PX}px) scale(${SELECTION_SCALE})`
      );
    });

    it('declares the reserved headroom from DECK_PADDING_TOP_PX', () => {
      expect(css).toContain(`padding-top:${DECK_PADDING_TOP_PX}px`);
    });

    it('keeps the lift inside the 8–12 px range required by R3.1', () => {
      expect(SELECTION_LIFT_PX).toBeGreaterThanOrEqual(8);
      expect(SELECTION_LIFT_PX).toBeLessThanOrEqual(12);
    });

    it('keeps the scale inside the 1.00–1.10 range required by R3.4', () => {
      expect(SELECTION_SCALE).toBeGreaterThanOrEqual(1.0);
      expect(SELECTION_SCALE).toBeLessThanOrEqual(1.1);
    });

    it('reserves at least the headroom the declared card heights need (R3.4)', () => {
      // The two card heights the stylesheet declares: desktop and mobile.
      expect(css).toContain('height:72px');
      expect(css).toContain('height:76px');

      for (const cardHeightPx of [72, 76]) {
        const geometry = {
          cardHeightPx,
          liftPx: SELECTION_LIFT_PX,
          scale: SELECTION_SCALE,
          paddingTopPx: DECK_PADDING_TOP_PX,
        };
        expect(requiredHeadroomPx(geometry)).toBeLessThanOrEqual(DECK_PADDING_TOP_PX);
        expect(isSelectionContained(geometry)).toBe(true);
      }
    });

    it('reserves space below the card row as well', () => {
      expect(css).toContain('padding-bottom:8px');
    });

    it('declares a hover lift that stays inside the reserved headroom (R3.3)', () => {
      const hoverLift = /transform:translateY\(-(\d+)px\)(?!\s*scale)/.exec(css);
      expect(hoverLift).not.toBeNull();
      const liftPx = Number(hoverLift![1]);
      // Hover is unscaled; add the focus ring (2 px outline + 2 px offset).
      expect(liftPx + 4).toBeLessThanOrEqual(DECK_PADDING_TOP_PX);
    });

    it('reaches the displacement within 300 ms (R3.1)', () => {
      expect(css).toMatch(/transform 300ms ease-out/);
    });
  });

  describe('reduced motion (R3.9)', () => {
    it('zeroes the transition duration for the card and the selected card', () => {
      const block = mediaBlock(css, '(prefers-reduced-motion:reduce)');
      expect(block).not.toBe('');
      expect(block).toContain('transition-duration:0ms');
      expect(block).toContain('card-deck__card');
      expect(block).toContain('card-deck__card--selected');
    });

    it('declares no transform inside the reduced-motion block, keeping the same end state', () => {
      const block = mediaBlock(css, '(prefers-reduced-motion:reduce)');
      // Overriding the transform here would change the end position/scale.
      expect(block).not.toContain('transform:');
    });
  });

  describe('mobile scrollable strip (R3.6)', () => {
    it('declares overflow-y: hidden so scrollHeight cannot exceed clientHeight', () => {
      const block = mediaBlock(css, '(max-width:767px)');
      expect(block).not.toBe('');
      expect(block).toContain('overflow-y:hidden');
    });

    it('keeps the reserved headroom in the mobile media query', () => {
      const block = mediaBlock(css, '(max-width:767px)');
      expect(block).toContain(`padding-top:${DECK_PADDING_TOP_PX}px`);
    });

    it('still scrolls horizontally', () => {
      const block = mediaBlock(css, '(max-width:767px)');
      expect(block).toContain('overflow-x:auto');
    });
  });

  describe('preserved visual declarations (R3.10)', () => {
    it('keeps the selected border width, gradient and shadow', () => {
      expect(css).toContain('border-width:3px');
      expect(css).toContain('box-shadow:var(--shadow-card-selected)');
      expect(css).toMatch(/\.card-deck__card--selected[^{]*\{[^}]*linear-gradient/);
    });

    it('keeps the focus indicator', () => {
      expect(css).toContain('outline:2px solid #1976d2');
      expect(css).toContain('outline-offset:2px');
    });

    it('keeps the disabled state', () => {
      expect(css).toMatch(/:disabled[^{]*\{[^}]*opacity:0\.5/);
      expect(css).toMatch(/:disabled[^{]*\{[^}]*cursor:not-allowed/);
    });
  });

  describe('DOM state', () => {
    let fixture: ComponentFixture<CardDeckComponent>;
    let component: CardDeckComponent;
    let roundSignal: WritableSignal<VotingRound | null>;
    let roundStarted: Subject<unknown>;
    let boardCleared: Subject<unknown>;

    const selectedButtons = (): HTMLButtonElement[] =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          '.card-deck__card--selected'
        )
      );

    const allButtons = (): HTMLButtonElement[] =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          '.card-deck__card'
        )
      );

    beforeEach(() => {
      roundSignal = signal<VotingRound | null>(VOTING_ROUND);
      roundStarted = new Subject<unknown>();
      boardCleared = new Subject<unknown>();

      const mockSessionState = {
        currentRound: roundSignal.asReadonly(),
        participants: signal([]).asReadonly(),
        selections: signal(new Map()).asReadonly(),
        isRevealed: signal(false).asReadonly(),
        metrics: signal(null).asReadonly(),
        history: signal([]).asReadonly(),
        currentUser: signal(null).asReadonly(),
        votingSystemCards: signal<ExtendedCardValue[]>([]).asReadonly(),
        sessionConfig: signal(null).asReadonly(),
        hasIssuePermission: signal(false).asReadonly(),
        hasRevealPermission: signal(false).asReadonly(),
        countdownActive: signal(false).asReadonly(),
        votedUserIds: signal(new Set()).asReadonly(),
      };

      const mockWsService = {
        send: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string) => {
          if (event === 'round:started') {
            return roundStarted.asObservable();
          }
          if (event === 'board:cleared') {
            return boardCleared.asObservable();
          }
          return new Subject<unknown>().asObservable();
        }),
        connectionState: signal('connected' as const),
      };

      TestBed.configureTestingModule({
        providers: [
          { provide: SessionStateService, useValue: mockSessionState },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      fixture = TestBed.createComponent(CardDeckComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
    });

    it('elevates no card before a selection', () => {
      expect(selectedButtons()).toHaveLength(0);
      expect(
        allButtons().every((btn) => btn.getAttribute('aria-pressed') === 'false')
      ).toBe(true);
    });

    it('keeps exactly one elevated card across successive selections (R3.7)', () => {
      const sequence: ExtendedCardValue[] = [0, 3, 'coffee', 13, 89, 'break', 1];

      for (const value of sequence) {
        component.selectCard(value);
        fixture.detectChanges();

        const selected = selectedButtons();
        expect(selected).toHaveLength(1);

        const expectedLabel = component.cards.find((c) => c.value === value)!.ariaLabel;
        expect(selected[0].getAttribute('aria-label')).toBe(expectedLabel);
        expect(selected[0].getAttribute('aria-pressed')).toBe('true');

        // Every other card is back to aria-pressed=false, i.e. lift 0 / scale 1.
        const pressed = allButtons().filter(
          (btn) => btn.getAttribute('aria-pressed') === 'true'
        );
        expect(pressed).toHaveLength(1);
        expect(component.isSelected(value)).toBe(true);
      }
    });

    it('resets the elevation when a new round starts (R3.8)', () => {
      component.selectCard(8);
      fixture.detectChanges();
      expect(selectedButtons()).toHaveLength(1);

      roundStarted.next({ roundId: 'round-2' });
      fixture.detectChanges();

      expect(selectedButtons()).toHaveLength(0);
      expect(component.isSelected(8)).toBe(false);
      expect(
        allButtons().every((btn) => btn.getAttribute('aria-pressed') === 'false')
      ).toBe(true);
    });

    it('resets the elevation when the board is cleared (R3.8)', () => {
      component.selectCard(21);
      fixture.detectChanges();
      expect(selectedButtons()).toHaveLength(1);

      boardCleared.next({});
      fixture.detectChanges();

      expect(selectedButtons()).toHaveLength(0);
      expect(component.isSelected(21)).toBe(false);
    });

    it('elevates no card once the round leaves the voting status (R3.8)', () => {
      component.selectCard(5);
      fixture.detectChanges();

      roundSignal.set({ ...VOTING_ROUND, status: 'revealed' });
      fixture.detectChanges();

      expect(component.isRoundActive()).toBe(false);
      // Cards are disabled, so no further selection can raise another card.
      expect(allButtons().every((btn) => btn.disabled)).toBe(true);
      component.selectCard(13);
      fixture.detectChanges();
      expect(selectedButtons()).toHaveLength(1);
      expect(component.isSelected(5)).toBe(true);
    });

    it('keeps the aria-pressed state and the selection announcement (R3.10)', () => {
      const deck = (fixture.nativeElement as HTMLElement).querySelector('.card-deck');
      expect(deck?.getAttribute('role')).toBe('radiogroup');
      expect(deck?.getAttribute('aria-label')).toBe('Estimation cards');

      component.selectCard(8);
      fixture.detectChanges();

      const announcer = (fixture.nativeElement as HTMLElement).querySelector(
        '.card-deck__announcer'
      );
      expect(announcer?.getAttribute('role')).toBe('status');
      expect(announcer?.getAttribute('aria-live')).toBe('polite');
      expect(announcer?.getAttribute('aria-atomic')).toBe('true');
      expect(announcer?.textContent?.trim()).toBe('Selected: Estimate 8 points');

      component.selectCard('coffee');
      fixture.detectChanges();
      expect(announcer?.textContent?.trim()).toBe('Selected: Coffee');
    });

    it('keeps an accessible name on every card (R3.10)', () => {
      for (const btn of allButtons()) {
        expect(btn.getAttribute('aria-label')).toBeTruthy();
        expect(btn.getAttribute('aria-pressed')).not.toBeNull();
      }
    });
  });
});
