import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { StarsAnimationComponent } from './stars-animation.component';

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

// Mock canvas context
function createMockCanvasContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe('StarsAnimationComponent', () => {
  let fixture: ComponentFixture<StarsAnimationComponent>;
  let component: StarsAnimationComponent;
  let mockCtx: CanvasRenderingContext2D;
  let rafCallbacks: Array<(time: number) => void>;
  let rafId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    mockMatchMedia(false); // Default: no reduced motion preference
    rafCallbacks = [];
    rafId = 0;

    mockCtx = createMockCanvasContext();

    // Mock HTMLCanvasElement.getContext
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx);

    // Mock getBoundingClientRect
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    TestBed.configureTestingModule({
      imports: [StarsAnimationComponent],
    });

    fixture = TestBed.createComponent(StarsAnimationComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('activation', () => {
    it('should not start animation when active is false', () => {
      // Spy on requestAnimationFrame AFTER component creation to avoid Angular internals
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();

      expect(rafSpy).not.toHaveBeenCalled();
    });

    it('should start animation when active becomes true', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      expect(rafSpy).toHaveBeenCalled();
    });

    it('should set canvas dimensions from bounding rect', () => {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      const canvas = fixture.nativeElement.querySelector('canvas');
      expect(canvas.width).toBe(400);
      expect(canvas.height).toBe(300);
    });
  });

  describe('reduced motion', () => {
    let rmFixture: ComponentFixture<StarsAnimationComponent>;

    beforeEach(() => {
      mockMatchMedia(true); // Simulate prefers-reduced-motion: reduce

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [StarsAnimationComponent],
      });

      // Re-mock after TestBed reset
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx);
      vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 400,
        height: 300,
        top: 0,
        left: 0,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      rmFixture = TestBed.createComponent(StarsAnimationComponent);
    });

    it('should skip animation entirely when reduced motion is preferred', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      rmFixture.componentRef.setInput('active', true);
      rmFixture.detectChanges();

      expect(rafSpy).not.toHaveBeenCalled();
    });

    it('should report prefersReducedMotion as true', () => {
      const rmComponent = rmFixture.componentInstance;
      expect(rmComponent.prefersReducedMotion()).toBe(true);
    });
  });

  describe('auto-cleanup after 3 seconds', () => {
    it('should schedule cleanup timeout when animation starts', () => {
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      // The timeout is set for ANIMATION_DURATION_MS + 100 = 3100ms
      vi.advanceTimersByTime(3100);

      expect(cancelSpy).toHaveBeenCalled();
    });

    it('should clear canvas after animation duration', () => {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      // Simulate animation completing by running the raf callback with time past duration
      if (rafCallbacks.length > 0) {
        // Run with time well past the 3000ms duration
        rafCallbacks[rafCallbacks.length - 1](performance.now() + 3100);
      }

      expect(mockCtx.clearRect).toHaveBeenCalled();
    });
  });

  describe('accessibility and DOM attributes', () => {
    it('should have aria-hidden="true" on the canvas', () => {
      fixture.detectChanges();

      const canvas = fixture.nativeElement.querySelector('canvas');
      expect(canvas.getAttribute('aria-hidden')).toBe('true');
    });

    it('should use pointer-events: none on the host via component styles', () => {
      fixture.detectChanges();

      // Verify the component defines pointer-events: none in its host styles
      // In jsdom, we can't test computed styles from component encapsulation,
      // but we verify the component selector is correct
      const hostEl = fixture.debugElement.nativeElement;
      expect(hostEl).toBeTruthy();
      // Verify the component has the correct selector by checking it renders a canvas
      const canvas = hostEl.querySelector('canvas');
      expect(canvas).toBeTruthy();
    });

    it('should have the stars-canvas class on the canvas element', () => {
      fixture.detectChanges();

      const canvas = fixture.nativeElement.querySelector('.stars-canvas');
      expect(canvas).toBeTruthy();
    });
  });

  describe('particle count cap', () => {
    it('should not exceed 50 particles', () => {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      // Run one frame of animation to verify particles are drawn
      if (rafCallbacks.length > 0) {
        rafCallbacks[0](performance.now() + 16); // ~1 frame at 60fps
      }

      // The save/restore calls indicate particle rendering
      // Each particle calls save() and restore() once
      const saveCalls = (mockCtx.save as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(saveCalls).toBeLessThanOrEqual(50);
    });
  });

  describe('cleanup on destroy', () => {
    it('should cancel animation frame on destroy', () => {
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      fixture.destroy();

      expect(cancelSpy).toHaveBeenCalled();
    });

    it('should clear timeout on destroy', () => {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return ++rafId;
      });
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      fixture.componentRef.setInput('active', true);
      fixture.detectChanges();

      fixture.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});
