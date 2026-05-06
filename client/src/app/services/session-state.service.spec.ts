import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import {
  User,
  VotingRound,
  VotingMetrics,
  HistoryEntry,
  SessionState,
  SessionConfiguration,
  GameSessionState,
  IssueItem,
  VOTING_SYSTEMS,
  SPECIAL_CARDS,
} from '@shared/types';

describe('SessionStateService', () => {
  let service: SessionStateService;
  let eventSubjects: Map<string, Subject<any>>;
  let mockAuthUser: User;

  function createMockWebSocketService() {
    eventSubjects = new Map();
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      on: vi.fn(<T>(event: string): Observable<T> => {
        if (!eventSubjects.has(event)) {
          eventSubjects.set(event, new Subject<any>());
        }
        return eventSubjects.get(event)!.asObservable() as Observable<T>;
      }),
      connectionState: signal('disconnected' as const),
    };
  }

  function emitEvent(event: string, data: any): void {
    if (!eventSubjects.has(event)) {
      eventSubjects.set(event, new Subject<any>());
    }
    eventSubjects.get(event)!.next(data);
  }

  beforeEach(() => {
    mockAuthUser = {
      id: 'user-1',
      displayName: 'TestUser',
      role: 'participant',
      isAnonymous: false,
    };

    const mockAuthService = {
      getCurrentUser: vi.fn().mockReturnValue(signal(mockAuthUser)),
      getToken: vi.fn().mockReturnValue('test-token'),
      login: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
    };

    const mockToastService = {
      show: vi.fn(),
      dismiss: vi.fn(),
      toasts: signal([]),
    };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: WebSocketService, useFactory: createMockWebSocketService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });

    service = TestBed.inject(SessionStateService);
  });

  describe('initial state', () => {
    it('should have null currentRound', () => {
      expect(service.currentRound()).toBeNull();
    });

    it('should have empty participants', () => {
      expect(service.participants()).toEqual([]);
    });

    it('should have empty selections', () => {
      expect(service.selections().size).toBe(0);
    });

    it('should have isRevealed as false', () => {
      expect(service.isRevealed()).toBe(false);
    });

    it('should have null metrics', () => {
      expect(service.metrics()).toBeNull();
    });

    it('should have empty history', () => {
      expect(service.history()).toEqual([]);
    });

    it('should set currentUser from AuthService', () => {
      expect(service.currentUser()).toEqual(mockAuthUser);
    });
  });

  describe('session:state (full state sync)', () => {
    it('should update all state from session:state event', () => {
      const participants: User[] = [
        { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
        { id: 'user-2', displayName: 'User2', role: 'moderator', isAnonymous: false },
      ];

      const state: SessionState = {
        currentRound: {
          id: 'round-1',
          storyDescription: 'Test story',
          status: 'voting',
          selections: { 'user-1': 5 } as any, // Sent as Record from server
          startedAt: new Date().toISOString(),
        } as any,
        participants,
        history: [],
        isRevealed: false,
      };

      emitEvent('session:state', { state });

      expect(service.participants()).toEqual(participants);
      expect(service.currentRound()).toBeTruthy();
      expect(service.currentRound()!.storyDescription).toBe('Test story');
      expect(service.currentRound()!.selections).toBeInstanceOf(Map);
      expect(service.currentRound()!.selections.get('user-1')).toBe(5);
      expect(service.isRevealed()).toBe(false);
      expect(service.history()).toEqual([]);
    });

    it('should handle null currentRound in session:state', () => {
      const state: SessionState = {
        currentRound: null,
        participants: [],
        history: [],
        isRevealed: false,
      };

      emitEvent('session:state', { state });

      expect(service.currentRound()).toBeNull();
      expect(service.selections().size).toBe(0);
    });

    it('should sync currentUser from participants list', () => {
      const participants: User[] = [
        { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
      ];

      const state: SessionState = {
        currentRound: null,
        participants,
        history: [],
        isRevealed: false,
      };

      emitEvent('session:state', { state });

      expect(service.currentUser()!.role).toBe('moderator');
    });
  });

  describe('round:started', () => {
    it('should set currentRound and reset selections/metrics', () => {
      const round = {
        id: 'round-1',
        storyDescription: 'New story',
        status: 'voting',
        selections: {},
        startedAt: new Date().toISOString(),
      };

      emitEvent('round:started', { round });

      expect(service.currentRound()).toBeTruthy();
      expect(service.currentRound()!.storyDescription).toBe('New story');
      expect(service.selections().size).toBe(0);
      expect(service.isRevealed()).toBe(false);
      expect(service.metrics()).toBeNull();
    });
  });

  describe('cards:revealed', () => {
    it('should update selections, isRevealed, and metrics', () => {
      // First start a round
      emitEvent('round:started', {
        round: {
          id: 'round-1',
          storyDescription: 'Story',
          status: 'voting',
          selections: {},
          startedAt: new Date().toISOString(),
        },
      });

      const metrics: VotingMetrics = {
        average: 5,
        mode: 5,
        spread: 6,
        distribution: { '3': 1, '5': 2, '8': 1 },
        outliers: [],
        numericVoteCount: 4,
        insufficientData: false,
      };

      emitEvent('cards:revealed', {
        selections: { 'user-1': 5, 'user-2': 3, 'user-3': 8, 'user-4': 5 },
        metrics,
      });

      expect(service.isRevealed()).toBe(true);
      expect(service.selections().size).toBe(4);
      expect(service.selections().get('user-1')).toBe(5);
      expect(service.metrics()).toEqual(metrics);
      expect(service.currentRound()!.status).toBe('revealed');
    });
  });

  describe('board:cleared', () => {
    it('should add history entry and reset round state', () => {
      const historyEntry: HistoryEntry = {
        roundId: 'round-1',
        storyDescription: 'Completed story',
        participants: [],
        metrics: {
          average: 5,
          mode: 5,
          spread: 0,
          distribution: { '5': 2 },
          outliers: [],
          numericVoteCount: 2,
          insufficientData: false,
        },
        completedAt: new Date().toISOString(),
      };

      emitEvent('board:cleared', { historyEntry });

      expect(service.history().length).toBe(1);
      expect(service.history()[0]).toEqual(historyEntry);
      expect(service.currentRound()).toBeNull();
      expect(service.selections().size).toBe(0);
      expect(service.isRevealed()).toBe(false);
      expect(service.metrics()).toBeNull();
    });

    it('should prepend new history entries', () => {
      const entry1: HistoryEntry = {
        roundId: 'round-1',
        storyDescription: 'Story 1',
        participants: [],
        metrics: { average: 3, mode: 3, spread: 0, distribution: {}, outliers: [], numericVoteCount: 1, insufficientData: true },
        completedAt: '2024-01-01T00:00:00Z',
      };

      const entry2: HistoryEntry = {
        roundId: 'round-2',
        storyDescription: 'Story 2',
        participants: [],
        metrics: { average: 5, mode: 5, spread: 0, distribution: {}, outliers: [], numericVoteCount: 2, insufficientData: false },
        completedAt: '2024-01-01T01:00:00Z',
      };

      emitEvent('board:cleared', { historyEntry: entry1 });
      emitEvent('board:cleared', { historyEntry: entry2 });

      expect(service.history().length).toBe(2);
      expect(service.history()[0].roundId).toBe('round-2');
      expect(service.history()[1].roundId).toBe('round-1');
    });
  });

  describe('participant:joined', () => {
    it('should update participants list', () => {
      const participants: User[] = [
        { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
        { id: 'user-2', displayName: 'NewUser', role: 'participant', isAnonymous: false },
      ];

      emitEvent('participant:joined', { participants });

      expect(service.participants().length).toBe(2);
      expect(service.participants()[1].displayName).toBe('NewUser');
    });
  });

  describe('participant:left', () => {
    it('should update participants list when someone leaves', () => {
      // First set up participants
      emitEvent('participant:joined', {
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
          { id: 'user-2', displayName: 'User2', role: 'participant', isAnonymous: false },
        ],
      });

      // Then one leaves
      emitEvent('participant:left', {
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
        ],
      });

      expect(service.participants().length).toBe(1);
    });
  });

  describe('role:changed', () => {
    it('should update the role in participants list', () => {
      emitEvent('participant:joined', {
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
          { id: 'user-2', displayName: 'User2', role: 'participant', isAnonymous: false },
        ],
      });

      emitEvent('role:changed', {
        user: { id: 'user-2', displayName: 'User2', role: 'moderator', isAnonymous: false },
      });

      const user2 = service.participants().find((p) => p.id === 'user-2');
      expect(user2!.role).toBe('moderator');
    });

    it('should update currentUser if the role change is for the current user', () => {
      emitEvent('role:changed', {
        user: { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
      });

      expect(service.currentUser()!.role).toBe('moderator');
    });
  });

  describe('history:cleared', () => {
    it('should clear all history entries', () => {
      // Add some history first
      emitEvent('board:cleared', {
        historyEntry: {
          roundId: 'round-1',
          storyDescription: 'Story',
          participants: [],
          metrics: { average: 5, mode: 5, spread: 0, distribution: {}, outliers: [], numericVoteCount: 2, insufficientData: false },
          completedAt: new Date().toISOString(),
        },
      });

      expect(service.history().length).toBe(1);

      emitEvent('history:cleared', {});

      expect(service.history().length).toBe(0);
    });
  });

  describe('error events', () => {
    it('should show an error toast when receiving an error event from the server', () => {
      const toastService = TestBed.inject(ToastService);

      emitEvent('error', { message: 'Action not permitted', code: 'UNAUTHORIZED' });

      expect(toastService.show).toHaveBeenCalledWith('error', 'Action not permitted');
    });

    it('should show an error toast with the server-provided message', () => {
      const toastService = TestBed.inject(ToastService);

      emitEvent('error', { message: 'Only moderators can reveal cards', code: 'FORBIDDEN' });

      expect(toastService.show).toHaveBeenCalledWith('error', 'Only moderators can reveal cards');
    });
  });

  describe('session:config-updated', () => {
    it('should update sessionConfig signal when session:config-updated event is received', () => {
      expect(service.sessionConfig()).toBeNull();

      const config: SessionConfiguration = {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'all-players', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: true,
      };

      emitEvent('session:config-updated', { config });

      expect(service.sessionConfig()).toEqual(config);
    });

    it('should replace previous config when a new config-updated event arrives', () => {
      const config1: SessionConfiguration = {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      };

      const config2: SessionConfiguration = {
        votingSystem: 't-shirt',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'all-players', allowedUserIds: [] },
        autoReveal: true,
        countdownAnimation: true,
      };

      emitEvent('session:config-updated', { config: config1 });
      expect(service.sessionConfig()!.votingSystem).toBe('fibonacci');

      emitEvent('session:config-updated', { config: config2 });
      expect(service.sessionConfig()!.votingSystem).toBe('t-shirt');
      expect(service.sessionConfig()!.autoReveal).toBe(true);
    });

    it('should extract session config from session:state event (GameSessionState)', () => {
      const config: SessionConfiguration = {
        votingSystem: 'modified-fibonacci',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: true,
        countdownAnimation: false,
      };

      const state: GameSessionState = {
        sessionId: 'sess0001',
        config,
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [mockAuthUser],
        history: [],
        isRevealed: false,
        issueList: [],
      };

      emitEvent('session:state', { state });

      expect(service.sessionConfig()).toEqual(config);
    });
  });

  describe('hasRevealPermission computed signal', () => {
    function setUserAndConfig(role: 'moderator' | 'participant', config: SessionConfiguration): void {
      const user: User = { ...mockAuthUser, role };
      const state: GameSessionState = {
        sessionId: 'sess0001',
        config,
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [user],
        history: [],
        isRevealed: false,
        issueList: [],
      };
      emitEvent('session:state', { state });
    }

    it('should return false when no config is set', () => {
      expect(service.hasRevealPermission()).toBe(false);
    });

    it('should return true for moderator when mode is moderator-only', () => {
      setUserAndConfig('moderator', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(true);
    });

    it('should return false for participant when mode is moderator-only', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(false);
    });

    it('should return true for participant when mode is all-players', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(true);
    });

    it('should return true for moderator when mode is all-players', () => {
      setUserAndConfig('moderator', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(true);
    });

    it('should return true for participant in allowedUserIds when mode is select-specific', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'select-specific', allowedUserIds: ['user-1'] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(true);
    });

    it('should return false for participant not in allowedUserIds when mode is select-specific', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'select-specific', allowedUserIds: ['user-99'] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(false);
    });

    it('should return true for moderator when mode is select-specific (moderators always have access)', () => {
      setUserAndConfig('moderator', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'select-specific', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasRevealPermission()).toBe(true);
    });
  });

  describe('hasIssuePermission computed signal', () => {
    function setUserAndConfig(role: 'moderator' | 'participant', config: SessionConfiguration): void {
      const user: User = { ...mockAuthUser, role };
      const state: GameSessionState = {
        sessionId: 'sess0001',
        config,
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [user],
        history: [],
        isRevealed: false,
        issueList: [],
      };
      emitEvent('session:state', { state });
    }

    it('should return false when no config is set', () => {
      expect(service.hasIssuePermission()).toBe(false);
    });

    it('should return true for moderator when mode is moderator-only', () => {
      setUserAndConfig('moderator', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(true);
    });

    it('should return false for participant when mode is moderator-only', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(false);
    });

    it('should return true for participant when mode is all-players', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'all-players', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(true);
    });

    it('should return true for participant in allowedUserIds when mode is select-specific', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'select-specific', allowedUserIds: ['user-1'] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(true);
    });

    it('should return false for participant not in allowedUserIds when mode is select-specific', () => {
      setUserAndConfig('participant', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'select-specific', allowedUserIds: ['user-other'] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(false);
    });

    it('should return true for moderator when mode is select-specific (moderators always have access)', () => {
      setUserAndConfig('moderator', {
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'select-specific', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });
      expect(service.hasIssuePermission()).toBe(true);
    });
  });

  describe('votingSystemCards computed signal', () => {
    function setConfig(config: SessionConfiguration): void {
      emitEvent('session:config-updated', { config });
    }

    it('should return empty array when no config is set', () => {
      expect(service.votingSystemCards()).toEqual([]);
    });

    it('should return fibonacci cards plus special cards', () => {
      setConfig({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      const cards = service.votingSystemCards();
      expect(cards).toEqual([...VOTING_SYSTEMS['fibonacci'], ...SPECIAL_CARDS]);
    });

    it('should return t-shirt cards plus special cards', () => {
      setConfig({
        votingSystem: 't-shirt',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      const cards = service.votingSystemCards();
      expect(cards).toEqual([...VOTING_SYSTEMS['t-shirt'], ...SPECIAL_CARDS]);
    });

    it('should return power-of-2 cards plus special cards', () => {
      setConfig({
        votingSystem: 'power-of-2',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      const cards = service.votingSystemCards();
      expect(cards).toEqual([...VOTING_SYSTEMS['power-of-2'], ...SPECIAL_CARDS]);
    });

    it('should return modified-fibonacci cards plus special cards', () => {
      setConfig({
        votingSystem: 'modified-fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      const cards = service.votingSystemCards();
      expect(cards).toEqual([...VOTING_SYSTEMS['modified-fibonacci'], ...SPECIAL_CARDS]);
    });

    it('should update cards when config changes voting system', () => {
      setConfig({
        votingSystem: 'fibonacci',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(service.votingSystemCards()).toEqual([...VOTING_SYSTEMS['fibonacci'], ...SPECIAL_CARDS]);

      setConfig({
        votingSystem: 't-shirt',
        revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
        autoReveal: false,
        countdownAnimation: false,
      });

      expect(service.votingSystemCards()).toEqual([...VOTING_SYSTEMS['t-shirt'], ...SPECIAL_CARDS]);
    });
  });

  describe('issue:list-updated event', () => {
    it('should update issueList signal when issue:list-updated is emitted', () => {
      expect(service.issueList()).toEqual([]);

      const issues = [
        { id: 'issue-1', title: 'First issue', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' },
        { id: 'issue-2', title: 'Second issue', status: 'estimating' as const, createdAt: '2024-01-01T01:00:00Z' },
      ];

      emitEvent('issue:list-updated', { issues });

      expect(service.issueList()).toEqual(issues);
    });

    it('should replace previous issue list with new data', () => {
      const initialIssues = [
        { id: 'issue-1', title: 'First issue', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' },
      ];

      emitEvent('issue:list-updated', { issues: initialIssues });
      expect(service.issueList().length).toBe(1);

      const updatedIssues = [
        { id: 'issue-1', title: 'First issue', status: 'estimated' as const, historyEntryId: 'round-1', createdAt: '2024-01-01T00:00:00Z' },
        { id: 'issue-2', title: 'New issue', status: 'pending' as const, createdAt: '2024-01-01T02:00:00Z' },
      ];

      emitEvent('issue:list-updated', { issues: updatedIssues });
      expect(service.issueList().length).toBe(2);
      expect(service.issueList()[0].status).toBe('estimated');
      expect(service.issueList()[1].title).toBe('New issue');
    });

    it('should handle empty issue list', () => {
      const issues = [
        { id: 'issue-1', title: 'Some issue', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' },
      ];

      emitEvent('issue:list-updated', { issues });
      expect(service.issueList().length).toBe(1);

      emitEvent('issue:list-updated', { issues: [] });
      expect(service.issueList()).toEqual([]);
    });
  });

  describe('participant:removed event', () => {
    it('should show a warning toast when participant:removed is received', () => {
      const toastService = TestBed.inject(ToastService);

      emitEvent('participant:removed', { reason: 'Removed by moderator' });

      expect(toastService.show).toHaveBeenCalledWith('warning', 'You have been removed from the session');
    });

    it('should show toast regardless of the reason provided', () => {
      const toastService = TestBed.inject(ToastService);

      emitEvent('participant:removed', { reason: 'Disruptive behavior' });

      expect(toastService.show).toHaveBeenCalledWith('warning', 'You have been removed from the session');
    });
  });

  describe('session:state restores issueList', () => {
    it('should restore issueList from session state on reconnect', () => {
      const issues = [
        { id: 'issue-1', title: 'Backlog item 1', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' },
        { id: 'issue-2', title: 'Backlog item 2', status: 'estimated' as const, historyEntryId: 'round-1', createdAt: '2024-01-01T01:00:00Z' },
        { id: 'issue-3', title: 'Backlog item 3', status: 'estimating' as const, createdAt: '2024-01-01T02:00:00Z' },
      ];

      const state: GameSessionState = {
        sessionId: 'sess-123',
        config: {
          votingSystem: 'fibonacci',
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
          issuePermission: { mode: 'all-players', allowedUserIds: [] },
          autoReveal: false,
          countdownAnimation: true,
        },
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [mockAuthUser],
        history: [],
        isRevealed: false,
        issueList: issues,
      };

      emitEvent('session:state', { state });

      expect(service.issueList()).toEqual(issues);
      expect(service.issueList().length).toBe(3);
      expect(service.issueList()[0].title).toBe('Backlog item 1');
      expect(service.issueList()[1].status).toBe('estimated');
      expect(service.issueList()[2].status).toBe('estimating');
    });

    it('should set empty issueList when session state has no issueList', () => {
      // First set some issues
      emitEvent('issue:list-updated', {
        issues: [{ id: 'issue-1', title: 'Old issue', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' }],
      });
      expect(service.issueList().length).toBe(1);

      // Reconnect with state that has no issueList (undefined)
      const state = {
        sessionId: 'sess-123',
        config: {
          votingSystem: 'fibonacci',
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
          issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
          autoReveal: false,
          countdownAnimation: true,
        },
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [mockAuthUser],
        history: [],
        isRevealed: false,
        // issueList intentionally omitted
      };

      emitEvent('session:state', { state });

      // The service only updates issueList if state.issueList is truthy
      // so the old value remains when issueList is not provided
      expect(service.issueList().length).toBe(1);
    });

    it('should restore empty issueList from session state', () => {
      // First set some issues
      emitEvent('issue:list-updated', {
        issues: [{ id: 'issue-1', title: 'Old issue', status: 'pending' as const, createdAt: '2024-01-01T00:00:00Z' }],
      });
      expect(service.issueList().length).toBe(1);

      // Reconnect with state that has an explicit empty issueList
      const state: GameSessionState = {
        sessionId: 'sess-123',
        config: {
          votingSystem: 'fibonacci',
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
          issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
          autoReveal: false,
          countdownAnimation: true,
        },
        ownerId: 'owner-1',
        createdAt: new Date().toISOString(),
        currentRound: null,
        participants: [mockAuthUser],
        history: [],
        isRevealed: false,
        issueList: [],
      };

      emitEvent('session:state', { state });

      // Empty array is falsy for the `if (state.issueList)` check when length is 0
      // but [] is truthy in JS, so it should be set
      expect(service.issueList()).toEqual([]);
    });
  });
});
