import { beforeEach, describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FinalWeightLeaderboardButtonComponent } from './final-weight-leaderboard-button.component';
import { SessionStateService } from '../../services/session-state.service';

/** Accuracy leaderboard header button: visibility and emit. */
describe('FinalWeightLeaderboardButtonComponent', () => {
  let fixture: ComponentFixture<FinalWeightLeaderboardButtonComponent>;
  let enabled: ReturnType<typeof signal<boolean>>;

  const btn = (): HTMLButtonElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button');

  beforeEach(() => {
    enabled = signal(false);
    TestBed.configureTestingModule({
      imports: [FinalWeightLeaderboardButtonComponent],
      providers: [
        { provide: SessionStateService, useValue: { finalWeightEnabled: enabled } },
      ],
    });
    fixture = TestBed.createComponent(FinalWeightLeaderboardButtonComponent);
    fixture.detectChanges();
  });

  it('is hidden when the final weight setting is off', () => {
    expect(btn()).toBeNull();
  });

  it('renders an accessible trophy button when the setting is on', () => {
    enabled.set(true);
    fixture.detectChanges();
    const button = btn();
    expect(button).toBeTruthy();
    expect(button?.getAttribute('aria-label')).toBe('Accuracy leaderboard');
    expect(button?.getAttribute('title')).toContain('Accuracy leaderboard');
  });

  it('emits openLeaderboard when clicked', () => {
    enabled.set(true);
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.openLeaderboard.subscribe(() => (emitted += 1));
    btn()?.click();
    expect(emitted).toBe(1);
  });
});