import { Injectable, signal, Signal, inject, OnDestroy, computed, effect } from '@angular/core';
import { Observable, Subject, Subscription } from 'rxjs';
import {
  User,
  VotingRound,
  VotingMetrics,
  HistoryEntry,
  SessionState,
  SessionConfiguration,
  GameSessionState,
  ExtendedCardValue,
  IssueItem,
  getCardsForVotingSystem,
  hasPermission,
  CalloutNote,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  isCalloutNote,
  normaliseCalloutNotes,
} from '@shared/types';
import { WebSocketService } from './websocket.service';
import { CalloutPersistenceService } from './callout-persistence.service';
import { CalloutCopyStoreService } from './callout-copy-store.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class SessionStateService implements OnDestroy {
  private readonly ws = inject(WebSocketService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly calloutPersistence = inject(CalloutPersistenceService);
  private readonly calloutCopyStore = inject(CalloutCopyStoreService);
  private readonly subscriptions: Subscription[] = [];

  /** Session id of the last received `session:state`; used to detect a routed-session change (R12.5). */
  private activeSessionId: string | null = null;
  private readonly noteAdded = new Subject<CalloutNoteAddedPayload>();
  private readonly noteRejected = new Subject<CalloutNoteRejectedPayload>();

  private readonly _currentRound = signal<VotingRound | null>(null);
  private readonly _participants = signal<User[]>([]);
  private readonly _selections = signal<Map<string, ExtendedCardValue>>(new Map());
  private readonly _isRevealed = signal<boolean>(false);
  private readonly _metrics = signal<VotingMetrics | null>(null);
  private readonly _history = signal<HistoryEntry[]>([]);
  private readonly _currentUser = signal<User | null>(null);
  private readonly _sessionConfig = signal<SessionConfiguration | null>(null);
  private readonly _countdownActive = signal<boolean>(false);
  private readonly _votedUserIds = signal<Set<string>>(new Set());
  private readonly _issueList = signal<IssueItem[]>([]);
  private readonly _ownerId = signal<string | null>(null);
  private readonly _calloutNotes = signal<ReadonlyMap<string, readonly CalloutNote[]>>(new Map());
  private readonly _stateSessionId = signal<string | null>(null);

  /**
   * Id of the session the held state belongs to (from the last `session:state`). The callout layer
   * compares it with the routed id so state of a previously routed session is never shown (R12.5).
   */
  readonly stateSessionId: Signal<string | null> = this._stateSessionId.asReadonly();

  /** Callout notes keyed by the round id they were written for (R10.4, R10.11). */
  readonly calloutNotes: Signal<ReadonlyMap<string, readonly CalloutNote[]>> =
    this._calloutNotes.asReadonly();
  /** Bridge for `callout:note:added`, so the prompt resolves its submit without its own socket subscription. */
  readonly calloutNoteAdded$: Observable<CalloutNoteAddedPayload> = this.noteAdded.asObservable();
  /** Bridge for `callout:note:rejected` (sender only); kept apart from the `error` toast path (R13.3). */
  readonly calloutNoteRejected$: Observable<CalloutNoteRejectedPayload> =
    this.noteRejected.asObservable();

  readonly currentRound: Signal<VotingRound | null> = this._currentRound.asReadonly();
  readonly participants: Signal<User[]> = this._participants.asReadonly();
  readonly selections: Signal<Map<string, ExtendedCardValue>> = this._selections.asReadonly();
  readonly isRevealed: Signal<boolean> = this._isRevealed.asReadonly();
  readonly metrics: Signal<VotingMetrics | null> = this._metrics.asReadonly();
  readonly history: Signal<HistoryEntry[]> = this._history.asReadonly();
  readonly currentUser: Signal<User | null> = this._currentUser.asReadonly();
  readonly sessionConfig: Signal<SessionConfiguration | null> = this._sessionConfig.asReadonly();
  readonly countdownActive: Signal<boolean> = this._countdownActive.asReadonly();
  readonly votedUserIds: Signal<Set<string>> = this._votedUserIds.asReadonly();
  readonly issueList: Signal<IssueItem[]> = this._issueList.asReadonly();
  readonly ownerId: Signal<string | null> = this._ownerId.asReadonly();

  readonly hasRevealPermission = computed(() => {
    const user = this._currentUser();
    const config = this._sessionConfig();
    if (!user || !config) return false;
    return hasPermission(user.id, user.role, config.revealPermission);
  });

  readonly hasIssuePermission = computed(() => {
    const user = this._currentUser();
    const config = this._sessionConfig();
    if (!user || !config) return false;
    return hasPermission(user.id, user.role, config.issuePermission);
  });

  readonly votingSystemCards = computed<ExtendedCardValue[]>(() => {
    const config = this._sessionConfig();
    if (!config) return [];
    return getCardsForVotingSystem(config.votingSystem);
  });

  constructor() {
    // Reactively track the auth user signal and update _currentUser when it changes
    effect(() => {
      const authUser = this.auth.getCurrentUser()();
      if (authUser && !this._currentUser()) {
        this._currentUser.set(authUser);
      }
    });
    this.subscribeToEvents();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  /**
   * Reset all session state signals to their initial values.
   * Called during logout to ensure clean state.
   */
  reset(): void {
    this._currentRound.set(null);
    this._participants.set([]);
    this._selections.set(new Map());
    this._isRevealed.set(false);
    this._metrics.set(null);
    this._history.set([]);
    this._currentUser.set(null);
    this._sessionConfig.set(null);
    this._countdownActive.set(false);
    this._votedUserIds.set(new Set());
    this._issueList.set([]);
    this._ownerId.set(null);
    this._calloutNotes.set(new Map());
    this.activeSessionId = null;
    this._stateSessionId.set(null);
    // R12.7: sign-out clears the callout dismissals and draft, purely locally.
    this.calloutPersistence.clearAll();
    this.calloutCopyStore.reset();
  }

  private subscribeToEvents(): void {
    // Full state sync on reconnect
    this.subscriptions.push(
      this.ws.on<{ state: GameSessionState }>('session:state').subscribe(({ state }) => {
        this.handleSessionChange(state.sessionId);

        const history = this.normaliseHistory(state.history);
        this._participants.set(state.participants);
        this._history.set(history);
        this._isRevealed.set(state.isRevealed);

        // Extract session config from GameSessionState
        if (state.config) {
          this._sessionConfig.set(state.config);
        }

        // Track the session owner from GameSessionState
        this._ownerId.set(state.ownerId ?? null);

        // Restore issue list from state
        if (state.issueList) {
          this._issueList.set(state.issueList);
        }

        const notesByRound = new Map<string, readonly CalloutNote[]>();
        for (const entry of history) {
          this.collectNotes(notesByRound, entry.roundId, entry.calloutNotes);
        }

        if (state.currentRound) {
          const round = this.deserializeRound(state.currentRound);
          this._currentRound.set(round);
          this._selections.set(round.selections);
          this.collectNotes(notesByRound, round.id, round.calloutNotes);
        } else {
          this._currentRound.set(null);
          this._selections.set(new Map());
        }
        // The full sync is authoritative for notes (R13.12): malformed collections arrive as [].
        this._calloutNotes.set(notesByRound);

        // Update current user from participants list
        this.syncCurrentUser(state.participants);
      })
    );

    // New round started
    this.subscriptions.push(
      this.ws.on<{ round: VotingRound }>('round:started').subscribe(({ round }) => {
        const deserialized = this.deserializeRound(round);
        this._currentRound.set(deserialized);
        this._selections.set(new Map());
        this._isRevealed.set(false);
        this._metrics.set(null);
        this._votedUserIds.set(new Set());
      })
    );

    // A participant voted (no value revealed)
    this.subscriptions.push(
      this.ws.on<{ userId: string }>('card:voted').subscribe(({ userId }) => {
        // Track that the user voted (for board display)
        this._votedUserIds.update((current) => {
          const updated = new Set(current);
          updated.add(userId);
          return updated;
        });
      })
    );

    // Cards revealed with selections and metrics
    this.subscriptions.push(
      this.ws
        .on<{ selections: Record<string, ExtendedCardValue>; metrics: VotingMetrics }>('cards:revealed')
        .subscribe(({ selections, metrics }) => {
          const selectionsMap = new Map<string, ExtendedCardValue>(Object.entries(selections));
          this._selections.set(selectionsMap);
          this._isRevealed.set(true);
          this._metrics.set(metrics);

          // Update round status
          const currentRound = this._currentRound();
          if (currentRound) {
            this._currentRound.set({
              ...currentRound,
              status: 'revealed',
              selections: selectionsMap,
            });
          }
        })
    );

    // Board cleared — round saved to history
    this.subscriptions.push(
      this.ws.on<{ historyEntry: HistoryEntry }>('board:cleared').subscribe(({ historyEntry }) => {
        const entry = this.normaliseHistoryEntry(historyEntry);
        this._history.set([entry, ...this._history()]);
        if (entry.calloutNotes?.length) {
          this.collectNotesInto(entry.roundId, entry.calloutNotes);
        }
        this._currentRound.set(null);
        this._selections.set(new Map());
        this._isRevealed.set(false);
        this._metrics.set(null);
        this._votedUserIds.set(new Set());
      })
    );

    // Participant joined — updated participant list
    this.subscriptions.push(
      this.ws.on<{ participants: User[] }>('participant:joined').subscribe(({ participants }) => {
        this._participants.set(participants);
        this.syncCurrentUser(participants);
      })
    );

    // Participant left — updated participant list
    this.subscriptions.push(
      this.ws.on<{ participants: User[] }>('participant:left').subscribe(({ participants }) => {
        this._participants.set(participants);
      })
    );

    // Role changed
    this.subscriptions.push(
      this.ws.on<{ user: User }>('role:changed').subscribe(({ user }) => {
        const participants = this._participants().map((p) =>
          p.id === user.id ? { ...p, role: user.role } : p
        );
        this._participants.set(participants);

        // Update current user if it's us
        const current = this._currentUser();
        if (current && current.id === user.id) {
          this._currentUser.set({ ...current, role: user.role });
        }
      })
    );

    // History cleared
    this.subscriptions.push(
      this.ws.on<Record<string, never>>('history:cleared').subscribe(() => {
        this._history.set([]);
        // Notes of the cleared history rounds go with them; keep only the current round's.
        const currentId = this._currentRound()?.id;
        const kept = new Map<string, readonly CalloutNote[]>();
        const currentNotes = currentId ? this._calloutNotes().get(currentId) : undefined;
        if (currentId && currentNotes) kept.set(currentId, currentNotes);
        this._calloutNotes.set(kept);
      })
    );

    // Session config updated
    this.subscriptions.push(
      this.ws
        .on<{ config: SessionConfiguration }>('session:config-updated')
        .subscribe(({ config }) => {
          this._sessionConfig.set(config);
        })
    );

    // Auto-reveal triggered
    this.subscriptions.push(
      this.ws
        .on<{ countdown: boolean }>('auto:reveal-triggered')
        .subscribe(() => {
          this._countdownActive.set(true);
        })
    );

    // Error events from server (unauthorized actions, etc.)
    this.subscriptions.push(
      this.ws.on<{ message: string; code: string }>('error').subscribe(({ message }) => {
        this.toast.show('error', message);
      })
    );

    // Callout note stored by the server (broadcast to every client in the session)
    this.subscriptions.push(
      this.ws.on<CalloutNoteAddedPayload>(CALLOUT_NOTE_ADDED).subscribe((payload) => {
        const note: unknown = payload?.note;
        if (!isCalloutNote(note)) return;
        this.addNote(note);
        this.noteAdded.next({ roundId: note.roundId, note });
      })
    );

    // Callout note rejected (sender only); intentionally not routed through the `error` toast
    this.subscriptions.push(
      this.ws.on<CalloutNoteRejectedPayload>(CALLOUT_NOTE_REJECTED).subscribe((payload) => {
        if (payload) this.noteRejected.next(payload);
      })
    );

    // Issue list updated
    this.subscriptions.push(
      this.ws.on<{ issues: IssueItem[] }>('issue:list-updated').subscribe(({ issues }) => {
        this._issueList.set(issues);
      })
    );

    // Participant removed — show toast notification to the removed user
    this.subscriptions.push(
      this.ws.on<{ reason: string }>('participant:removed').subscribe(({ reason }) => {
        this.toast.show('warning', 'You have been removed from the session');
      })
    );
  }

  /**
   * Deserialize a VotingRound from JSON transport format.
   * The server sends selections as a Record; we convert to Map.
   */
  private deserializeRound(round: any): VotingRound {
    const deserialized: VotingRound = {
      ...round,
      selections:
        round.selections instanceof Map
          ? round.selections
          : new Map<string, ExtendedCardValue>(Object.entries(round.selections || {})),
    };
    if ('calloutNotes' in round) {
      deserialized.calloutNotes = normaliseCalloutNotes(round.calloutNotes);
    }
    return deserialized;
  }

  /** Normalises `calloutNotes` on a received history entry; entries without the field are untouched (R13.12). */
  private normaliseHistoryEntry(entry: HistoryEntry): HistoryEntry {
    if (entry && 'calloutNotes' in entry) {
      return { ...entry, calloutNotes: normaliseCalloutNotes(entry.calloutNotes) };
    }
    return entry;
  }

  private normaliseHistory(history: HistoryEntry[]): HistoryEntry[] {
    return Array.isArray(history) ? history.map((e) => this.normaliseHistoryEntry(e)) : history;
  }

  private collectNotes(
    target: Map<string, readonly CalloutNote[]>,
    roundId: string,
    notes: unknown
  ): void {
    const normalised = normaliseCalloutNotes(notes);
    if (normalised.length > 0) {
      target.set(roundId, normalised);
    }
  }

  private collectNotesInto(roundId: string, notes: readonly CalloutNote[]): void {
    const next = new Map(this._calloutNotes());
    next.set(roundId, notes);
    this._calloutNotes.set(next);
  }

  /** Appends a stored note to its round (ignoring duplicates by id) and mirrors it into the round or history entry. */
  private addNote(note: CalloutNote): void {
    const existing = this._calloutNotes().get(note.roundId) ?? [];
    if (existing.some((n) => n.id === note.id)) return;
    this.collectNotesInto(note.roundId, [...existing, note]);

    const round = this._currentRound();
    if (round && round.id === note.roundId) {
      this._currentRound.set({ ...round, calloutNotes: [...(round.calloutNotes ?? []), note] });
      return;
    }
    if (this._history().some((e) => e.roundId === note.roundId)) {
      this._history.set(
        this._history().map((e) =>
          e.roundId === note.roundId ? { ...e, calloutNotes: [...(e.calloutNotes ?? []), note] } : e
        )
      );
    }
  }

  /**
   * Detects a change of routed session (R12.5): drops the draft, prunes other sessions' dismissals,
   * clears the phrase memo and forgets the previous session's notes. After a reload there is no
   * previous in-memory id, so a restored draft belonging to another session also counts as a change;
   * a restored draft for this same session is kept (R12.10).
   */
  private handleSessionChange(sessionId: unknown): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const previous = this.activeSessionId;
    this.activeSessionId = sessionId;
    this._stateSessionId.set(sessionId);
    const draft = this.calloutPersistence.draft();
    const changed =
      previous !== null ? previous !== sessionId : draft !== null && draft.sessionId !== sessionId;
    if (!changed) return;
    this.calloutPersistence.sessionChanged(sessionId);
    this.calloutCopyStore.reset();
    this._calloutNotes.set(new Map());
  }

  /**
   * Sync the current user signal from the participants list.
   */
  private syncCurrentUser(participants: User[]): void {
    // Try auth user first
    const authUser = this.auth.getCurrentUser()();
    if (authUser) {
      const found = participants.find((p) => p.id === authUser.id);
      if (found) {
        this._currentUser.set(found);
        return;
      }
    }
    // If current user is already set (from a previous sync), try to find them
    const current = this._currentUser();
    if (current) {
      const found = participants.find((p) => p.id === current.id);
      if (found) {
        this._currentUser.set(found);
      }
    }
  }
}
