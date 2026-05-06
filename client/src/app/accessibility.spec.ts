import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import axe from 'axe-core';
import { CardDeckComponent } from './components/card-deck/card-deck.component';
import { BoardComponent } from './components/board/board.component';
import { SessionHistoryComponent } from './components/session-history/session-history.component';
import { MetricsComponent } from './components/metrics/metrics.component';
import { StoryManagerComponent } from './components/story-manager/story-manager.component';
import { ProfileComponent } from './components/profile/profile.component';
import { SessionStateService } from './services/session-state.service';
import { WebSocketService } from './services/websocket.service';
import {
  User,
  VotingRound,
  HistoryEntry,
  VotingMetrics,
  CardValue,
} from '@shared/types';

function createMockSessionState(overrides: Record<string, any> = {}) {
  return {
    currentRound: signal<VotingRound | null>(null).asReadonly(),
    participants: signal<User[]>([]).asReadonly(),
    selections: signal<Map<string, CardValue>>(new Map()).asReadonly(),
    isRevealed: signal(false).asReadonly(),
    metrics: signal<VotingMetrics | null>(null).asReadonly(),
    history: signal<HistoryEntry[]>([]).asReadonly(),
    currentUser: signal<User | null>(null).asReadonly(),
    issueList: signal([]).asReadonly(),
    sessionConfig: signal(null).asReadonly(),
    hasRevealPermission: signal(false).asReadonly(),
    hasIssuePermission: signal(false).asReadonly(),
    votedUserIds: signal(new Set()).asReadonly(),
    countdownActive: signal(false).asReadonly(),
    votingSystemCards: signal([]).asReadonly(),
    ...overrides,
  };
}

function createMockWsService() {
  return {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn().mockReturnValue(EMPTY),
    connectionState: signal('disconnected' as const),
  };
}

async function runAxe(element: HTMLElement): Promise<axe.AxeResults> {
  return axe.run(element, {
    rules: {
      // Disable region rule since components are tested in isolation
      region: { enabled: false },
      // Disable color-contrast in jsdom (unreliable without real rendering)
      'color-contrast': { enabled: false },
    },
  });
}

/**
 * Validates: Requirements 19.1, 19.2, 19.3, 19.4
 */
describe('Accessibility — axe-core automated audit', () => {
  let mockWsService: ReturnType<typeof createMockWsService>;

  beforeEach(() => {
    mockWsService = createMockWsService();
  });

  describe('CardDeckComponent', () => {
    it('should have no axe violations', async () => {
      const roundSignal = signal<VotingRound | null>({
        id: 'r1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState({
              currentRound: roundSignal.asReadonly(),
            }),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const results = await runAxe(fixture.nativeElement);
      expect(results.violations).toEqual([]);
    });

    it('should have ARIA labels on all card buttons', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll(
        '.card-deck__card'
      ) as NodeListOf<HTMLButtonElement>;
      expect(buttons.length).toBe(14);
      buttons.forEach((btn: HTMLButtonElement) => {
        expect(btn.getAttribute('aria-label')).toBeTruthy();
      });
    });

    it('should have aria-pressed on card buttons', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll(
        '.card-deck__card'
      ) as NodeListOf<HTMLButtonElement>;
      buttons.forEach((btn: HTMLButtonElement) => {
        expect(btn.getAttribute('aria-pressed')).toBe('false');
      });
    });

    it('should have role="radiogroup" on the card deck container', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const deck = fixture.nativeElement.querySelector('.card-deck');
      expect(deck.getAttribute('role')).toBe('radiogroup');
      expect(deck.getAttribute('aria-label')).toBe('Estimation cards');
    });
  });

  describe('CardDeckComponent — ARIA live region', () => {
    it('should have an ARIA live region for selection announcements', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const announcer = fixture.nativeElement.querySelector(
        '.card-deck__announcer'
      );
      expect(announcer).toBeTruthy();
      expect(announcer.getAttribute('aria-live')).toBe('polite');
      expect(announcer.getAttribute('role')).toBe('status');
    });

    it('should announce card selection to screen readers', () => {
      const roundSignal = signal<VotingRound | null>({
        id: 'r1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState({
              currentRound: roundSignal.asReadonly(),
            }),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      fixture.componentInstance.selectCard(5);
      fixture.detectChanges();

      const announcer = fixture.nativeElement.querySelector(
        '.card-deck__announcer'
      );
      expect(announcer.textContent.trim()).toContain('Selected');
    });
  });

  describe('BoardComponent', () => {
    it('should have no axe violations', async () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState({
              participants: signal<User[]>([
                {
                  id: 'u1',
                  displayName: 'Alice',
                  role: 'participant' as const,
                  isAnonymous: false,
                },
              ]).asReadonly(),
            }),
          },
        ],
      });

      const fixture = TestBed.createComponent(BoardComponent);
      fixture.detectChanges();

      const results = await runAxe(fixture.nativeElement);
      expect(results.violations).toEqual([]);
    });

    it('should have an ARIA live region for board announcements', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
        ],
      });

      const fixture = TestBed.createComponent(BoardComponent);
      fixture.detectChanges();

      const announcer = fixture.nativeElement.querySelector(
        '.board__announcer'
      );
      expect(announcer).toBeTruthy();
      expect(announcer.getAttribute('aria-live')).toBe('polite');
      expect(announcer.getAttribute('role')).toBe('status');
    });
  });

  describe('SessionHistoryComponent', () => {
    it('should have no axe violations', async () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(SessionHistoryComponent);
      fixture.detectChanges();

      const results = await runAxe(fixture.nativeElement);
      expect(results.violations).toEqual([]);
    });

    it('should have aria-expanded on history item headers', () => {
      const entry: HistoryEntry = {
        roundId: 'r1',
        storyDescription: 'Test story',
        participants: [
          { userId: 'u1', displayName: 'Alice', cardValue: 5 },
        ],
        metrics: {
          average: 5,
          mode: 5,
          spread: 0,
          distribution: { '5': 1 },
          outliers: [],
          numericVoteCount: 1,
          insufficientData: false,
        },
        completedAt: new Date().toISOString(),
      };

      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState({
              history: signal<HistoryEntry[]>([entry]).asReadonly(),
            }),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(SessionHistoryComponent);
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector(
        '.session-history__item-header'
      );
      expect(header).toBeTruthy();
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('Keyboard navigation', () => {
    it('should allow card selection via keyboard (Enter/Space handlers exist)', () => {
      const roundSignal = signal<VotingRound | null>({
        id: 'r1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState({
              currentRound: roundSignal.asReadonly(),
            }),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      // Simulate Enter key on a card button
      const firstCard = fixture.nativeElement.querySelector(
        '.card-deck__card'
      ) as HTMLButtonElement;
      firstCard.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      fixture.detectChanges();

      // The card should be selectable via keyboard
      expect(mockWsService.send).toHaveBeenCalled();
    });

    it('should have focus-visible styles (buttons have tabindex by default)', () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SessionStateService,
            useValue: createMockSessionState(),
          },
          { provide: WebSocketService, useValue: mockWsService },
        ],
      });

      const fixture = TestBed.createComponent(CardDeckComponent);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll(
        'button'
      ) as NodeListOf<HTMLButtonElement>;
      // All buttons should be focusable (no negative tabindex)
      buttons.forEach((btn: HTMLButtonElement) => {
        const tabIndex = btn.getAttribute('tabindex');
        expect(tabIndex === null || Number(tabIndex) >= 0).toBe(true);
      });
    });
  });
});
