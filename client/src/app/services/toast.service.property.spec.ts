import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { TestBed } from '@angular/core/testing';
import { ToastService, ToastType } from './toast.service';

/**
 * Property 20: Toast maximum visible count
 *
 * For any sequence of toast notifications added to the toast queue,
 * the number of visible toasts SHALL never exceed 3 at any point in time.
 * When a 4th toast is added, the oldest visible toast SHALL be removed.
 *
 * **Validates: Requirements 25.6**
 */
describe('Property 20: Toast maximum visible count', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should never have more than 3 visible toasts after any sequence of additions', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('error' as ToastType, 'warning' as ToastType, 'info' as ToastType),
            message: fc.string({ minLength: 1 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (toastInputs) => {
          const service = TestBed.inject(ToastService);

          for (const input of toastInputs) {
            service.show(input.type, input.message);
            // After each addition, verify at most 3 visible toasts
            expect(service.toasts().length).toBeLessThanOrEqual(3);
          }

          // Clean up timers for this run
          vi.runAllTimers();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should remove the oldest toast when a 4th is added', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('error' as ToastType, 'warning' as ToastType, 'info' as ToastType),
            message: fc.string({ minLength: 1 }),
          }),
          { minLength: 4, maxLength: 10 }
        ),
        (toastInputs) => {
          const service = TestBed.inject(ToastService);

          // Add first 3 toasts
          for (let i = 0; i < 3; i++) {
            service.show(toastInputs[i].type, toastInputs[i].message);
          }

          // Capture the IDs of the first 3 toasts
          const toastsAfterThree = service.toasts();
          expect(toastsAfterThree.length).toBe(3);
          const oldestId = toastsAfterThree[0].id;

          // Add the 4th toast
          service.show(toastInputs[3].type, toastInputs[3].message);

          const toastsAfterFour = service.toasts();
          // Still at most 3
          expect(toastsAfterFour.length).toBe(3);
          // The oldest toast should have been removed
          const remainingIds = toastsAfterFour.map((t) => t.id);
          expect(remainingIds).not.toContain(oldestId);

          // Clean up timers for this run
          vi.runAllTimers();
        }
      ),
      { numRuns: 100 }
    );
  });
});
