import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal, computed } from '@angular/core';
import { EMPTY } from 'rxjs';
import { RetroColumnComponent } from './retro-column.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroColumn, RetroCard } from '@shared/types';

function createMockCard(overrides: Partial<RetroCard> = {}): RetroCard {
  return {
    id: 'card-1',
    text: 'Test card text',
    authorId: 'user-1',
    authorName: 'Alice',
    votes: 0,
    votedBy: [],
    comments: [],
    columnId: 'col-1',
    order: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockColumn(overrides: Partial<RetroColumn> = {}): RetroColumn {
  return {
    id: 'col-1',
    name: 'What went well',
    cards: [
      createMockCard({ id: 'card-1', text: 'Card One', columnId: 'col-1', order: 0 }),
      createMockCard({ id: 'card-2', text: 'Card Two', columnId: 'col-1', order: 1 }),
    ],
    order: 0,
    ...overrides,
  };
}

/**
 * Creates a mock DragEvent where event.target.closest('[data-card-id]') returns
 * an element with the given cardId (simulating a card-on-card drop).
 */
function createCardOnCardDropEvent(draggedCardId: string, targetCardId: string): DragEvent {
  const mockTargetElement = {
    closest: (selector: string) => {
      if (selector === '[data-card-id]') {
        return { getAttribute: (attr: string) => attr === 'data-card-id' ? targetCardId : null };
      }
      return null;
    },
  } as unknown as HTMLElement;

  const dataTransferData: Record<string, string> = {
    'text/retro-card-id': draggedCardId,
  };

  const mockDataTransfer = {
    getData: (key: string) => dataTransferData[key] ?? '',
    types: ['text/retro-card-id'],
    dropEffect: 'move',
  } as unknown as DataTransfer;

  const event = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: mockTargetElement,
    dataTransfer: mockDataTransfer,
    clientX: 0,
    clientY: 0,
  } as unknown as DragEvent;

  return event;
}

/**
 * Creates a mock DragEvent where event.target.closest('[data-card-id]') returns null
 * (simulating a card-on-column drop — card dropped on empty space in the column).
 */
function createCardOnColumnDropEvent(draggedCardId: string): DragEvent {
  const mockTargetElement = {
    closest: (_selector: string) => null,
  } as unknown as HTMLElement;

  const dataTransferData: Record<string, string> = {
    'text/retro-card-id': draggedCardId,
  };

  const mockDataTransfer = {
    getData: (key: string) => dataTransferData[key] ?? '',
    types: ['text/retro-card-id'],
    dropEffect: 'move',
  } as unknown as DataTransfer;

  const event = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: mockTargetElement,
    dataTransfer: mockDataTransfer,
    clientX: 0,
    clientY: 100,
  } as unknown as DragEvent;

  return event;
}

describe('RetroColumnComponent - Merge Detection', () => {
  let fixture: ComponentFixture<RetroColumnComponent>;
  let component: RetroColumnComponent;
  let isCompletedSignal: WritableSignal<boolean>;
  let columnsSignal: WritableSignal<RetroColumn[]>;
  let mockWsService: any;

  const mockColumn = createMockColumn();

  beforeEach(() => {
    isCompletedSignal = signal(false);
    columnsSignal = signal<RetroColumn[]>([mockColumn]);

    const mockRetroState = {
      isCompleted: isCompletedSignal.asReadonly(),
      isModerator: signal(false).asReadonly(),
      columns: columnsSignal.asReadonly(),
      cardsRevealed: signal(true).asReadonly(),
      currentUserId: signal('user-1').asReadonly(),
      config: signal(null).asReadonly(),
      lastAddedOwnCardId: signal(null),
      ownNewCardIds: signal(new Set<string>()).asReadonly(),
      votingEnabled: signal(true).asReadonly(),
      votesRemaining: signal(5).asReadonly(),
    };

    mockWsService = {
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      sendCardAdd: vi.fn(),
      sendCardEdit: vi.fn(),
      sendCardRemove: vi.fn(),
      sendCardMove: vi.fn(),
      sendCardVote: vi.fn(),
      sendCardMerge: vi.fn(),
      sendColumnRemove: vi.fn(),
      sendColumnReorder: vi.fn(),
      sendCommentAdd: vi.fn(),
      sendCommentRemove: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [RetroColumnComponent],
      providers: [
        { provide: RetroStateService, useValue: mockRetroState },
        { provide: RetroWebSocketService, useValue: mockWsService },
      ],
    });

    fixture = TestBed.createComponent(RetroColumnComponent);
    fixture.componentRef.setInput('column', mockColumn);
    fixture.detectChanges();
    component = fixture.componentInstance;
  });

  describe('card-on-card drop shows merge popup', () => {
    it('should show merge popup when a card is dropped on another card', () => {
      const event = createCardOnCardDropEvent('card-1', 'card-2');

      component.onDrop(event);

      expect(component.showMergePopup()).toBe(true);
      expect(component.mergeSourceCardText()).toBe('Card One');
      expect(component.mergeTargetCardText()).toBe('Card Two');
    });

    it('should NOT call sendCardMove when card-on-card drop is detected', () => {
      const event = createCardOnCardDropEvent('card-1', 'card-2');

      component.onDrop(event);

      expect(mockWsService.sendCardMove).not.toHaveBeenCalled();
    });

    it('should NOT show merge popup when card is dropped on itself', () => {
      const event = createCardOnCardDropEvent('card-1', 'card-1');

      component.onDrop(event);

      expect(component.showMergePopup()).toBe(false);
    });
  });

  describe('card-on-column drop does NOT show merge popup (moves card normally)', () => {
    it('should NOT show merge popup when card is dropped on column (empty space)', () => {
      const event = createCardOnColumnDropEvent('card-1');

      component.onDrop(event);

      expect(component.showMergePopup()).toBe(false);
    });

    it('should call sendCardMove when card is dropped on column area', () => {
      const event = createCardOnColumnDropEvent('card-1');

      component.onDrop(event);

      expect(mockWsService.sendCardMove).toHaveBeenCalledWith(
        'card-1',
        'col-1',
        expect.any(Number)
      );
    });
  });

  describe('merge is prevented on completed board', () => {
    it('should NOT show merge popup when board is completed', () => {
      isCompletedSignal.set(true);

      const event = createCardOnCardDropEvent('card-1', 'card-2');

      component.onDrop(event);

      expect(component.showMergePopup()).toBe(false);
    });

    it('should NOT call sendCardMerge when board is completed', () => {
      isCompletedSignal.set(true);

      const event = createCardOnCardDropEvent('card-1', 'card-2');

      component.onDrop(event);

      expect(mockWsService.sendCardMerge).not.toHaveBeenCalled();
    });
  });

  describe('merge confirmation flow', () => {
    it('should call sendCardMerge with correct IDs when merge is confirmed', () => {
      const event = createCardOnCardDropEvent('card-1', 'card-2');
      component.onDrop(event);

      // Confirm the merge
      component.onMergeConfirmed();

      expect(mockWsService.sendCardMerge).toHaveBeenCalledWith('card-1', 'card-2');
    });

    it('should dismiss popup and NOT call sendCardMerge when merge is cancelled', () => {
      const event = createCardOnCardDropEvent('card-1', 'card-2');
      component.onDrop(event);

      expect(component.showMergePopup()).toBe(true);

      // Cancel the merge
      component.onMergeCancelled();

      expect(component.showMergePopup()).toBe(false);
      expect(mockWsService.sendCardMerge).not.toHaveBeenCalled();
    });
  });
});
