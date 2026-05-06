import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { StoryManagerComponent } from './story-manager.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { User, VotingRound, SessionConfiguration } from '@shared/types';

describe('StoryManagerComponent', () => {
  let component: StoryManagerComponent;
  let mockWsService: { send: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; connectionState: ReturnType<typeof signal> };
  let currentUserSignal: WritableSignal<User | null>;
  let currentRoundSignal: WritableSignal<VotingRound | null>;
  let isRevealedSignal: WritableSignal<boolean>;
  let hasIssuePermissionSignal: WritableSignal<boolean>;
  let hasRevealPermissionSignal: WritableSignal<boolean>;
  let sessionConfigSignal: WritableSignal<SessionConfiguration | null>;

  beforeEach(() => {
    currentUserSignal = signal<User | null>(null);
    currentRoundSignal = signal<VotingRound | null>(null);
    isRevealedSignal = signal<boolean>(false);
    hasIssuePermissionSignal = signal<boolean>(false);
    hasRevealPermissionSignal = signal<boolean>(false);
    sessionConfigSignal = signal<SessionConfiguration | null>(null);

    const mockSessionState = {
      currentRound: currentRoundSignal.asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: isRevealedSignal.asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: currentUserSignal.asReadonly(),
      votingSystemCards: signal([]).asReadonly(),
      sessionConfig: sessionConfigSignal.asReadonly(),
      hasIssuePermission: hasIssuePermissionSignal.asReadonly(),
      hasRevealPermission: hasRevealPermissionSignal.asReadonly(),
      countdownActive: signal(false).asReadonly(),
      votedUserIds: signal(new Set()).asReadonly(),
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

    const fixture = TestBed.createComponent(StoryManagerComponent);
    component = fixture.componentInstance;
  });

  describe('visibility based on role', () => {
    it('should be visible when user is a moderator', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(true);
    });

    it('should not be visible when user is a participant', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(false);
    });

    it('should not be visible when no user is logged in', () => {
      expect(component.isModerator()).toBe(false);
    });
  });

  describe('story input validation', () => {
    it('should show validation error when submitting empty story', () => {
      component.storyDescription = '';
      component.submitStory();
      expect(component.showValidationError()).toBe(true);
      expect(mockWsService.send).not.toHaveBeenCalled();
    });

    it('should show validation error when submitting whitespace-only story', () => {
      component.storyDescription = '   ';
      component.submitStory();
      expect(component.showValidationError()).toBe(true);
      expect(mockWsService.send).not.toHaveBeenCalled();
    });

    it('should clear validation error on valid submission', () => {
      component.storyDescription = '';
      component.submitStory();
      expect(component.showValidationError()).toBe(true);

      component.storyDescription = 'Valid story';
      component.submitStory();
      expect(component.showValidationError()).toBe(false);
    });
  });

  describe('story submission', () => {
    it('should send story:submit event with trimmed description', () => {
      component.storyDescription = '  My story  ';
      component.submitStory();
      expect(mockWsService.send).toHaveBeenCalledWith('story:submit', {
        storyDescription: 'My story',
      });
    });

    it('should clear the input after successful submission', () => {
      component.storyDescription = 'A story';
      component.submitStory();
      expect(component.storyDescription).toBe('');
    });
  });

  describe('button enable/disable states', () => {
    it('should disable submit when a round is active (voting)', () => {
      currentRoundSignal.set({
        id: 'r1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });
      expect(component.isRoundActive()).toBe(true);
    });

    it('should disable submit when a round is active (revealed)', () => {
      currentRoundSignal.set({
        id: 'r1',
        storyDescription: 'Test',
        status: 'revealed',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });
      expect(component.isRoundActive()).toBe(true);
    });

    it('should enable submit when no round is active', () => {
      expect(component.isRoundActive()).toBe(false);
    });

    it('should enable Reveal Cards only during voting', () => {
      currentRoundSignal.set({
        id: 'r1',
        storyDescription: 'Test',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });
      expect(component.canReveal()).toBe(true);
    });

    it('should disable Reveal Cards when round is revealed', () => {
      currentRoundSignal.set({
        id: 'r1',
        storyDescription: 'Test',
        status: 'revealed',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });
      expect(component.canReveal()).toBe(false);
    });

    it('should disable Reveal Cards when no round exists', () => {
      expect(component.canReveal()).toBe(false);
    });

    it('should enable Clear Board only after reveal', () => {
      isRevealedSignal.set(true);
      expect(component.canClear()).toBe(true);
    });

    it('should disable Clear Board before reveal', () => {
      isRevealedSignal.set(false);
      expect(component.canClear()).toBe(false);
    });
  });

  describe('WebSocket events', () => {
    it('should send cards:reveal event', () => {
      component.revealCards();
      expect(mockWsService.send).toHaveBeenCalledWith('cards:reveal', {});
    });

    it('should send board:clear event', () => {
      component.clearBoard();
      expect(mockWsService.send).toHaveBeenCalledWith('board:clear', {});
    });

    it('should send round:revote event', () => {
      component.revote();
      expect(mockWsService.send).toHaveBeenCalledWith('round:revote', {});
    });
  });

  describe('re-vote button', () => {
    it('should show re-vote button when cards are revealed and user has reveal permission', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      hasRevealPermissionSignal.set(true);
      isRevealedSignal.set(true);
      currentRoundSignal.set({
        id: 'r1',
        storyDescription: 'Test',
        status: 'revealed',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      expect(component.canRevealCards()).toBe(true);
      expect(component.isRevealed()).toBe(true);
    });

    it('should not show re-vote button when cards are not revealed', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      hasRevealPermissionSignal.set(true);
      isRevealedSignal.set(false);

      expect(component.isRevealed()).toBe(false);
    });

    it('should not show re-vote button when user does not have reveal permission', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasRevealPermissionSignal.set(false);
      isRevealedSignal.set(true);
      sessionConfigSignal.set({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(component.canRevealCards()).toBe(false);
    });
  });

  describe('permission-based visibility', () => {
    it('should show story submission controls when hasIssuePermission is true', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasIssuePermissionSignal.set(true);
      sessionConfigSignal.set({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'all-players', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(component.canManageStories()).toBe(true);
    });

    it('should hide story submission controls when hasIssuePermission is false and user is not moderator', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasIssuePermissionSignal.set(false);
      sessionConfigSignal.set({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(component.canManageStories()).toBe(false);
    });

    it('should show reveal button when hasRevealPermission is true', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasRevealPermissionSignal.set(true);
      sessionConfigSignal.set({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(component.canRevealCards()).toBe(true);
    });

    it('should hide reveal button when hasRevealPermission is false and user is not moderator', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasRevealPermissionSignal.set(false);
      sessionConfigSignal.set({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(component.canRevealCards()).toBe(false);
    });

    it('should fall back to moderator-only when no session config exists', () => {
      // Moderator should have access without session config
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      hasIssuePermissionSignal.set(false);
      hasRevealPermissionSignal.set(false);
      sessionConfigSignal.set(null);

      expect(component.canManageStories()).toBe(true);
      expect(component.canRevealCards()).toBe(true);
    });

    it('should deny participant access when no session config exists', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      hasIssuePermissionSignal.set(false);
      hasRevealPermissionSignal.set(false);
      sessionConfigSignal.set(null);

      expect(component.canManageStories()).toBe(false);
      expect(component.canRevealCards()).toBe(false);
    });
  });
});
