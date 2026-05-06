import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import { EMPTY } from 'rxjs';
import { UserMenuComponent, getAvatarLetter } from './user-menu.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { User } from '@shared/types';

describe('UserMenuComponent', () => {
  let component: UserMenuComponent;
  let fixture: ComponentFixture<UserMenuComponent>;
  let currentUserSignal: WritableSignal<User | null>;
  let mockWsService: {
    send: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    connectionState: ReturnType<typeof signal>;
  };
  let mockAuthService: {
    login: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    getToken: ReturnType<typeof vi.fn>;
    validateSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
  let mockRouter: { navigate: ReturnType<typeof vi.fn> };

  const testUser: User = {
    id: 'u1',
    displayName: 'Alice',
    role: 'participant',
    isAnonymous: false,
  };

  beforeEach(() => {
    currentUserSignal = signal<User | null>(testUser);

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: signal(false).asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: currentUserSignal.asReadonly(),
    };

    mockWsService = {
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    mockAuthService = {
      login: vi.fn(),
      getCurrentUser: vi.fn().mockReturnValue(signal(testUser)),
      getToken: vi.fn().mockReturnValue('test-token'),
      validateSession: vi.fn(),
      logout: vi.fn(),
    };

    mockRouter = {
      navigate: vi.fn().mockResolvedValue(true),
    };

    TestBed.configureTestingModule({
      imports: [UserMenuComponent],
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter },
      ],
    });

    fixture = TestBed.createComponent(UserMenuComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('getAvatarLetter (pure function)', () => {
    it('should return the first letter of a display name in uppercase', () => {
      expect(getAvatarLetter('Alice')).toBe('A');
    });

    it('should uppercase a lowercase first letter', () => {
      expect(getAvatarLetter('bob')).toBe('B');
    });

    it('should handle single character names', () => {
      expect(getAvatarLetter('z')).toBe('Z');
    });

    it('should handle names starting with a number', () => {
      expect(getAvatarLetter('3rdUser')).toBe('3');
    });
  });

  describe('avatar rendering', () => {
    it('should render the first letter of the display name in uppercase', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar');
      expect(avatarButton?.textContent?.trim()).toBe('A');
    });

    it('should update avatar letter when user changes', () => {
      currentUserSignal.set({ ...testUser, displayName: 'bob' });
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar');
      expect(avatarButton?.textContent?.trim()).toBe('B');
    });

    it('should not render when no user is present', () => {
      currentUserSignal.set(null);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.querySelector('.user-menu__avatar')).toBeNull();
    });
  });

  describe('dropdown open/close', () => {
    it('should not show dropdown initially', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.querySelector('.user-menu__dropdown')).toBeNull();
    });

    it('should open dropdown on avatar click', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      expect(compiled.querySelector('.user-menu__dropdown')).toBeTruthy();
    });

    it('should close dropdown on second avatar click (toggle)', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;

      avatarButton.click();
      fixture.detectChanges();
      expect(compiled.querySelector('.user-menu__dropdown')).toBeTruthy();

      avatarButton.click();
      fixture.detectChanges();
      expect(compiled.querySelector('.user-menu__dropdown')).toBeNull();
    });

    it('should close dropdown on outside click', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();
      expect(compiled.querySelector('.user-menu__dropdown')).toBeTruthy();

      // Simulate a click outside the component
      const outsideEvent = new MouseEvent('click', { bubbles: true });
      document.dispatchEvent(outsideEvent);
      fixture.detectChanges();

      expect(compiled.querySelector('.user-menu__dropdown')).toBeNull();
    });

    it('should close dropdown on Escape key', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();
      expect(compiled.querySelector('.user-menu__dropdown')).toBeTruthy();

      // Simulate Escape key on document
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent);
      fixture.detectChanges();

      expect(compiled.querySelector('.user-menu__dropdown')).toBeNull();
    });

    it('should display user info in dropdown', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const name = compiled.querySelector('.user-menu__name');
      const role = compiled.querySelector('.user-menu__role');
      expect(name?.textContent?.trim()).toBe('Alice');
      expect(role?.textContent?.trim()).toBe('participant');
    });
  });

  describe('role switch', () => {
    it('should send role:change WebSocket event when switching role', () => {
      component.toggleMenu();
      fixture.detectChanges();

      component.switchRole();

      expect(mockWsService.send).toHaveBeenCalledWith('role:change', {
        role: 'moderator',
      });
    });

    it('should send role:change to participant when current role is moderator', () => {
      currentUserSignal.set({ ...testUser, role: 'moderator' });
      fixture.detectChanges();

      component.switchRole();

      expect(mockWsService.send).toHaveBeenCalledWith('role:change', {
        role: 'participant',
      });
    });

    it('should close menu after switching role', () => {
      component.toggleMenu();
      fixture.detectChanges();
      expect(component.menuOpen()).toBe(true);

      component.switchRole();
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(false);
    });

    it('should not send event when no user is logged in', () => {
      currentUserSignal.set(null);
      fixture.detectChanges();

      component.switchRole();

      expect(mockWsService.send).not.toHaveBeenCalled();
    });

    it('should display the switch role button with correct label', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const menuItems = compiled.querySelectorAll('.user-menu__item');
      expect(menuItems[0]?.textContent?.trim()).toContain('Switch to moderator');
    });
  });

  describe('logout', () => {
    it('should call AuthService.logout()', () => {
      component.logout();
      expect(mockAuthService.logout).toHaveBeenCalled();
    });

    it('should redirect to login page', () => {
      component.logout();
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('should close menu after logout', () => {
      component.toggleMenu();
      fixture.detectChanges();
      expect(component.menuOpen()).toBe(true);

      component.logout();
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(false);
    });

    it('should call logout and navigate in order', () => {
      component.logout();

      expect(mockAuthService.logout).toHaveBeenCalledTimes(1);
      expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/login']);
    });
  });

  describe('keyboard navigation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should open menu with Enter key on avatar button', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;

      // Enter key triggers click on buttons natively, so we simulate click
      avatarButton.click();
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(true);
    });

    it('should open menu with ArrowDown on avatar button', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;

      const arrowDownEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
      avatarButton.dispatchEvent(arrowDownEvent);
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(true);
    });

    it('should navigate down with ArrowDown key in menu', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      const compiled = fixture.nativeElement as HTMLElement;
      const menuItems = compiled.querySelectorAll('[role="menuitem"]');

      const arrowDownEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
      menuItems[0].dispatchEvent(arrowDownEvent);
      fixture.detectChanges();

      expect(component.focusedIndex()).toBe(1);
    });

    it('should navigate up with ArrowUp key in menu', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      // Start at second item
      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 0);
      fixture.detectChanges();
      expect(component.focusedIndex()).toBe(1);

      // Navigate up
      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }), 1);
      fixture.detectChanges();
      expect(component.focusedIndex()).toBe(0);
    });

    it('should clamp focus at first item when pressing ArrowUp at top', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }), 0);
      fixture.detectChanges();

      expect(component.focusedIndex()).toBe(0);
    });

    it('should clamp focus at last item when pressing ArrowDown at bottom', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 1);
      fixture.detectChanges();

      expect(component.focusedIndex()).toBe(1);
    });

    it('should close menu and return focus to avatar on Escape from menu item', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      const compiled = fixture.nativeElement as HTMLElement;
      const menuItems = compiled.querySelectorAll('[role="menuitem"]');

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      menuItems[0].dispatchEvent(escapeEvent);
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(false);
    });

    it('should navigate to first item with Home key', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      // Move to second item first
      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 0);
      expect(component.focusedIndex()).toBe(1);

      // Press Home
      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'Home' }), 1);
      fixture.detectChanges();

      expect(component.focusedIndex()).toBe(0);
    });

    it('should navigate to last item with End key', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'End' }), 0);
      fixture.detectChanges();

      expect(component.focusedIndex()).toBe(1);
    });

    it('should close menu on Tab key', () => {
      component.toggleMenu();
      fixture.detectChanges();
      vi.advanceTimersByTime(0);

      component.onMenuItemKeydown(new KeyboardEvent('keydown', { key: 'Tab' }), 0);
      fixture.detectChanges();

      expect(component.menuOpen()).toBe(false);
    });
  });

  describe('ARIA labels', () => {
    it('should have aria-label on avatar button with user name', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar');
      expect(avatarButton?.getAttribute('aria-label')).toBe('User menu for Alice');
    });

    it('should have aria-expanded on avatar button', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar');
      expect(avatarButton?.getAttribute('aria-expanded')).toBe('false');

      (avatarButton as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(avatarButton?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should have aria-haspopup on avatar button', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar');
      expect(avatarButton?.getAttribute('aria-haspopup')).toBe('true');
    });

    it('should have role="menu" on dropdown', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const dropdown = compiled.querySelector('.user-menu__dropdown');
      expect(dropdown?.getAttribute('role')).toBe('menu');
    });

    it('should have aria-label on dropdown menu', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const dropdown = compiled.querySelector('.user-menu__dropdown');
      expect(dropdown?.getAttribute('aria-label')).toBe('User menu');
    });

    it('should have role="menuitem" on all menu options', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const menuItems = compiled.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(2);
    });

    it('should have aria-label on role switch option', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const menuItems = compiled.querySelectorAll('[role="menuitem"]');
      expect(menuItems[0]?.getAttribute('aria-label')).toBe('Switch to moderator role');
    });

    it('should have aria-label on logout option', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const menuItems = compiled.querySelectorAll('[role="menuitem"]');
      expect(menuItems[1]?.getAttribute('aria-label')).toBe('Logout');
    });

    it('should update aria-label on role switch when user role changes', () => {
      currentUserSignal.set({ ...testUser, role: 'moderator' });
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const avatarButton = compiled.querySelector('.user-menu__avatar') as HTMLButtonElement;
      avatarButton.click();
      fixture.detectChanges();

      const menuItems = compiled.querySelectorAll('[role="menuitem"]');
      expect(menuItems[0]?.getAttribute('aria-label')).toBe('Switch to participant role');
    });
  });
});
