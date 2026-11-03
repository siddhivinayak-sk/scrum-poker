import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { IssueListPanelComponent } from './issue-list-panel.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { IssueItem } from '@shared/types';

describe('IssueListPanelComponent', () => {
  let fixture: ComponentFixture<IssueListPanelComponent>;
  let component: IssueListPanelComponent;
  let mockSessionState: {
    issueList: ReturnType<typeof signal<IssueItem[]>>;
    hasIssuePermission: ReturnType<typeof signal<boolean>>;
    finalWeightEnabled: ReturnType<typeof signal<boolean>>;
    isRevealed: ReturnType<typeof signal<boolean>>;
    currentRound: ReturnType<typeof signal<any>>;
  };
  let mockWs: { send: ReturnType<typeof vi.fn> };

  function createIssue(
    id: string,
    title: string,
    status: 'pending' | 'estimating' | 'estimated' = 'pending'
  ): IssueItem {
    return { id, title, status, createdAt: new Date().toISOString() };
  }

  beforeEach(() => {
    mockSessionState = {
      issueList: signal<IssueItem[]>([]),
      hasIssuePermission: signal(true),
      finalWeightEnabled: signal(false),
      isRevealed: signal(false),
      currentRound: signal(null),
    };

    mockWs = { send: vi.fn(() => true) };

    TestBed.configureTestingModule({
      imports: [IssueListPanelComponent],
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWs },
      ],
    });

    fixture = TestBed.createComponent(IssueListPanelComponent);
    component = fixture.componentInstance;
  });

  describe('add issue', () => {
    it('should send issue:add event with the title when add button is clicked', () => {
      fixture.detectChanges();

      component.newIssueTitle.set('New story');
      component.addIssue();

      expect(mockWs.send).toHaveBeenCalledWith('issue:add', { titles: ['New story'] });
    });

    it('should clear the input after adding an issue', () => {
      fixture.detectChanges();

      component.newIssueTitle.set('New story');
      component.addIssue();

      expect(component.newIssueTitle()).toBe('');
    });

    it('should not send event when title is empty', () => {
      fixture.detectChanges();

      component.newIssueTitle.set('   ');
      component.addIssue();

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('bulk import', () => {
    it('should send issue:add event with multiple titles from textarea', () => {
      fixture.detectChanges();

      component.showBulkImport.set(true);
      component.bulkText.set('Story 1\nStory 2\nStory 3');
      component.bulkImport();

      expect(mockWs.send).toHaveBeenCalledWith('issue:add', {
        titles: ['Story 1', 'Story 2', 'Story 3'],
      });
    });

    it('should filter out empty lines during bulk import', () => {
      fixture.detectChanges();

      component.showBulkImport.set(true);
      component.bulkText.set('Story 1\n\n  \nStory 2');
      component.bulkImport();

      expect(mockWs.send).toHaveBeenCalledWith('issue:add', {
        titles: ['Story 1', 'Story 2'],
      });
    });

    it('should clear bulk text and hide bulk import after importing', () => {
      fixture.detectChanges();

      component.showBulkImport.set(true);
      component.bulkText.set('Story 1');
      component.bulkImport();

      expect(component.bulkText()).toBe('');
      expect(component.showBulkImport()).toBe(false);
    });
  });

  // R22.16, R23.16: bulk import keeps the text and the panel open when send() reports
  // that the frame was not handed to the socket, and clears both when it was.
  describe('bulk import text preservation', () => {
    const multiLineText = 'Story 1\n  Story 2  \n\nStory 3';
    const parsedTitles = ['Story 1', 'Story 2', 'Story 3'];

    async function openBulkImportAndEnterText(text: string): Promise<void> {
      fixture.detectChanges();
      const toggle: HTMLButtonElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__toggle-bulk'
      );
      toggle.click();
      fixture.detectChanges();
      // Let ngModel's initial (async) writeValue('') land before typing, as it would for a user.
      await fixture.whenStable();

      const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__textarea'
      );
      textarea.value = text;
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    async function clickImport(): Promise<void> {
      const importBtn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__bulk-btn'
      );
      expect(importBtn.disabled).toBe(false);
      importBtn.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('keeps Bulk_Import_Text and the panel open when send() returns false', async () => {
      mockWs.send.mockReturnValue(false);
      await openBulkImportAndEnterText(multiLineText);

      await clickImport();

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      expect(mockWs.send).toHaveBeenCalledWith('issue:add', { titles: parsedTitles });

      expect(component.bulkText()).toBe(multiLineText);
      expect(component.showBulkImport()).toBe(true);

      const panel = fixture.nativeElement.querySelector('.issue-list-panel__bulk');
      expect(panel).not.toBeNull();
      const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__textarea'
      );
      expect(textarea.value).toBe(multiLineText);
      const toggle: HTMLButtonElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__toggle-bulk'
      );
      expect(toggle.textContent?.trim()).toBe('Hide bulk import');
    });

    it('clears Bulk_Import_Text and closes the panel when send() returns true', async () => {
      mockWs.send.mockReturnValue(true);
      await openBulkImportAndEnterText(multiLineText);

      await clickImport();

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      expect(mockWs.send).toHaveBeenCalledWith('issue:add', { titles: parsedTitles });

      expect(component.bulkText()).toBe('');
      expect(component.showBulkImport()).toBe(false);

      expect(fixture.nativeElement.querySelector('.issue-list-panel__bulk')).toBeNull();
      expect(fixture.nativeElement.querySelector('.issue-list-panel__textarea')).toBeNull();
      const toggle: HTMLButtonElement = fixture.nativeElement.querySelector(
        '.issue-list-panel__toggle-bulk'
      );
      expect(toggle.textContent?.trim()).toBe('Bulk import');
    });
  });

  describe('reorder', () => {
    it('should send issue:reorder event with new order after drag and drop', () => {
      mockSessionState.issueList.set([
        createIssue('a', 'Issue A'),
        createIssue('b', 'Issue B'),
        createIssue('c', 'Issue C'),
      ]);
      fixture.detectChanges();

      // Simulate dragging item 0 to position 2
      component.onDragStart(0);
      component.onDrop(2);

      expect(mockWs.send).toHaveBeenCalledWith('issue:reorder', {
        orderedIds: ['b', 'c', 'a'],
      });
    });

    it('should not send event when dropping on same position', () => {
      mockSessionState.issueList.set([
        createIssue('a', 'Issue A'),
        createIssue('b', 'Issue B'),
      ]);
      fixture.detectChanges();

      component.onDragStart(1);
      component.onDrop(1);

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('select for estimation', () => {
    it('should send issue:select event when Estimate button is clicked', () => {
      mockSessionState.issueList.set([createIssue('issue-1', 'My Issue')]);
      fixture.detectChanges();

      component.selectIssue('issue-1');

      expect(mockWs.send).toHaveBeenCalledWith('issue:select', { issueId: 'issue-1' });
    });

    it('should show Estimate button only for pending issues', () => {
      mockSessionState.issueList.set([
        createIssue('a', 'Pending', 'pending'),
        createIssue('b', 'Estimated', 'estimated'),
        createIssue('c', 'Estimating', 'estimating'),
      ]);
      // Mark the 'Estimating' issue as the active round so it doesn't show a Resume button
      mockSessionState.currentRound.set({ storyDescription: 'Estimating' } as any);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.issue-list-panel__select-btn');
      expect(buttons.length).toBe(1);
      expect(buttons[0].getAttribute('aria-label')).toBe('Estimate Pending');
    });
  });

  describe('permission gating', () => {
    it('should hide add input and bulk import when user lacks issue permission', () => {
      mockSessionState.hasIssuePermission.set(false);
      fixture.detectChanges();

      const addSection = fixture.nativeElement.querySelector('.issue-list-panel__add');
      const toggleBtn = fixture.nativeElement.querySelector('.issue-list-panel__toggle-bulk');
      expect(addSection).toBeNull();
      expect(toggleBtn).toBeNull();
    });

    it('should still display the issue list when user lacks permission', () => {
      mockSessionState.hasIssuePermission.set(false);
      mockSessionState.issueList.set([createIssue('a', 'Visible Issue')]);
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.issue-list-panel__item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Visible Issue');
    });

    it('should not show Estimate buttons when user lacks permission', () => {
      mockSessionState.hasIssuePermission.set(false);
      mockSessionState.issueList.set([createIssue('a', 'Issue', 'pending')]);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.issue-list-panel__select-btn');
      expect(buttons.length).toBe(0);
    });
  });

  describe('visual distinction', () => {
    it('should apply estimated class to estimated issues', () => {
      mockSessionState.issueList.set([createIssue('a', 'Done', 'estimated')]);
      fixture.detectChanges();

      const item = fixture.nativeElement.querySelector('.issue-list-panel__item--estimated');
      expect(item).toBeTruthy();
    });

    it('should show checkmark for estimated issues', () => {
      mockSessionState.issueList.set([createIssue('a', 'Done', 'estimated')]);
      fixture.detectChanges();

      const status = fixture.nativeElement.querySelector('.issue-list-panel__item-status');
      expect(status?.textContent?.trim()).toBe('✓');
    });

    it('should show empty state when no issues exist', () => {
      mockSessionState.issueList.set([]);
      fixture.detectChanges();

      const empty = fixture.nativeElement.querySelector('.issue-list-panel__empty');
      expect(empty).toBeTruthy();
      expect(empty.textContent).toContain('No issues added yet');
    });
  });
});
