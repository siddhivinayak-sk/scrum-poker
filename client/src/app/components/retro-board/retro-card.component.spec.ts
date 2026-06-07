import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { RetroCardComponent } from './retro-card.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroCard } from '@shared/types';

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

describe('RetroCardComponent - Auto-Focus and Owner Highlight', () => {
  let fixture: ComponentFixture<RetroCardComponent>;
  let component: RetroCardComponent;
  let lastAddedOwnCardIdSignal: WritableSignal<string | null>;
  let ownNewCardIdsSignal: WritableSignal<Set<string>>;

  beforeEach(() => {
    lastAddedOwnCardIdSignal = signal<string | null>(null);
    ownNewCardIdsSignal = signal<Set<string>>(new Set());

    const mockRetroState = {
      lastAddedOwnCardId: lastAddedOwnCardIdSignal,
      ownNewCardIds: ownNewCardIdsSignal.asReadonly(),
      isCompleted: signal(false).asReadonly(),
      votingEnabled: signal(true).asReadonly(),
      votesRemaining: signal(5).asReadonly(),
      config: signal(null).asReadonly(),
      currentUserId: signal('user-1').asReadonly(),
      isModerator: signal(false).asReadonly(),
    };

    const mockWsService = {
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      sendCardEdit: vi.fn(),
      sendCardVote: vi.fn(),
      sendCardRemove: vi.fn(),
      sendCommentAdd: vi.fn(),
      sendCommentRemove: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [RetroCardComponent],
      providers: [
        { provide: RetroStateService, useValue: mockRetroState },
        { provide: RetroWebSocketService, useValue: mockWsService },
      ],
    });
  });

  function createComponent(card: RetroCard): ComponentFixture<RetroCardComponent> {
    const fix = TestBed.createComponent(RetroCardComponent);
    fix.componentRef.setInput('card', card);
    fix.detectChanges();
    return fix;
  }

  describe('Auto-focus behavior', () => {
    it('should auto-focus textarea for own card when lastAddedOwnCardId matches', async () => {
      const card = createMockCard({ id: 'card-own', authorId: 'user-1' });
      lastAddedOwnCardIdSignal.set('card-own');

      fixture = createComponent(card);
      component = fixture.componentInstance;

      // Wait for afterNextRender to fire
      await fixture.whenStable();
      fixture.detectChanges();

      // After auto-focus, the lastAddedOwnCardId should be cleared
      expect(lastAddedOwnCardIdSignal()).toBeNull();
    });

    it('should NOT auto-focus textarea for cards added by other users', async () => {
      const card = createMockCard({ id: 'card-other', authorId: 'user-2' });
      // lastAddedOwnCardId is null (not set for other user's card)
      lastAddedOwnCardIdSignal.set(null);

      fixture = createComponent(card);
      component = fixture.componentInstance;

      await fixture.whenStable();
      fixture.detectChanges();

      // lastAddedOwnCardId should still be null — no focus action taken
      expect(lastAddedOwnCardIdSignal()).toBeNull();

      // The textarea should exist but should not be the actively focused element
      const textarea = fixture.nativeElement.querySelector('textarea');
      expect(textarea).toBeTruthy();
      expect(document.activeElement).not.toBe(textarea);
    });

    it('should NOT auto-focus when card ID does not match lastAddedOwnCardId', async () => {
      const card = createMockCard({ id: 'card-1', authorId: 'user-1' });
      // A different card was just added
      lastAddedOwnCardIdSignal.set('card-different');

      fixture = createComponent(card);
      component = fixture.componentInstance;

      await fixture.whenStable();
      fixture.detectChanges();

      // The signal should NOT be cleared (it belongs to a different card)
      expect(lastAddedOwnCardIdSignal()).toBe('card-different');

      const textarea = fixture.nativeElement.querySelector('textarea');
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('Owner highlight behavior', () => {
    it('should apply owner-highlight class for own cards', () => {
      const card = createMockCard({ id: 'card-own', authorId: 'user-1' });
      ownNewCardIdsSignal.set(new Set(['card-own']));

      fixture = createComponent(card);
      component = fixture.componentInstance;
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('.retro-card');
      expect(cardEl).toBeTruthy();
      expect(cardEl.classList.contains('owner-highlight')).toBe(true);
    });

    it('should NOT apply owner-highlight class for other users cards', () => {
      const card = createMockCard({ id: 'card-other', authorId: 'user-2' });
      // ownNewCardIds does not contain card-other
      ownNewCardIdsSignal.set(new Set(['card-own']));

      fixture = createComponent(card);
      component = fixture.componentInstance;
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('.retro-card');
      expect(cardEl).toBeTruthy();
      expect(cardEl.classList.contains('owner-highlight')).toBe(false);
    });

    it('should NOT apply owner-highlight class when ownNewCardIds is empty', () => {
      const card = createMockCard({ id: 'card-1', authorId: 'user-1' });
      ownNewCardIdsSignal.set(new Set());

      fixture = createComponent(card);
      component = fixture.componentInstance;
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('.retro-card');
      expect(cardEl).toBeTruthy();
      expect(cardEl.classList.contains('owner-highlight')).toBe(false);
    });

    it('should apply owner-highlight class only when card ID is in ownNewCardIds', () => {
      // Simulate scenario: only card-own is highlighted
      ownNewCardIdsSignal.set(new Set(['card-own']));

      // Create component for a card that IS in the set
      const ownCard = createMockCard({ id: 'card-own', authorId: 'user-1' });
      fixture = createComponent(ownCard);
      fixture.detectChanges();
      const ownCardEl = fixture.nativeElement.querySelector('.retro-card');
      expect(ownCardEl.classList.contains('owner-highlight')).toBe(true);
    });

    it('should reflect isOwnerHighlighted computed correctly', () => {
      const card = createMockCard({ id: 'card-own', authorId: 'user-1' });
      ownNewCardIdsSignal.set(new Set(['card-own']));

      fixture = createComponent(card);
      component = fixture.componentInstance;

      expect(component.isOwnerHighlighted()).toBe(true);

      // When card is removed from the set, highlight should disappear
      ownNewCardIdsSignal.set(new Set());
      expect(component.isOwnerHighlighted()).toBe(false);
    });
  });
});
