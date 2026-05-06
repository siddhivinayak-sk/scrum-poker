import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { CountdownOverlayComponent } from './countdown-overlay.component';

// Mock window.matchMedia for jsdom environment
function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('CountdownOverlayComponent', () => {
  let fixture: ComponentFixture<CountdownOverlayComponent>;
  let component: CountdownOverlayComponent;

  beforeEach(() => {
    vi.useFakeTimers();
    mockMatchMedia(false); // Default: no reduced motion preference

    TestBed.configureTestingModule({
      imports: [CountdownOverlayComponent],
    });

    fixture = TestBed.createComponent(CountdownOverlayComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('countdown sequence (3, 2, 1)', () => {
    it('should start at 3 when activated', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      expect(component.currentNumber()).toBe(3);
    });

    it('should show 2 after 1 second', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      vi.advanceTimersByTime(1000);
      expect(component.currentNumber()).toBe(2);
    });

    it('should show 1 after 2 seconds', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      vi.advanceTimersByTime(2000);
      expect(component.currentNumber()).toBe(1);
    });

    it('should complete the full 3-2-1 sequence over 3 seconds', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      expect(component.currentNumber()).toBe(3);

      vi.advanceTimersByTime(1000);
      expect(component.currentNumber()).toBe(2);

      vi.advanceTimersByTime(1000);
      expect(component.currentNumber()).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(component.done()).toBe(true);
    });

    it('should not display overlay when not active', () => {
      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay).toBeNull();
    });

    it('should display overlay when active', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay).toBeTruthy();
    });

    it('should hide overlay after countdown completes', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      vi.advanceTimersByTime(3000);
      fixture.detectChanges();

      // done() is true, so the @if condition (active() && !done()) hides the overlay
      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay).toBeNull();
    });

    it('should display the countdown number in the overlay', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const numberEl = fixture.nativeElement.querySelector('.countdown-number');
      expect(numberEl?.textContent?.trim()).toBe('3');

      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(numberEl?.textContent?.trim()).toBe('2');
    });
  });

  describe('completion callback', () => {
    it('should emit onComplete after 3 seconds', () => {
      const completeSpy = vi.fn();
      component.onComplete.subscribe(completeSpy);

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      expect(completeSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3000);

      expect(completeSpy).toHaveBeenCalledTimes(1);
    });

    it('should not emit onComplete before 3 seconds', () => {
      const completeSpy = vi.fn();
      component.onComplete.subscribe(completeSpy);

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      vi.advanceTimersByTime(2999);

      expect(completeSpy).not.toHaveBeenCalled();
    });

    it('should not emit onComplete when not activated', () => {
      const completeSpy = vi.fn();
      component.onComplete.subscribe(completeSpy);

      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();

      vi.advanceTimersByTime(5000);

      expect(completeSpy).not.toHaveBeenCalled();
    });
  });

  describe('reset behavior', () => {
    it('should reset countdown when deactivated', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      vi.advanceTimersByTime(2000);
      expect(component.currentNumber()).toBe(1);

      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();

      expect(component.currentNumber()).toBe(3);
      expect(component.done()).toBe(false);
    });

    it('should clear timers on destroy', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      fixture.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('reduced-motion behavior', () => {
    it('should have animate class on countdown number when reduced motion is not preferred', () => {
      // matchMedia returns false (no reduced motion) in beforeEach
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const numberEl = fixture.nativeElement.querySelector('.countdown-number');
      expect(component.prefersReducedMotion).toBe(false);
      expect(numberEl?.classList.contains('animate')).toBe(true);
    });
  });

  describe('reduced-motion behavior (prefers-reduced-motion)', () => {
    let rmFixture: ComponentFixture<CountdownOverlayComponent>;
    let rmComponent: CountdownOverlayComponent;

    beforeEach(() => {
      mockMatchMedia(true); // Simulate prefers-reduced-motion: reduce

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [CountdownOverlayComponent],
      });

      rmFixture = TestBed.createComponent(CountdownOverlayComponent);
      rmComponent = rmFixture.componentInstance;
    });

    it('should not have animate class when reduced motion is preferred', () => {
      rmFixture.componentRef.setInput('active', true);
      rmFixture.detectChanges();

      const numberEl = rmFixture.nativeElement.querySelector('.countdown-number');
      expect(rmComponent.prefersReducedMotion).toBe(true);
      expect(numberEl?.classList.contains('animate')).toBe(false);
    });

    it('should still show countdown numbers without animation', () => {
      rmFixture.componentRef.setInput('active', true);
      rmFixture.detectChanges();

      expect(rmComponent.currentNumber()).toBe(3);

      vi.advanceTimersByTime(1000);
      expect(rmComponent.currentNumber()).toBe(2);

      vi.advanceTimersByTime(1000);
      expect(rmComponent.currentNumber()).toBe(1);
    });

    it('should still emit onComplete after countdown finishes', () => {
      const completeSpy = vi.fn();
      rmComponent.onComplete.subscribe(completeSpy);

      rmFixture.componentRef.setInput('active', true);
      rmFixture.detectChanges();

      vi.advanceTimersByTime(3000);

      expect(completeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('ARIA live region', () => {
    it('should have role="status" on the overlay', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay?.getAttribute('role')).toBe('status');
    });

    it('should have aria-live="assertive" on the overlay', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay?.getAttribute('aria-live')).toBe('assertive');
    });

    it('should have aria-atomic="true" on the overlay', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const overlay = fixture.nativeElement.querySelector('.overlay');
      expect(overlay?.getAttribute('aria-atomic')).toBe('true');
    });

    it('should announce each countdown number via the live region', () => {
      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      // The overlay with aria-live contains the countdown number
      const overlay = fixture.nativeElement.querySelector('[aria-live="assertive"]');
      expect(overlay).toBeTruthy();
      expect(overlay?.textContent?.trim()).toContain('3');

      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(overlay?.textContent?.trim()).toContain('2');

      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(overlay?.textContent?.trim()).toContain('1');
    });
  });
});
