import { Injectable, signal, computed, inject, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { FeelingCategory, RetroSessionState } from '@shared/types';
import { RetroWebSocketService } from './retro-websocket.service';
import { RetroStateService } from './retro-state.service';

@Injectable({ providedIn: 'root' })
export class FeelingsService implements OnDestroy {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly subscriptions: Subscription[] = [];

  /** Full feelings map: userId -> selected feeling category or null */
  private readonly _feelings = signal<Record<string, FeelingCategory | null>>({});

  /** Public readonly signal of all participants' feelings */
  readonly feelings = this._feelings.asReadonly();

  /** Computed signal for the current user's feeling */
  readonly myFeeling = computed<FeelingCategory | null>(() => {
    const userId = this.retroState.currentUserId();
    if (!userId) return null;
    const map = this._feelings();
    return map[userId] ?? null;
  });

  constructor() {
    this.subscribeToEvents();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  /**
   * Select or deselect a feeling category.
   * If the user clicks the same feeling they currently have, pass null to deselect (toggle).
   * Only updates local state if the WebSocket is connected (send succeeds).
   */
  selectFeeling(category: FeelingCategory | null): void {
    if (this.ws.connectionState() !== 'connected') {
      return;
    }
    this.ws.send('retro:feeling:select', { category });
  }

  /**
   * Reset feelings state (e.g., on disconnect or session leave).
   */
  reset(): void {
    this._feelings.set({});
  }

  private subscribeToEvents(): void {
    // Initialize feelings from full session state on join/reconnect
    this.subscriptions.push(
      this.ws.on<{ state: RetroSessionState }>('retro:session:state').subscribe(({ state }) => {
        const feelings = state.feelings ?? {};
        this._feelings.set(feelings);
      })
    );

    // Update feelings on individual feeling updates broadcast by the server
    this.subscriptions.push(
      this.ws
        .on<{ userId: string; category: FeelingCategory | null }>('retro:feeling:updated')
        .subscribe(({ userId, category }) => {
          this._feelings.update((current) => {
            if (category === null) {
              // Remove the entry or set to null
              const updated = { ...current };
              delete updated[userId];
              return updated;
            }
            return { ...current, [userId]: category };
          });
        })
    );
  }
}
