import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal } from '@angular/core';
import {
  FinalWeightGateService,
  FINAL_WEIGHT_ACK_TIMEOUT_MS,
  END_SESSION_CLEAR_TIMEOUT_MS,
} from './final-weight-gate.service';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';
import { DEFAULT_SESSION_CONFIG, User } from '@shared/types';

/** Validates: Requirements 4, 11.10, 11.11 */
describe('FinalWeightGateService', () => {
  let gate: FinalWeightGateService;
  let subjects: Map<string, Subject<unknown>>;
  let send: ReturnType<typeof vi.fn>;

  const ada: User = { id: 'u1', displayName: 'Ada', role: 'moderator', isAnonymous: false };
  const bob: User = { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false };

  const enabled = signal(true);
  const revealed = signal(true);
  const currentUser = signal<User | null>(ada);
  const currentRound = signal<{ id: string; finalWeight?: unknown } | null>({ id: 'r1' });

  function emit(event: string, data: unknown): void {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  }

  const selection = { value: 5 as never, showFunniest: false };
  const flush = (): void => TestBed.tick();

  beforeEach(() => {
    vi.useFakeTimers();
    subjects = new Map();
    send = vi.fn().mockReturnValue(true);
    enabled.set(true);
    revealed.set(true);
    currentUser.set(ada);
    currentRound.set({ id: 'r1' });

    TestBed.configureTestingModule({
      providers: [
        {
          provide: WebSocketService,
          useValue: {
            send,
            on: vi.fn(<T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            }),
          },
        },
        {
          provide: SessionStateService,
          useValue: {
            finalWeightEnabled: enabled,
            isRevealed: revealed,
            currentUser,
            currentRound,
            sessionConfig: signal({ ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true }),
            selections: signal(new Map<string, never>([['u1', 3 as never], ['u2', 8 as never]])),
            participants: signal([ada, bob]),
          },
        },
      ],
    });
    gate = TestBed.inject(FinalWeightGateService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('guard', () => {
    it('runs the action immediately when the feature is off', () => {
      enabled.set(false);
      const action = vi.fn();
      gate.guard(action);
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('runs the action immediately for non-moderators', () => {
      currentUser.set(bob);
      const action = vi.fn();
      gate.guard(action);
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('runs the action immediately when the round is not revealed', () => {
      revealed.set(false);
      const action = vi.fn();
      gate.guard(action);
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('opens the dialog otherwise without running the action', () => {
      const action = vi.fn();
      gate.guard(action);
      expect(action).not.toHaveBeenCalled();
      expect(gate.dialog()?.roundId).toBe('r1');
      expect(gate.dialog()?.mode).toBe('gate');
    });

    it('ignores a second guard while the dialog is open', () => {
      const first = vi.fn();
      const second = vi.fn();
      gate.guard(first);
      gate.guard(second);
      gate.skip();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });
  });

  describe('confirm / skip / cancel', () => {
    it('confirm sends finalweight:submit and runs the action after the matching finalweight:set', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.confirm(selection);
      expect(send).toHaveBeenCalledWith('finalweight:submit', {
        roundId: 'r1',
        value: 5,
        showFunniest: false,
      });
      expect(gate.dialog()?.submitting).toBe(true);

      emit('finalweight:set', { roundId: 'other' });
      expect(action).not.toHaveBeenCalled();

      emit('finalweight:set', { roundId: 'r1' });
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('skip runs the action and closes the dialog', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.skip();
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('cancel drops the action and closes the dialog', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.cancel();
      expect(action).not.toHaveBeenCalled();
      expect(gate.dialog()).toBeNull();
    });
  });

  describe('acknowledgement handling', () => {
    it('sets an inline error and keeps the dialog after the ack timeout', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.confirm(selection);
      vi.advanceTimersByTime(FINAL_WEIGHT_ACK_TIMEOUT_MS - 1);
      expect(gate.dialog()?.submitting).toBe(true);
      vi.advanceTimersByTime(1);
      expect(gate.dialog()?.submitting).toBe(false);
      expect(gate.dialog()?.error).toBeTruthy();
      expect(action).not.toHaveBeenCalled();
    });

    it.each(['UNAUTHORIZED', 'FEATURE_DISABLED', 'INVALID_FINAL_WEIGHT'])(
      '%s keeps the dialog open with an error',
      (code) => {
        const action = vi.fn();
        gate.guard(action);
        gate.confirm(selection);
        emit('error', { code, message: 'x' });
        expect(gate.dialog()).not.toBeNull();
        expect(gate.dialog()?.submitting).toBe(false);
        expect(gate.dialog()?.error).toBeTruthy();
        expect(action).not.toHaveBeenCalled();
      }
    );

    it('ROUND_NOT_FOUND proceeds as skip', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.confirm(selection);
      emit('error', { code: 'ROUND_NOT_FOUND' });
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('retry resends the last selection and can succeed', () => {
      const action = vi.fn();
      gate.guard(action);
      gate.confirm(selection);
      vi.advanceTimersByTime(FINAL_WEIGHT_ACK_TIMEOUT_MS);
      expect(gate.dialog()?.error).toBeTruthy();

      gate.retry();
      expect(send).toHaveBeenCalledTimes(2);
      expect(gate.dialog()?.error).toBeNull();
      expect(gate.dialog()?.submitting).toBe(true);

      emit('finalweight:set', { roundId: 'r1' });
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('a failed send shows an error and keeps the dialog', () => {
      send.mockReturnValue(false);
      const action = vi.fn();
      gate.guard(action);
      gate.confirm(selection);
      expect(gate.dialog()?.submitting).toBe(false);
      expect(gate.dialog()?.error).toBeTruthy();
      expect(action).not.toHaveBeenCalled();
    });
  });

  describe('automatic close', () => {
    it('closes as skip when the round id changes', () => {
      const action = vi.fn();
      gate.guard(action);
      currentRound.set({ id: 'r2' });
      flush();
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });

    it('closes as skip when the feature is turned off', () => {
      const action = vi.fn();
      gate.guard(action);
      flush();
      enabled.set(false);
      flush();
      expect(action).toHaveBeenCalledTimes(1);
      expect(gate.dialog()).toBeNull();
    });
  });

  describe('guardEndSession', () => {
    it('deletes immediately when no prompt is needed', () => {
      enabled.set(false);
      const del = vi.fn();
      gate.guardEndSession(del);
      expect(del).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('sends board:clear after skip and deletes on board:cleared', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      expect(del).not.toHaveBeenCalled();
      gate.skip();
      expect(send).toHaveBeenCalledWith('board:clear', {});
      expect(del).not.toHaveBeenCalled();
      emit('board:cleared', {});
      expect(del).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(END_SESSION_CLEAR_TIMEOUT_MS);
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('deletes on error', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      gate.skip();
      emit('error', { code: 'X' });
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('deletes after the 3s timeout', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      gate.skip();
      vi.advanceTimersByTime(END_SESSION_CLEAR_TIMEOUT_MS - 1);
      expect(del).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('does not delete when cancelled', () => {
      const del = vi.fn();
      gate.guardEndSession(del);
      gate.cancel();
      vi.advanceTimersByTime(END_SESSION_CLEAR_TIMEOUT_MS);
      expect(del).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });
});
