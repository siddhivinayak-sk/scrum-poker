import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { DEFAULT_SESSION_CONFIG, type ExtendedCardValue, type User } from '@shared/types';
import { buildFinalWeightOptions, votesFromRound } from '@shared/final-weight';
import {
  FinalWeightDialogComponent,
  type FinalWeightEditTarget,
} from './final-weight-dialog.component';
import {
  FINAL_WEIGHT_ACK_TIMEOUT_MS,
  FinalWeightGateService,
} from '../../services/final-weight-gate.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/** Validates: Requirements 5.4, 5.5, 5.6, 8.2, 8.3, 8.4, 9.7, 11.10, 14.1, 14.2, 14.3, 14.4, 14.5, 14.7 */
describe('FinalWeightDialogComponent', () => {
  const ada: User = { id: 'u1', displayName: 'Ada', role: 'moderator', isAnonymous: false };
  const bob: User = { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false };

  let fixture: ComponentFixture<FinalWeightDialogComponent>;
  let gate: FinalWeightGateService;
  let subjects: Map<string, Subject<unknown>>;
  let send: ReturnType<typeof vi.fn>;
  let selections: ReturnType<typeof signal<Map<string, ExtendedCardValue>>>;
  let revealed: ReturnType<typeof signal<boolean>>;
  let currentRound: ReturnType<typeof signal<{ id: string; finalWeight?: unknown } | null>>;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(sel: string): T | null => root().querySelector<T>(sel);
  const qa = (sel: string): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>(sel));
  const cards = (): HTMLElement[] => qa('[role="radio"]');
  const cardByValue = (v: string): HTMLElement =>
    cards().find((c) => c.querySelector('.fw-card__value')?.textContent?.trim() === v)!;
  const button = (label: string): HTMLButtonElement =>
    qa('button').find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  const settle = (): void => {
    for (let i = 0; i < 3; i += 1) fixture.detectChanges();
  };
  const emit = (event: string, data: unknown): void => {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  };

  function setup(votes: Array<[string, ExtendedCardValue]>): void {
    selections.set(new Map(votes));
  }

  beforeEach(() => {
    subjects = new Map();
    send = vi.fn().mockReturnValue(true);
    selections = signal(new Map<string, ExtendedCardValue>([['u1', 3], ['u2', 8]]));
    revealed = signal(true);
    currentRound = signal<{ id: string; finalWeight?: unknown } | null>({ id: 'r1' });

    TestBed.configureTestingModule({
      imports: [FinalWeightDialogComponent],
      providers: [
        {
          provide: WebSocketService,
          useValue: {
            send,
            on: <T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            },
          },
        },
        {
          provide: SessionStateService,
          useValue: {
            finalWeightEnabled: signal(true),
            isRevealed: revealed,
            currentUser: signal<User | null>(ada),
            currentRound,
            sessionConfig: signal({ ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true }),
            selections,
            participants: signal([ada, bob]),
          },
        },
      ],
    });
    gate = TestBed.inject(FinalWeightGateService);
    fixture = TestBed.createComponent(FinalWeightDialogComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while no dialog is requested', () => {
    expect(q('.fw-dialog')).toBeNull();
  });

  describe('gate mode', () => {
    it('opens as an accessible modal dialog', () => {
      gate.guard(vi.fn());
      settle();
      const dialog = q('.fw-dialog')!;
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(q('[role="radiogroup"]')).not.toBeNull();
    });

    it('marks the suggested card with a badge but does not preselect it', () => {
      gate.guard(vi.fn());
      settle();
      const dialogOptions = gate.dialog()!.options;
      const suggested = dialogOptions.find((o) => o.suggested)!;
      expect(suggested).toBeDefined();

      const badges = qa('.fw-card__badge--suggested');
      expect(badges).toHaveLength(1);
      expect(badges[0].closest('[role="radio"]')).toBe(cardByValue(String(suggested.value)));

      for (const c of cards()) expect(c.getAttribute('aria-checked')).toBe('false');
      expect(button('Confirm').disabled).toBe(true);
    });

    it('lets 0 be selected and sends it (0 is a real weight)', () => {
      setup([]);
      gate.guard(vi.fn());
      settle();
      const zero = cardByValue('0');
      expect(zero).toBeDefined();
      zero.click();
      settle();
      expect(zero.getAttribute('aria-checked')).toBe('true');
      button('Confirm').click();
      expect(send).toHaveBeenCalledWith('finalweight:submit', {
        roundId: 'r1',
        value: 0,
        showFunniest: false,
      });
    });

    it('falls back to the full ladder when there are no scorable votes', () => {
      setup([]);
      gate.guard(vi.fn());
      settle();
      const ladder = gate.dialog()!.ladder;
      expect(cards().map((c) => c.querySelector('.fw-card__value')!.textContent!.trim())).toEqual(
        ladder.map(String)
      );
      expect(q('.fw-dialog__desc')!.textContent).toContain('no scorable votes');
      expect(q('.fw-dialog__link')).toBeNull();
    });

    it('shows suggestions first and toggles to the full ladder', () => {
      gate.guard(vi.fn());
      settle();
      const { options, ladder } = gate.dialog()!;
      expect(cards()).toHaveLength(options.length);
      const toggle = q<HTMLButtonElement>('.fw-dialog__link')!;
      toggle.click();
      settle();
      expect(cards()).toHaveLength(ladder.length);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    });

    it('sends confirm with the funniest flag and runs the action after the ack', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      cardByValue('5').click();
      settle();
      q<HTMLInputElement>('.fw-dialog__check input')!.click();
      settle();
      button('Confirm').click();
      settle();
      expect(send).toHaveBeenCalledWith('finalweight:submit', {
        roundId: 'r1',
        value: 5,
        showFunniest: true,
      });
      expect(button('Saving…').disabled).toBe(true);
      expect(action).not.toHaveBeenCalled();

      emit('finalweight:set', { roundId: 'r1' });
      settle();
      expect(action).toHaveBeenCalledTimes(1);
      expect(q('.fw-dialog')).toBeNull();
    });

    it('Skip runs the action without sending anything', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      button('Skip').click();
      settle();
      expect(action).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(q('.fw-dialog')).toBeNull();
    });

    it('Cancel drops the action', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      button('Cancel').click();
      settle();
      expect(action).not.toHaveBeenCalled();
      expect(q('.fw-dialog')).toBeNull();
    });

    it('Escape cancels the dialog', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      settle();
      expect(action).not.toHaveBeenCalled();
      expect(q('.fw-dialog')).toBeNull();
    });

    it('shows a rejection inline with Retry, and retry resends', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      cardByValue('5').click();
      settle();
      button('Confirm').click();
      emit('error', { code: 'INVALID_FINAL_WEIGHT', message: 'x' });
      settle();
      const alert = q('[role="alert"]')!;
      expect(alert.textContent).toContain('not valid');
      expect(action).not.toHaveBeenCalled();
      expect(button('Confirm').disabled).toBe(false);

      send.mockClear();
      button('Retry').click();
      settle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(q('[role="alert"]')).toBeNull();
    });

    it('shows a timeout error after the ack window', () => {
      vi.useFakeTimers();
      gate.guard(vi.fn());
      settle();
      cardByValue('5').click();
      settle();
      button('Confirm').click();
      vi.advanceTimersByTime(FINAL_WEIGHT_ACK_TIMEOUT_MS + 1);
      settle();
      expect(q('[role="alert"]')!.textContent).toContain('not confirmed in time');
    });

    it('moves selection with arrow keys (roving radio group)', () => {
      gate.guard(vi.fn());
      settle();
      const first = cards()[0];
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      settle();
      expect(cards()[1].getAttribute('aria-checked')).toBe('true');
      cards()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      settle();
      expect(cards()[0].getAttribute('aria-checked')).toBe('true');
    });

    it('traps focus: Tab on the last control wraps to the first, Shift+Tab back', () => {
      gate.guard(vi.fn());
      settle();
      const dialog = q('.fw-dialog')!;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex="0"]'
        )
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      last.focus();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      last.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      const back = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      first.dispatchEvent(back);
      expect(back.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it('moves focus into the dialog on open', () => {
      gate.guard(vi.fn());
      settle();
      expect(q('.fw-dialog')!.contains(document.activeElement)).toBe(true);
    });

    it('closes as Skip when the round is no longer revealed', () => {
      const action = vi.fn();
      gate.guard(action);
      settle();
      revealed.set(false);
      settle();
      expect(q('.fw-dialog')).toBeNull();
      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe('edit mode', () => {
    function target(over: Partial<FinalWeightEditTarget> = {}): FinalWeightEditTarget {
      const votes = votesFromRound(new Map<string, ExtendedCardValue>([['u1', 3], ['u2', 8]]), [ada, bob]);
      const { options, ladder } = buildFinalWeightOptions(votes, 'fibonacci');
      return { roundId: 'r1', options, ladder, current: null, ...over };
    }
    const open = (t: FinalWeightEditTarget): void => {
      fixture.componentRef.setInput('edit', t);
      settle();
    };

    it('uses edit labels and has no Skip button', () => {
      open(target());
      expect(q('.fw-dialog__title')!.textContent).toContain('Change final weight');
      expect(button('Close')).toBeDefined();
      expect(button('Skip')).toBeUndefined();
    });

    it('preselects an existing weight (including 0) and its funniest flag', () => {
      open(target({ current: { value: 0, votingSystem: 'fibonacci', showFunniest: true } as never }));
      expect(cardByValue('0').getAttribute('aria-checked')).toBe('true');
      expect(q<HTMLInputElement>('.fw-dialog__check input')!.checked).toBe(true);
      expect(button('Confirm').disabled).toBe(false);
    });

    it('submits itself and emits closed on the matching ack', () => {
      const closed = vi.fn();
      fixture.componentInstance.closed.subscribe(closed);
      open(target());
      cardByValue('5').click();
      settle();
      button('Confirm').click();
      expect(send).toHaveBeenCalledWith('finalweight:submit', {
        roundId: 'r1',
        value: 5,
        showFunniest: false,
      });
      emit('finalweight:set', { roundId: 'other' });
      expect(closed).not.toHaveBeenCalled();
      emit('finalweight:set', { roundId: 'r1' });
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('shows errors and retries; Close and Escape emit closed', () => {
      const closed = vi.fn();
      fixture.componentInstance.closed.subscribe(closed);
      open(target());
      cardByValue('5').click();
      settle();
      button('Confirm').click();
      emit('error', { code: 'UNAUTHORIZED' });
      settle();
      expect(q('[role="alert"]')!.textContent).toContain('Only a moderator');
      send.mockClear();
      button('Retry').click();
      expect(send).toHaveBeenCalledTimes(1);

      button('Close').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(closed).toHaveBeenCalledTimes(2);
    });

    it('reports a failed send as an inline error', () => {
      send.mockReturnValue(false);
      open(target());
      cardByValue('5').click();
      settle();
      button('Confirm').click();
      settle();
      expect(q('[role="alert"]')!.textContent).toContain('Not connected');
    });
  });
});
