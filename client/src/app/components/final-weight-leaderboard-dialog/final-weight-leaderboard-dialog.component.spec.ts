import { beforeEach, describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { ExtendedCardValue, HistoryEntry, ParticipantVote, User } from '@shared/types';
import { FinalWeightLeaderboardDialogComponent } from './final-weight-leaderboard-dialog.component';
import { SessionStateService } from '../../services/session-state.service';

/**
 * Accuracy leaderboard dialog: ranks voters most-accurate-first, separates warming-up voters,
 * escapes names, and behaves as an accessible modal.
 */
describe('FinalWeightLeaderboardDialogComponent', () => {
  const mod: User = { id: 'm', displayName: 'Mod', role: 'moderator', isAnonymous: false };

  let fixture: ComponentFixture<FinalWeightLeaderboardDialogComponent>;
  let component: FinalWeightLeaderboardDialogComponent;
  let enabled: ReturnType<typeof signal<boolean>>;
  let history: ReturnType<typeof signal<HistoryEntry[]>>;
  let user: ReturnType<typeof signal<User | null>>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const settle = (): void => {
    for (let i = 0; i < 3; i += 1) fixture.detectChanges();
  };

  function vote(userId: string, name: string, card: ExtendedCardValue | null): ParticipantVote {
    return { userId, displayName: name, cardValue: card };
  }

  /** A fibonacci round with a stored final weight and the given votes. */
  function entry(
    roundId: string,
    weight: ExtendedCardValue,
    votes: ParticipantVote[],
  ): HistoryEntry {
    return {
      roundId,
      storyDescription: 's',
      participants: votes,
      metrics: {
        average: null,
        mode: null,
        spread: null,
        distribution: {},
        outliers: [],
        numericVoteCount: votes.length,
        insufficientData: false,
      },
      completedAt: '2026-05-01T10:00:00.000Z',
      finalWeight: { value: weight, votingSystem: 'fibonacci', showFunniest: false },
    };
  }

  beforeEach(() => {
    enabled = signal(true);
    history = signal<HistoryEntry[]>([]);
    user = signal<User | null>(mod);
    TestBed.configureTestingModule({
      imports: [FinalWeightLeaderboardDialogComponent],
      providers: [
        {
          provide: SessionStateService,
          useValue: { finalWeightEnabled: enabled, history, currentUser: user },
        },
      ],
    });
    fixture = TestBed.createComponent(FinalWeightLeaderboardDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders nothing until show() is called', () => {
    expect(el().querySelector('[role="dialog"]')).toBeNull();
    component.show();
    settle();
    expect(el().querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('is an accessible modal with a labelled title', () => {
    component.show();
    settle();
    const dialog = el().querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('fwlb-title');
    expect(el().querySelector('#fwlb-title')?.textContent).toContain('Accuracy leaderboard');
  });

  it('shows an empty message when there are no scored rounds', () => {
    component.show();
    settle();
    expect(el().querySelector('.fwlb__empty')?.textContent).toContain('No scored rounds yet');
  });

  it('ranks voters most accurate first with medals', () => {
    // Weight 5. Over two rounds: Mod avg distance 0, Ann avg distance 2 -> Mod first.
    history.set([
      entry('r1', 5, [vote('m', 'Mod', 5), vote('a', 'Ann', 8)]),
      entry('r2', 5, [vote('m', 'Mod', 5), vote('a', 'Ann', 3)]),
    ]);
    component.show();
    settle();
    const rows = Array.from(el().querySelectorAll('.fwlb__list:not(.fwlb__list--plain) .fwlb__row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.fwlb__name')?.textContent).toContain('Mod');
    expect(rows[0].querySelector('.fwlb__rank')?.textContent?.trim()).toBe(component.medal(1));
    expect(rows[0].querySelector('.fwlb__avg')?.textContent?.trim()).toBe('0.00');
    expect(rows[1].querySelector('.fwlb__name')?.textContent).toContain('Ann');
    expect(rows[1].querySelector('.fwlb__rank')?.textContent?.trim()).toBe(component.medal(2));
  });

  it('lists a voter with fewer than two scored rounds under "Warming up"', () => {
    // Only one scored round -> both voters are warming up, none ranked.
    history.set([entry('r1', 5, [vote('m', 'Mod', 5), vote('a', 'Ann', 8)])]);
    component.show();
    settle();
    expect(el().querySelector('.fwlb__subtitle')?.textContent).toContain('Warming up');
    const warming = Array.from(el().querySelectorAll('.fwlb__list--plain .fwlb__row'));
    expect(warming).toHaveLength(2);
    expect(el().querySelector('.fwlb__list:not(.fwlb__list--plain)')).toBeNull();
  });

  it('marks the current user with "(you)"', () => {
    history.set([
      entry('r1', 5, [vote('m', 'Mod', 5), vote('a', 'Ann', 8)]),
      entry('r2', 5, [vote('m', 'Mod', 5), vote('a', 'Ann', 3)]),
    ]);
    component.show();
    settle();
    const self = el().querySelector('.fwlb__row--self');
    expect(self?.textContent).toContain('Mod');
    expect(self?.textContent).toContain('(you)');
  });

  it('renders voter names as text, never as HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    history.set([
      entry('r1', 5, [vote('m', evil, 5), vote('a', 'Ann', 8)]),
      entry('r2', 5, [vote('m', evil, 5), vote('a', 'Ann', 3)]),
    ]);
    component.show();
    settle();
    expect(el().querySelector('img')).toBeNull();
    expect(el().querySelector('.fwlb__name')?.textContent).toContain(evil);
  });

  it('closes on close()', () => {
    component.show();
    settle();
    component.close();
    settle();
    expect(el().querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes when the final weight setting is turned off', () => {
    component.show();
    settle();
    enabled.set(false);
    settle();
    expect(el().querySelector('[role="dialog"]')).toBeNull();
  });
});