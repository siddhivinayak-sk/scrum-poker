/**
 * Layout contract for the issue list panel (Stream 2, Requirement 2).
 *
 * The client test environment performs no layout — `getBoundingClientRect()`
 * returns zeros and nothing is measured. These tests therefore assert the two
 * things that are observable without layout:
 *
 *  1. the *declared* CSS of the component, read from its compiled style blocks,
 *     which is what the browser applies at every viewport width, and
 *  2. the *rendered DOM structure* and accessible names.
 *
 * Measured geometry is covered by the pure box-model property test in
 * `issue-title.property.spec.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { IssueListPanelComponent } from './issue-list-panel.component';
import { ISSUE_TITLE_PLACEHOLDER } from './issue-title';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { IssueItem, VotingRound } from '@shared/types';

/** Minimal view of the compiled component definition's style blocks. */
interface StyledComponentType {
  readonly ɵcmp?: { readonly styles?: readonly string[] };
}

/** All compiled style blocks of the component, whitespace-normalised. */
function componentCss(): string {
  const styles = (IssueListPanelComponent as unknown as StyledComponentType).ɵcmp?.styles ?? [];
  return styles.join('\n').replace(/\s+/g, ' ');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Declaration body of the rule whose selector targets exactly `className`.
 * The negative lookahead keeps `.issue-list-panel` from matching the
 * `.issue-list-panel__item` rules, and tolerates the `[_ngcontent-…]` scoping
 * attribute the compiler appends to each selector.
 */
function ruleBody(className: string): string {
  const pattern = new RegExp(`\\.${escapeForRegExp(className)}(?![\\w-])[^{}]*\\{([^{}]*)\\}`);
  const match = pattern.exec(componentCss());
  expect(match, `no CSS rule found for .${className}`).not.toBeNull();
  return match === null ? '' : match[1];
}

/** True when the rule pins a flex item to `basis` with no grow. */
function declaresFixedBasis(body: string, basis: string): boolean {
  const escaped = escapeForRegExp(basis);
  const shorthand = new RegExp(`flex:\\s*0\\s+0\\s+${escaped}`).test(body);
  const longhand =
    new RegExp(`flex-basis:\\s*${escaped}`).test(body) && /flex-grow:\s*0/.test(body);
  return shorthand || longhand;
}

describe('IssueListPanelComponent layout', () => {
  let fixture: ComponentFixture<IssueListPanelComponent>;
  let mockSessionState: {
    issueList: ReturnType<typeof signal<IssueItem[]>>;
    hasIssuePermission: ReturnType<typeof signal<boolean>>;
    currentRound: ReturnType<typeof signal<VotingRound | null>>;
  };
  let mockWs: { send: ReturnType<typeof vi.fn> };

  function createIssue(
    id: string,
    title: string,
    status: 'pending' | 'estimating' | 'estimated' = 'pending'
  ): IssueItem {
    return { id, title, status, createdAt: new Date().toISOString() };
  }

  function rows(): HTMLLIElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLLIElement>(
        '.issue-list-panel__item'
      )
    );
  }

  function query<T extends Element>(selector: string): T | null {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  }

  beforeEach(() => {
    mockSessionState = {
      issueList: signal<IssueItem[]>([]),
      hasIssuePermission: signal(true),
      currentRound: signal<VotingRound | null>(null),
    };
    mockWs = { send: vi.fn() };

    TestBed.configureTestingModule({
      imports: [IssueListPanelComponent],
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWs },
      ],
    });

    fixture = TestBed.createComponent(IssueListPanelComponent);
  });

  describe('declared title styles', () => {
    it('exposes compiled component styles to assert against', () => {
      expect(componentCss().length).toBeGreaterThan(0);
    });

    it('clamps the title to two lines with hidden overflow (R2.1, R2.8)', () => {
      const body = ruleBody('issue-list-panel__item-title');

      expect(body).toMatch(/display:\s*-webkit-box/);
      expect(body).toMatch(/-webkit-line-clamp:\s*2/);
      expect(body).toMatch(/-webkit-box-orient:\s*vertical/);
      expect(body).toMatch(/overflow:\s*hidden/);
    });

    it('no longer forces the title onto a single line (R2.1)', () => {
      expect(ruleBody('issue-list-panel__item-title')).not.toMatch(/white-space:\s*nowrap/);
    });

    it('lets the title shrink below its content width and take the remaining space (R2.11)', () => {
      const body = ruleBody('issue-list-panel__item-title');

      expect(body).toMatch(/min-width:\s*0(?![\w.%])/);
      expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    });

    it('breaks a title that holds no whitespace (R2.4)', () => {
      expect(ruleBody('issue-list-panel__item-title')).toMatch(/overflow-wrap:\s*anywhere/);
    });

    it('declares a title font size of at least 12 pixels (R2.6)', () => {
      const body = ruleBody('issue-list-panel__item-title');
      const fontSize = /font-size:\s*(\d*\.?\d+)rem/.exec(body);

      expect(fontSize, 'title rule declares no rem font-size').not.toBeNull();
      expect(Number(fontSize?.[1]) * 16).toBeGreaterThanOrEqual(12);
      expect(body).toMatch(/line-height:\s*1\.35/);
    });
  });

  describe('declared row box styles', () => {
    it('gives the action slot a fixed inline size (R2.11)', () => {
      const body = ruleBody('issue-list-panel__item-action');

      expect(declaresFixedBasis(body, '5.5rem'), `action slot rule: ${body}`).toBe(true);
    });

    it('keeps the status marker at a fixed inline size (R2.4)', () => {
      const body = ruleBody('issue-list-panel__item-status');

      expect(body).toMatch(/min-width:\s*1rem/);
      expect(body).toMatch(/flex:\s*0\s+0\s+auto|flex-grow:\s*0/);
    });

    it('lays the three row children out in a row with a gap, so their boxes cannot overlap (R2.4)', () => {
      const body = ruleBody('issue-list-panel__item');

      expect(body).toMatch(/display:\s*flex/);
      expect(body).toMatch(/gap:\s*0\.5rem/);
      expect(body).not.toMatch(/position:\s*absolute/);
    });

    it('confines overflow to the panel and starts every row at the content edge (R2.12)', () => {
      expect(ruleBody('issue-list-panel')).toMatch(/overflow:\s*hidden/);

      const list = ruleBody('issue-list-panel__list');
      expect(list).toMatch(/padding:\s*0(?![\w.%])/);
      expect(list).toMatch(/margin:\s*0(?![\w.%])/);

      // A negative inline margin would pull a row left of the content edge.
      expect(ruleBody('issue-list-panel__item')).not.toMatch(/margin[^:;]*:\s*-/);
    });
  });

  describe('rendered row structure', () => {
    beforeEach(() => {
      mockSessionState.issueList.set([
        createIssue('a', 'Pending issue', 'pending'),
        createIssue('b', 'Issue under estimation', 'estimating'),
        createIssue('c', 'Finished issue', 'estimated'),
      ]);
      mockSessionState.currentRound.set({
        storyDescription: 'Issue under estimation',
      } as VotingRound);
      fixture.detectChanges();
    });

    it('renders status marker, title and action slot once per row, in that order (R2.4)', () => {
      expect(rows()).toHaveLength(3);

      for (const row of rows()) {
        expect(row.querySelectorAll('.issue-list-panel__item-status')).toHaveLength(1);
        expect(row.querySelectorAll('.issue-list-panel__item-title')).toHaveLength(1);
        expect(row.querySelectorAll('.issue-list-panel__item-action')).toHaveLength(1);

        const childClasses = Array.from(row.children).map((child) => child.className);
        expect(childClasses).toEqual([
          'issue-list-panel__item-status',
          'issue-list-panel__item-title',
          'issue-list-panel__item-action',
        ]);
      }
    });

    it('always renders the action slot, whatever the row status (R2.11)', () => {
      // The 'estimated' row carries no button, but still reserves its slot so
      // every row's action shares one left edge.
      const slots = rows().map((row) => row.querySelector('.issue-list-panel__item-action'));

      expect(slots.every((slot) => slot !== null)).toBe(true);
      expect(slots[2]?.querySelectorAll('button')).toHaveLength(0);
    });

    it('carries the complete stored title as both title and aria-label (R2.2)', () => {
      const longTitle = 'L'.repeat(500);
      mockSessionState.issueList.set([createIssue('long', longTitle)]);
      fixture.detectChanges();

      const title = query<HTMLElement>('.issue-list-panel__item-title');

      expect(title?.getAttribute('title')).toBe(longTitle);
      expect(title?.getAttribute('aria-label')).toBe(longTitle);
      expect(title?.getAttribute('title')).not.toContain('…');
      expect(title?.getAttribute('title')).not.toContain('...');
      expect(title?.textContent).toBe(longTitle);
    });
  });

  describe('blank titles', () => {
    it.each(['', '   ', '\n\t '])(
      'renders a placeholder that is also the accessible name (R2.10) for %j',
      (storedTitle) => {
        mockSessionState.issueList.set([createIssue('blank', storedTitle)]);
        fixture.detectChanges();

        const title = query<HTMLElement>('.issue-list-panel__item-title');

        expect(title?.textContent?.trim()).toBe(ISSUE_TITLE_PLACEHOLDER);
        expect(title?.getAttribute('title')).toBe(ISSUE_TITLE_PLACEHOLDER);
        expect(title?.getAttribute('aria-label')).toBe(ISSUE_TITLE_PLACEHOLDER);
      }
    );

    it('keeps a blank-titled row selectable by its existing action (R2.10)', () => {
      mockSessionState.issueList.set([createIssue('blank', '   ', 'pending')]);
      fixture.detectChanges();

      const button = query<HTMLButtonElement>('.issue-list-panel__select-btn');
      expect(button).not.toBeNull();

      button?.click();

      expect(mockWs.send).toHaveBeenCalledWith('issue:select', { issueId: 'blank' });
    });
  });

  describe('pre-existing actions keep their accessible names (R2.7)', () => {
    beforeEach(() => {
      mockSessionState.issueList.set([
        createIssue('a', 'Pending issue', 'pending'),
        createIssue('b', 'Paused issue', 'estimating'),
      ]);
      // A different story is live, so the 'estimating' row offers Resume.
      mockSessionState.currentRound.set({ storyDescription: 'Another story' } as VotingRound);
      fixture.detectChanges();
    });

    it('keeps the estimate and resume actions', () => {
      const labels = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.issue-list-panel__select-btn')
      ).map((button) => button.getAttribute('aria-label'));

      expect(labels).toEqual(['Estimate Pending issue', 'Resume Paused issue']);
    });

    it('keeps the add action', () => {
      expect(query('.issue-list-panel__input')?.getAttribute('aria-label')).toBe(
        'New issue title'
      );
      expect(query('.issue-list-panel__add-btn')?.getAttribute('title')).toBe('Add issue');
    });

    it('keeps the bulk import actions', () => {
      const toggle = query<HTMLButtonElement>('.issue-list-panel__toggle-bulk');
      expect(toggle?.getAttribute('title')).toBe('Bulk import');

      toggle?.click();
      fixture.detectChanges();

      expect(query('.issue-list-panel__textarea')?.getAttribute('aria-label')).toBe(
        'Bulk import issues'
      );
      expect(query('.issue-list-panel__bulk-btn')?.getAttribute('title')).toBe('Import issues');
    });

    it('keeps rows draggable and reordering intact', () => {
      expect(rows().map((row) => row.getAttribute('draggable'))).toEqual(['true', 'true']);

      const component = fixture.componentInstance;
      component.onDragStart(0);
      component.onDrop(1);

      expect(mockWs.send).toHaveBeenCalledWith('issue:reorder', { orderedIds: ['b', 'a'] });
    });
  });
});
