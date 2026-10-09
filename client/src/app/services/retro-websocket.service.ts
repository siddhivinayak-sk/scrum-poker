import { Injectable, signal, Signal, OnDestroy, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subject, filter, map } from 'rxjs';
import {
  ConnectionState,
  WebSocketMessage,
  RetroConfiguration,
  RETRO_SESSION_ENDED,
  RetroSessionEndedPayload,
} from '@shared/types';
import { ToastService, ToastType } from './toast.service';
import { BasePathService } from './base-path.service';
import {
  ConnectionEvent,
  EpisodeEffect,
  EpisodeState,
  initialEpisodeState,
  reduceEpisode,
} from './connection-episode';

/**
 * Calculate exponential backoff delay for reconnection attempts.
 * delay = min(2^n * 1000, 30000) ms
 *
 * Re-exported from the pure episode reducer, which owns the single implementation
 * the poker and retro services share. The retro name is kept so every existing
 * call site and test is unaffected (R11.19).
 */
export { calculateBackoff as calculateRetroBackoff } from './connection-episode';

/**
 * Tag carried by every connection notification, so the reducer's
 * `dismiss-connection-toasts` effect maps onto `ToastService.dismissByTag` (R11.27).
 */
const CONNECTION_TOAST_TAG = 'connection';

/**
 * Close codes the retro socket reports with their own cause and no reconnection
 * (R11.17, R11.18). 4004 — the retrospective session no longer exists — is the
 * retro socket's own reserved code; 4009 is the duplicate display name, which
 * sends the participant back to this session's login. 4010 is reserved by the
 * poker socket, so it has no entry here and ends the episode silently.
 */
const CLOSE_CODE_NOTICE: Record<
  number,
  { type: ToastType; message: string; route: (sessionId: string | null) => string }
> = {
  4009: {
    type: 'error',
    message: 'This name is already taken in the session. Please choose a different name.',
    route: (sessionId) => `/retro/${sessionId}/login`,
  },
  4004: {
    type: 'error',
    message: 'Retrospective session not found.',
    route: () => '/lobby',
  },
};

@Injectable({ providedIn: 'root' })
export class RetroWebSocketService implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);

  private ws: WebSocket | null = null;
  private token: string | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  /**
   * Set once `retro:session:ended` has arrived for the current connection. The
   * server broadcasts the event and then closes the socket (code 1000), and may
   * answer a message that raced the removal with `retro:error` NOT_FOUND
   * followed by a 4004 close. Either close must stay silent here so the board
   * page's single notification is the only one the participant sees
   * (R9.12, R11.17, R11.18).
   */
  private sessionEnded = false;

  /**
   * Every reconnect, notification and navigation decision comes from the pure
   * reducer shared with the poker service; this class only owns the retro socket,
   * its timer and the effect execution. The two services share the rule set and
   * no state, so neither imports the other (R13.9).
   */
  private episode: EpisodeState = initialEpisodeState;

  private readonly messages$ = new Subject<WebSocketMessage>();
  private readonly _connectionState = signal<ConnectionState>(initialEpisodeState.connection);

  readonly connectionState: Signal<ConnectionState> = this._connectionState.asReadonly();

  constructor() {
    // Subscribed internally, independently of any page subscription, so the
    // transport stops reconnecting as soon as the session is gone.
    this.on<RetroSessionEndedPayload>(RETRO_SESSION_ENDED).subscribe(() =>
      this.handleSessionEnded()
    );
  }

  /**
   * Open a WebSocket connection to a retro session.
   */
  connect(sessionId: string, token: string): void {
    this.token = token;
    this.sessionId = sessionId;
    this.manualDisconnect = false;
    this.sessionEnded = false;
    this.clearReconnectTimer();
    this.episode = initialEpisodeState;
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
    // A user-initiated close is a `manual-disconnect`, never a `close`: it ends the
    // episode silently instead of opening one.
    this.dispatch({ kind: 'manual-disconnect' });
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

  /** Reduce one connection event, publish the new state and run the returned effects. */
  private dispatch(event: ConnectionEvent): void {
    const { state, effects } = reduceEpisode(this.episode, event);
    this.episode = state;
    this._connectionState.set(state.connection);
    for (const effect of effects) {
      this.runEffect(effect);
    }
  }

  private runEffect(effect: EpisodeEffect): void {
    switch (effect.kind) {
      case 'schedule-reconnect':
        this.scheduleReconnect(effect.delayMs);
        break;

      case 'dismiss-connection-toasts':
        this.dismissConnectionToasts();
        break;

      case 'toast-give-up':
        this.toastService.show('error', 'Unable to connect after 10 attempts. Redirecting to login.', {
          tag: CONNECTION_TOAST_TAG,
        });
        break;

      case 'navigate-login':
        this.router.navigate(['/login']);
        break;

      case 'toast-close-code':
        this.notifyCloseCode(effect.code);
        break;
    }
  }

  /**
   * A reserved close code carries its own cause: report it once, go where that cause
   * belongs and never retry.
   */
  private notifyCloseCode(code: number): void {
    this.manualDisconnect = true;
    const notice = CLOSE_CODE_NOTICE[code];
    if (!notice) {
      return;
    }
    this.toastService.show(notice.type, notice.message, { tag: CONNECTION_TOAST_TAG });
    this.router.navigate([notice.route(this.sessionId)]);
  }

  /** Guarded call so a partial `ToastService` implementation is tolerated. */
  private dismissConnectionToasts(): void {
    this.toastService.dismissByTag?.(CONNECTION_TOAST_TAG);
  }

  private openConnection(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // The socket is CONNECTING from here until `onopen`, which the indicator reads as
    // `reconnecting` (R11.2). The episode's own counters are untouched.
    this._connectionState.set('reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = this.basePath.getBasePath();
    const url = `${protocol}//${window.location.host}${basePath}/retro?token=${this.token}&sessionId=${this.sessionId}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.ngZone.run(() => {
        this.dispatch({ kind: 'open' });
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
      this.ngZone.run(() => this.handleClose(event));
    };

    this.ws.onerror = () => {
      // The onclose handler will fire after onerror, so reconnection is handled there.
    };
  }

  /**
   * The single place where a socket closure turns into a connection decision.
   * Every outcome is the reducer's: this method only chooses which event the
   * closure is.
   */
  private handleClose(event: CloseEvent): void {
    this.ws = null;

    // The moderator ended the session: the 1000 close that follows the
    // broadcast, and a 4004 close answering a message that raced the removal,
    // are both expected. Reporting them as a manual disconnect ends the episode
    // with no reconnect, no notification and no navigation — the board page
    // already showed the only one (R9.12, R11.17, R11.18).
    if (this.sessionEnded || this.manualDisconnect) {
      this.dispatch({ kind: 'manual-disconnect' });
      return;
    }

    // Reserved codes (4009 duplicate name, 4004 missing session) end the episode
    // with exactly one notification; anything else opens a reconnect episode with
    // none (R11.14, R11.18).
    this.dispatch({ kind: 'close', code: event?.code });
  }

  /**
   * `retro:session:ended` arrived: the session is gone, so stop the transport
   * before the server's close lands. The user-visible part (one notification
   * and the navigation to the lobby) belongs to `RetroBoardPageComponent`,
   * which subscribes to the same event (R9.12).
   */
  private handleSessionEnded(): void {
    this.sessionEnded = true;
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.dispatch({ kind: 'manual-disconnect' });
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || this.sessionEnded) {
          return;
        }

        // The attempt is counted first: the reducer decides whether this is the
        // attempt that reaches the give-up threshold (R11.16, R11.23, R11.24).
        this.dispatch({ kind: 'attempt' });
        if (this.episode.gaveUp) {
          this.manualDisconnect = true;
          return;
        }

        this.openConnection();
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
