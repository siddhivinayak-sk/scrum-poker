import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToastService, ToastType } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
  });

  describe('show()', () => {
    it('should create a toast with correct type and message', () => {
      service.show('error', 'Connection lost');

      const toasts = service.toasts();
      expect(toasts.length).toBe(1);
      expect(toasts[0].type).toBe('error');
      expect(toasts[0].message).toBe('Connection lost');
    });

    it('should assign a UUID id to each toast', () => {
      service.show('info', 'Test message');

      const toasts = service.toasts();
      expect(toasts[0].id).toBeDefined();
      expect(typeof toasts[0].id).toBe('string');
      expect(toasts[0].id.length).toBeGreaterThan(0);
    });

    it('should assign unique ids to different toasts', () => {
      service.show('info', 'First');
      service.show('warning', 'Second');

      const toasts = service.toasts();
      expect(toasts[0].id).not.toBe(toasts[1].id);
    });

    it('should add toast to the toasts signal', () => {
      expect(service.toasts().length).toBe(0);

      service.show('warning', 'Low battery');
      expect(service.toasts().length).toBe(1);

      service.show('info', 'Update available');
      expect(service.toasts().length).toBe(2);
    });

    it('should set createdAt timestamp', () => {
      const now = Date.now();
      service.show('info', 'Test');

      const toast = service.toasts()[0];
      expect(toast.createdAt).toBeGreaterThanOrEqual(now);
    });

    it('should support all three toast types', () => {
      service.show('error', 'Error msg');
      service.show('warning', 'Warning msg');
      service.show('info', 'Info msg');

      const toasts = service.toasts();
      expect(toasts[0].type).toBe('error');
      expect(toasts[1].type).toBe('warning');
      expect(toasts[2].type).toBe('info');
    });
  });

  describe('auto-dismiss', () => {
    it('should auto-dismiss a toast after 5000ms', () => {
      service.show('info', 'Will disappear');
      expect(service.toasts().length).toBe(1);

      vi.advanceTimersByTime(4999);
      expect(service.toasts().length).toBe(1);

      vi.advanceTimersByTime(1);
      expect(service.toasts().length).toBe(0);
    });

    it('should auto-dismiss each toast independently after 5000ms', () => {
      service.show('info', 'First');
      vi.advanceTimersByTime(2000);

      service.show('warning', 'Second');
      expect(service.toasts().length).toBe(2);

      // First toast should dismiss at 5000ms from its creation
      vi.advanceTimersByTime(3000);
      expect(service.toasts().length).toBe(1);
      expect(service.toasts()[0].message).toBe('Second');

      // Second toast should dismiss at 5000ms from its creation
      vi.advanceTimersByTime(2000);
      expect(service.toasts().length).toBe(0);
    });
  });

  describe('dismiss()', () => {
    it('should remove a toast by id', () => {
      service.show('error', 'Remove me');
      const toastId = service.toasts()[0].id;

      service.dismiss(toastId);
      expect(service.toasts().length).toBe(0);
    });

    it('should only remove the specified toast', () => {
      service.show('error', 'Keep me');
      service.show('info', 'Remove me');

      const toasts = service.toasts();
      const removeId = toasts[1].id;
      const keepId = toasts[0].id;

      service.dismiss(removeId);

      expect(service.toasts().length).toBe(1);
      expect(service.toasts()[0].id).toBe(keepId);
    });

    it('should clear the auto-dismiss timer on manual dismiss', () => {
      service.show('info', 'Manual dismiss');
      const toastId = service.toasts()[0].id;

      // Manually dismiss before timeout
      service.dismiss(toastId);
      expect(service.toasts().length).toBe(0);

      // Advance past the auto-dismiss time — should not cause errors
      vi.advanceTimersByTime(6000);
      expect(service.toasts().length).toBe(0);
    });

    it('should handle dismissing a non-existent id gracefully', () => {
      service.show('info', 'Existing');
      service.dismiss('non-existent-id');

      expect(service.toasts().length).toBe(1);
    });
  });

  describe('max 3 visible toasts', () => {
    it('should enforce a maximum of 3 visible toasts', () => {
      service.show('error', 'Toast 1');
      service.show('warning', 'Toast 2');
      service.show('info', 'Toast 3');
      expect(service.toasts().length).toBe(3);

      service.show('error', 'Toast 4');
      expect(service.toasts().length).toBe(3);
    });

    it('should remove the oldest toast when a 4th is added', () => {
      service.show('error', 'Toast 1');
      service.show('warning', 'Toast 2');
      service.show('info', 'Toast 3');

      const oldestId = service.toasts()[0].id;

      service.show('error', 'Toast 4');

      const ids = service.toasts().map((t) => t.id);
      expect(ids).not.toContain(oldestId);
      expect(service.toasts()[2].message).toBe('Toast 4');
    });

    it('should clear the timer for the removed oldest toast', () => {
      service.show('error', 'Toast 1');
      service.show('warning', 'Toast 2');
      service.show('info', 'Toast 3');
      service.show('error', 'Toast 4');

      // All 4 toasts had timers set. After adding the 4th, the oldest was removed.
      // Advance time to clear all remaining timers — should not cause errors.
      vi.runAllTimers();
      expect(service.toasts().length).toBe(0);
    });
  });

  describe('ngOnDestroy', () => {
    it('should clear all timers on destroy', () => {
      service.show('error', 'Toast 1');
      service.show('warning', 'Toast 2');

      service.ngOnDestroy();

      // Advance past auto-dismiss time — timers should have been cleared
      // so no dismiss callbacks should fire (toasts signal won't be updated)
      // We verify no errors are thrown
      vi.advanceTimersByTime(10000);
    });
  });
});
