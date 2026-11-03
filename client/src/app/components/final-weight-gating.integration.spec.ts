/**
 * Final weight gating wired through the real FinalWeightGateService into the round-completing
 * entry points (facilitator-flow, story-manager, issue-list-panel), plus the weight display in the
 * issue list and session history.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 4.10, 4.11, 12.1, 12.10, 12.11, 13.4
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import {
  DEFAULT_SESSION_CONFIG,
  type ExtendedCardValue,
  type HistoryEntry,
  type IssueItem,
  type User,
} from '@shared/types';
import { FinalWeightGateService } from '../services/final-weight-gate.service';
import { SessionStateService } from '../services/session-state.service';
import { WebSocketService } from '../services/websocket.service';
import { FacilitatorFlowComponent } from './facilitator-flow/facilitator-flow.component';
import { StoryManagerComponent } from './story-manager/story-manager.component';
import { IssueListPanelComponent } from './issue-list-panel/issue-list-panel.component';
import { SessionHistoryComponent } from './session-history/session-history.component';

const MOD: User = { id: 'm', displayName: 'Mod', role: 'moderator', isAnonymous: false };
const PLAYER: User = { id: 'p', displayName: 'Pat', role: 'participant', isAnonymous: false };

const PENDING: IssueItem = {
  id: 'i1',
  title: 'Pending one',
  status: 'pending',
  createdAt: '2026-05-01T10:00:00.000Z',
};

describe('final weight gating at the entry points', () => {
  let subjects: Map<string, Subject<unknown>>;
  let send: ReturnType<typeof vi.fn>;
  let enabled: ReturnType<typeof signal<boolean>>;
  let user: ReturnType<typeof signal<User | null>>;
  let revealed: ReturnType<typeof signal<boolean>>;
  let round: ReturnType<typeof signal<{ id: string; status: string; storyDescription: string } | null>>;
  let issues: ReturnType<typeof signal<IssueItem[]>>;
  let history: ReturnType<typeof signal<HistoryEntry[]>>;
  let gate: FinalWeightGateService;

  const emit = (event: string, data: unknown): void => {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  };
  const tick = (): void => TestBed.tick();

  beforeEach(() => {
    subjects = new Map();
    send = vi.fn().mockReturnValue(true);
    enabled = signal(true);
    user = signal<User | null>(MOD);
    revealed = signal(true);
    round = signal({ id: 'r1', status: 'revealed', storyDescription: 'Story' });
    issues = signal<IssueItem[]>([PENDING]);
    history = signal<HistoryEntry[]>([]);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: WebSocketService,
          useValue: {
            send,
            connect: vi.fn(),
            disconnect: vi.fn(),
            connectionState: signal('connected'),
            on: <T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            },
          },
        },
        {
          provide: SessionStateService,
          useValue: {
            finalWeightEnabled: enabled,
            currentUser: user,
            isRevealed: revealed,
            currentRound: round,
            sessionConfig: signal({ ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true }),
            selections: signal(new Map<string, ExtendedCardValue>([['m', 3], ['p', 8]])),
            participants: signal([MOD, PLAYER]),
            issueList: issues,
            history,
            hasIssuePermission: signal(true),
            hasRevealPermission: signal(true),
            metrics: signal(null),
            votingSystemCards: signal([]),
            countdownActive: signal(false),
            votedUserIds: signal(new Set<string>()),
          },
        },
      ],
    });
    gate = TestBed.inject(FinalWeightGateService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface EntryPoint {
    name: string;
    trigger: () => void;
    event: string;
    payload: unknown;
  }

  function entryPoints(): EntryPoint[] {
    const flow = TestBed.createComponent(FacilitatorFlowComponent).componentInstance;
    const story = TestBed.createComponent(StoryManagerComponent).componentInstance;
    const list = TestBed.createComponent(IssueListPanelComponent).componentInstance;
    return [
      { name: 'facilitator-flow Clear', trigger: () => flow.clearAndNext(), event: 'board:clear', payload: {} },
      {
        name: 'facilitator-flow Next',
        trigger: () => flow.nextIssue(),
        event: 'issue:select',
        payload: { issueId: 'i1' },
      },
      { name: 'story-manager clearBoard', trigger: () => story.clearBoard(), event: 'board:clear', payload: {} },
      {
        name: 'story-manager story submit',
        trigger: () => {
          story.storyDescription = 'Next story';
          story.submitStory();
        },
        event: 'story:submit',
        payload: { storyDescription: 'Next story' },
      },
      {
        name: 'issue-list selectIssue',
        trigger: () => list.selectIssue('i1'),
        event: 'issue:select',
        payload: { issueId: 'i1' },
      },
    ];
  }

  const NAMES = [
    'facilitator-flow Clear',
    'facilitator-flow Next',
    'story-manager clearBoard',
    'story-manager story submit',
    'issue-list selectIssue',
  ];

  describe.each(NAMES)('%s', (name) => {
    const point = (): EntryPoint => entryPoints().find((p) => p.name === name)!;

    it('feature off: runs synchronously, no dialog, no final weight traffic', () => {
      enabled.set(false);
      const p = point();
      p.trigger();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(p.event, p.payload);
      expect(gate.dialog()).toBeNull();
    });

    it('non-moderator: runs synchronously', () => {
      user.set(PLAYER);
      const p = point();
      p.trigger();
      expect(send).toHaveBeenCalledWith(p.event, p.payload);
      expect(gate.dialog()).toBeNull();
    });

    it('moderator but round not revealed: runs synchronously', () => {
      revealed.set(false);
      const p = point();
      p.trigger();
      expect(send).toHaveBeenCalledWith(p.event, p.payload);
      expect(gate.dialog()).toBeNull();
    });

    it('moderator + revealed: opens the dialog and defers the action', () => {
      const p = point();
      p.trigger();
      expect(gate.dialog()).not.toBeNull();
      expect(gate.dialog()!.roundId).toBe('r1');
      expect(send).not.toHaveBeenCalled();
    });

    it('Skip runs the deferred action once', () => {
      const p = point();
      p.trigger();
      gate.skip();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(p.event, p.payload);
      expect(gate.dialog()).toBeNull();
    });

    it('Cancel drops the action', () => {
      const p = point();
      p.trigger();
      gate.cancel();
      expect(send).not.toHaveBeenCalled();
      expect(gate.dialog()).toBeNull();
    });

    it('Confirm sends the weight first and the action only after the ack', () => {
      const p = point();
      p.trigger();
      gate.confirm({ value: 5, showFunniest: false });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBe('finalweight:submit');
      emit('finalweight:set', { roundId: 'r1' });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]).toEqual([p.event, p.payload]);
    });
  });

  it('story submit keeps the typed text when the dialog is cancelled', () => {
    const story = TestBed.createComponent(StoryManagerComponent).componentInstance;
    story.storyDescription = 'Keep me';
    story.submitStory();
    gate.cancel();
    expect(story.storyDescription).toBe('Keep me');
    expect(send).not.toHaveBeenCalled();
  });

  it('Re-Vote is never gated', () => {
    const flow = TestBed.createComponent(FacilitatorFlowComponent).componentInstance;
    const story = TestBed.createComponent(StoryManagerComponent).componentInstance;
    flow.revote();
    story.revote();
    expect(gate.dialog()).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'round:revote', {});
    expect(send).toHaveBeenNthCalledWith(2, 'round:revote', {});
  });

  describe('End Session sequencing in the gate', () => {
    it('feature off: deletes immediately without board:clear', () => {
      enabled.set(false);
      const del = vi.fn();
      gate.guardEndSession(del);
      expect(del).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('on + moderator + revealed: dialog opens, delete deferred until board:cleared', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      expect(gate.dialog()).not.toBeNull();
      expect(del).not.toHaveBeenCalled();
      gate.skip();
      expect(send).toHaveBeenCalledWith('board:clear', {});
      expect(del).not.toHaveBeenCalled();
      emit('board:cleared', {});
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('cancel keeps the session', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      gate.cancel();
      expect(del).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('weight display', () => {
    function historyEntry(finalWeight?: ExtendedCardValue): HistoryEntry {
      return {
        roundId: 'h1',
        storyDescription: 'Done story',
        participants: [{ userId: 'm', displayName: 'Mod', cardValue: 3 }],
        metrics: {
          average: 3,
          mode: 3,
          spread: 0,
          distribution: { '3': 1 },
          outliers: [],
          numericVoteCount: 1,
          insufficientData: false,
        },
        completedAt: '2026-05-01T10:00:00.000Z',
        ...(finalWeight !== undefined
          ? { finalWeight: { value: finalWeight, votingSystem: 'fibonacci' as const, showFunniest: false } }
          : {}),
      };
    }
    const text = (el: unknown): string =>
      ((el as { nativeElement: HTMLElement }).nativeElement.textContent ?? '').replace(/\s+/g, ' ');

    it('issue list shows the weight, including 0', () => {
      issues.set([
        { ...PENDING, id: 'z', status: 'estimated', finalWeight: 0 },
        { ...PENDING, id: 'f', status: 'estimated', finalWeight: 5 },
        { ...PENDING, id: 'n', status: 'estimated' },
      ]);
      const fixture = TestBed.createComponent(IssueListPanelComponent);
      fixture.detectChanges();
      const weights = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.issue-list-panel__item-weight')
      ).map((e) => e.textContent!.trim());
      expect(weights).toEqual(['Final weight: 0', 'Final weight: 5']);
    });

    it('issue list hides the weight when the feature is off', () => {
      enabled.set(false);
      issues.set([{ ...PENDING, id: 'f', status: 'estimated', finalWeight: 5 }]);
      const fixture = TestBed.createComponent(IssueListPanelComponent);
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('.issue-list-panel__item-weight')).toBeNull();
      expect(text(fixture)).not.toContain('Final weight');
    });

    it('session history shows the weight, including 0, and nothing without one', () => {
      history.set([historyEntry(0)]);
      const fixture = TestBed.createComponent(SessionHistoryComponent);
      fixture.detectChanges();
      expect(text(fixture)).toContain('Final weight: 0');

      history.set([historyEntry()]);
      fixture.detectChanges();
      expect(text(fixture)).not.toContain('Final weight');
    });

    it('session history hides the weight when the feature is off', () => {
      enabled.set(false);
      history.set([historyEntry(5)]);
      const fixture = TestBed.createComponent(SessionHistoryComponent);
      fixture.detectChanges();
      expect(text(fixture)).not.toContain('Final weight');
    });
  });

  it('closes the dialog as Skip when the setting is turned off mid-prompt', () => {
    const flow = TestBed.createComponent(FacilitatorFlowComponent).componentInstance;
    flow.clearAndNext();
    expect(gate.dialog()).not.toBeNull();
    enabled.set(false);
    tick();
    expect(gate.dialog()).toBeNull();
    expect(send).toHaveBeenCalledWith('board:clear', {});
  });
});
