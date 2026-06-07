import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal } from '@angular/core';
import { RetroStateService } from './retro-state.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { AuthService } from './auth.service';
import {
  RetroSessionState,
  RetroColumn,
  RetroCard,
  RetroComment,
  RetroConfiguration,
  User,
} from '@shared/types';

describe('RetroStateService', () => {
  let service: RetroStateService;
  let eventSubjects: Map<string, Subject<any>>;
  let mockAuthUser: User;

  function createMockRetroWebSocketService() {
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

  function createMockState(overrides: Partial<RetroSessionState> = {}): RetroSessionState {
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
        columns: [
          { id: 'col-1', name: 'Start', cards: [], order: 0 },
          { id: 'col-2', name: 'Stop', cards: [], order: 1 },
          { id: 'col-3', name: 'Continue', cards: [], order: 2 },
        ],
        context: '',
        cardsRevealed: false,
        votingEnabled: false,
        isCompleted: false,
      },
      participants: [
        { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
      ],
      ownerId: 'user-1',
      createdAt: '2024-01-01T00:00:00Z',
      votesRemaining: { 'user-1': 6 },
      feelings: {},
      ...overrides,
    };
  }

  function createMockCard(overrides: Partial<RetroCard> = {}): RetroCard {
    return {
      id: 'card-1',
      text: 'Test card',
      authorId: 'user-1',
      authorName: 'TestUser',
      votes: 0,
      votedBy: [],
      comments: [],
      columnId: 'col-1',
      order: 0,
      createdAt: '2024-01-01T00:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockAuthUser = {
      id: 'user-1',
      displayName: 'TestUser',
      role: 'moderator',
      isAnonymous: false,
    };

    const mockAuthService = {
      getCurrentUser: vi.fn().mockReturnValue(signal(mockAuthUser)),
      getToken: vi.fn().mockReturnValue('test-token'),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: RetroWebSocketService, useFactory: createMockRetroWebSocketService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    service = TestBed.inject(RetroStateService);
  });

  describe('initial state', () => {
    it('should have null state', () => {
      expect(service.state()).toBeNull();
    });

    it('should have null currentUserId', () => {
      expect(service.currentUserId()).toBeNull();
    });

    it('should have empty columns', () => {
      expect(service.columns()).toEqual([]);
    });

    it('should have 0 votesRemaining', () => {
      expect(service.votesRemaining()).toBe(0);
    });

    it('should have isModerator as false', () => {
      expect(service.isModerator()).toBe(false);
    });

    it('should have isCompleted as false', () => {
      expect(service.isCompleted()).toBe(false);
    });

    it('should have null config', () => {
      expect(service.config()).toBeNull();
    });

    it('should have empty context', () => {
      expect(service.context()).toBe('');
    });

    it('should have empty participants', () => {
      expect(service.participants()).toEqual([]);
    });

    it('should have cardsRevealed as false', () => {
      expect(service.cardsRevealed()).toBe(false);
    });

    it('should have votingEnabled as false', () => {
      expect(service.votingEnabled()).toBe(false);
    });
  });

  describe('retro:session:state (full state sync)', () => {
    it('should set full state from session:state event', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.state()).toEqual(state);
      expect(service.columns().length).toBe(3);
      expect(service.participants().length).toBe(1);
    });

    it('should set currentUserId from auth service', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.currentUserId()).toBe('user-1');
    });

    it('should compute isModerator correctly when user is owner', () => {
      const state = createMockState({ ownerId: 'user-1' });
      emitEvent('retro:session:state', { state });

      expect(service.isModerator()).toBe(true);
    });

    it('should compute isModerator as false when user is not owner', () => {
      const state = createMockState({
        ownerId: 'user-2',
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'participant', isAnonymous: false },
        ],
      });
      emitEvent('retro:session:state', { state });

      expect(service.isModerator()).toBe(false);
    });

    it('should compute votesRemaining for current user', () => {
      const state = createMockState({ votesRemaining: { 'user-1': 4 } });
      emitEvent('retro:session:state', { state });

      expect(service.votesRemaining()).toBe(4);
    });

    it('should compute config from state', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.config()!.boardName).toBe('Test Board');
      expect(service.config()!.maxVotesPerUser).toBe(6);
    });

    it('should compute context from state', () => {
      const state = createMockState();
      state.board.context = 'Sprint 42 retrospective';
      emitEvent('retro:session:state', { state });

      expect(service.context()).toBe('Sprint 42 retrospective');
    });

    it('should compute cardsRevealed from state', () => {
      const state = createMockState();
      state.board.cardsRevealed = true;
      emitEvent('retro:session:state', { state });

      expect(service.cardsRevealed()).toBe(true);
    });

    it('should compute votingEnabled from state', () => {
      const state = createMockState();
      state.board.votingEnabled = true;
      emitEvent('retro:session:state', { state });

      expect(service.votingEnabled()).toBe(true);
    });
  });

  describe('cardsByColumn method', () => {
    it('should return cards for a specific column', () => {
      const card = createMockCard({ columnId: 'col-1' });
      const state = createMockState();
      state.board.columns[0].cards = [card];
      emitEvent('retro:session:state', { state });

      expect(service.cardsByColumn('col-1')).toEqual([card]);
    });

    it('should return empty array for column with no cards', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.cardsByColumn('col-2')).toEqual([]);
    });

    it('should return empty array for non-existent column', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.cardsByColumn('non-existent')).toEqual([]);
    });

    it('should return empty array when state is null', () => {
      expect(service.cardsByColumn('col-1')).toEqual([]);
    });
  });

  describe('retro:card:added', () => {
    it('should add card to the correct column', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      const newCard = createMockCard({ id: 'card-new', text: 'New card' });
      emitEvent('retro:card:added', { card: newCard, columnId: 'col-1' });

      expect(service.cardsByColumn('col-1').length).toBe(1);
      expect(service.cardsByColumn('col-1')[0].text).toBe('New card');
    });

    it('should not affect other columns', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      const newCard = createMockCard({ id: 'card-new', columnId: 'col-1' });
      emitEvent('retro:card:added', { card: newCard, columnId: 'col-1' });

      expect(service.cardsByColumn('col-2')).toEqual([]);
    });
  });

  describe('retro:card:edited', () => {
    it('should update card text', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', text: 'Original' })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:edited', { cardId: 'card-1', text: 'Updated text' });

      expect(service.cardsByColumn('col-1')[0].text).toBe('Updated text');
    });

    it('should not affect other cards', () => {
      const state = createMockState();
      state.board.columns[0].cards = [
        createMockCard({ id: 'card-1', text: 'Card 1' }),
        createMockCard({ id: 'card-2', text: 'Card 2', order: 1 }),
      ];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:edited', { cardId: 'card-1', text: 'Updated' });

      expect(service.cardsByColumn('col-1')[1].text).toBe('Card 2');
    });
  });

  describe('retro:card:removed', () => {
    it('should remove card from column', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1' })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:removed', { cardId: 'card-1', columnId: 'col-1' });

      expect(service.cardsByColumn('col-1')).toEqual([]);
    });

    it('should not affect cards in other columns', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', columnId: 'col-1' })];
      state.board.columns[1].cards = [createMockCard({ id: 'card-2', columnId: 'col-2' })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:removed', { cardId: 'card-1', columnId: 'col-1' });

      expect(service.cardsByColumn('col-2').length).toBe(1);
    });
  });

  describe('retro:card:moved', () => {
    it('should move card between columns', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', columnId: 'col-1' })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:moved', {
        cardId: 'card-1',
        targetColumnId: 'col-2',
        targetIndex: 0,
      });

      expect(service.cardsByColumn('col-1')).toEqual([]);
      expect(service.cardsByColumn('col-2').length).toBe(1);
      expect(service.cardsByColumn('col-2')[0].id).toBe('card-1');
    });

    it('should insert card at the correct index', () => {
      const state = createMockState();
      state.board.columns[1].cards = [
        createMockCard({ id: 'card-existing', columnId: 'col-2', text: 'Existing' }),
      ];
      state.board.columns[0].cards = [
        createMockCard({ id: 'card-1', columnId: 'col-1', text: 'Moving' }),
      ];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:moved', {
        cardId: 'card-1',
        targetColumnId: 'col-2',
        targetIndex: 0,
      });

      expect(service.cardsByColumn('col-2')[0].text).toBe('Moving');
      expect(service.cardsByColumn('col-2')[1].text).toBe('Existing');
    });
  });

  describe('retro:card:voted', () => {
    it('should update card votes and votesRemaining', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', votes: 0, votedBy: [] })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:card:voted', {
        cardId: 'card-1',
        votes: 1,
        votedBy: ['user-1'],
        votesRemaining: { 'user-1': 5 },
      });

      expect(service.cardsByColumn('col-1')[0].votes).toBe(1);
      expect(service.cardsByColumn('col-1')[0].votedBy).toEqual(['user-1']);
      expect(service.votesRemaining()).toBe(5);
    });
  });

  describe('retro:comment:added', () => {
    it('should add comment to card', () => {
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', comments: [] })];
      emitEvent('retro:session:state', { state });

      const comment: RetroComment = {
        id: 'comment-1',
        text: 'Great point!',
        authorId: 'user-2',
        authorName: 'User2',
        createdAt: '2024-01-01T01:00:00Z',
      };
      emitEvent('retro:comment:added', { cardId: 'card-1', comment });

      expect(service.cardsByColumn('col-1')[0].comments.length).toBe(1);
      expect(service.cardsByColumn('col-1')[0].comments[0].text).toBe('Great point!');
    });
  });

  describe('retro:comment:removed', () => {
    it('should remove comment from card', () => {
      const comment: RetroComment = {
        id: 'comment-1',
        text: 'A comment',
        authorId: 'user-1',
        authorName: 'TestUser',
        createdAt: '2024-01-01T00:00:00Z',
      };
      const state = createMockState();
      state.board.columns[0].cards = [createMockCard({ id: 'card-1', comments: [comment] })];
      emitEvent('retro:session:state', { state });

      emitEvent('retro:comment:removed', { cardId: 'card-1', commentId: 'comment-1' });

      expect(service.cardsByColumn('col-1')[0].comments).toEqual([]);
    });
  });

  describe('retro:column:added', () => {
    it('should add column to the board', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      const newColumn: RetroColumn = { id: 'col-new', name: 'New Column', cards: [], order: 3 };
      emitEvent('retro:column:added', { column: newColumn });

      expect(service.columns().length).toBe(4);
      expect(service.columns()[3].name).toBe('New Column');
    });
  });

  describe('retro:column:removed', () => {
    it('should remove column from the board', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:column:removed', { columnId: 'col-2' });

      expect(service.columns().length).toBe(2);
      expect(service.columns().find((c) => c.id === 'col-2')).toBeUndefined();
    });
  });

  describe('retro:column:reordered', () => {
    it('should reorder columns based on orderedIds', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:column:reordered', { orderedIds: ['col-3', 'col-1', 'col-2'] });

      expect(service.columns()[0].id).toBe('col-3');
      expect(service.columns()[1].id).toBe('col-1');
      expect(service.columns()[2].id).toBe('col-2');
    });

    it('should update order property on columns', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:column:reordered', { orderedIds: ['col-3', 'col-1', 'col-2'] });

      expect(service.columns()[0].order).toBe(0);
      expect(service.columns()[1].order).toBe(1);
      expect(service.columns()[2].order).toBe(2);
    });
  });

  describe('retro:column:renamed', () => {
    it('should rename the specified column', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:column:renamed', { columnId: 'col-1', name: 'Renamed Column' });

      expect(service.columns()[0].name).toBe('Renamed Column');
    });

    it('should not affect other columns', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:column:renamed', { columnId: 'col-1', name: 'Renamed' });

      expect(service.columns()[1].name).toBe('Stop');
      expect(service.columns()[2].name).toBe('Continue');
    });
  });

  describe('retro:context:updated', () => {
    it('should update the board context', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      emitEvent('retro:context:updated', { text: 'Sprint 42 context' });

      expect(service.context()).toBe('Sprint 42 context');
    });
  });

  describe('retro:cards:revealed', () => {
    it('should set cardsRevealed to true', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.cardsRevealed()).toBe(false);

      emitEvent('retro:cards:revealed', {});

      expect(service.cardsRevealed()).toBe(true);
    });
  });

  describe('retro:voting:enabled', () => {
    it('should set votingEnabled to true', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.votingEnabled()).toBe(false);

      emitEvent('retro:voting:enabled', {});

      expect(service.votingEnabled()).toBe(true);
    });
  });

  describe('retro:board:completed', () => {
    it('should set isCompleted to true', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.isCompleted()).toBe(false);

      emitEvent('retro:board:completed', {});

      expect(service.isCompleted()).toBe(true);
    });
  });

  describe('retro:config:updated', () => {
    it('should update the config', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      const newConfig: RetroConfiguration = {
        ...state.config,
        boardName: 'Updated Board',
        maxVotesPerUser: 10,
      };
      emitEvent('retro:config:updated', { config: newConfig });

      expect(service.config()!.boardName).toBe('Updated Board');
      expect(service.config()!.maxVotesPerUser).toBe(10);
    });
  });

  describe('retro:participant:joined', () => {
    it('should update participants list', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      const newParticipants: User[] = [
        { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
        { id: 'user-2', displayName: 'NewUser', role: 'participant', isAnonymous: false },
      ];
      emitEvent('retro:participant:joined', { participants: newParticipants });

      expect(service.participants().length).toBe(2);
      expect(service.participants()[1].displayName).toBe('NewUser');
    });
  });

  describe('retro:participant:left', () => {
    it('should update participants list when someone leaves', () => {
      const state = createMockState({
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
          { id: 'user-2', displayName: 'User2', role: 'participant', isAnonymous: false },
        ],
      });
      emitEvent('retro:session:state', { state });

      emitEvent('retro:participant:left', {
        participants: [
          { id: 'user-1', displayName: 'TestUser', role: 'moderator', isAnonymous: false },
        ],
      });

      expect(service.participants().length).toBe(1);
    });
  });

  describe('retro:card:merged', () => {
    it('should update the target card with merged data', () => {
      const state = createMockState();
      const targetCard = createMockCard({ id: 'card-1', text: 'Target text', columnId: 'col-1', votes: 1 });
      state.board.columns[0].cards = [targetCard];
      const sourceCard = createMockCard({ id: 'card-2', text: 'Source text', columnId: 'col-1', votes: 2, order: 1 });
      state.board.columns[0].cards.push(sourceCard);
      emitEvent('retro:session:state', { state });

      const mergedTargetCard: RetroCard = {
        ...targetCard,
        text: 'Target text\n--------\nSource text',
        votes: 3,
      };
      emitEvent('retro:card:merged', {
        targetCard: mergedTargetCard,
        removedCardId: 'card-2',
        removedFromColumnId: 'col-1',
      });

      const col1Cards = service.cardsByColumn('col-1');
      expect(col1Cards.length).toBe(1);
      expect(col1Cards[0].text).toBe('Target text\n--------\nSource text');
      expect(col1Cards[0].votes).toBe(3);
    });

    it('should remove the source card from its column', () => {
      const state = createMockState();
      state.board.columns[0].cards = [
        createMockCard({ id: 'card-1', text: 'Target', columnId: 'col-1' }),
      ];
      state.board.columns[1].cards = [
        createMockCard({ id: 'card-2', text: 'Source', columnId: 'col-2' }),
      ];
      emitEvent('retro:session:state', { state });

      const mergedTargetCard = createMockCard({
        id: 'card-1',
        text: 'Target\n--------\nSource',
        columnId: 'col-1',
      });
      emitEvent('retro:card:merged', {
        targetCard: mergedTargetCard,
        removedCardId: 'card-2',
        removedFromColumnId: 'col-2',
      });

      expect(service.cardsByColumn('col-2')).toEqual([]);
      expect(service.cardsByColumn('col-1')[0].text).toBe('Target\n--------\nSource');
    });

    it('should not affect cards in unrelated columns', () => {
      const state = createMockState();
      state.board.columns[0].cards = [
        createMockCard({ id: 'card-1', text: 'Target', columnId: 'col-1' }),
        createMockCard({ id: 'card-2', text: 'Source', columnId: 'col-1', order: 1 }),
      ];
      state.board.columns[2].cards = [
        createMockCard({ id: 'card-3', text: 'Unrelated', columnId: 'col-3' }),
      ];
      emitEvent('retro:session:state', { state });

      const mergedTargetCard = createMockCard({
        id: 'card-1',
        text: 'Target\n--------\nSource',
        columnId: 'col-1',
      });
      emitEvent('retro:card:merged', {
        targetCard: mergedTargetCard,
        removedCardId: 'card-2',
        removedFromColumnId: 'col-1',
      });

      expect(service.cardsByColumn('col-3')[0].text).toBe('Unrelated');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const state = createMockState();
      emitEvent('retro:session:state', { state });

      expect(service.state()).not.toBeNull();
      expect(service.currentUserId()).not.toBeNull();

      service.reset();

      expect(service.state()).toBeNull();
      expect(service.currentUserId()).toBeNull();
      expect(service.columns()).toEqual([]);
      expect(service.votesRemaining()).toBe(0);
      expect(service.isModerator()).toBe(false);
      expect(service.isCompleted()).toBe(false);
      expect(service.config()).toBeNull();
      expect(service.context()).toBe('');
      expect(service.participants()).toEqual([]);
      expect(service.cardsRevealed()).toBe(false);
      expect(service.votingEnabled()).toBe(false);
    });
  });

  describe('no-op when state is null', () => {
    it('should not crash when events arrive before state is set', () => {
      // These should all be no-ops since state is null
      expect(() => {
        emitEvent('retro:card:added', { card: createMockCard(), columnId: 'col-1' });
        emitEvent('retro:card:edited', { cardId: 'card-1', text: 'Updated' });
        emitEvent('retro:card:removed', { cardId: 'card-1', columnId: 'col-1' });
        emitEvent('retro:cards:revealed', {});
        emitEvent('retro:voting:enabled', {});
        emitEvent('retro:board:completed', {});
      }).not.toThrow();

      // State should still be null
      expect(service.state()).toBeNull();
    });
  });
});
