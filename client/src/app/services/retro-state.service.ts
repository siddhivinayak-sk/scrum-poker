import { Injectable, signal, Signal, inject, OnDestroy, computed } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  RetroSessionState,
  RetroColumn,
  RetroCard,
  RetroComment,
  RetroConfiguration,
  User,
} from '@shared/types';
import { RetroWebSocketService } from './retro-websocket.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class RetroStateService implements OnDestroy {
  private readonly ws = inject(RetroWebSocketService);
  private readonly auth = inject(AuthService);
  private readonly subscriptions: Subscription[] = [];

  private readonly _state = signal<RetroSessionState | null>(null);
  private readonly _currentUserId = signal<string | null>(null);

  /** Full session state signal */
  readonly state: Signal<RetroSessionState | null> = this._state.asReadonly();

  /** Current user's ID */
  readonly currentUserId: Signal<string | null> = this._currentUserId.asReadonly();

  /** Board columns */
  readonly columns = computed<RetroColumn[]>(() => {
    const state = this._state();
    return state?.board.columns ?? [];
  });

  /** Current user's remaining votes */
  readonly votesRemaining = computed<number>(() => {
    const state = this._state();
    const userId = this._currentUserId();
    if (!state || !userId) return 0;
    return state.votesRemaining[userId] ?? 0;
  });

  /** Whether current user is the moderator (owner or has moderator role) */
  readonly isModerator = computed<boolean>(() => {
    const state = this._state();
    const userId = this._currentUserId();
    if (!state || !userId) return false;
    // Check if user is the owner OR has moderator role in participants
    if (state.ownerId === userId) return true;
    const participant = state.participants.find(p => p.id === userId);
    return participant?.role === 'moderator';
  });

  /** Whether the board is completed */
  readonly isCompleted = computed<boolean>(() => {
    const state = this._state();
    return state?.board.isCompleted ?? false;
  });

  /** Current board configuration */
  readonly config = computed<RetroConfiguration | null>(() => {
    const state = this._state();
    return state?.config ?? null;
  });

  /** Board context text */
  readonly context = computed<string>(() => {
    const state = this._state();
    return state?.board.context ?? '';
  });

  /** Participant list */
  readonly participants = computed<User[]>(() => {
    const state = this._state();
    return state?.participants ?? [];
  });

  /** Whether cards have been revealed */
  readonly cardsRevealed = computed<boolean>(() => {
    const state = this._state();
    return state?.board.cardsRevealed ?? false;
  });

  /** Whether voting is enabled */
  readonly votingEnabled = computed<boolean>(() => {
    const state = this._state();
    return state?.board.votingEnabled ?? false;
  });

  constructor() {
    this.subscribeToEvents();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  /**
   * Get cards for a specific column.
   */
  cardsByColumn(columnId: string): RetroCard[] {
    const state = this._state();
    if (!state) return [];
    const column = state.board.columns.find((c) => c.id === columnId);
    return column?.cards ?? [];
  }

  /**
   * Reset all state to initial values.
   */
  reset(): void {
    this._state.set(null);
    this._currentUserId.set(null);
  }

  private subscribeToEvents(): void {
    // Full state sync on connect/reconnect
    this.subscriptions.push(
      this.ws.on<{ state: RetroSessionState }>('retro:session:state').subscribe(({ state }) => {
        this._state.set(state);
        this.syncCurrentUserId();
      })
    );

    // Card added
    this.subscriptions.push(
      this.ws.on<{ card: RetroCard; columnId: string }>('retro:card:added').subscribe(({ card, columnId }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: state.board.columns.map((col) =>
              col.id === columnId ? { ...col, cards: [...col.cards, card] } : col
            ),
          },
        }));
      })
    );

    // Card edited
    this.subscriptions.push(
      this.ws.on<{ cardId: string; text: string }>('retro:card:edited').subscribe(({ cardId, text }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: state.board.columns.map((col) => ({
              ...col,
              cards: col.cards.map((card) => (card.id === cardId ? { ...card, text } : card)),
            })),
          },
        }));
      })
    );

    // Card removed
    this.subscriptions.push(
      this.ws.on<{ cardId: string; columnId?: string }>('retro:card:removed').subscribe(({ cardId }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: state.board.columns.map((col) => ({
              ...col,
              cards: col.cards.filter((card) => card.id !== cardId),
            })),
          },
        }));
      })
    );

    // Card moved
    this.subscriptions.push(
      this.ws
        .on<{ cardId: string; fromColumnId: string; toColumnId: string; targetIndex: number }>(
          'retro:card:moved'
        )
        .subscribe(({ cardId, fromColumnId, toColumnId, targetIndex }) => {
          this.updateState((state) => {
            // Find the card in the source column
            const sourceCol = state.board.columns.find((c) => c.id === fromColumnId);
            const card = sourceCol?.cards.find((c) => c.id === cardId);
            if (!card) return state;

            const movedCard = { ...card, columnId: toColumnId };

            return {
              ...state,
              board: {
                ...state.board,
                columns: state.board.columns.map((col) => {
                  if (col.id === fromColumnId) {
                    return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
                  }
                  if (col.id === toColumnId) {
                    const newCards = [...col.cards];
                    newCards.splice(targetIndex, 0, movedCard);
                    return { ...col, cards: newCards };
                  }
                  return col;
                }),
              },
            };
          });
        })
    );

    // Card voted
    this.subscriptions.push(
      this.ws
        .on<{ cardId: string; votes: number; votedBy: string[]; votesRemaining: Record<string, number> }>(
          'retro:card:voted'
        )
        .subscribe(({ cardId, votes, votedBy, votesRemaining }) => {
          this.updateState((state) => ({
            ...state,
            votesRemaining: { ...state.votesRemaining, ...votesRemaining },
            board: {
              ...state.board,
              columns: state.board.columns.map((col) => ({
                ...col,
                cards: col.cards.map((card) =>
                  card.id === cardId ? { ...card, votes, votedBy } : card
                ),
              })),
            },
          }));
        })
    );

    // Comment added
    this.subscriptions.push(
      this.ws
        .on<{ cardId: string; comment: RetroComment }>('retro:comment:added')
        .subscribe(({ cardId, comment }) => {
          this.updateState((state) => ({
            ...state,
            board: {
              ...state.board,
              columns: state.board.columns.map((col) => ({
                ...col,
                cards: col.cards.map((card) =>
                  card.id === cardId ? { ...card, comments: [...card.comments, comment] } : card
                ),
              })),
            },
          }));
        })
    );

    // Comment removed
    this.subscriptions.push(
      this.ws
        .on<{ cardId: string; commentId: string }>('retro:comment:removed')
        .subscribe(({ cardId, commentId }) => {
          this.updateState((state) => ({
            ...state,
            board: {
              ...state.board,
              columns: state.board.columns.map((col) => ({
                ...col,
                cards: col.cards.map((card) =>
                  card.id === cardId
                    ? { ...card, comments: card.comments.filter((c) => c.id !== commentId) }
                    : card
                ),
              })),
            },
          }));
        })
    );

    // Column added
    this.subscriptions.push(
      this.ws.on<{ column: RetroColumn }>('retro:column:added').subscribe(({ column }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: [...state.board.columns, column],
          },
        }));
      })
    );

    // Column removed
    this.subscriptions.push(
      this.ws.on<{ columnId: string }>('retro:column:removed').subscribe(({ columnId }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: state.board.columns.filter((col) => col.id !== columnId),
          },
        }));
      })
    );

    // Column reordered
    this.subscriptions.push(
      this.ws.on<{ orderedIds: string[] }>('retro:column:reordered').subscribe(({ orderedIds }) => {
        this.updateState((state) => {
          const columnMap = new Map(state.board.columns.map((col) => [col.id, col]));
          const reordered = orderedIds
            .map((id, index) => {
              const col = columnMap.get(id);
              return col ? { ...col, order: index } : null;
            })
            .filter((col): col is RetroColumn => col !== null);

          return {
            ...state,
            board: {
              ...state.board,
              columns: reordered,
            },
          };
        });
      })
    );

    // Column renamed
    this.subscriptions.push(
      this.ws.on<{ columnId: string; name: string }>('retro:column:renamed').subscribe(({ columnId, name }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            columns: state.board.columns.map((col) =>
              col.id === columnId ? { ...col, name } : col
            ),
          },
        }));
      })
    );

    // Context updated
    this.subscriptions.push(
      this.ws.on<{ text: string }>('retro:context:updated').subscribe(({ text }) => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            context: text,
          },
        }));
      })
    );

    // Cards revealed
    this.subscriptions.push(
      this.ws.on<Record<string, never>>('retro:cards:revealed').subscribe(() => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            cardsRevealed: true,
          },
        }));
      })
    );

    // Voting enabled
    this.subscriptions.push(
      this.ws.on<Record<string, never>>('retro:voting:enabled').subscribe(() => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            votingEnabled: true,
          },
        }));
      })
    );

    // Board completed
    this.subscriptions.push(
      this.ws.on<Record<string, never>>('retro:board:completed').subscribe(() => {
        this.updateState((state) => ({
          ...state,
          board: {
            ...state.board,
            isCompleted: true,
          },
        }));
      })
    );

    // Config updated
    this.subscriptions.push(
      this.ws.on<{ config: RetroConfiguration }>('retro:config:updated').subscribe(({ config }) => {
        this.updateState((state) => ({
          ...state,
          config,
        }));
      })
    );

    // Participant joined
    this.subscriptions.push(
      this.ws.on<{ participants: User[] }>('retro:participant:joined').subscribe(({ participants }) => {
        this.updateState((state) => ({
          ...state,
          participants,
        }));
      })
    );

    // Participant left
    this.subscriptions.push(
      this.ws.on<{ participants: User[] }>('retro:participant:left').subscribe(({ participants }) => {
        this.updateState((state) => ({
          ...state,
          participants,
        }));
      })
    );
  }

  /**
   * Helper to update state immutably. Only applies if state is non-null.
   */
  private updateState(updater: (state: RetroSessionState) => RetroSessionState): void {
    const current = this._state();
    if (!current) return;
    this._state.set(updater(current));
  }

  /**
   * Sync the current user ID from the auth service.
   */
  private syncCurrentUserId(): void {
    const authUser = this.auth.getCurrentUser()();
    if (authUser) {
      this._currentUserId.set(authUser.id);
    }
  }
}
