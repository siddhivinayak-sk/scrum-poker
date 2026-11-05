import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  DEFAULT_SESSION_CONFIG,
  type ExtendedCardValue,
  type HistoryEntry,
  type User,
} from '@shared/types';
import { computeAccuracy } from '@shared/final-weight';
import { FinalWeightHeaderButtonComponent } from './final-weight-header-button.component';
import type { FinalWeightEditTarget } from '../final-weight-dialog/final-weight-dialog.component';
import { SessionStateService, type LatestAccuracy } from '../../services/session-state.service';

/** Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6, 8.7 */
describe('FinalWeightHeaderButtonComponent', () => {
  const mod: User = { id: 'm', displayName: 'Mod', role: 'moderator', isAnonymous: false };
  const ann: User = { id: 'a', displayName: 'Ann', role: 'participant', isAnonymous: false };

  let fixture: ComponentFixture<FinalWeightHeaderButtonComponent>;
  let enabled: ReturnType<typeof signal<boolean>>;
  let user: ReturnType<typeof signal<User | null>>;
  let round: ReturnType<typeof signal<{ id: string; finalWeight?: unknown } | null>>;
  let revealed: ReturnType<typeof signal<boolean>>;
  let history: ReturnType<typeof signal<HistoryEntry[]>>;
  let latest: ReturnType<typeof signal<LatestAccuracy | null>>;
  let selections: ReturnType<typeof signal<Map<string, ExtendedCardValue>>>;

  const btn = (): HTMLButtonElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button');
  const settle = (): void => {
    for (let i = 0; i < 3; i += 1) fixture.detectChanges();
  };

  function historyEntry(roundId: string): HistoryEntry {
    return {
      roundId,
      storyDescription: 's',
      participants: [
        { userId: 'm', displayName: 'Mod', cardValue: 3 },
        { userId: 'a', displayName: 'Ann', cardValue: 8 },
      ],
      metrics: {
        average: 5.5,
        mode: null,
        spread: null,
        distribution: {},
        outliers: [],
        numericVoteCount: 2,
        insufficientData: false,
      },
      completedAt: '2026-05-01T10:00:00.000Z',
    };
  }

  function accuracy(): LatestAccuracy {
    const record = { value: 5 as ExtendedCardValue, votingSystem: 'fibonacci' as const, showFunniest: true };
    return {
      roundId: 'r1',
      record,
      result: computeAccuracy(historyEntry('x').participants, record),
    };
  }

  beforeEach(() => {
    enabled = signal(true);
    user = signal<User | null>(mod);
    round = signal<{ id: string; finalWeight?: unknown } | null>(null);
    revealed = signal(false);
    history = signal<HistoryEntry[]>([]);
    latest = signal<LatestAccuracy | null>(null);
    selections = signal(new Map<string, ExtendedCardValue>());

    TestBed.configureTestingModule({
      imports: [FinalWeightHeaderButtonComponent],
      providers: [
        {
          provide: SessionStateService,
          useValue: {
            finalWeightEnabled: enabled,
            currentUser: user,
            currentRound: round,
            isRevealed: revealed,
            history,
            latestAccuracy: latest,
            selections,
            participants: signal([mod, ann]),
            sessionConfig: signal({ ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true }),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(FinalWeightHeaderButtonComponent);
    settle();
  });

  it('is not rendered when the setting is off', () => {
    enabled.set(false);
    settle();
    expect(btn()).toBeNull();
  });

  it('is rendered with an accessible name when the setting is on', () => {
    expect(btn()!.getAttribute('aria-label')).toBe('Final weight and accuracy');
  });

  describe('disabled states', () => {
    it('moderator with nothing to show: disabled, explains why', () => {
      expect(btn()!.disabled).toBe(true);
      expect(btn()!.getAttribute('title')).toContain('reveal a round');
    });

    it('participant with nothing to show: disabled, explains why', () => {
      user.set(ann);
      settle();
      expect(btn()!.disabled).toBe(true);
      expect(btn()!.getAttribute('title')).toContain('moderator has not set');
    });

    it('moderator with a voting (not revealed) round: still disabled', () => {
      round.set({ id: 'r1' });
      settle();
      expect(btn()!.disabled).toBe(true);
    });

    it('participant with a revealed round and no result: disabled (cannot edit)', () => {
      user.set(ann);
      round.set({ id: 'r1' });
      revealed.set(true);
      settle();
      expect(btn()!.disabled).toBe(true);
    });
  });

  describe('moderator edit target', () => {
    it('revealed round: emits an edit target for that round with suggestions and ladder', () => {
      selections.set(new Map<string, ExtendedCardValue>([['m', 3], ['a', 8]]));
      round.set({ id: 'r1' });
      revealed.set(true);
      settle();
      const edit = vi.fn<(t: FinalWeightEditTarget) => void>();
      fixture.componentInstance.edit.subscribe(edit);

      expect(btn()!.disabled).toBe(false);
      btn()!.click();
      expect(edit).toHaveBeenCalledTimes(1);
      const target = edit.mock.calls[0][0];
      expect(target.roundId).toBe('r1');
      expect(target.current).toBeNull();
      expect(target.options.length).toBeGreaterThan(0);
      expect(target.ladder).toContain(0);
    });

    it('revealed round with a weight already set (0) passes it as current', () => {
      round.set({ id: 'r1', finalWeight: { value: 0, votingSystem: 'fibonacci', showFunniest: false } });
      revealed.set(true);
      settle();
      const edit = vi.fn<(t: FinalWeightEditTarget) => void>();
      fixture.componentInstance.edit.subscribe(edit);
      btn()!.click();
      expect(edit.mock.calls[0][0].current?.value).toBe(0);
    });

    it('after Clear (no round): targets the newest history entry using its votes', () => {
      history.set([historyEntry('h-new'), historyEntry('h-old')]);
      settle();
      const edit = vi.fn<(t: FinalWeightEditTarget) => void>();
      fixture.componentInstance.edit.subscribe(edit);

      expect(btn()!.disabled).toBe(false);
      btn()!.click();
      const target = edit.mock.calls[0][0];
      expect(target.roundId).toBe('h-new');
      expect(target.options.length).toBeGreaterThan(0);
    });

    it('does not target history while a round is on the board but not revealed', () => {
      history.set([historyEntry('h-new')]);
      round.set({ id: 'r2' });
      settle();
      expect(btn()!.disabled).toBe(true);
    });

    it('with a result and nothing editable, reopens the balloon instead', () => {
      latest.set(accuracy());
      round.set({ id: 'r2' });
      settle();
      const balloon = { reopen: vi.fn() };
      fixture.componentRef.setInput('balloon', balloon);
      settle();
      const edit = vi.fn();
      fixture.componentInstance.edit.subscribe(edit);

      expect(btn()!.disabled).toBe(false);
      expect(btn()!.getAttribute('title')).toContain('latest accuracy');
      btn()!.click();
      expect(balloon.reopen).toHaveBeenCalledTimes(1);
      expect(edit).not.toHaveBeenCalled();
    });
  });

  describe('participant', () => {
    it('reopens the balloon when a result exists, never opens the edit dialog', () => {
      user.set(ann);
      latest.set(accuracy());
      round.set({ id: 'r1' });
      revealed.set(true);
      history.set([historyEntry('h')]);
      const balloon = { reopen: vi.fn() };
      fixture.componentRef.setInput('balloon', balloon);
      settle();
      const edit = vi.fn();
      fixture.componentInstance.edit.subscribe(edit);

      expect(btn()!.disabled).toBe(false);
      btn()!.click();
      expect(balloon.reopen).toHaveBeenCalledTimes(1);
      expect(edit).not.toHaveBeenCalled();
      expect(fixture.componentInstance.editTarget()).toBeNull();
    });
  });

  it('activate does nothing when the setting is off', () => {
    latest.set(accuracy());
    const balloon = { reopen: vi.fn() };
    fixture.componentRef.setInput('balloon', balloon);
    enabled.set(false);
    settle();
    fixture.componentInstance.activate();
    expect(balloon.reopen).not.toHaveBeenCalled();
  });
});
