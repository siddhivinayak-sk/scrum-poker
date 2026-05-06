import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { ToastComponent } from './toast.component';
import { ToastService, ToastMessage } from '../../services/toast.service';

describe('ToastComponent', () => {
  let component: ToastComponent;
  let fixture: ComponentFixture<ToastComponent>;
  let toastsSignal: WritableSignal<ToastMessage[]>;
  let mockDismiss: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toastsSignal = signal<ToastMessage[]>([]);
    mockDismiss = vi.fn();

    const mockToastService = {
      toasts: toastsSignal.asReadonly(),
      show: vi.fn(),
      dismiss: mockDismiss,
    };

    TestBed.configureTestingModule({
      imports: [ToastComponent],
      providers: [{ provide: ToastService, useValue: mockToastService }],
    });

    fixture = TestBed.createComponent(ToastComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  const makeToast = (
    overrides: Partial<ToastMessage> = {}
  ): ToastMessage => ({
    id: overrides.id ?? 'toast-1',
    type: overrides.type ?? 'info',
    message: overrides.message ?? 'Test message',
    createdAt: overrides.createdAt ?? Date.now(),
  });

  describe('rendering toasts', () => {
    it('should render no toasts when the list is empty', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const toastElements = compiled.querySelectorAll('.toast');
      expect(toastElements.length).toBe(0);
    });

    it('should render toasts from ToastService', () => {
      toastsSignal.set([
        makeToast({ id: 't1', message: 'First' }),
        makeToast({ id: 't2', message: 'Second' }),
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastElements = compiled.querySelectorAll('.toast');
      expect(toastElements.length).toBe(2);
    });

    it('should display the toast message text', () => {
      toastsSignal.set([makeToast({ message: 'Connection lost' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const messageEl = compiled.querySelector('.toast__message');
      expect(messageEl?.textContent?.trim()).toBe('Connection lost');
    });
  });

  describe('CSS class per type', () => {
    it('should apply toast--error class for error toasts', () => {
      toastsSignal.set([makeToast({ type: 'error' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.classList.contains('toast--error')).toBe(true);
      expect(toastEl?.classList.contains('toast--warning')).toBe(false);
      expect(toastEl?.classList.contains('toast--info')).toBe(false);
    });

    it('should apply toast--warning class for warning toasts', () => {
      toastsSignal.set([makeToast({ type: 'warning' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.classList.contains('toast--warning')).toBe(true);
      expect(toastEl?.classList.contains('toast--error')).toBe(false);
      expect(toastEl?.classList.contains('toast--info')).toBe(false);
    });

    it('should apply toast--info class for info toasts', () => {
      toastsSignal.set([makeToast({ type: 'info' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.classList.contains('toast--info')).toBe(true);
      expect(toastEl?.classList.contains('toast--error')).toBe(false);
      expect(toastEl?.classList.contains('toast--warning')).toBe(false);
    });
  });

  describe('dismiss button', () => {
    it('should render a dismiss button for each toast', () => {
      toastsSignal.set([
        makeToast({ id: 't1' }),
        makeToast({ id: 't2' }),
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const dismissButtons = compiled.querySelectorAll('.toast__dismiss');
      expect(dismissButtons.length).toBe(2);
    });

    it('should call toastService.dismiss() with the correct id when clicked', () => {
      toastsSignal.set([makeToast({ id: 'abc-123' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const dismissButton = compiled.querySelector('.toast__dismiss') as HTMLButtonElement;
      dismissButton.click();

      expect(mockDismiss).toHaveBeenCalledWith('abc-123');
    });

    it('should have an accessible aria-label on the dismiss button', () => {
      toastsSignal.set([
        makeToast({ type: 'error', message: 'Connection failed' }),
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const dismissButton = compiled.querySelector('.toast__dismiss');
      const ariaLabel = dismissButton?.getAttribute('aria-label');
      expect(ariaLabel).toBe('Dismiss error notification: Connection failed');
    });
  });

  describe('ARIA attributes', () => {
    it('should set role="alert" for error toasts', () => {
      toastsSignal.set([makeToast({ type: 'error' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('role')).toBe('alert');
    });

    it('should set role="status" for warning toasts', () => {
      toastsSignal.set([makeToast({ type: 'warning' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('role')).toBe('status');
    });

    it('should set role="status" for info toasts', () => {
      toastsSignal.set([makeToast({ type: 'info' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('role')).toBe('status');
    });

    it('should set aria-live="assertive" for error toasts', () => {
      toastsSignal.set([makeToast({ type: 'error' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('aria-live')).toBe('assertive');
    });

    it('should set aria-live="polite" for warning toasts', () => {
      toastsSignal.set([makeToast({ type: 'warning' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('aria-live')).toBe('polite');
    });

    it('should set aria-live="polite" for info toasts', () => {
      toastsSignal.set([makeToast({ type: 'info' })]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastEl = compiled.querySelector('.toast');
      expect(toastEl?.getAttribute('aria-live')).toBe('polite');
    });

    it('should set aria-atomic="true" on all toasts', () => {
      toastsSignal.set([
        makeToast({ id: 't1', type: 'error' }),
        makeToast({ id: 't2', type: 'info' }),
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastElements = compiled.querySelectorAll('.toast');
      toastElements.forEach((el) => {
        expect(el.getAttribute('aria-atomic')).toBe('true');
      });
    });
  });

  describe('toast container', () => {
    it('should have a toast-container element with aria-label', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const container = compiled.querySelector('.toast-container');
      expect(container).toBeTruthy();
      expect(container?.getAttribute('aria-label')).toBe('Notifications');
    });

    it('should position the container with fixed positioning in top-right corner', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const container = compiled.querySelector('.toast-container') as HTMLElement;
      const styles = getComputedStyle(container);
      expect(styles.position).toBe('fixed');
    });
  });

  describe('multiple toast types rendered together', () => {
    it('should correctly apply different ARIA roles and classes for mixed toast types', () => {
      toastsSignal.set([
        makeToast({ id: 't1', type: 'error', message: 'Error msg' }),
        makeToast({ id: 't2', type: 'warning', message: 'Warning msg' }),
        makeToast({ id: 't3', type: 'info', message: 'Info msg' }),
      ]);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const toastElements = compiled.querySelectorAll('.toast');

      // Error toast
      expect(toastElements[0].classList.contains('toast--error')).toBe(true);
      expect(toastElements[0].getAttribute('role')).toBe('alert');
      expect(toastElements[0].getAttribute('aria-live')).toBe('assertive');

      // Warning toast
      expect(toastElements[1].classList.contains('toast--warning')).toBe(true);
      expect(toastElements[1].getAttribute('role')).toBe('status');
      expect(toastElements[1].getAttribute('aria-live')).toBe('polite');

      // Info toast
      expect(toastElements[2].classList.contains('toast--info')).toBe(true);
      expect(toastElements[2].getAttribute('role')).toBe('status');
      expect(toastElements[2].getAttribute('aria-live')).toBe('polite');
    });
  });
});
