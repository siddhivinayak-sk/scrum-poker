import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { signal } from '@angular/core';

describe('AuthService', () => {
  let service: AuthService;

  const mockToastService = {
    show: vi.fn(),
    dismiss: vi.fn(),
    toasts: signal([]),
  };

  // The AuthService constructor calls restoreSession() which uses localStorage.
  // In the Angular test environment, localStorage may be a simple object without
  // standard Storage methods. We need to ensure it has the methods the service uses.
  let originalLocalStorage: Storage;

  beforeEach(() => {
    // Save and mock localStorage with a simple in-memory implementation
    originalLocalStorage = globalThis.localStorage;
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete store[key]; }),
      clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
      get length() { return Object.keys(store).length; },
      key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true, configurable: true });

    // Clear sessionStorage return-to key
    sessionStorage.removeItem('scrum-poker-return-to');

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: ToastService, useValue: mockToastService },
      ],
    });

    service = TestBed.inject(AuthService);
  });

  afterEach(() => {
    sessionStorage.removeItem('scrum-poker-return-to');
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, writable: true, configurable: true });
  });

  describe('setReturnTo', () => {
    it('should store the path in sessionStorage', () => {
      service.setReturnTo('/session/abc12345');

      expect(sessionStorage.getItem('scrum-poker-return-to')).toBe('/session/abc12345');
    });

    it('should overwrite a previously stored path', () => {
      service.setReturnTo('/session/first');
      service.setReturnTo('/session/second');

      expect(sessionStorage.getItem('scrum-poker-return-to')).toBe('/session/second');
    });
  });

  describe('getReturnTo', () => {
    it('should return the stored path', () => {
      service.setReturnTo('/session/abc12345');

      const result = service.getReturnTo();

      expect(result).toBe('/session/abc12345');
    });

    it('should clear the stored path after reading', () => {
      service.setReturnTo('/session/abc12345');

      service.getReturnTo();

      expect(sessionStorage.getItem('scrum-poker-return-to')).toBeNull();
    });

    it('should return null when no path is stored', () => {
      const result = service.getReturnTo();

      expect(result).toBeNull();
    });

    it('should return null on second call after path was read and cleared', () => {
      service.setReturnTo('/session/abc12345');

      const first = service.getReturnTo();
      const second = service.getReturnTo();

      expect(first).toBe('/session/abc12345');
      expect(second).toBeNull();
    });
  });
});
