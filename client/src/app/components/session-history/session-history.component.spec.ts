import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import {
  SessionHistoryComponent,
  deriveHistorySummary,
  orderCalloutNotes,
} from './session-history.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { User, HistoryEntry, VotingMetrics, CalloutNote, NOTE_MAX_LENGTH } from '@shared/types';

function makeMetrics(overrides: Partial<VotingMetrics> = {}): VotingMetrics {
  return {
    average: 5,
    mode: 5,
    spread: 4,
    distribution: { '3': 1, '5': 2, '8': 1 },
    outliers: [],
    numericVoteCount: 4,
    insufficientData: false,
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    roundId: 'r1',
    storyDescription: 'Test story',
    participants: [
      { userId: 'u1', displayName: 'Alice', cardValue: 5 },
      { userId: 'u2', displayName: 'Bob', cardValue: 8 },
    ],
    metrics: makeMetrics(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionHistoryComponent', () => {
  let component: SessionHistoryComponent;
  let mockWsService: { send: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; connectionState: ReturnType<typeof signal> };
  let currentUserSignal: WritableSignal<User | null>;
  let historySignal: WritableSignal<HistoryEntry[]>;

  beforeEach(() => {
    currentUserSignal = signal<User | null>(null);
    historySignal = signal<HistoryEntry[]>([]);

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: signal(false).asReadonly(),
      metrics: signal(null).asReadonly(),
      history: historySignal.asReadonly(),
      currentUser: currentUserSignal.asReadonly(),
    };

    mockWsService = {
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
      ],
    });

    const fixture = TestBed.createComponent(SessionHistoryComponent);
    component = fixture.componentInstance;
  });

  describe('history listing', () => {
    it('should show empty message when no history entries', () => {
      expect(component.history().length).toBe(0);
    });

    it('should list history entries', () => {
      historySignal.set([
        makeHistoryEntry({ roundId: 'r1', storyDescription: 'Story 1' }),
        makeHistoryEntry({ roundId: 'r2', storyDescription: 'Story 2' }),
      ]);
      expect(component.history().length).toBe(2);
    });

    it('should derive correct summary for an entry', () => {
      const entry = makeHistoryEntry({
        metrics: makeMetrics({ average: 6.5, mode: 8 }),
      });
      const summary = component.getSummary(entry);
      expect(summary.average).toBe('6.5');
      expect(summary.mode).toBe('8');
    });
  });

  describe('expandable detail view', () => {
    it('should not be expanded by default', () => {
      expect(component.isExpanded('r1')).toBe(false);
    });

    it('should expand when toggled', () => {
      component.toggleExpand('r1');
      expect(component.isExpanded('r1')).toBe(true);
    });

    it('should collapse when toggled again', () => {
      component.toggleExpand('r1');
      component.toggleExpand('r1');
      expect(component.isExpanded('r1')).toBe(false);
    });

    it('should allow multiple entries to be expanded independently', () => {
      component.toggleExpand('r1');
      component.toggleExpand('r2');
      expect(component.isExpanded('r1')).toBe(true);
      expect(component.isExpanded('r2')).toBe(true);
    });
  });

  describe('moderator-only clear history', () => {
    it('should show clear button only for moderators', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(true);
    });

    it('should not show clear button for participants', () => {
      currentUserSignal.set({
        id: 'u1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });
      expect(component.isModerator()).toBe(false);
    });

    it('should show confirmation dialog when clear is prompted', () => {
      component.promptClearHistory();
      expect(component.showConfirmDialog()).toBe(true);
    });

    it('should hide confirmation dialog on cancel', () => {
      component.promptClearHistory();
      component.cancelClear();
      expect(component.showConfirmDialog()).toBe(false);
    });

    it('should send history:clear event on confirm', () => {
      component.promptClearHistory();
      component.confirmClear();
      expect(mockWsService.send).toHaveBeenCalledWith('history:clear', {});
      expect(component.showConfirmDialog()).toBe(false);
    });

    it('should not send event if cancelled', () => {
      component.promptClearHistory();
      component.cancelClear();
      expect(mockWsService.send).not.toHaveBeenCalled();
    });
  });
});

describe('deriveHistorySummary (pure function)', () => {
  it('should format average to one decimal place', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ average: 3.666 }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.average).toBe('3.7');
  });

  it('should show dash for null average', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ average: null }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.average).toBe('—');
  });

  it('should show dash for null mode', () => {
    const entry = makeHistoryEntry({
      metrics: makeMetrics({ mode: null }),
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.mode).toBe('—');
  });

  it('should include story description and roundId', () => {
    const entry = makeHistoryEntry({
      roundId: 'abc',
      storyDescription: 'My story',
    });
    const summary = deriveHistorySummary(entry);
    expect(summary.roundId).toBe('abc');
    expect(summary.storyDescription).toBe('My story');
  });
});

// ---------------------------------------------------------------------------
// History notes (R10.9, R10.10, R10.11)
// ---------------------------------------------------------------------------

function makeNote(overrides: Partial<CalloutNote> = {}): CalloutNote {
  return {
    id: 'n1',
    roundId: 'r1',
    authorId: 'u1',
    authorName: 'Alice',
    text: 'A note',
    storedAt: '2024-01-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Deliberately malformed notes must pass through the component's `unknown` boundary. */
function malformed(value: unknown): CalloutNote {
  return value as CalloutNote;
}

describe('orderCalloutNotes (pure function)', () => {
  it('orders notes oldest first by storedAt', () => {
    const notes = [
      makeNote({ id: 'c', storedAt: '2024-01-01T10:00:03.000Z' }),
      makeNote({ id: 'a', storedAt: '2024-01-01T10:00:01.000Z' }),
      makeNote({ id: 'b', storedAt: '2024-01-01T10:00:02.000Z' }),
    ];
    expect(orderCalloutNotes(notes).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps stored order for notes sharing the same storedAt', () => {
    const same = '2024-01-01T10:00:00.000Z';
    const notes = [
      makeNote({ id: 'x1', storedAt: same }),
      makeNote({ id: 'early', storedAt: '2023-12-31T23:59:59.000Z' }),
      makeNote({ id: 'x2', storedAt: same }),
      makeNote({ id: 'x3', storedAt: same }),
    ];
    expect(orderCalloutNotes(notes).map((n) => n.id)).toEqual(['early', 'x1', 'x2', 'x3']);
  });

  it('compares instants, not strings, when the ISO formats differ', () => {
    const notes = [
      makeNote({ id: 'later', storedAt: '2024-01-01T10:00:00.500Z' }),
      makeNote({ id: 'earlier', storedAt: '2024-01-01T11:00:00+02:00' }), // 09:00Z
    ];
    expect(orderCalloutNotes(notes).map((n) => n.id)).toEqual(['earlier', 'later']);
  });

  it('does not mutate the input array', () => {
    const notes = [
      makeNote({ id: 'b', storedAt: '2024-01-01T10:00:02.000Z' }),
      makeNote({ id: 'a', storedAt: '2024-01-01T10:00:01.000Z' }),
    ];
    const snapshot = notes.map((n) => n.id);
    orderCalloutNotes(notes);
    expect(notes.map((n) => n.id)).toEqual(snapshot);
  });

  it('returns the notes with text and author unchanged', () => {
    const note = makeNote({ authorName: 'Bob', text: '  <b>x</b> & "y"  ' });
    const [result] = orderCalloutNotes([note]);
    expect(result.authorName).toBe('Bob');
    expect(result.text).toBe('  <b>x</b> & "y"  ');
  });

  it('returns [] for absent or non-array input', () => {
    expect(orderCalloutNotes(undefined)).toEqual([]);
    expect(orderCalloutNotes(null)).toEqual([]);
    expect(orderCalloutNotes('notes')).toEqual([]);
    expect(orderCalloutNotes({ 0: makeNote() })).toEqual([]);
    expect(orderCalloutNotes([])).toEqual([]);
  });

  it('drops malformed records and keeps the well-formed ones in order', () => {
    const input = [
      makeNote({ id: 'b', storedAt: '2024-01-01T10:00:02.000Z' }),
      null,
      'text',
      42,
      { id: 'no-text', roundId: 'r1', authorId: 'u1', authorName: 'Z', storedAt: '2024-01-01T10:00:00.000Z' },
      { ...makeNote({ id: 'bad-time' }), storedAt: 12345 },
      makeNote({ id: 'a', storedAt: '2024-01-01T10:00:01.000Z' }),
    ];
    expect(orderCalloutNotes(input).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('does not throw for an unparseable storedAt and keeps stored order for equal strings', () => {
    const notes = [
      makeNote({ id: 'one', storedAt: 'not-a-date' }),
      makeNote({ id: 'two', storedAt: 'not-a-date' }),
    ];
    expect(() => orderCalloutNotes(notes)).not.toThrow();
    expect(orderCalloutNotes(notes).map((n) => n.id)).toEqual(['one', 'two']);
  });
});

describe('SessionHistoryComponent notes rendering', () => {
  let fixture: ComponentFixture<SessionHistoryComponent>;
  let historySignal: WritableSignal<HistoryEntry[]>;

  function render(entry: HistoryEntry, expand = true): HTMLElement {
    historySignal.set([entry]);
    if (expand) fixture.componentInstance.toggleExpand(entry.roundId);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function noteRows(root: HTMLElement): { author: string; text: string }[] {
    return Array.from(root.querySelectorAll('.session-history__note')).map((li) => ({
      author: li.querySelector('.session-history__note-author')?.textContent ?? '',
      text: li.querySelector('.session-history__note-text')?.textContent ?? '',
    }));
  }

  function notesHeading(root: HTMLElement): HTMLElement | undefined {
    return Array.from(root.querySelectorAll<HTMLElement>('h4')).find(
      (h) => h.textContent?.trim() === 'Notes',
    );
  }

  beforeEach(() => {
    historySignal = signal<HistoryEntry[]>([]);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: SessionStateService,
          useValue: {
            history: historySignal.asReadonly(),
            currentUser: signal<User | null>(null).asReadonly(),
          },
        },
        {
          provide: WebSocketService,
          useValue: { send: vi.fn(), on: vi.fn().mockReturnValue(EMPTY) },
        },
      ],
    });

    fixture = TestBed.createComponent(SessionHistoryComponent);
  });

  it('renders the author name and the full text of each note', () => {
    const longText = 'x'.repeat(NOTE_MAX_LENGTH);
    const root = render(
      makeHistoryEntry({
        calloutNotes: [
          makeNote({ id: 'n1', authorName: 'Alice', text: 'Short note' }),
          makeNote({ id: 'n2', authorName: 'Bob', text: longText, storedAt: '2024-01-01T10:00:01.000Z' }),
        ],
      }),
    );

    expect(notesHeading(root)).toBeDefined();
    expect(noteRows(root)).toEqual([
      { author: 'Alice', text: 'Short note' },
      { author: 'Bob', text: longText },
    ]);
  });

  it('renders notes oldest first regardless of stored array order', () => {
    const root = render(
      makeHistoryEntry({
        calloutNotes: [
          makeNote({ id: 'c', authorName: 'Carol', text: 'third', storedAt: '2024-01-01T10:00:03.000Z' }),
          makeNote({ id: 'a', authorName: 'Alice', text: 'first', storedAt: '2024-01-01T10:00:01.000Z' }),
          makeNote({ id: 'b', authorName: 'Bob', text: 'second', storedAt: '2024-01-01T10:00:02.000Z' }),
        ],
      }),
    );

    expect(noteRows(root).map((r) => r.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps stored order for notes with equal storedAt', () => {
    const same = '2024-01-01T10:00:00.000Z';
    const root = render(
      makeHistoryEntry({
        calloutNotes: [
          makeNote({ id: 'n1', authorName: 'Zed', text: 'one', storedAt: same }),
          makeNote({ id: 'n2', authorName: 'Amy', text: 'two', storedAt: same }),
          makeNote({ id: 'n3', authorName: 'Max', text: 'three', storedAt: same }),
        ],
      }),
    );

    expect(noteRows(root).map((r) => r.text)).toEqual(['one', 'two', 'three']);
  });

  it('displays markup in note text and author literally without injecting elements', () => {
    const root = render(
      makeHistoryEntry({
        calloutNotes: [
          makeNote({
            id: 'n1',
            authorName: '<i>Mallory</i>',
            text: '<b>x</b><img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>',
          }),
        ],
      }),
    );

    const textEl = root.querySelector('.session-history__note-text') as HTMLElement;
    const authorEl = root.querySelector('.session-history__note-author') as HTMLElement;

    expect(textEl.textContent).toBe(
      '<b>x</b><img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>',
    );
    expect(authorEl.textContent).toBe('<i>Mallory</i>');
    expect(textEl.children.length).toBe(0);
    expect(authorEl.children.length).toBe(0);
    expect(root.querySelector('.session-history__notes b, .session-history__notes i')).toBeNull();
    expect(root.querySelector('.session-history__notes img, .session-history__notes script')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  it('shows no Notes block when calloutNotes is absent', () => {
    const root = render(makeHistoryEntry());

    expect(root.querySelector('.session-history__detail')).not.toBeNull();
    expect(notesHeading(root)).toBeUndefined();
    expect(root.querySelector('.session-history__notes')).toBeNull();
    expect(root.querySelectorAll('.session-history__note').length).toBe(0);
  });

  it('shows no Notes block when calloutNotes is empty', () => {
    const root = render(makeHistoryEntry({ calloutNotes: [] }));

    expect(root.querySelector('.session-history__detail')).not.toBeNull();
    expect(notesHeading(root)).toBeUndefined();
    expect(root.querySelector('.session-history__notes')).toBeNull();
  });

  it('shows notes only in the expanded detail region', () => {
    const root = render(makeHistoryEntry({ calloutNotes: [makeNote()] }), false);

    expect(root.querySelector('.session-history__detail')).toBeNull();
    expect(root.querySelector('.session-history__note')).toBeNull();
  });

  it('renders only well-formed notes when the stored collection holds malformed records', () => {
    const root = render(
      makeHistoryEntry({
        calloutNotes: [
          malformed(null),
          malformed('oops'),
          malformed({ id: 'x', authorName: 'NoText' }),
          makeNote({ id: 'ok', authorName: 'Alice', text: 'kept' }),
          malformed({ ...makeNote({ id: 'bad' }), text: 7 }),
        ],
      }),
    );

    expect(noteRows(root)).toEqual([{ author: 'Alice', text: 'kept' }]);
  });

  it('does not throw when calloutNotes is not an array', () => {
    const entry = makeHistoryEntry({
      calloutNotes: 'broken' as unknown as CalloutNote[],
    });

    expect(() => render(entry)).not.toThrow();
    expect(fixture.componentInstance.orderedNotes(entry)).toEqual([]);
  });

  it('orderedNotes returns [] for an entry without notes', () => {
    expect(fixture.componentInstance.orderedNotes(makeHistoryEntry())).toEqual([]);
  });
});
