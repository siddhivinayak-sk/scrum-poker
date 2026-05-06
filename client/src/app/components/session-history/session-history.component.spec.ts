import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import {
  SessionHistoryComponent,
  deriveHistorySummary,
} from './session-history.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { User, HistoryEntry, VotingMetrics } from '@shared/types';

function makeMetrics(overrides: Partial<VotingMetrics> = {}): VotingMetrics {
  return {
    average: 5,
    mode: 5,
    spread: 4,
    distribution: { '3': 1, '5': 2, '8': 1 },
    outliers: [],
    numericVoteCount: 4,
    insufficientData: false,
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    roundId: 'r1',
    storyDescription: 'Test story',
    participants: [
      { userId: 'u1', displayName: 'Alice', cardValue: 5 },
      { userId: 'u2', displayName: 'Bob', cardValue: 8 },
    ],
    metrics: makeMetrics(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionHistoryComponent', () => {
  let component: SessionHistoryComponent;
  let mockWsService: { send: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; connectionState: ReturnType<typeof signal> };
  let currentUserSignal: WritableSignal<User | null>;
  let historySignal: WritableSignal<HistoryEntry[]>;

  beforeEach(() => {
    currentUserSignal = signal<User | null>(null);
    historySignal = signal<HistoryEntry[]>([]);

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: signal(false).asReadonly(),
      metrics: signal(null).asReadonly(),
      history: historySignal.asReadonly(),
      currentUser: currentUserSignal.asReadonly(),
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

    const fixture = TestBed.createComponent(SessionHistoryComponent);
    component = fixture.componentInstance;
  });

  describe('history listing', () => {
    it('should show empty message when no history entries', () => {
      expect(component.history().length).toBe(0);
    });

    it('should list history entries', () => {
      historySignal.set([
        makeHistoryEntry({ roundId: 'r1', storyDescription: 'Story 1' }),
        makeHistoryEntry({ roundId: 'r2', storyDescription: 'Story 2' }),
      ]);
      expect(component.history().length).toBe(2);
    });

    it('should derive correct summary for an entry', () => {
      const entry = makeHistoryEntry({
        metrics: makeMetrics({ average: 6.5, mode: 8 }),
      });
      const summary = component.getSummary(entry);
      expect(summary.average).toBe('6.5');
      expect(summary.mode).toBe('8');
    });
  });

  describe('expandable detail view', () => {
    it('should not be expanded by default', () => {
      expect(component.isExpanded('r1')).toBe(false);
    });

    it('should expand when toggled', () => {
      component.toggleExpand('r1');
      expect(component.isExpanded('r1')).toBe(true);
    });

    it('should collapse when toggled again', () => {
      component.toggleExpand('r1');
      component.toggleExpand('r1');
      expect(component.isExpanded('r1')).toBe(false);
    });

    it('should allow multiple entries to be expanded independently', () => {
      component.toggleExpand('r1');
      component.toggleExpand('r2');
      expect(component.isExpanded('r1')).toBe(true);
      expect(component.isExpanded('r2')).toBe(true);
    });
  });

  describe('moderator-only clear history', () => {
    it('should show clear button only for moderators', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(true);
    });

    it('should not show clear button for participants', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(false);
    });

    it('should show confirmation dialog when clear is prompted', () => {
      component.promptClearHistory();
      expect(component.showConfirmDialog()).toBe(true);
    });

    it('should hide confirmation dialog on cancel', () => {
      component.promptClearHistory();
      component.cancelClear();
      expect(component.showConfirmDialog()).toBe(false);
    });

    it('should send history:clear event on confirm', () => {
      component.promptClearHistory();
      component.confirmClear();
      expect(mockWsService.send).toHaveBeenCalledWith('history:clear', {});
      expect(component.showConfirmDialog()).toBe(false);
    });

    it('should not send event if cancelled', () => {
      component.promptClearHistory();
      component.cancelClear();
      expect(mockWsService.send).not.toHaveBeenCalled();
    });
  });
});

describe('deriveHistorySummary (pure function)', () => {
  it('should format average to one decimal place', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ average: 3.666 }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.average).toBe('3.7');
  });

  it('should show dash for null average', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ average: null }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.average).toBe('—');
  });

  it('should show dash for null mode', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ mode: null }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.mode).toBe('—');
  });

  it('should include story description and roundId', () => {
    const entry = makeHistoryEntry({
      roundId: 'abc',
      storyDescription: 'My story',
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.roundId).toBe('abc');
    expect(summary.storyDescription).toBe('My story');
  });
});
