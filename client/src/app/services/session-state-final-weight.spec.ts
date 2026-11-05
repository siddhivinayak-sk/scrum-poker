import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { SessionStateService, LatestAccuracy } from './session-state.service';
import { WebSocketService } from './websocket.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { computeAccuracy } from '@shared/final-weight';
import {
  DEFAULT_SESSION_CONFIG,
  FinalWeightRecord,
  HistoryEntry,
  ParticipantVote,
  SessionConfiguration,
  User,
} from '@shared/types';

describe('SessionStateService final weight accuracy', () => {
  let service: SessionStateService;
  let subjects: Map<string, Subject<unknown>>;
  let announced: LatestAccuracy[];

  const ada: User = { id: 'u1', displayName: 'Ada', role: 'moderator', isAnonymous: false };
  const bob: User = { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false };
  const config = { ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true };
  const record = (value: FinalWeightRecord['value'], showFunniest = false): FinalWeightRecord => ({
    value,
    votingSystem: config.votingSystem,
    showFunniest,
  });
  const votes: ParticipantVote[] = [
    { userId: 'u1', displayName: 'Ada', cardValue: 3 },
    { userId: 'u2', displayName: 'Bob', cardValue: 8 },
  ];

  function emit(event: string, data: unknown): void {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  }

  function entry(roundId: string, finalWeight?: FinalWeightRecord): HistoryEntry {
    return {
      roundId,
      storyDescription: roundId,
      participants: votes,
      metrics: { average: 5.5, median: 5.5, mode: [], min: 3, max: 8, hasConsensus: false } as never,
      completedAt: '2026-05-01T10:00:00.000Z',
      ...(finalWeight ? { finalWeight } : {}),
    };
  }

  function state(extra: Record<string, unknown> = {}, cfg: SessionConfiguration = config): { state: unknown } {
    return {
      state: {
        sessionId: 's1',
        config: cfg,
        ownerId: 'u1',
        createdAt: '2026-05-01T09:00:00.000Z',
        issueList: [],
        participants: [ada, bob],
        history: [],
        isRevealed: false,
        currentRound: null,
        ...extra,
      },
    };
  }

  function setPayload(roundId: string, rec: FinalWeightRecord): unknown {
    return { roundId, record: rec, result: computeAccuracy(votes, rec) };
  }

  beforeEach(() => {
    sessionStorage.clear();
    subjects = new Map();
    announced = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        {
          provide: WebSocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            send: vi.fn(),
            on: vi.fn(<T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            }),
            connectionState: signal('disconnected' as const),
          },
        },
        { provide: AuthService, useValue: { getCurrentUser: vi.fn().mockReturnValue(signal(ada)) } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });
    service = TestBed.inject(SessionStateService);
    service.accuracyAnnounced$.subscribe((a) => announced.push(a));
  });

  it('finalWeightEnabled is true only for boolean true', () => {
    expect(service.finalWeightEnabled()).toBe(false);
    emit('session:state', state({}, (({ finalWeightEnabled: _omit, ...rest }) => rest)(config)));
    expect(service.finalWeightEnabled()).toBe(false);
    emit('session:config-updated', { config });
    expect(service.finalWeightEnabled()).toBe(true);
  });

  it('finalweight:set sets latestAccuracy, patches the current round and announces', () => {
    emit('session:state', state({
      isRevealed: true,
      currentRound: { id: 'r1', storyDescription: 'x', status: 'revealed', selections: { u1: 3, u2: 8 } },
    }));
    emit('finalweight:set', setPayload('r1', record(5)));
    expect(service.latestAccuracy()?.roundId).toBe('r1');
    expect(service.currentRound()?.finalWeight?.value).toBe(5);
    expect(announced).toHaveLength(1);
  });

  it('patches the matching history entry when the round is already saved', () => {
    emit('session:state', state({ history: [entry('r0'), entry('r1')] }));
    emit('finalweight:set', setPayload('r1', record(5)));
    expect(service.history().find((e) => e.roundId === 'r1')?.finalWeight?.value).toBe(5);
    expect(service.history().find((e) => e.roundId === 'r0')?.finalWeight).toBeUndefined();
  });

  it('does not re-announce identical repeats but announces a corrected weight', () => {
    emit('session:state', state({ history: [entry('r1')] }));
    emit('finalweight:set', setPayload('r1', record(5)));
    emit('finalweight:set', setPayload('r1', record(5)));
    expect(announced).toHaveLength(1);
    emit('finalweight:set', setPayload('r1', record(8)));
    expect(announced).toHaveLength(2);
    emit('finalweight:set', setPayload('r1', record(8, true)));
    expect(announced).toHaveLength(3);
  });

  it('restores from the newest history entry with a weight on session:state without announcing', () => {
    emit('session:state', state({
      history: [entry('r3'), entry('r2', record(3)), entry('r1', record(8))],
    }));
    const latest = service.latestAccuracy();
    expect(latest?.roundId).toBe('r2');
    expect(latest?.result).toEqual(computeAccuracy(votes, record(3)));
    expect(announced).toHaveLength(0);
  });

  it('restores from the current round weight using its selections', () => {
    emit('session:state', state({
      isRevealed: true,
      history: [entry('r0', record(8))],
      currentRound: {
        id: 'r1', storyDescription: 'x', status: 'revealed', selections: { u1: 3, u2: 8 },
        finalWeight: record(5),
      },
    }));
    expect(service.latestAccuracy()?.roundId).toBe('r1');
    expect(service.latestAccuracy()?.result).toEqual(computeAccuracy(votes, record(5)));
    expect(announced).toHaveLength(0);
  });

  it('keeps the accuracy through board:cleared, restored from the new history entry', () => {
    emit('session:state', state({
      isRevealed: true,
      currentRound: { id: 'r1', storyDescription: 'x', status: 'revealed', selections: { u1: 3, u2: 8 } },
    }));
    emit('finalweight:set', setPayload('r1', record(5)));
    emit('board:cleared', { historyEntry: entry('r1', record(5)) });
    expect(service.latestAccuracy()?.roundId).toBe('r1');
    expect(announced).toHaveLength(1);
  });

  it('clears on history:cleared', () => {
    emit('session:state', state({ history: [entry('r1', record(5))] }));
    expect(service.latestAccuracy()).not.toBeNull();
    emit('history:cleared', {});
    expect(service.latestAccuracy()).toBeNull();
  });

  it('clears when the setting turns off', () => {
    emit('session:state', state({ history: [entry('r1', record(5))] }));
    emit('session:config-updated', { config: { ...config, finalWeightEnabled: false } });
    expect(service.latestAccuracy()).toBeNull();
  });

  it('round:started keeps the accuracy of a saved round and clears one that was discarded', () => {
    emit('session:state', state({ history: [entry('r1', record(5))] }));
    emit('round:started', { round: { id: 'r2', storyDescription: 'n', status: 'voting', selections: {} } });
    expect(service.latestAccuracy()?.roundId).toBe('r1');

    emit('session:state', state({
      isRevealed: true,
      currentRound: { id: 'r3', storyDescription: 'x', status: 'revealed', selections: { u1: 3, u2: 8 } },
    }));
    emit('finalweight:set', setPayload('r3', record(5)));
    emit('round:started', { round: { id: 'r4', storyDescription: 'x', status: 'voting', selections: {} } });
    expect(service.latestAccuracy()).toBeNull();
  });
});
