import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import {
  DEFAULT_SESSION_CONFIG,
  type ExtendedCardValue,
  type FinalWeightRecord,
  type HistoryEntry,
  type ParticipantVote,
} from '@shared/types';
import { computeAccuracy } from '@shared/final-weight';
import {
  FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS,
  FinalWeightBalloonComponent,
} from './final-weight-balloon.component';
import { SessionStateService, type LatestAccuracy } from '../../services/session-state.service';

/** Validates: Requirements 7.2, 7.3, 7.4, 7.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.9, 10.2, 10.3, 10.4, 10.5, 14.6 */
describe('FinalWeightBalloonComponent', () => {
  let fixture: ComponentFixture<FinalWeightBalloonComponent>;
  let announced$: Subject<LatestAccuracy>;
  let enabled: ReturnType<typeof signal<boolean>>;
  let latest: ReturnType<typeof signal<LatestAccuracy | null>>;
  let history: ReturnType<typeof signal<HistoryEntry[]>>;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = (sel: string): HTMLElement | null => root().querySelector<HTMLElement>(sel);
  const text = (): string => root().textContent ?? '';
  const settle = (): void => {
    for (let i = 0; i < 3; i += 1) fixture.detectChanges();
  };

  function vote(id: string, name: string, card: ExtendedCardValue | null): ParticipantVote {
    return { userId: id, displayName: name, cardValue: card };
  }

  function accuracy(
    votes: ParticipantVote[],
    value: ExtendedCardValue,
    showFunniest = true,
    roundId = 'r1'
  ): LatestAccuracy {
    const record: FinalWeightRecord = { value, votingSystem: 'fibonacci', showFunniest };
    return { roundId, record, result: computeAccuracy(votes, record) };
  }

  function announce(data: LatestAccuracy): void {
    latest.set(data);
    announced$.next(data);
    settle();
  }

  function entry(roundId: string, votes: ParticipantVote[], value: ExtendedCardValue): HistoryEntry {
    return {
      roundId,
      storyDescription: roundId,
      participants: votes,
      metrics: {
        average: null,
        mode: null,
        spread: null,
        distribution: {},
        outliers: [],
        numericVoteCount: 0,
        insufficientData: true,
      },
      completedAt: '2026-05-01T10:00:00.000Z',
      finalWeight: { value, votingSystem: 'fibonacci', showFunniest: true },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    announced$ = new Subject<LatestAccuracy>();
    enabled = signal(true);
    latest = signal<LatestAccuracy | null>(null);
    history = signal<HistoryEntry[]>([]);

    TestBed.configureTestingModule({
      imports: [FinalWeightBalloonComponent],
      providers: [
        {
          provide: SessionStateService,
          useValue: {
            finalWeightEnabled: enabled,
            latestAccuracy: latest,
            accuracyAnnounced$: announced$.asObservable(),
            history,
            sessionConfig: signal({ ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true }),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(FinalWeightBalloonComponent);
    settle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing until a result is announced', () => {
    expect(q('.fw-balloon')).toBeNull();
  });

  it('shows weight, closest block and the furthest "just for fun" block', () => {
    announce(
      accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8), vote('c', 'Cy', 8)], 8)
    );
    expect(q('.fw-balloon')!.getAttribute('role')).toBe('status');
    expect(q('.fw-balloon__value')!.textContent).toBe('8');
    const blocks = Array.from(root().querySelectorAll('.fw-balloon__block'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toContain('Ben');
    expect(blocks[0].textContent).toContain('Cy');
    expect(blocks[1].textContent).toContain('Just for fun');
    expect(blocks[1].textContent).toContain('Ann');
  });

  it('hides the furthest block when showFunniest is off', () => {
    announce(
      accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8), vote('c', 'Cy', 8)], 8, false)
    );
    expect(root().querySelectorAll('.fw-balloon__block')).toHaveLength(1);
    expect(text()).not.toContain('Just for fun');
    expect(text()).not.toContain('Ann');
  });

  it('shows the all-exact message instead of closest/furthest', () => {
    announce(accuracy([vote('a', 'Ann', 5), vote('b', 'Ben', 5)], 5));
    expect(text()).toContain('Hive mind!');
    expect(root().querySelectorAll('.fw-balloon__block')).toHaveLength(0);
  });

  it('shows a neutral message when the result is not comparable', () => {
    announce(accuracy([vote('a', 'Ann', 5), vote('b', 'Ben', null)], 5));
    expect(text()).toContain('Not enough comparable votes');
    expect(root().querySelectorAll('.fw-balloon__block')).toHaveLength(0);
    expect(q('.fw-balloon__value')!.textContent).toBe('5');
  });

  it('renders a final weight of 0', () => {
    announce(accuracy([vote('a', 'Ann', 0), vote('b', 'Ben', 3)], 0));
    expect(q('.fw-balloon__value')!.textContent).toBe('0');
  });

  it('limits listed names to three and adds "and N more"', () => {
    const votes = ['a', 'b', 'c', 'd', 'e'].map((id) => vote(id, `N${id}`, 8));
    votes.push(vote('z', 'Zed', 1));
    announce(accuracy(votes, 8));
    expect(text()).toContain('and 2 more');
  });

  it('escapes voter names: no HTML is injected', () => {
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    announce(
      accuracy([vote('a', evil, 1), vote('b', 'Ben', 8), vote('c', 'Cy', 8)], 8)
    );
    expect(root().querySelector('img')).toBeNull();
    expect(root().querySelector('.fw-balloon b')).toBeNull();
    expect(text()).toContain(evil);
  });

  it('escapes names in the standings too', () => {
    const evil = '<script>alert(1)</script>';
    const votes = [vote('a', evil, 1), vote('b', 'Ben', 8)];
    history.set([entry('h1', votes, 8)]);
    announce(accuracy(votes, 8));
    (q('.fw-balloon__toggle') as HTMLButtonElement).click();
    settle();
    expect(root().querySelector('script')).toBeNull();
    expect(q('.fw-balloon__standings')!.textContent).toContain(evil);
  });

  describe('standings', () => {
    it('is collapsed by default and shows warming up for a single round', () => {
      const votes = [vote('a', 'Ann', 5), vote('b', 'Ben', 8)];
      history.set([entry('h1', votes, 8)]);
      announce(accuracy(votes, 8));
      const toggle = q('.fw-balloon__toggle') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(q('.fw-balloon__standings')).toBeNull();
      toggle.click();
      settle();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(q('.fw-balloon__standings')!.textContent).toContain('warming up');
      expect(q('.fw-balloon__standings')!.textContent).toContain('(1 round)');
    });

    it('shows the average distance once a voter has two rounds', () => {
      const votes = [vote('a', 'Ann', 5), vote('b', 'Ben', 8)];
      history.set([entry('h1', votes, 8), entry('h2', votes, 8)]);
      announce(accuracy(votes, 8));
      (q('.fw-balloon__toggle') as HTMLButtonElement).click();
      settle();
      const s = q('.fw-balloon__standings')!.textContent!;
      expect(s).toContain('avg 0.0 steps');
      expect(s).toContain('avg 1.0 steps');
      expect(s).toContain('(2 rounds)');
      expect(s).not.toContain('warming up');
    });

    it('says so when there are no scored rounds', () => {
      announce(accuracy([vote('a', 'Ann', 5), vote('b', 'Ben', 8)], 8));
      (q('.fw-balloon__toggle') as HTMLButtonElement).click();
      settle();
      expect(q('.fw-balloon__standings')!.textContent).toContain('No scored rounds yet');
    });
  });

  describe('dismissal and reopen', () => {
    const data = (): LatestAccuracy =>
      accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8)], 8);

    it('auto-dismisses after the timeout and emits closed', () => {
      const closed = vi.fn();
      fixture.componentInstance.closed.subscribe(closed);
      announce(data());
      vi.advanceTimersByTime(FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS - 1);
      settle();
      expect(q('.fw-balloon')).not.toBeNull();
      vi.advanceTimersByTime(2);
      settle();
      expect(q('.fw-balloon')).toBeNull();
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('pauses auto-dismiss while hovered and resumes on leave', () => {
      announce(data());
      q('.fw-balloon')!.dispatchEvent(new Event('pointerenter'));
      vi.advanceTimersByTime(FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS * 2);
      settle();
      expect(q('.fw-balloon')).not.toBeNull();
      q('.fw-balloon')!.dispatchEvent(new Event('pointerleave'));
      vi.advanceTimersByTime(FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS + 1);
      settle();
      expect(q('.fw-balloon')).toBeNull();
    });

    it('closes with the close button', () => {
      announce(data());
      (q('.fw-balloon__close') as HTMLButtonElement).click();
      settle();
      expect(q('.fw-balloon')).toBeNull();
    });

    it('closes on Escape, but leaves Escape to an open modal dialog', () => {
      announce(data());
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      document.body.appendChild(modal);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      settle();
      expect(q('.fw-balloon')).not.toBeNull();
      modal.remove();

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      settle();
      expect(q('.fw-balloon')).toBeNull();
    });

    it('reopens the latest result after dismissal', () => {
      announce(data());
      (q('.fw-balloon__close') as HTMLButtonElement).click();
      settle();
      fixture.componentInstance.reopen();
      settle();
      expect(q('.fw-balloon')).not.toBeNull();
      expect(q('.fw-balloon__value')!.textContent).toBe('8');
    });

    it('reopen does nothing without a result', () => {
      fixture.componentInstance.reopen();
      settle();
      expect(q('.fw-balloon')).toBeNull();
    });
  });

  describe('setting off', () => {
    it('stays hidden when the setting is off, even if announced', () => {
      enabled.set(false);
      announce(accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8)], 8));
      expect(q('.fw-balloon')).toBeNull();
    });

    it('hides when the setting is turned off while shown, and reopen is a no-op', () => {
      announce(accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8)], 8));
      enabled.set(false);
      settle();
      expect(q('.fw-balloon')).toBeNull();
      fixture.componentInstance.reopen();
      settle();
      expect(q('.fw-balloon')).toBeNull();
    });
  });

  it('ships a prefers-reduced-motion rule that disables the balloon animation', () => {
    announce(accuracy([vote('a', 'Ann', 1), vote('b', 'Ben', 8)], 8));
    const css = Array.from(document.head.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const idx = css.indexOf('prefers-reduced-motion');
    expect(idx).toBeGreaterThan(-1);
    const rule = css.slice(idx, css.indexOf('}', css.indexOf('}', idx) + 1) + 1);
    expect(rule).toContain('animation: none');
  });
});
