import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { Observable, EMPTY } from 'rxjs';
import {
  CardDeckComponent,
  CARD_COLOR_MAP,
  SPECIAL_CARD_COLOR_MAP,
  SPECIAL_CARD_LABELS,
  getCardColor,
} from './card-deck.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import {
  VotingRound,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
  NumericCardValue,
  SpecialCardValue,
  ExtendedCardValue,
  VOTING_SYSTEMS,
  getCardsForVotingSystem,
  VotingSystemType,
} from '@shared/types';

describe('CardDeckComponent', () => {
  let component: CardDeckComponent;
  let mockWsService: { send: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; connectionState: ReturnType<typeof signal> };
  let roundSignal: ReturnType<typeof signal<VotingRound | null>>;
  let votingSystemCardsSignal: WritableSignal<ExtendedCardValue[]>;

  beforeEach(() => {
    roundSignal = signal<VotingRound | null>(null);
    votingSystemCardsSignal = signal<ExtendedCardValue[]>([]);

    const mockSessionState = {
      currentRound: roundSignal.asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: signal(false).asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: signal(null).asReadonly(),
      votingSystemCards: votingSystemCardsSignal.asReadonly(),
      sessionConfig: signal(null).asReadonly(),
      hasIssuePermission: signal(false).asReadonly(),
      hasRevealPermission: signal(false).asReadonly(),
      countdownActive: signal(false).asReadonly(),
      votedUserIds: signal(new Set()).asReadonly(),
    };

    mockWsService = {
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
      ],
    });

    const fixture = TestBed.createComponent(CardDeckComponent);
    component = fixture.componentInstance;
  });

  describe('card rendering', () => {
    it('should have exactly 14 cards', () => {
      expect(component.cards.length).toBe(14);
    });

    it('should include all 11 numeric Fibonacci values', () => {
      const numericValues = component.cards
        .filter((c) => typeof c.value === 'number')
        .map((c) => c.value);
      expect(numericValues).toEqual([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
    });

    it('should include 3 special cards: coffee, no-clue, break', () => {
      const specialValues = component.cards
        .filter((c) => typeof c.value === 'string')
        .map((c) => c.value);
      expect(specialValues).toEqual(['coffee', 'no-clue', 'break']);
    });

    it('should display ☕ for coffee card', () => {
      const coffeeCard = component.cards.find((c) => c.value === 'coffee');
      expect(coffeeCard!.label).toBe('☕');
    });

    it('should display ? for no-clue card', () => {
      const noClueCard = component.cards.find((c) => c.value === 'no-clue');
      expect(noClueCard!.label).toBe('?');
    });

    it('should display ⏸ for break card', () => {
      const breakCard = component.cards.find((c) => c.value === 'break');
      expect(breakCard!.label).toBe('⏸');
    });

    it('should have ARIA labels for all cards', () => {
      for (const card of component.cards) {
        expect(card.ariaLabel).toBeTruthy();
        expect(card.ariaLabel.length).toBeGreaterThan(0);
      }
    });
  });

  describe('selection highlighting', () => {
    it('should not have any card selected initially', () => {
      for (const card of component.cards) {
        expect(component.isSelected(card.value)).toBe(false);
      }
    });

    it('should highlight the selected card after selection', () => {
      // Activate a round so selection works
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.selectCard(5);

      expect(component.isSelected(5)).toBe(true);
      expect(component.isSelected(3)).toBe(false);
    });

    it('should replace previous selection when a new card is selected', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.selectCard(3);
      expect(component.isSelected(3)).toBe(true);

      component.selectCard(8);
      expect(component.isSelected(8)).toBe(true);
      expect(component.isSelected(3)).toBe(false);
    });
  });

  describe('disabled state', () => {
    it('should not be active when no round exists', () => {
      expect(component.isRoundActive()).toBe(false);
    });

    it('should be active when a voting round is in progress', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      expect(component.isRoundActive()).toBe(true);
    });

    it('should not be active when round status is revealed', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'revealed',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      expect(component.isRoundActive()).toBe(false);
    });

    it('should not send selection when round is not active', () => {
      component.selectCard(5);
      expect(mockWsService.send).not.toHaveBeenCalled();
    });
  });

  describe('WebSocket integration', () => {
    it('should send card:select event when a card is selected during active round', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.selectCard(13);

      expect(mockWsService.send).toHaveBeenCalledWith('card:select', { cardValue: 13 });
    });

    it('should send card:select for special cards', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.selectCard('coffee');

      expect(mockWsService.send).toHaveBeenCalledWith('card:select', { cardValue: 'coffee' });
    });
  });

  describe('color mapping', () => {
    it('should map every numeric Fibonacci value to a CSS custom property', () => {
      for (const value of FIBONACCI_SEQUENCE) {
        expect(CARD_COLOR_MAP[value]).toBe(`var(--card-color-${value})`);
      }
    });

    it('should map every special card to its CSS custom property', () => {
      expect(SPECIAL_CARD_COLOR_MAP['coffee']).toBe('var(--card-color-coffee)');
      expect(SPECIAL_CARD_COLOR_MAP['no-clue']).toBe('var(--card-color-no-clue)');
      expect(SPECIAL_CARD_COLOR_MAP['break']).toBe('var(--card-color-break)');
    });

    it('getCardColor should return the correct color for numeric values', () => {
      expect(getCardColor(0)).toBe('var(--card-color-0)');
      expect(getCardColor(13)).toBe('var(--card-color-13)');
      expect(getCardColor(89)).toBe('var(--card-color-89)');
    });

    it('getCardColor should return the correct color for special values', () => {
      expect(getCardColor('coffee')).toBe('var(--card-color-coffee)');
      expect(getCardColor('no-clue')).toBe('var(--card-color-no-clue)');
      expect(getCardColor('break')).toBe('var(--card-color-break)');
    });

    it('every card display should have a color property', () => {
      for (const card of component.cards) {
        expect(card.color).toBeTruthy();
        expect(card.color).toContain('var(--card-color-');
      }
    });
  });

  describe('special card labels', () => {
    it('should have textLabel "Coffee" on the coffee card', () => {
      const coffeeCard = component.cards.find((c) => c.value === 'coffee');
      expect(coffeeCard!.textLabel).toBe('Coffee');
    });

    it('should have textLabel "Unknown" on the no-clue card', () => {
      const noClueCard = component.cards.find((c) => c.value === 'no-clue');
      expect(noClueCard!.textLabel).toBe('Unknown');
    });

    it('should have textLabel "Break" on the break card', () => {
      const breakCard = component.cards.find((c) => c.value === 'break');
      expect(breakCard!.textLabel).toBe('Break');
    });

    it('should not have textLabel on numeric cards', () => {
      const numericCards = component.cards.filter((c) => typeof c.value === 'number');
      for (const card of numericCards) {
        expect(card.textLabel).toBeUndefined();
      }
    });

    it('SPECIAL_CARD_LABELS should map all three special cards', () => {
      expect(SPECIAL_CARD_LABELS['coffee']).toEqual({ icon: '☕', label: 'Coffee' });
      expect(SPECIAL_CARD_LABELS['no-clue']).toEqual({ icon: '?', label: 'Unknown' });
      expect(SPECIAL_CARD_LABELS['break']).toEqual({ icon: '⏸', label: 'Break' });
    });
  });

  describe('value-based color coding', () => {
    it('should assign cooler color (lower index) to card 0 than card 89', () => {
      // The color scale uses CSS custom properties named by value.
      // Lower values map to cooler tones (blues/greens), higher to warmer (reds).
      // We verify the CSS variable names follow the expected pattern.
      const card0 = component.cards.find((c) => c.value === 0);
      const card89 = component.cards.find((c) => c.value === 89);
      expect(card0!.color).toBe('var(--card-color-0)');
      expect(card89!.color).toBe('var(--card-color-89)');
      // Different CSS custom properties confirm distinct color coding
      expect(card0!.color).not.toBe(card89!.color);
    });

    it('should assign distinct colors to each numeric card value', () => {
      const numericCards = component.cards.filter((c) => typeof c.value === 'number');
      const colors = numericCards.map((c) => c.color);
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(numericCards.length);
    });

    it('should assign distinct accent colors to special cards vs numeric cards', () => {
      const specialColors = component.cards
        .filter((c) => typeof c.value === 'string')
        .map((c) => c.color);
      const numericColors = component.cards
        .filter((c) => typeof c.value === 'number')
        .map((c) => c.color);
      // No special card color should match any numeric card color
      for (const sc of specialColors) {
        expect(numericColors).not.toContain(sc);
      }
    });
  });

  describe('selection animation CSS class', () => {
    it('should apply card-deck__card--selected class when a card is selected', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      const comp = fixture.componentInstance;
      comp.selectCard(8);
      fixture.detectChanges();

      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.card-deck__card'
      );
      const selectedButtons = Array.from(buttons).filter((btn) =>
        btn.classList.contains('card-deck__card--selected')
      );
      expect(selectedButtons.length).toBe(1);

      // Verify the selected button has the correct aria-label for card value 8
      expect(selectedButtons[0].getAttribute('aria-label')).toBe('Estimate 8 points');
    });

    it('should move selected class when a different card is chosen', () => {
      roundSignal.set({
        id: 'round-1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      const comp = fixture.componentInstance;

      comp.selectCard(3);
      fixture.detectChanges();

      comp.selectCard(13);
      fixture.detectChanges();

      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.card-deck__card'
      );
      const selectedButtons = Array.from(buttons).filter((btn) =>
        btn.classList.contains('card-deck__card--selected')
      );
      expect(selectedButtons.length).toBe(1);
      expect(selectedButtons[0].getAttribute('aria-label')).toBe('Estimate 13 points');
    });

    // Note: The actual CSS transform (translateY(-20px) scale(1.05)) and transition
    // (300ms ease-out) are defined in the component's styles block. These CSS-only
    // properties cannot be reliably tested in a JSDOM environment because JSDOM does
    // not compute CSS styles. The class application above confirms the correct CSS
    // class is toggled, which in a real browser triggers the animation.
  });

  describe('ARIA labels for special cards', () => {
    it('should set ARIA label to "Coffee" for the coffee card', () => {
      const coffeeCard = component.cards.find((c) => c.value === 'coffee');
      expect(coffeeCard!.ariaLabel).toBe('Coffee');
    });

    it('should set ARIA label to "Unknown" for the no-clue card', () => {
      const noClueCard = component.cards.find((c) => c.value === 'no-clue');
      expect(noClueCard!.ariaLabel).toBe('Unknown');
    });

    it('should set ARIA label to "Break" for the break card', () => {
      const breakCard = component.cards.find((c) => c.value === 'break');
      expect(breakCard!.ariaLabel).toBe('Break');
    });

    it('should set ARIA label with point value for numeric cards', () => {
      const card5 = component.cards.find((c) => c.value === 5);
      expect(card5!.ariaLabel).toBe('Estimate 5 points');

      const card0 = component.cards.find((c) => c.value === 0);
      expect(card0!.ariaLabel).toBe('Estimate 0 points');
    });

    it('should render aria-label attributes on card buttons in the template', () => {
      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.card-deck__card'
      );
      expect(buttons.length).toBe(14);

      // Verify special card buttons have the label text as aria-label
      const ariaLabels = Array.from(buttons).map((btn) =>
        btn.getAttribute('aria-label')
      );
      expect(ariaLabels).toContain('Coffee');
      expect(ariaLabels).toContain('Unknown');
      expect(ariaLabels).toContain('Break');
    });
  });

  // Note: CSS hover effects (:hover pseudo-class elevation/border changes) and
  // @media (prefers-reduced-motion: reduce) rules are CSS-only features that cannot
  // be unit tested in a JSDOM environment. JSDOM does not support :hover simulation
  // or media query evaluation. These visual behaviors are defined in the component's
  // inline styles and should be verified through visual regression testing or
  // end-to-end tests in a real browser. The tests above verify that the correct CSS
  // classes and inline styles are applied, which in a real browser trigger the
  // hover effects and respect reduced-motion preferences.

  describe('dynamic voting system card rendering', () => {
    it('should render correct cards for fibonacci voting system', () => {
      const fibCards = getCardsForVotingSystem('fibonacci');
      votingSystemCardsSignal.set(fibCards);

      const cards = component.cards;
      const values = cards.map((c) => c.value);

      // Should include all fibonacci values
      for (const v of VOTING_SYSTEMS['fibonacci']) {
        expect(values).toContain(v);
      }
      // Should include special cards
      for (const s of SPECIAL_CARDS) {
        expect(values).toContain(s);
      }
      expect(cards.length).toBe(VOTING_SYSTEMS['fibonacci'].length + SPECIAL_CARDS.length);
    });

    it('should render correct cards for modified-fibonacci voting system', () => {
      const modFibCards = getCardsForVotingSystem('modified-fibonacci');
      votingSystemCardsSignal.set(modFibCards);

      const cards = component.cards;
      const values = cards.map((c) => c.value);

      // Should include all modified-fibonacci values
      for (const v of VOTING_SYSTEMS['modified-fibonacci']) {
        expect(values).toContain(v);
      }
      // Verify specific modified-fibonacci values
      expect(values).toContain('½');
      expect(values).toContain(20);
      expect(values).toContain(40);
      expect(values).toContain(100);
      // Should include special cards
      for (const s of SPECIAL_CARDS) {
        expect(values).toContain(s);
      }
      expect(cards.length).toBe(VOTING_SYSTEMS['modified-fibonacci'].length + SPECIAL_CARDS.length);
    });

    it('should render correct cards for t-shirt voting system', () => {
      const tshirtCards = getCardsForVotingSystem('t-shirt');
      votingSystemCardsSignal.set(tshirtCards);

      const cards = component.cards;
      const values = cards.map((c) => c.value);

      // Should include all t-shirt values
      for (const v of VOTING_SYSTEMS['t-shirt']) {
        expect(values).toContain(v);
      }
      expect(values).toContain('XS');
      expect(values).toContain('S');
      expect(values).toContain('M');
      expect(values).toContain('L');
      expect(values).toContain('XL');
      expect(values).toContain('XXL');
      // Should include special cards
      for (const s of SPECIAL_CARDS) {
        expect(values).toContain(s);
      }
      expect(cards.length).toBe(VOTING_SYSTEMS['t-shirt'].length + SPECIAL_CARDS.length);
    });

    it('should render correct cards for power-of-2 voting system', () => {
      const pow2Cards = getCardsForVotingSystem('power-of-2');
      votingSystemCardsSignal.set(pow2Cards);

      const cards = component.cards;
      const values = cards.map((c) => c.value);

      // Should include all power-of-2 values
      for (const v of VOTING_SYSTEMS['power-of-2']) {
        expect(values).toContain(v);
      }
      expect(values).toContain(4);
      expect(values).toContain(16);
      expect(values).toContain(32);
      expect(values).toContain(64);
      // Should include special cards
      for (const s of SPECIAL_CARDS) {
        expect(values).toContain(s);
      }
      expect(cards.length).toBe(VOTING_SYSTEMS['power-of-2'].length + SPECIAL_CARDS.length);
    });

    it('should always include special cards regardless of voting system', () => {
      const systems: VotingSystemType[] = ['fibonacci', 'modified-fibonacci', 't-shirt', 'power-of-2'];

      for (const system of systems) {
        votingSystemCardsSignal.set(getCardsForVotingSystem(system));
        const cards = component.cards;
        const values = cards.map((c) => c.value);

        expect(values).toContain('coffee');
        expect(values).toContain('no-clue');
        expect(values).toContain('break');
      }
    });

    it('should update cards when voting system changes', () => {
      // Start with fibonacci
      votingSystemCardsSignal.set(getCardsForVotingSystem('fibonacci'));
      let cards = component.cards;
      expect(cards.length).toBe(VOTING_SYSTEMS['fibonacci'].length + SPECIAL_CARDS.length);
      expect(cards.map((c) => c.value)).toContain(89);
      expect(cards.map((c) => c.value)).not.toContain('XS');

      // Switch to t-shirt
      votingSystemCardsSignal.set(getCardsForVotingSystem('t-shirt'));
      cards = component.cards;
      expect(cards.length).toBe(VOTING_SYSTEMS['t-shirt'].length + SPECIAL_CARDS.length);
      expect(cards.map((c) => c.value)).toContain('XS');
      expect(cards.map((c) => c.value)).not.toContain(89);
    });

    it('should fall back to default Fibonacci cards when votingSystemCards is empty', () => {
      votingSystemCardsSignal.set([]);
      const cards = component.cards;
      // Default fallback is ALL_CARDS (Fibonacci + specials = 14)
      expect(cards.length).toBe(14);
      const values = cards.map((c) => c.value);
      expect(values).toContain(0);
      expect(values).toContain(89);
      expect(values).toContain('coffee');
    });
  });
});
