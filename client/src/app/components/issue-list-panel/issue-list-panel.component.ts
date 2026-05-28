import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { IssueItem } from '@shared/types';

@Component({
  selector: 'app-issue-list-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <aside class="issue-list-panel" role="complementary" aria-label="Issue list">
      <h3 class="issue-list-panel__title">Issues</h3>

      @if (canManage()) {
        <div class="issue-list-panel__add">
          <input
            class="issue-list-panel__input"
            type="text"
            placeholder="Add issue..."
            [(ngModel)]="newIssueTitle"
            (keydown.enter)="addIssue()"
            aria-label="New issue title"
          />
          <button
            class="issue-list-panel__add-btn"
            (click)="addIssue()"
            type="button"
            [disabled]="!newIssueTitle().trim()"
            title="Add issue"
          >
            Add
          </button>
        </div>

        @if (showBulkImport()) {
          <div class="issue-list-panel__bulk">
            <textarea
              class="issue-list-panel__textarea"
              placeholder="Paste issues (one per line)..."
              [(ngModel)]="bulkText"
              aria-label="Bulk import issues"
            ></textarea>
            <button
              class="issue-list-panel__bulk-btn"
              (click)="bulkImport()"
              type="button"
              [disabled]="!bulkText().trim()"
              title="Import issues"
            >
              Import
            </button>
          </div>
        }

        <button
          class="issue-list-panel__toggle-bulk"
          (click)="toggleBulkImport()"
          type="button"
          title="Bulk import"
        >
          {{ showBulkImport() ? 'Hide bulk import' : 'Bulk import' }}
        </button>
      }

      <ul class="issue-list-panel__list" role="list">
        @for (issue of issues(); track issue.id; let i = $index) {
          <li
            class="issue-list-panel__item"
            [class.issue-list-panel__item--estimated]="issue.status === 'estimated'"
            [class.issue-list-panel__item--estimating]="issue.status === 'estimating'"
            [attr.draggable]="canManage()"
            (dragstart)="onDragStart(i)"
            (dragover)="onDragOver($event, i)"
            (drop)="onDrop(i)"
            role="listitem"
          >
            <span class="issue-list-panel__item-status" aria-hidden="true">
              @if (issue.status === 'estimated') {
                ✓
              } @else if (issue.status === 'estimating') {
                ●
              } @else {
                ○
              }
            </span>
            <span class="issue-list-panel__item-title" [title]="issue.title">{{ issue.title }}</span>
            @if (canManage() && issue.status === 'pending') {
              <button
                class="issue-list-panel__select-btn"
                (click)="selectIssue(issue.id)"
                type="button"
                [attr.aria-label]="'Estimate ' + issue.title"
                title="Estimate this issue"
              >
                Estimate
              </button>
            }
            @if (canManage() && issue.status === 'estimating' && !isActiveIssue(issue)) {
              <button
                class="issue-list-panel__select-btn issue-list-panel__select-btn--resume"
                (click)="selectIssue(issue.id)"
                type="button"
                [attr.aria-label]="'Resume ' + issue.title"
                title="Resume estimation for this issue"
              >
                Resume
              </button>
            }
          </li>
        }
      </ul>

      @if (issues().length === 0) {
        <p class="issue-list-panel__empty">No issues added yet</p>
      }
    </aside>
  `,
  styles: [
    `
      .issue-list-panel {
        padding: 0.75rem;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fff;
        overflow: hidden;
      }

      .issue-list-panel__title {
        margin: 0 0 0.5rem;
        font-size: 1rem;
        font-weight: 700;
      }

      .issue-list-panel__add {
        display: flex;
        gap: 0.375rem;
        margin-bottom: 0.5rem;
      }

      .issue-list-panel__input {
        flex: 1;
        min-width: 0;
        padding: 0.375rem 0.5rem;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.85rem;
      }

      .issue-list-panel__add-btn,
      .issue-list-panel__bulk-btn {
        padding: 0.375rem 0.75rem;
        border: none;
        border-radius: 4px;
        background: #1976d2;
        color: #fff;
        font-size: 0.85rem;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .issue-list-panel__add-btn:disabled,
      .issue-list-panel__bulk-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .issue-list-panel__toggle-bulk {
        background: none;
        border: none;
        color: #1976d2;
        font-size: 0.8rem;
        cursor: pointer;
        padding: 0.25rem 0;
        margin-bottom: 0.5rem;
      }

      .issue-list-panel__bulk {
        margin-bottom: 0.5rem;
      }

      .issue-list-panel__textarea {
        width: 100%;
        min-height: 60px;
        padding: 0.375rem 0.5rem;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.85rem;
        resize: vertical;
        margin-bottom: 0.375rem;
      }

      .issue-list-panel__list {
        list-style: none;
        padding: 0;
        margin: 0;
      }

      .issue-list-panel__item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.25rem;
        border-bottom: 1px solid #f0f0f0;
        cursor: grab;
      }

      .issue-list-panel__item--estimated {
        opacity: 0.6;
      }

      .issue-list-panel__item--estimating {
        background: #e3f2fd;
        border-radius: 4px;
      }

      .issue-list-panel__item-status {
        font-size: 0.8rem;
        min-width: 1rem;
        text-align: center;
      }

      .issue-list-panel__item-title {
        flex: 1;
        font-size: 0.85rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        word-break: break-word;
      }

      .issue-list-panel__select-btn {
        padding: 0.2rem 0.5rem;
        border: 1px solid #1976d2;
        border-radius: 4px;
        background: transparent;
        color: #1976d2;
        font-size: 0.75rem;
        cursor: pointer;
        white-space: nowrap;
      }

      .issue-list-panel__select-btn:hover {
        background: #e3f2fd;
      }

      .issue-list-panel__empty {
        color: #888;
        font-size: 0.85rem;
        font-style: italic;
        text-align: center;
        padding: 1rem 0;
      }
    `,
  ],
})
export class IssueListPanelComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly ws = inject(WebSocketService);

  readonly issues = computed<IssueItem[]>(() => this.sessionState.issueList());
  readonly canManage = computed<boolean>(() => this.sessionState.hasIssuePermission());

  readonly newIssueTitle = signal('');
  readonly bulkText = signal('');
  readonly showBulkImport = signal(false);

  private dragIndex: number | null = null;

  toggleBulkImport(): void {
    this.showBulkImport.update((v) => !v);
  }

  addIssue(): void {
    const title = this.newIssueTitle().trim();
    if (!title) return;
    this.ws.send('issue:add', { titles: [title] });
    this.newIssueTitle.set('');
  }

  bulkImport(): void {
    const text = this.bulkText().trim();
    if (!text) return;
    const titles = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (titles.length === 0) return;
    this.ws.send('issue:add', { titles });
    this.bulkText.set('');
    this.showBulkImport.set(false);
  }

  selectIssue(issueId: string): void {
    this.ws.send('issue:select', { issueId });
  }

  isActiveIssue(issue: IssueItem): boolean {
    const round = this.sessionState.currentRound();
    if (!round) return false;
    return round.storyDescription === issue.title;
  }

  onDragStart(index: number): void {
    this.dragIndex = index;
  }

  onDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
  }

  onDrop(targetIndex: number): void {
    if (this.dragIndex === null || this.dragIndex === targetIndex) return;
    const currentIssues = [...this.issues()];
    const [moved] = currentIssues.splice(this.dragIndex, 1);
    currentIssues.splice(targetIndex, 0, moved);
    const orderedIds = currentIssues.map((i) => i.id);
    this.ws.send('issue:reorder', { orderedIds });
    this.dragIndex = null;
  }
}
