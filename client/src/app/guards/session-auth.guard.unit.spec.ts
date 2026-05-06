import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivatedRouteSnapshot, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { sessionAuthGuard } from './session-auth.guard';
import { authGuard } from './auth.guard';
import { routes } from '../app.routes';
import { Signal, signal } from '@angular/core';
import { User } from '@shared/types';

/**
 * Unit tests for sessionAuthGuard and route configuration.
 *
 * These complement the property-based tests in session-auth.guard.spec.ts
 * by testing specific concrete scenarios and route configuration.
 *
 * Validates: Requirements 4.1, 4.2, 4.4, 13.4
 */

interface MockAuthService {
  getCurrentUser: ReturnType<typeof vi.fn<() => Signal<User | null>>>;
  setReturnTo: ReturnType<typeof vi.fn<(path: string) => void>>;
}

function createMockRoute(sessionId: string): ActivatedRouteSnapshot {
  const paramMap = {
    get: (key: string) => (key === 'sessionId' ? sessionId : null),
    has: (key: string) => key === 'sessionId',
    getAll: (key: string) => (key === 'sessionId' ? [sessionId] : []),
    keys: ['sessionId'],
  };
  return { paramMap } as unknown as ActivatedRouteSnapshot;
}

describe('sessionAuthGuard - Unit Tests', () => {
  let mockAuthService: MockAuthService;

  beforeEach(() => {
    mockAuthService = {
      getCurrentUser: vi.fn<() => Signal<User | null>>(),
      setReturnTo: vi.fn<(path: string) => void>(),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    });
  });

  describe('unauthenticated user redirect', () => {
    it('should redirect to /login when user is not authenticated', () => {
      const userSignal = signal<User | null>(null);
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('abc12345');
      const result = TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(result).toBeInstanceOf(UrlTree);
      expect((result as UrlTree).toString()).toBe('/login');
    });

    it('should store returnTo with the session path for a specific session ID', () => {
      const userSignal = signal<User | null>(null);
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('xyz78901');
      TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(mockAuthService.setReturnTo).toHaveBeenCalledWith('/session/xyz78901');
    });

    it('should store returnTo with correct format /session/{sessionId}', () => {
      const userSignal = signal<User | null>(null);
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const sessionId = 'team2024';
      const route = createMockRoute(sessionId);
      TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(mockAuthService.setReturnTo).toHaveBeenCalledWith(`/session/${sessionId}`);
    });

    it('should not store returnTo when sessionId param is missing', () => {
      const userSignal = signal<User | null>(null);
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      // Route with no sessionId param
      const paramMap = {
        get: () => null,
        has: () => false,
        getAll: () => [],
        keys: [],
      };
      const route = { paramMap } as unknown as ActivatedRouteSnapshot;

      const result = TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(mockAuthService.setReturnTo).not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(UrlTree);
      expect((result as UrlTree).toString()).toBe('/login');
    });
  });

  describe('authenticated user access', () => {
    it('should return true for an authenticated participant', () => {
      const userSignal = signal<User | null>({
        id: 'user-123',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('abc12345');
      const result = TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(result).toBe(true);
    });

    it('should return true for an authenticated moderator', () => {
      const userSignal = signal<User | null>({
        id: 'mod-456',
        displayName: 'Bob',
        role: 'moderator',
        isAnonymous: false,
      });
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('session1');
      const result = TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(result).toBe(true);
    });

    it('should return true for an anonymous authenticated user', () => {
      const userSignal = signal<User | null>({
        id: 'anon-789',
        displayName: 'Guest',
        role: 'participant',
        isAnonymous: true,
      });
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('abc12345');
      const result = TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(result).toBe(true);
    });

    it('should not call setReturnTo when user is authenticated', () => {
      const userSignal = signal<User | null>({
        id: 'user-123',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      mockAuthService.getCurrentUser.mockReturnValue(userSignal);

      const route = createMockRoute('abc12345');
      TestBed.runInInjectionContext(() =>
        sessionAuthGuard(route, {} as any)
      );

      expect(mockAuthService.setReturnTo).not.toHaveBeenCalled();
    });
  });
});

describe('Route configuration - Unit Tests', () => {
  it('should have a /create-session route guarded by authGuard', () => {
    const createSessionRoute = routes.find((r) => r.path === 'create-session');

    expect(createSessionRoute).toBeDefined();
    expect(createSessionRoute!.canActivate).toBeDefined();
    expect(createSessionRoute!.canActivate!.length).toBe(1);
    expect(createSessionRoute!.canActivate![0]).toBe(authGuard);
  });

  it('should have a /create-session route with lazy-loaded component', () => {
    const createSessionRoute = routes.find((r) => r.path === 'create-session');

    expect(createSessionRoute).toBeDefined();
    expect(createSessionRoute!.loadComponent).toBeDefined();
    expect(typeof createSessionRoute!.loadComponent).toBe('function');
  });

  it('should have a /session/:sessionId route guarded by sessionAuthGuard', () => {
    const sessionRoute = routes.find((r) => r.path === 'session/:sessionId');

    expect(sessionRoute).toBeDefined();
    expect(sessionRoute!.canActivate).toBeDefined();
    expect(sessionRoute!.canActivate!.length).toBe(1);
    expect(sessionRoute!.canActivate![0]).toBe(sessionAuthGuard);
  });

  it('should have a /session/:sessionId route with lazy-loaded component', () => {
    const sessionRoute = routes.find((r) => r.path === 'session/:sessionId');

    expect(sessionRoute).toBeDefined();
    expect(sessionRoute!.loadComponent).toBeDefined();
    expect(typeof sessionRoute!.loadComponent).toBe('function');
  });

  it('should redirect /poker to /lobby', () => {
    const pokerRoute = routes.find((r) => r.path === 'poker');

    expect(pokerRoute).toBeDefined();
    expect(pokerRoute!.redirectTo).toBe('lobby');
    expect(pokerRoute!.pathMatch).toBe('full');
  });

  it('should redirect root path to /login', () => {
    const rootRoute = routes.find((r) => r.path === '');

    expect(rootRoute).toBeDefined();
    expect(rootRoute!.redirectTo).toBe('login');
    expect(rootRoute!.pathMatch).toBe('full');
  });

  it('should redirect wildcard paths to /login', () => {
    const wildcardRoute = routes.find((r) => r.path === '**');

    expect(wildcardRoute).toBeDefined();
    expect(wildcardRoute!.redirectTo).toBe('login');
  });

  it('should have a /login route with LoginComponent', () => {
    const loginRoute = routes.find((r) => r.path === 'login');

    expect(loginRoute).toBeDefined();
    expect(loginRoute!.component).toBeDefined();
  });
});
