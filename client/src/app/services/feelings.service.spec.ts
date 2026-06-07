import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal, WritableSignal } from '@angular/core';
import { FeelingsService } from './feelings.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { RetroStateService } from './retro-state.service';
import { FeelingCategory, RetroSessionState } from '@shared/types';

describe('FeelingsService', () => {
  let service: FeelingsService;
  let eventSubjects: Map<string, Subject<any>>;
  let mockConnectionState: WritableSignal<'connected' | 'disconnected' | 'reconnecting'>;
  let mockCurrentUserId: WritableSignal<string | null>;
  let mockSend: ReturnType<typeof vi.fn>;

  function createMockRetroWebSocketService() {
    eventSubjects = new Map();
    mockConnectionState = signal<'connected' | 'disconnected' | 'reconnecting'>('connected');
    mockSend = vi.fn();
    return {
      send: mockSend,
      on: vi.fn(<T>(event: string): Observable<T> => {
        if (!eventSubjects.has(event)) {
          eventSubjects.set(event, new Subject<any>());
        }
        return eventSubjects.get(event)!.asObservable() as Observable<T>;
      }),
      connectionState: mockConnectionState,
    };
  }

  function createMockRetroStateService() {
    mockCurrentUserId = signal<string | null>('user-1');
    return {
      currentUserId: mockCurrentUserId,
    };
  }

  function emitEvent(event: string, data: any): void {
    if (!eventSubjects.has(event)) {
      eventSubjects.set(event, new Subject<any>());
    }
    eventSubjects.get(event)!.next(data);
  }

  function createMockSessionState(
    overrides: Partial<RetroSessionState> = {}
  ): RetroSessionState {
    return {
      sessionId: 'session-1',
      config: {
        boardName: 'Test Board',
        maxVotesPerUser: 6,
        templateId: 'start-stop-continue',
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        password: null,
        enableGifEmoji: true,
        columnLayout: 'vertical',
        allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
      },
      board: {
        columns: [],
        context: '',
        cardsRevealed: false,
        votingEnabled: false,
        isCompleted: false,
      },
      participants: [
        { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
        { id: 'user-2', displayName: 'OtherUser', role: 'participant', isAnonymous: false },
      ],
      ownerId: 'user-1',
      createdAt: '2024-01-01T00:00:00Z',
      votesRemaining: { 'user-1': 6 },
      feelings: {},
      ...overrides,
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: RetroWebSocketService, useFactory: createMockRetroWebSocketService },
        { provide: RetroStateService, useFactory: createMockRetroStateService },
      ],
    });

    service = TestBed.inject(FeelingsService);
  });

  describe('selectFeeling', () => {
    it('should send retro:feeling:select with the correct category when connected', () => {
      service.selectFeeling('Happy');

      expect(mockSend).toHaveBeenCalledWith('retro:feeling:select', { category: 'Happy' });
    });

    it('should send retro:feeling:select with null to deselect', () => {
      service.selectFeeling(null);

      expect(mockSend).toHaveBeenCalledWith('retro:feeling:select', { category: null });
    });

    it('should not send when connectionState is disconnected', () => {
      mockConnectionState.set('disconnected');

      service.selectFeeling('Happy');

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should not send when connectionState is reconnecting', () => {
      mockConnectionState.set('reconnecting');

      service.selectFeeling('Sad');

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('myFeeling', () => {
    it('should return null when no feeling is set for current user', () => {
      expect(service.myFeeling()).toBeNull();
    });

    it('should reflect the current user feeling after session state initialization', () => {
      const state = createMockSessionState({
        feelings: { 'user-1': 'Happy', 'user-2': 'Sad' },
      });
      emitEvent('retro:session:state', { state });

      expect(service.myFeeling()).toBe('Happy');
    });

    it('should update when feeling:updated event changes current user feeling', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-1', category: 'Confidence' });

      expect(service.myFeeling()).toBe('Confidence');
    });

    it('should return null when currentUserId is null', () => {
      mockCurrentUserId.set(null);

      const state = createMockSessionState({
        feelings: { 'user-1': 'Happy' },
      });
      emitEvent('retro:session:state', { state });

      expect(service.myFeeling()).toBeNull();
    });

    it('should return null after feeling is deselected for current user', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-1', category: 'Sad' });
      expect(service.myFeeling()).toBe('Sad');

      emitEvent('retro:feeling:updated', { userId: 'user-1', category: null });
      expect(service.myFeeling()).toBeNull();
    });
  });

  describe('feelings signal updates on retro:feeling:updated', () => {
    it('should add a new feeling entry for a user', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Mad' });

      expect(service.feelings()).toEqual({ 'user-2': 'Mad' });
    });

    it('should update an existing feeling entry for a user', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Sad' });
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Happy' });

      expect(service.feelings()['user-2']).toBe('Happy');
    });

    it('should remove a feeling entry when category is null', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Glad' });
      expect(service.feelings()['user-2']).toBe('Glad');

      emitEvent('retro:feeling:updated', { userId: 'user-2', category: null });
      expect(service.feelings()['user-2']).toBeUndefined();
    });

    it('should handle multiple users independently', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-1', category: 'Happy' });
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Sad' });
      emitEvent('retro:feeling:updated', { userId: 'user-3', category: 'Confidence' });

      expect(service.feelings()).toEqual({
        'user-1': 'Happy',
        'user-2': 'Sad',
        'user-3': 'Confidence',
      });
    });
  });

  describe('initialization from session state', () => {
    it('should initialize feelings from retro:session:state event', () => {
      const state = createMockSessionState({
        feelings: { 'user-1': 'Happy', 'user-2': 'Sad' },
      });
      emitEvent('retro:session:state', { state });

      expect(service.feelings()).toEqual({ 'user-1': 'Happy', 'user-2': 'Sad' });
    });

    it('should handle missing feelings in session state gracefully', () => {
      const state = createMockSessionState();
      // Simulate a state without feelings field (older session format)
      delete (state as any).feelings;
      emitEvent('retro:session:state', { state });

      expect(service.feelings()).toEqual({});
    });

    it('should overwrite existing feelings when new session state arrives', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-1', category: 'Mad' });
      expect(service.feelings()).toEqual({ 'user-1': 'Mad' });

      const state = createMockSessionState({
        feelings: { 'user-2': 'Glad' },
      });
      emitEvent('retro:session:state', { state });

      expect(service.feelings()).toEqual({ 'user-2': 'Glad' });
    });

    it('should initialize feelings with empty map from session state', () => {
      const state = createMockSessionState({ feelings: {} });
      emitEvent('retro:session:state', { state });

      expect(service.feelings()).toEqual({});
    });
  });

  describe('local state not updated on connection failure', () => {
    it('should not update local state when connection is disconnected', () => {
      mockConnectionState.set('disconnected');

      service.selectFeeling('Happy');

      // The send was not called, so no local state should change
      expect(mockSend).not.toHaveBeenCalled();
      // The feelings map should remain unchanged (empty)
      expect(service.myFeeling()).toBeNull();
    });

    it('should not update local state when connection is reconnecting', () => {
      mockConnectionState.set('reconnecting');

      service.selectFeeling('Frustration');

      expect(mockSend).not.toHaveBeenCalled();
      expect(service.myFeeling()).toBeNull();
    });

    it('should only update feelings via server events, not on selectFeeling call', () => {
      // Even when connected, selectFeeling does not update local state directly
      service.selectFeeling('Happy');

      // Local state only updates from server events
      expect(service.myFeeling()).toBeNull();
      expect(service.feelings()).toEqual({});
    });
  });

  describe('reset', () => {
    it('should clear all feelings state', () => {
      emitEvent('retro:feeling:updated', { userId: 'user-1', category: 'Happy' });
      emitEvent('retro:feeling:updated', { userId: 'user-2', category: 'Sad' });
      expect(Object.keys(service.feelings()).length).toBe(2);

      service.reset();

      expect(service.feelings()).toEqual({});
      expect(service.myFeeling()).toBeNull();
    });
  });
});
