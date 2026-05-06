import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { Observable, EMPTY, Subject } from 'rxjs';
import {
  BoardComponent,
  deriveBoardCards,
  getCardDisplayText,
  calculateStaggerDelay,
  calculateClearAnimationDuration,
  prefersReducedMotion,
} from './board.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { User, CardValue, VotingRound } from '@shared/types';

describe('BoardComponent', () => {
  let component: BoardComponent;
  let participantsSignal: WritableSignal<User[]>;
  let selectionsSignal: WritableSignal<Map<string, CardValue>>;
  let isRevealedSignal: WritableSignal<boolean>;
  let votedUserIdsSignal: WritableSignal<Set<string>>;

  beforeEach(() => {
    participantsSignal = signal<User[]>([]);
    selectionsSignal = signal<Map<string, CardValue>>(new Map());
    isRevealedSignal = signal<boolean>(false);
    votedUserIdsSignal = signal<Set<string>>(new Set());

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: participantsSignal.asReadonly(),
      selections: selectionsSignal.asReadonly(),
      isRevealed: isRevealedSignal.asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: signal(null).asReadonly(),
      votedUserIds: votedUserIdsSignal.asReadonly(),
    };

    const mockWsService = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    const mockAuthService = {
      getCurrentUser: vi.fn().mockReturnValue(signal(null)),
      getToken: vi.fn().mockReturnValue(null),
      login: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    const fixture = TestBed.createComponent(BoardComponent);
    component = fixture.componentInstance;
  });

  describe('stars animation integration', () => {
    beforeEach(() => {
      // Mock matchMedia for the stars animation component
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    });

    it('should not trigger stars animation on initial state (already revealed on reconnect)', () => {
      // Simulate reconnect to already-revealed state: isRevealed starts as true
      // The previousRevealState is null initially, so it should NOT trigger
      expect(component.starsActive()).toBe(false);
    });

    it('should trigger stars animation on reveal transition (false → true)', () => {
      // First set to false to establish previous state
      isRevealedSignal.set(false);
      TestBed.flushEffects();
      expect(component.starsActive()).toBe(false);

      // Now transition to true
      isRevealedSignal.set(true);
      TestBed.flushEffects();
      expect(component.starsActive()).toBe(true);
    });

    it('should reset stars animation when reveal goes back to false', () => {
      isRevealedSignal.set(false);
      TestBed.flushEffects();
      isRevealedSignal.set(true);
      TestBed.flushEffects();
      expect(component.starsActive()).toBe(true);

      isRevealedSignal.set(false);
      TestBed.flushEffects();
      expect(component.starsActive()).toBe(false);
    });
  });

  describe('participant placeholders', () => {
    it('should display no cards when there are no participants', () => {
      expect(component.boardCards().length).toBe(0);
    });

    it('should display one card per participant', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
        { id: 'u3', displayName: 'Charlie', role: 'moderator', isAnonymous: false },
      ]);

      expect(component.boardCards().length).toBe(3);
    });

    it('should include participant display names', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);

      expect(component.boardCards()[0].displayName).toBe('Alice');
    });
  });

  describe('face-down state (pre-reveal)', () => {
    beforeEach(() => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(false);
    });

    it('should not expose card values before reveal', () => {
      selectionsSignal.set(new Map([['u1', 5 as CardValue]]));

      const cards = component.boardCards();
      expect(cards[0].cardValue).toBeNull();
      expect(cards[1].cardValue).toBeNull();
    });

    it('should indicate voted status without revealing value', () => {
      selectionsSignal.set(new Map([['u1', 8 as CardValue]]));

      const cards = component.boardCards();
      expect(cards[0].hasVoted).toBe(true);
      expect(cards[1].hasVoted).toBe(false);
    });

    it('should show "Voted ✓" text for participants who voted', () => {
      selectionsSignal.set(new Map([['u1', 13 as CardValue]]));

      const cards = component.boardCards();
      expect(component.getDisplayText(cards[0])).toBe('Voted ✓');
    });

    it('should show empty text for participants who have not voted', () => {
      const cards = component.boardCards();
      expect(component.getDisplayText(cards[0])).toBe('');
      expect(component.getDisplayText(cards[1])).toBe('');
    });
  });

  describe('face-up state (post-reveal)', () => {
    beforeEach(() => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
        { id: 'u3', displayName: 'Charlie', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(true);
    });

    it('should show selected card value after reveal', () => {
      selectionsSignal.set(
        new Map<string, CardValue>([
          ['u1', 5],
          ['u2', 13],
        ])
      );

      const cards = component.boardCards();
      expect(cards[0].cardValue).toBe(5);
      expect(cards[1].cardValue).toBe(13);
    });

    it('should show "No Vote" for participants who did not vote', () => {
      selectionsSignal.set(new Map<string, CardValue>([['u1', 5]]));

      const cards = component.boardCards();
      expect(component.getDisplayText(cards[2])).toBe('No Vote');
    });

    it('should show card value as string for voted participants', () => {
      selectionsSignal.set(new Map<string, CardValue>([['u1', 21]]));

      const cards = component.boardCards();
      expect(component.getDisplayText(cards[0])).toBe('21');
    });

    it('should show special card values after reveal', () => {
      selectionsSignal.set(new Map<string, CardValue>([['u1', 'coffee']]));

      const cards = component.boardCards();
      expect(component.getDisplayText(cards[0])).toBe('coffee');
    });
  });

  describe('ARIA announcements', () => {
    it('should announce when cards are revealed', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map<string, CardValue>([['u1', 5]]));
      isRevealedSignal.set(true);

      expect(component.announcement()).toBe('Cards have been revealed');
    });

    it('should announce vote count during voting', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map<string, CardValue>([['u1', 5]]));
      isRevealedSignal.set(false);

      expect(component.announcement()).toBe('1 of 2 participants have voted');
    });

    it('should have empty announcement when no votes and not revealed', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(false);

      expect(component.announcement()).toBe('');
    });
  });
});

describe('deriveBoardCards (pure function)', () => {
  it('should return empty array for empty participants', () => {
    const result = deriveBoardCards([], new Map(), false);
    expect(result).toEqual([]);
  });

  it('should map participants to board cards with correct structure', () => {
    const participants: User[] = [
      { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
    ];
    const result = deriveBoardCards(participants, new Map(), false);

    expect(result[0]).toEqual({
      userId: 'u1',
      displayName: 'Alice',
      hasVoted: false,
      cardValue: null,
    });
  });
});

describe('getCardDisplayText (pure function)', () => {
  it('should return "Voted ✓" for voted card in pre-reveal', () => {
    const card = { userId: 'u1', displayName: 'A', hasVoted: true, cardValue: null };
    expect(getCardDisplayText(card, false)).toBe('Voted ✓');
  });

  it('should return empty string for non-voted card in pre-reveal', () => {
    const card = { userId: 'u1', displayName: 'A', hasVoted: false, cardValue: null };
    expect(getCardDisplayText(card, false)).toBe('');
  });

  it('should return card value as string in post-reveal', () => {
    const card = { userId: 'u1', displayName: 'A', hasVoted: true, cardValue: 8 as CardValue };
    expect(getCardDisplayText(card, true)).toBe('8');
  });

  it('should return "No Vote" for null card value in post-reveal', () => {
    const card = { userId: 'u1', displayName: 'A', hasVoted: false, cardValue: null };
    expect(getCardDisplayText(card, true)).toBe('No Vote');
  });
});


/**
 * Board Clear Animation Tests
 * Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.5
 */
describe('board clear animation', () => {
  describe('calculateStaggerDelay (pure function)', () => {
    it('should return 0 for index 0', () => {
      expect(calculateStaggerDelay(0)).toBe(0);
    });

    it('should return 50 for index 1', () => {
      expect(calculateStaggerDelay(1)).toBe(50);
    });

    it('should return 250 for index 5', () => {
      expect(calculateStaggerDelay(5)).toBe(250);
    });

    it('should return index * 50 for any index', () => {
      expect(calculateStaggerDelay(10)).toBe(500);
    });
  });

  describe('calculateClearAnimationDuration (pure function)', () => {
    it('should return 0 for 0 cards', () => {
      expect(calculateClearAnimationDuration(0)).toBe(0);
    });

    it('should return 400 for 1 card', () => {
      expect(calculateClearAnimationDuration(1)).toBe(400);
    });

    it('should return 450 for 2 cards', () => {
      expect(calculateClearAnimationDuration(2)).toBe(450);
    });

    it('should return 400 + (n-1)*50 for n cards', () => {
      expect(calculateClearAnimationDuration(5)).toBe(600);
      expect(calculateClearAnimationDuration(10)).toBe(850);
    });
  });

  describe('triggerClearAnimation (component)', () => {
    let component: BoardComponent;
    let participantsSignal: WritableSignal<User[]>;
    let selectionsSignal: WritableSignal<Map<string, CardValue>>;
    let isRevealedSignal: WritableSignal<boolean>;
    let votedUserIdsSignal: WritableSignal<Set<string>>;

    beforeEach(() => {
      vi.useFakeTimers();

      participantsSignal = signal<User[]>([]);
      selectionsSignal = signal<Map<string, CardValue>>(new Map());
      isRevealedSignal = signal<boolean>(false);
      votedUserIdsSignal = signal<Set<string>>(new Set());

      const mockSessionState = {
        currentRound: signal(null).asReadonly(),
        participants: participantsSignal.asReadonly(),
        selections: selectionsSignal.asReadonly(),
        isRevealed: isRevealedSignal.asReadonly(),
        metrics: signal(null).asReadonly(),
        history: signal([]).asReadonly(),
        currentUser: signal(null).asReadonly(),
        votedUserIds: votedUserIdsSignal.asReadonly(),
      };

      const mockWsService = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        send: vi.fn(),
        on: vi.fn().mockReturnValue(EMPTY),
        connectionState: signal('disconnected' as const),
      };

      const mockAuthService = {
        getCurrentUser: vi.fn().mockReturnValue(signal(null)),
        getToken: vi.fn().mockReturnValue(null),
        login: vi.fn(),
        validateSession: vi.fn(),
        logout: vi.fn(),
      };

      TestBed.configureTestingModule({
        providers: [
          { provide: SessionStateService, useValue: mockSessionState },
          { provide: WebSocketService, useValue: mockWsService },
          { provide: AuthService, useValue: mockAuthService },
        ],
      });

      const fixture = TestBed.createComponent(BoardComponent);
      component = fixture.componentInstance;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should set clearing to true and snapshot clearingCards when triggered', () => {
      // Mock matchMedia to return no reduced motion
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });

      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(
        new Map<string, CardValue>([
          ['u1', 5],
          ['u2', 8],
        ])
      );
      isRevealedSignal.set(true);

      component.triggerClearAnimation();

      expect(component.clearing()).toBe(true);
      expect(component.clearingCards().length).toBe(2);
      expect(component.clearingCards()[0].displayName).toBe('Alice');
      expect(component.clearingCards()[1].displayName).toBe('Bob');
    });

    it('should not enter clearing state when there are no cards', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });

      component.triggerClearAnimation();

      expect(component.clearing()).toBe(false);
      expect(component.clearingCards().length).toBe(0);
    });

    it('should reset clearing to false after animation duration elapses', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });

      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
        { id: 'u3', displayName: 'Charlie', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(
        new Map<string, CardValue>([
          ['u1', 3],
          ['u2', 5],
          ['u3', 8],
        ])
      );
      isRevealedSignal.set(true);

      component.triggerClearAnimation();
      expect(component.clearing()).toBe(true);

      // Total duration for 3 cards: 400 + (3-1)*50 = 500ms
      vi.advanceTimersByTime(500);

      expect(component.clearing()).toBe(false);
      expect(component.clearingCards().length).toBe(0);
    });

    it('should still be clearing before animation duration fully elapses', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });

      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map<string, CardValue>([['u1', 5], ['u2', 8]]));
      isRevealedSignal.set(true);

      component.triggerClearAnimation();

      // Total duration for 2 cards: 400 + (2-1)*50 = 450ms
      // Advance only 400ms — should still be clearing
      vi.advanceTimersByTime(400);
      expect(component.clearing()).toBe(true);

      // Advance the remaining 50ms
      vi.advanceTimersByTime(50);
      expect(component.clearing()).toBe(false);
    });

    it('should reset immediately without timer when reduced motion is preferred', () => {
      // Mock matchMedia to indicate reduced motion preference
      window.matchMedia = vi.fn().mockReturnValue({ matches: true });

      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map<string, CardValue>([['u1', 13]]));
      isRevealedSignal.set(true);

      component.triggerClearAnimation();

      // With reduced motion, clearing should be false immediately (no animation)
      expect(component.clearing()).toBe(false);
      expect(component.clearingCards().length).toBe(0);
    });
  });

  describe('prefersReducedMotion (pure function)', () => {
    it('should return true when matchMedia indicates reduced motion', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true });

      expect(prefersReducedMotion()).toBe(true);
    });

    it('should return false when matchMedia indicates no reduced motion preference', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: false });

      expect(prefersReducedMotion()).toBe(false);
    });
  });
});
