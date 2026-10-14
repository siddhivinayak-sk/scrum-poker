import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalloutNote, CalloutNoteAddedPayload, VotingRound } from '@shared/types';
import {
  BALLOON_AUTO_DISMISS_MS,
  MAX_BALLOONS,
  ModeratorNoteBalloonComponent,
} from './moderator-note-balloon.component';
import { SessionStateService } from '../../services/session-state.service';

const SESSION_ID = 'session-1';
const ROUND_ID = 'round-1';
const MODERATOR_ID = 'mod-1';

function note(overrides: Partial<CalloutNote> = {}): CalloutNote {
  return {
    id: 'note-1',
    roundId: ROUND_ID,
    authorId: 'voter-1',
    authorName: 'Dana',
    text: 'I think there is hidden migration work',
    storedAt: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

describe('ModeratorNoteBalloonComponent', () => {
  let fixture: ComponentFixture<ModeratorNoteBalloonComponent>;
  let noteAdded: Subject<CalloutNoteAddedPayload>;
  let hasRevealPermission: WritableSignal<boolean>;
  let currentRound: WritableSignal<VotingRound | null>;
  let currentUser: WritableSignal<{ id: string } | null>;

  function round(): VotingRound {
    return {
      id: ROUND_ID,
      storyDescription: 'Story',
      status: 'revealed',
      selections: new Map(),
    } as unknown as VotingRound;
  }

  function texts(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.note-balloon__text') as NodeListOf<HTMLElement>
    ).map((el) => el.textContent?.trim() ?? '');
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    noteAdded = new Subject<CalloutNoteAddedPayload>();
    hasRevealPermission = signal(true);
    currentRound = signal<VotingRound | null>(round());
    currentUser = signal<{ id: string } | null>({ id: MODERATOR_ID });

    const sessionState = {
      calloutNoteAdded$: noteAdded.asObservable(),
      hasRevealPermission,
      currentRound,
      currentUser,
    };

    await TestBed.configureTestingModule({
      imports: [ModeratorNoteBalloonComponent],
      providers: [{ provide: SessionStateService, useValue: sessionState }],
    }).compileComponents();

    fixture = TestBed.createComponent(ModeratorNoteBalloonComponent);
    fixture.componentRef.setInput('sessionId', SESSION_ID);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows a balloon for a note on the current round', () => {
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    fixture.detectChanges();
    expect(texts()).toEqual(['I think there is hidden migration work']);
  });

  it('ignores notes for a different round', () => {
    noteAdded.next({ roundId: 'other', note: note({ roundId: 'other' }) });
    fixture.detectChanges();
    expect(texts()).toEqual([]);
  });

  it("ignores the moderator's own note", () => {
    noteAdded.next({ roundId: ROUND_ID, note: note({ authorId: MODERATOR_ID }) });
    fixture.detectChanges();
    expect(texts()).toEqual([]);
  });

  it('shows nothing for a non-moderator', () => {
    hasRevealPermission.set(false);
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.note-balloons')).toBeNull();
  });

  it('auto-dismisses after the configured interval', () => {
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    fixture.detectChanges();
    expect(texts()).toHaveLength(1);

    vi.advanceTimersByTime(BALLOON_AUTO_DISMISS_MS);
    fixture.detectChanges();
    expect(texts()).toEqual([]);
  });

  it('dismisses on the close control', () => {
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      '.note-balloon__dismiss'
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(texts()).toEqual([]);
  });

  it('de-dupes a replayed note by id', () => {
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    noteAdded.next({ roundId: ROUND_ID, note: note() });
    fixture.detectChanges();
    expect(texts()).toHaveLength(1);
  });

  it('caps the number of simultaneous balloons', () => {
    for (let i = 0; i < MAX_BALLOONS + 2; i++) {
      noteAdded.next({
        roundId: ROUND_ID,
        note: note({ id: `note-${i}`, text: `note ${i}` }),
      });
    }
    fixture.detectChanges();
    expect(texts()).toHaveLength(MAX_BALLOONS);
  });
});
