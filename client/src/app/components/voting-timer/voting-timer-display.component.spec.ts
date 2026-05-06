import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { VotingTimerDisplayComponent } from './voting-timer-display.component';

describe('VotingTimerDisplayComponent', () => {
  let fixture: ComponentFixture<VotingTimerDisplayComponent>;
  let component: VotingTimerDisplayComponent;

  beforeEach(() => {
    vi.useFakeTimers();

    TestBed.configureTestingModule({
      imports: [VotingTimerDisplayComponent],
    });

    fixture = TestBed.createComponent(VotingTimerDisplayComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('MM:SS format', () => {
    it('should display 00:00 initially when no round is active', () => {
      fixture.detectChanges();
      expect(component.display()).toBe('00:00');
    });

    it('should display elapsed time in MM:SS format when revealed', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const reveal = new Date('2024-01-01T10:02:45Z'); // 2 min 45 sec

      fixture.componentRef.setInput('startedAt', start.toISOString());
      fixture.componentRef.setInput('revealedAt', reveal.toISOString());
      fixture.detectChanges();

      expect(component.display()).toBe('02:45');
    });

    it('should zero-pad single-digit minutes and seconds', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const reveal = new Date('2024-01-01T10:01:05Z'); // 1 min 5 sec

      fixture.componentRef.setInput('startedAt', start.toISOString());
      fixture.componentRef.setInput('revealedAt', reveal.toISOString());
      fixture.detectChanges();

      expect(component.display()).toBe('01:05');
    });
  });

  describe('running timer', () => {
    it('should start ticking when startedAt is set and revealedAt is null', () => {
      const now = new Date('2024-01-01T10:00:00Z');
      vi.setSystemTime(now);

      fixture.componentRef.setInput('startedAt', now.toISOString());
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      expect(component.display()).toBe('00:00');

      vi.advanceTimersByTime(3000);
      expect(component.display()).toBe('00:03');
    });

    it('should update every second while round is active', () => {
      const now = new Date('2024-01-01T10:00:00Z');
      vi.setSystemTime(now);

      fixture.componentRef.setInput('startedAt', now.toISOString());
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      vi.advanceTimersByTime(1000);
      expect(component.display()).toBe('00:01');

      vi.advanceTimersByTime(1000);
      expect(component.display()).toBe('00:02');

      vi.advanceTimersByTime(1000);
      expect(component.display()).toBe('00:03');
    });

    it('should handle times crossing minute boundaries', () => {
      const now = new Date('2024-01-01T10:00:00Z');
      vi.setSystemTime(now);

      fixture.componentRef.setInput('startedAt', now.toISOString());
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      vi.advanceTimersByTime(65000); // 1 min 5 sec
      expect(component.display()).toBe('01:05');
    });
  });

  describe('stops on reveal', () => {
    it('should stop the timer and show final time when revealedAt is set', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      vi.setSystemTime(start);

      fixture.componentRef.setInput('startedAt', start.toISOString());
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      // Timer is running
      vi.advanceTimersByTime(5000);
      expect(component.display()).toBe('00:05');

      // Now reveal at 10 seconds
      const reveal = new Date('2024-01-01T10:00:10Z');
      fixture.componentRef.setInput('revealedAt', reveal.toISOString());
      fixture.detectChanges();

      expect(component.display()).toBe('00:10');

      // Advancing time should NOT change the display since timer is stopped
      vi.advanceTimersByTime(5000);
      expect(component.display()).toBe('00:10');
    });
  });

  describe('resets on clear', () => {
    it('should reset to 00:00 when both inputs become null', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const reveal = new Date('2024-01-01T10:00:30Z');

      fixture.componentRef.setInput('startedAt', start.toISOString());
      fixture.componentRef.setInput('revealedAt', reveal.toISOString());
      fixture.detectChanges();

      expect(component.display()).toBe('00:30');

      // Clear the board — both inputs become null
      fixture.componentRef.setInput('startedAt', null);
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      expect(component.display()).toBe('00:00');
    });
  });

  describe('cleanup on destroy', () => {
    it('should clean up interval when component is destroyed', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const now = new Date('2024-01-01T10:00:00Z');
      vi.setSystemTime(now);

      fixture.componentRef.setInput('startedAt', now.toISOString());
      fixture.componentRef.setInput('revealedAt', null);
      fixture.detectChanges();

      // Timer should be running
      vi.advanceTimersByTime(2000);
      expect(component.display()).toBe('00:02');

      // Destroy the component
      fixture.destroy();

      // clearInterval should have been called
      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });
  });

  describe('ARIA attributes', () => {
    it('should have role="timer" on the display element', () => {
      fixture.detectChanges();

      const timerEl = fixture.nativeElement.querySelector('.timer-display');
      expect(timerEl).toBeTruthy();
      expect(timerEl.getAttribute('role')).toBe('timer');
    });

    it('should have an aria-label for accessibility', () => {
      fixture.detectChanges();

      const timerEl = fixture.nativeElement.querySelector('.timer-display');
      expect(timerEl.getAttribute('aria-label')).toBe('Voting timer');
    });
  });
});
