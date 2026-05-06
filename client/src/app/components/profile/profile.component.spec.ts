import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { ProfileComponent, toggleRole, applyRoleChange } from './profile.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { User } from '@shared/types';

describe('ProfileComponent', () => {
  let component: ProfileComponent;
  let mockWsService: { send: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; connectionState: ReturnType<typeof signal> };
  let currentUserSignal: WritableSignal<User | null>;

  beforeEach(() => {
    currentUserSignal = signal<User | null>(null);

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

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
      ],
    });

    const fixture = TestBed.createComponent(ProfileComponent);
    component = fixture.componentInstance;
  });

  describe('user display', () => {
    it('should expose current user from session state', () => {
      expect(component.currentUser()).toBeNull();

      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });

      expect(component.currentUser()?.displayName).toBe('Alice');
      expect(component.currentUser()?.role).toBe('participant');
    });
  });

  describe('role toggle', () => {
    it('should show next role as moderator when current is participant', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      expect(component.nextRole()).toBe('moderator');
    });

    it('should show next role as participant when current is moderator', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      expect(component.nextRole()).toBe('participant');
    });

    it('should default to moderator when no user', () => {
      expect(component.nextRole()).toBe('moderator');
    });
  });

  describe('role change event', () => {
    it('should send role:change event with new role when switching', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });

      component.switchRole();

      expect(mockWsService.send).toHaveBeenCalledWith('role:change', {
        role: 'moderator',
      });
    });

    it('should send role:change to participant when current is moderator', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });

      component.switchRole();

      expect(mockWsService.send).toHaveBeenCalledWith('role:change', {
        role: 'participant',
      });
    });

    it('should not send event when no user is logged in', () => {
      component.switchRole();
      expect(mockWsService.send).not.toHaveBeenCalled();
    });
  });
});

describe('toggleRole (pure function)', () => {
  it('should return moderator for participant', () => {
    expect(toggleRole('participant')).toBe('moderator');
  });

  it('should return participant for moderator', () => {
    expect(toggleRole('moderator')).toBe('participant');
  });
});

describe('applyRoleChange (pure function)', () => {
  it('should return a new user with the updated role', () => {
    const user: User = {
      id: 'u1',
      displayName: 'Alice',
      role: 'participant',
      isAnonymous: false,
    };
    const updated = applyRoleChange(user, 'moderator');
    expect(updated.role).toBe('moderator');
    expect(updated.id).toBe('u1');
    expect(updated.displayName).toBe('Alice');
  });

  it('should not mutate the original user', () => {
    const user: User = {
      id: 'u1',
      displayName: 'Alice',
      role: 'participant',
      isAnonymous: false,
    };
    applyRoleChange(user, 'moderator');
    expect(user.role).toBe('participant');
  });
});
