import { Injectable, signal, Signal, inject, OnDestroy, computed, effect } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  User,
  CardValue,
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
} from '@shared/types';
import { WebSocketService } from './websocket.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class SessionStateService implements OnDestroy {
  private readonly ws = inject(WebSocketService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly subscriptions: Subscription[] = [];

  private readonly _currentRound = signal<VotingRound | null>(null);
  private readonly _participants = signal<User[]>([]);
  private readonly _selections = signal<Map<string, CardValue>>(new Map());
  private readonly _isRevealed = signal<boolean>(false);
  private readonly _metrics = signal<VotingMetrics | null>(null);
  private readonly _history = signal<HistoryEntry[]>([]);
  private readonly _currentUser = signal<User | null>(null);
  private readonly _sessionConfig = signal<SessionConfiguration | null>(null);
  private readonly _countdownActive = signal<boolean>(false);
  private readonly _votedUserIds = signal<Set<string>>(new Set());
  private readonly _issueList = signal<IssueItem[]>([]);

  readonly currentRound: Signal<VotingRound | null> = this._currentRound.asReadonly();
  readonly participants: Signal<User[]> = this._participants.asReadonly();
  readonly selections: Signal<Map<string, CardValue>> = this._selections.asReadonly();
  readonly isRevealed: Signal<boolean> = this._isRevealed.asReadonly();
  readonly metrics: Signal<VotingMetrics | null> = this._metrics.asReadonly();
  readonly history: Signal<HistoryEntry[]> = this._history.asReadonly();
  readonly currentUser: Signal<User | null> = this._currentUser.asReadonly();
  readonly sessionConfig: Signal<SessionConfiguration | null> = this._sessionConfig.asReadonly();
  readonly countdownActive: Signal<boolean> = this._countdownActive.asReadonly();
  readonly votedUserIds: Signal<Set<string>> = this._votedUserIds.asReadonly();
  readonly issueList: Signal<IssueItem[]> = this._issueList.asReadonly();

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
  }

  private subscribeToEvents(): void {
    // Full state sync on reconnect
    this.subscriptions.push(
      this.ws.on<{ state: GameSessionState }>('session:state').subscribe(({ state }) => {
        this._participants.set(state.participants);
        this._history.set(state.history);
        this._isRevealed.set(state.isRevealed);

        // Extract session config from GameSessionState
        if (state.config) {
          this._sessionConfig.set(state.config);
        }

        // Restore issue list from state
        if (state.issueList) {
          this._issueList.set(state.issueList);
        }

        if (state.currentRound) {
          const round = this.deserializeRound(state.currentRound);
          this._currentRound.set(round);
          this._selections.set(round.selections);
        } else {
          this._currentRound.set(null);
          this._selections.set(new Map());
        }

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
        .on<{ selections: Record<string, CardValue>; metrics: VotingMetrics }>('cards:revealed')
        .subscribe(({ selections, metrics }) => {
          const selectionsMap = new Map<string, CardValue>(Object.entries(selections));
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
        this._history.set([historyEntry, ...this._history()]);
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
    return {
      ...round,
      selections:
        round.selections instanceof Map
          ? round.selections
          : new Map<string, CardValue>(Object.entries(round.selections || {})),
    };
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
