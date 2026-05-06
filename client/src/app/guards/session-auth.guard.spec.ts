import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { ActivatedRouteSnapshot, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { sessionAuthGuard } from './session-auth.guard';
import { Signal, signal } from '@angular/core';
import { User } from '@shared/types';

interface MockAuthService {
  getCurrentUser: ReturnType<typeof vi.fn<() => Signal<User | null>>>;
  setReturnTo: ReturnType<typeof vi.fn<(path: string) => void>>;
  getReturnTo: ReturnType<typeof vi.fn<() => string | null>>;
}

/**
 * Property 11: Unauthenticated session link redirect preserves session ID
 *
 * For any session ID, when an unauthenticated user navigates to `/session/{sessionId}`,
 * the redirect URL SHALL contain the original session ID as a `returnTo` parameter,
 * and after login the user SHALL be redirected to `/session/{sessionId}`.
 *
 * **Validates: Requirements 4.2**
 */
describe('Property 11: Unauthenticated session link redirect preserves session ID', () => {
  let mockAuthService: MockAuthService;
  let router: Router;

  beforeEach(() => {
    mockAuthService = {
      getCurrentUser: vi.fn<() => Signal<User | null>>(),
      setReturnTo: vi.fn<(path: string) => void>(),
      getReturnTo: vi.fn<() => string | null>(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    router = TestBed.inject(Router);
  });

  /**
   * Helper to create a mock ActivatedRouteSnapshot with a given sessionId param.
   */
  function createMockRoute(sessionId: string): ActivatedRouteSnapshot {
    const paramMap = {
      get: (key: string) => (key === 'sessionId' ? sessionId : null),
      has: (key: string) => key === 'sessionId',
      getAll: (key: string) => (key === 'sessionId' ? [sessionId] : []),
      keys: ['sessionId'],
    };

    return { paramMap } as unknown as ActivatedRouteSnapshot;
  }

  it('should store returnTo with session ID and redirect to /login for any unauthenticated session ID', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8}$/),
        (sessionId) => {
          // Reset mocks for each iteration
          mockAuthService.setReturnTo.mockClear();

          // Simulate unauthenticated user (getCurrentUser returns signal with null)
          const userSignal = signal<User | null>(null);
          mockAuthService.getCurrentUser.mockReturnValue(userSignal);

          const route = createMockRoute(sessionId);

          // Execute the guard within the TestBed injection context
          const result = TestBed.runInInjectionContext(() =>
            sessionAuthGuard(route, {} as any)
          );

          // Guard should call setReturnTo with the correct session path
          expect(mockAuthService.setReturnTo).toHaveBeenCalledWith(`/session/${sessionId}`);

          // Guard should return a UrlTree redirecting to /login
          expect(result).toBeInstanceOf(UrlTree);
          const urlTree = result as UrlTree;
          expect(urlTree.toString()).toBe('/login');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should preserve session ID through setReturnTo/getReturnTo round-trip for post-login redirect', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8}$/),
        (sessionId) => {
          // Track what was stored via setReturnTo
          let storedReturnTo: string | null = null;
          mockAuthService.setReturnTo.mockImplementation((path: string) => {
            storedReturnTo = path;
          });
          mockAuthService.getReturnTo.mockImplementation(() => {
            const val = storedReturnTo;
            storedReturnTo = null;
            return val;
          });

          // Simulate unauthenticated user
          const userSignal = signal<User | null>(null);
          mockAuthService.getCurrentUser.mockReturnValue(userSignal);

          const route = createMockRoute(sessionId);

          // Execute the guard — this stores the returnTo path
          TestBed.runInInjectionContext(() =>
            sessionAuthGuard(route, {} as any)
          );

          // Simulate post-login: getReturnTo should return the session path
          const returnTo = mockAuthService.getReturnTo();
          expect(returnTo).toBe(`/session/${sessionId}`);

          // After reading, returnTo should be cleared (one-time use)
          const secondRead = mockAuthService.getReturnTo();
          expect(secondRead).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should allow authenticated users through without redirect for any session ID', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8}$/),
        (sessionId) => {
          mockAuthService.setReturnTo.mockClear();

          // Simulate authenticated user
          const userSignal = signal<User | null>({
            id: 'user-1',
            displayName: 'Test',
            role: 'participant',
            isAnonymous: false,
          });
          mockAuthService.getCurrentUser.mockReturnValue(userSignal);

          const route = createMockRoute(sessionId);

          const result = TestBed.runInInjectionContext(() =>
            sessionAuthGuard(route, {} as any)
          );

          // Guard should return true (allow access)
          expect(result).toBe(true);

          // Guard should NOT call setReturnTo
          expect(mockAuthService.setReturnTo).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});
