import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { BoardComponent } from './board.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { User, CardValue } from '@shared/types';

/**
 * Card Flip Animation Tests
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4
 */
describe('Card Flip Animation', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<BoardComponent>>;
  let component: BoardComponent;
  let participantsSignal: WritableSignal<User[]>;
  let selectionsSignal: WritableSignal<Map<string, CardValue>>;
  let isRevealedSignal: WritableSignal<boolean>;

  beforeEach(() => {
    // Mock matchMedia for StarsAnimationComponent
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as any;

    participantsSignal = signal<User[]>([]);
    selectionsSignal = signal<Map<string, CardValue>>(new Map());
    isRevealedSignal = signal<boolean>(false);

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: participantsSignal.asReadonly(),
      selections: selectionsSignal.asReadonly(),
      isRevealed: isRevealedSignal.asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: signal(null).asReadonly(),
      votedUserIds: signal(new Set<string>()).asReadonly(),
    };

    const mockWsService = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    const mockAuthService = {
      getCurrentUser: vi.fn().mockReturnValue(signal(null)),
      getToken: vi.fn().mockReturnValue(null),
      login: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    fixture = TestBed.createComponent(BoardComponent);
    component = fixture.componentInstance;
  });

  describe('CSS class application for flip animation', () => {
    it('should not apply revealed class before reveal', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map([['u1', 5 as CardValue]]));
      isRevealedSignal.set(false);
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('.board__card');
      expect(cardEl).not.toBeNull();
      expect(cardEl.classList.contains('board__card--revealed')).toBe(false);
    });

    it('should apply board__card--revealed class when isRevealed is true', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map([['u1', 8 as CardValue]]));
      isRevealedSignal.set(true);
      fixture.detectChanges();

      const cardEl = fixture.nativeElement.querySelector('.board__card');
      expect(cardEl.classList.contains('board__card--revealed')).toBe(true);
    });

    it('should trigger flip on all participant cards when revealed', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
        { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false },
        { id: 'u3', displayName: 'Charlie', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(true);
      fixture.detectChanges();

      const cards = fixture.nativeElement.querySelectorAll('.board__card');
      expect(cards.length).toBe(3);
      cards.forEach((card: HTMLElement) => {
        expect(card.classList.contains('board__card--revealed')).toBe(true);
      });
    });
  });

  describe('3D flip structure (Requirement 10.3)', () => {
    beforeEach(() => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map([['u1', 13 as CardValue]]));
      fixture.detectChanges();
    });

    it('should have an inner container for 3D transform', () => {
      const inner = fixture.nativeElement.querySelector('.board__card-inner');
      expect(inner).not.toBeNull();
    });

    it('should have a front face element', () => {
      const front = fixture.nativeElement.querySelector('.board__card-front');
      expect(front).not.toBeNull();
      expect(front.classList.contains('board__card-face')).toBe(true);
    });

    it('should have a back face element', () => {
      const back = fixture.nativeElement.querySelector('.board__card-back');
      expect(back).not.toBeNull();
      expect(back.classList.contains('board__card-face')).toBe(true);
    });

    it('should display participant name on front face', () => {
      const frontName = fixture.nativeElement.querySelector(
        '.board__card-front .board__card-name'
      );
      expect(frontName.textContent.trim()).toBe('Alice');
    });

    it('should display participant name on back face', () => {
      const backName = fixture.nativeElement.querySelector(
        '.board__card-back .board__card-name'
      );
      expect(backName.textContent.trim()).toBe('Alice');
    });
  });

  describe('face-down content (front face)', () => {
    it('should show "Voted ✓" on front face when participant has voted', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map([['u1', 5 as CardValue]]));
      isRevealedSignal.set(false);
      fixture.detectChanges();

      const frontValue = fixture.nativeElement.querySelector(
        '.board__card-front .board__card-value'
      );
      expect(frontValue.textContent.trim()).toBe('Voted ✓');
    });

    it('should show empty text on front face when participant has not voted', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(false);
      fixture.detectChanges();

      const frontValue = fixture.nativeElement.querySelector(
        '.board__card-front .board__card-value'
      );
      expect(frontValue.textContent.trim()).toBe('');
    });
  });

  describe('face-up content (back face)', () => {
    it('should show card value on back face when participant voted', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      selectionsSignal.set(new Map([['u1', 21 as CardValue]]));
      isRevealedSignal.set(true);
      fixture.detectChanges();

      const backValue = fixture.nativeElement.querySelector(
        '.board__card-back .board__card-value'
      );
      expect(backValue.textContent.trim()).toBe('21');
    });

    it('should show "No Vote" on back face when participant did not vote', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      isRevealedSignal.set(true);
      fixture.detectChanges();

      const backValue = fixture.nativeElement.querySelector(
        '.board__card-back .board__card-value'
      );
      expect(backValue.textContent.trim()).toBe('No Vote');
    });
  });

  describe('animation duration (Requirement 10.2)', () => {
    it('should have 600ms transition duration on card inner element', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      fixture.detectChanges();

      const inner = fixture.nativeElement.querySelector('.board__card-inner') as HTMLElement;
      const style = getComputedStyle(inner);
      // The transition property should contain 600ms
      const transition = style.transition || style.getPropertyValue('transition');
      expect(transition).toContain('600ms');
    });
  });

  describe('perspective for 3D effect (Requirement 10.3)', () => {
    it('should have perspective set on the grid container', () => {
      participantsSignal.set([
        { id: 'u1', displayName: 'Alice', role: 'participant', isAnonymous: false },
      ]);
      fixture.detectChanges();

      const grid = fixture.nativeElement.querySelector('.board__grid') as HTMLElement;
      const style = getComputedStyle(grid);
      const perspective = style.perspective || style.getPropertyValue('perspective');
      expect(perspective).toBe('800px');
    });
  });

  describe('reduced motion preference (Requirement 10.4)', () => {
    it('should include prefers-reduced-motion media query in component styles', () => {
      // Verify the component's inline styles contain the reduced-motion media query.
      // We check the component metadata styles array directly.
      const componentStyles = (BoardComponent as any).ɵcmp?.styles ?? [];
      const allStyles = componentStyles.join(' ');
      expect(allStyles).toContain('prefers-reduced-motion');
      expect(allStyles).toContain('transition');
      expect(allStyles).toContain('none');
    });
  });
});
