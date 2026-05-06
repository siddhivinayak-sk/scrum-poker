import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FacilitatorFlowComponent } from './facilitator-flow.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { VotingRound, IssueItem } from '@shared/types';

describe('FacilitatorFlowComponent', () => {
  let fixture: ComponentFixture<FacilitatorFlowComponent>;
  let mockSessionState: {
    currentRound: ReturnType<typeof signal<VotingRound | null>>;
    isRevealed: ReturnType<typeof signal<boolean>>;
    hasRevealPermission: ReturnType<typeof signal<boolean>>;
    issueList: ReturnType<typeof signal<IssueItem[]>>;
  };
  let mockWs: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSessionState = {
      currentRound: signal<VotingRound | null>(null),
      isRevealed: signal(false),
      hasRevealPermission: signal(true),
      issueList: signal<IssueItem[]>([]),
    };

    mockWs = {
      send: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [FacilitatorFlowComponent],
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWs },
      ],
    });

    fixture = TestBed.createComponent(FacilitatorFlowComponent);
  });

  function createRound(overrides: Partial<VotingRound> = {}): VotingRound {
    return {
      id: 'round-1',
      storyDescription: 'Test story',
      status: 'voting',
      selections: new Map(),
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createIssue(status: 'pending' | 'estimating' | 'estimated'): IssueItem {
    return {
      id: `issue-${Math.random().toString(36).slice(2)}`,
      title: `Issue ${status}`,
      status,
      createdAt: new Date().toISOString(),
    };
  }

  describe('flow state derivation', () => {
    it('should be idle when no round is active', () => {
      mockSessionState.currentRound.set(null);
      fixture.detectChanges();

      const prompt = fixture.nativeElement.querySelector('.facilitator-flow__prompt');
      expect(prompt?.textContent).toContain('Select or enter the next story');
    });

    it('should be voting when a round is active and not revealed', () => {
      mockSessionState.currentRound.set(createRound());
      mockSessionState.isRevealed.set(false);
      fixture.detectChanges();

      const prompt = fixture.nativeElement.querySelector('.facilitator-flow__prompt');
      expect(prompt?.textContent).toContain('Voting in progress');
    });

    it('should be revealed when a round is active and revealed', () => {
      mockSessionState.currentRound.set(createRound({ status: 'revealed' }));
      mockSessionState.isRevealed.set(true);
      fixture.detectChanges();

      const prompt = fixture.nativeElement.querySelector('.facilitator-flow__prompt');
      expect(prompt?.textContent).toContain('Cards revealed');
    });
  });

  describe('progress computation', () => {
    it('should show progress when issues exist', () => {
      mockSessionState.issueList.set([
        createIssue('estimated'),
        createIssue('estimated'),
        createIssue('pending'),
        createIssue('estimating'),
      ]);
      fixture.detectChanges();

      const progressText = fixture.nativeElement.querySelector(
        '.facilitator-flow__progress-text'
      );
      expect(progressText?.textContent?.trim()).toBe('2 / 4');
    });

    it('should not show progress when no issues exist', () => {
      mockSessionState.issueList.set([]);
      fixture.detectChanges();

      const progress = fixture.nativeElement.querySelector('.facilitator-flow__progress');
      expect(progress).toBeNull();
    });
  });

  describe('action button visibility', () => {
    it('should show Reveal Cards button in voting state', () => {
      mockSessionState.currentRound.set(createRound());
      mockSessionState.isRevealed.set(false);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.facilitator-flow__btn--reveal');
      expect(btn).toBeTruthy();
      expect(btn.textContent?.trim()).toBe('Reveal Cards');
    });

    it('should show Re-Vote and Clear & Next Story buttons in revealed state', () => {
      mockSessionState.currentRound.set(createRound({ status: 'revealed' }));
      mockSessionState.isRevealed.set(true);
      fixture.detectChanges();

      const revoteBtn = fixture.nativeElement.querySelector('.facilitator-flow__btn--revote');
      const clearBtn = fixture.nativeElement.querySelector('.facilitator-flow__btn--clear');
      expect(revoteBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();
      expect(revoteBtn.textContent?.trim()).toBe('Re-Vote');
      expect(clearBtn.textContent?.trim()).toBe('Clear & Next Story');
    });

    it('should not render anything when user lacks reveal permission', () => {
      mockSessionState.hasRevealPermission.set(false);
      fixture.detectChanges();

      const flow = fixture.nativeElement.querySelector('.facilitator-flow');
      expect(flow).toBeNull();
    });
  });

  describe('actions', () => {
    it('should send cards:reveal event when Reveal Cards is clicked', () => {
      mockSessionState.currentRound.set(createRound());
      mockSessionState.isRevealed.set(false);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.facilitator-flow__btn--reveal');
      btn.click();

      expect(mockWs.send).toHaveBeenCalledWith('cards:reveal', {});
    });

    it('should send round:revote event when Re-Vote is clicked', () => {
      mockSessionState.currentRound.set(createRound({ status: 'revealed' }));
      mockSessionState.isRevealed.set(true);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.facilitator-flow__btn--revote');
      btn.click();

      expect(mockWs.send).toHaveBeenCalledWith('round:revote', {});
    });

    it('should send board:clear event when Clear & Next Story is clicked', () => {
      mockSessionState.currentRound.set(createRound({ status: 'revealed' }));
      mockSessionState.isRevealed.set(true);
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.facilitator-flow__btn--clear');
      btn.click();

      expect(mockWs.send).toHaveBeenCalledWith('board:clear', {});
    });
  });
});
