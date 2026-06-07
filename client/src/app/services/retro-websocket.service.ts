import { Injectable, signal, Signal, OnDestroy, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subject, filter, map } from 'rxjs';
import { WebSocketMessage, RetroConfiguration } from '@shared/types';
import { ToastService } from './toast.service';
import { BasePathService } from './base-path.service';

/**
 * Calculate exponential backoff delay for reconnection attempts.
 * delay = min(2^n * 1000, 30000) ms
 */
export function calculateRetroBackoff(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 1000, 30000);
}

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

@Injectable({ providedIn: 'root' })
export class RetroWebSocketService implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);

  private ws: WebSocket | null = null;
  private token: string | null = null;
  private sessionId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;

  private readonly messages$ = new Subject<WebSocketMessage>();
  private readonly _connectionState = signal<ConnectionState>('disconnected');

  readonly connectionState: Signal<ConnectionState> = this._connectionState.asReadonly();

  /**
   * Open a WebSocket connection to a retro session.
   */
  connect(sessionId: string, token: string): void {
    this.token = token;
    this.sessionId = sessionId;
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.openConnection();
  }

  /**
   * Close the WebSocket connection and stop reconnection attempts.
   */
  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connectionState.set('disconnected');
  }

  /**
   * Send a message to the server.
   */
  send(event: string, data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const message: WebSocketMessage = {
          event,
          data,
          timestamp: new Date().toISOString(),
        };
        this.ws.send(JSON.stringify(message));
      } catch {
        this.toastService.show('error', 'Failed to send message to server. Please try again.');
      }
    }
  }

  /**
   * Subscribe to messages of a specific event type.
   * Returns an Observable that emits the data payload for matching events.
   */
  on<T>(event: string): Observable<T> {
    return this.messages$.pipe(
      filter((msg) => msg.event === event),
      map((msg) => msg.data as T)
    );
  }

  // --- Client → Server event methods ---

  sendCardAdd(columnId: string, text: string): void {
    this.send('retro:card:add', { columnId, text });
  }

  sendCardEdit(cardId: string, text: string): void {
    this.send('retro:card:edit', { cardId, text });
  }

  sendCardRemove(cardId: string): void {
    this.send('retro:card:remove', { cardId });
  }

  sendCardMove(cardId: string, targetColumnId: string, targetIndex: number): void {
    this.send('retro:card:move', { cardId, targetColumnId, targetIndex });
  }

  sendCardVote(cardId: string): void {
    this.send('retro:card:vote', { cardId });
  }

  sendCardUnvote(cardId: string): void {
    this.send('retro:card:unvote', { cardId });
  }

  sendCommentAdd(cardId: string, text: string): void {
    this.send('retro:comment:add', { cardId, text });
  }

  sendCommentRemove(cardId: string, commentId: string): void {
    this.send('retro:comment:remove', { cardId, commentId });
  }

  sendColumnAdd(name: string): void {
    this.send('retro:column:add', { name });
  }

  sendColumnRemove(columnId: string): void {
    this.send('retro:column:remove', { columnId });
  }

  sendColumnReorder(orderedIds: string[]): void {
    this.send('retro:column:reorder', { orderedIds });
  }

  sendColumnRename(columnId: string, name: string): void {
    this.send('retro:column:rename', { columnId, name });
  }

  sendContextUpdate(text: string): void {
    this.send('retro:context:update', { text });
  }

  sendCardsReveal(): void {
    this.send('retro:cards:reveal', {});
  }

  sendVotingEnable(): void {
    this.send('retro:voting:enable', {});
  }

  sendBoardComplete(): void {
    this.send('retro:board:complete', {});
  }

  sendCardMerge(sourceCardId: string, targetCardId: string): void {
    this.send('retro:card:merge', { sourceCardId, targetCardId });
  }

  sendConfigUpdate(config: Partial<RetroConfiguration>): void {
    this.send('retro:config:update', { config });
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.messages$.complete();
  }

  private openConnection(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = this.basePath.getBasePath();
    const url = `${protocol}//${window.location.host}${basePath}/retro?token=${this.token}&sessionId=${this.sessionId}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.ngZone.run(() => {
        this.reconnectAttempt = 0;
        this._connectionState.set('connected');
      });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.ngZone.run(() => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.messages$.next(message);
        } catch {
          // Ignore malformed messages
        }
      });
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ngZone.run(() => {
        this.ws = null;

        // Handle duplicate display name rejection (code 4009)
        if (event.code === 4009) {
          this.manualDisconnect = true;
          this._connectionState.set('disconnected');
          this.toastService.show('error', 'This name is already taken in the session. Please choose a different name.');
          this.router.navigate([`/retro/${this.sessionId}/login`]);
          return;
        }

        // Handle session not found (code 4004)
        if (event.code === 4004) {
          this.manualDisconnect = true;
          this._connectionState.set('disconnected');
          this.toastService.show('error', 'Retrospective session not found.');
          this.router.navigate(['/lobby']);
          return;
        }

        if (!this.manualDisconnect) {
          this._connectionState.set('reconnecting');
          this.toastService.show('error', 'Connection lost. Attempting to reconnect...');
          this.scheduleReconnect();
        } else {
          this._connectionState.set('disconnected');
        }
      });
    };

    this.ws.onerror = () => {
      // The onclose handler will fire after onerror, so reconnection is handled there.
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    // After 10 failed attempts, give up and redirect to login
    if (this.reconnectAttempt >= 10) {
      this.manualDisconnect = true;
      this._connectionState.set('disconnected');
      this.toastService.show('error', 'Unable to connect after 10 attempts. Redirecting to login.');
      this.router.navigate(['/login']);
      return;
    }

    const delay = calculateRetroBackoff(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.manualDisconnect) {
        this.toastService.show('warning', `Reconnecting... (attempt ${this.reconnectAttempt})`);
        this.openConnection();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
