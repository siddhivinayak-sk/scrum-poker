import { Injectable, signal, Signal, OnDestroy, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subject, filter, map } from 'rxjs';
import { ConnectionState, WebSocketMessage } from '@shared/types';
import { ToastService, ToastType } from './toast.service';
import { BasePathService } from './base-path.service';
import {
  ConnectionEvent,
  EpisodeEffect,
  EpisodeState,
  initialEpisodeState,
  reduceEpisode,
} from './connection-episode';
import { exceedsFrameLimit } from './frame-guard';

/**
 * Exponential backoff for reconnection attempts: `min(2^n * 1000, 30000)` ms.
 * Re-exported from the pure episode reducer, which now owns the single implementation
 * shared by the poker and retro services (R11.19).
 */
export { calculateBackoff } from './connection-episode';

/**
 * Tag carried by every connection notification, so the reducer's
 * `dismiss-connection-toasts` effect maps onto `ToastService.dismissByTag` (R11.27).
 */
const CONNECTION_TOAST_TAG = 'connection';

/** Untagged, so a later Connection_State change never dismisses it (R23.10). */
const FRAME_TOO_LARGE_MESSAGE = 'This change is too large to send.';

/** Shown once when repeated 1009 closes halt reconnection (R23.12). */
const PAYLOAD_TOO_LARGE_CLOSE_MESSAGE =
  'The connection was closed because a message was too large. Reload the page to reconnect.';

/**
 * One record per socket the service creates (design D13). The handlers capture their
 * record, so `record !== this.current` identifies a Stale_Socket (R25.1).
 */
interface SocketRecord {
  readonly socket: WebSocket;
  /** The socket fired `close`. */
  closeEmitted: boolean;
  /** The service called `socket.close()`. */
  closeCalled: boolean;
}

/**
 * Close codes the poker socket reports with their own cause and no reconnection
 * (R11.17, R11.18). 4004 is reserved by the retro socket, so it has no entry here.
 */
const CLOSE_CODE_NOTICE: Record<number, { type: ToastType; message: string; route: string }> = {
  4009: {
    type: 'error',
    message: 'This name is already taken in the session. Please choose a different name.',
    route: '/login',
  },
  4010: {
    type: 'warning',
    message: 'You have been removed from the session by the moderator.',
    route: '/lobby',
  },
};

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);

  /** The Current_Socket, or none after `disconnect()` (R25). */
  private current: SocketRecord | null = null;
  private token: string | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;

  /**
   * Every reconnect, notification and navigation decision comes from the pure
   * reducer; this class only owns the socket, the timer and the effect execution.
   */
  private episode: EpisodeState = initialEpisodeState;

  private readonly messages$ = new Subject<WebSocketMessage>();
  private readonly _connectionState = signal<ConnectionState>(initialEpisodeState.connection);

  readonly connectionState: Signal<ConnectionState> = this._connectionState.asReadonly();

  private readonly _generation = signal(0);

  /**
   * Connection_Generation: starts at 0, increases by exactly 1 on each `open` of the
   * Current_Socket and is never reset (R25.7).
   */
  readonly connectionGeneration: Signal<number> = this._generation.asReadonly();

  /**
   * Open a WebSocket connection with the given auth token and optional session ID.
   */
  connect(token: string, sessionId?: string): void {
    this.token = token;
    this.sessionId = sessionId ?? null;
    this.manualDisconnect = false;
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
    if (this.current) {
      // The retired socket's later `close` takes the stale branch, so it cannot
      // dispatch a second `manual-disconnect` (R25.2).
      this.retire(this.current);
      this.current = null;
    }
    // A user-initiated close is a `manual-disconnect`, never a `close`: it ends the
    // episode silently instead of opening one.
    this.dispatch({ kind: 'manual-disconnect' });
  }

  /**
   * Send a message to the server over the Current_Socket.
   *
   * Returns `false` without sending when the Current_Socket is not `OPEN`, when the
   * serialised frame exceeds `WS_MAX_PAYLOAD_BYTES` (R23.10) or when sending throws;
   * returns `true` once the frame was handed to the socket (R23.16, R25.10).
   */
  send(event: string, data: unknown): boolean {
    const socket = this.current?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const message: WebSocketMessage = {
        event,
        data,
        timestamp: new Date().toISOString(),
      };
      const json = JSON.stringify(message);
      if (exceedsFrameLimit(json)) {
        // No tag, so `dismiss-connection-toasts` never removes it; no frame content
        // is logged (R23.10).
        this.toastService.show('error', FRAME_TOO_LARGE_MESSAGE);
        return false;
      }
      socket.send(json);
      return true;
    } catch {
      if (event === 'card:select') {
        this.toastService.show('error', 'Your vote was not recorded. Please try selecting your card again.');
      } else {
        this.toastService.show('error', 'Failed to send message to server. Please try again.');
      }
      return false;
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

      case 'toast-payload-too-large':
        // No navigation: the board stays displayed in its offline state (R23.12).
        this.toastService.show('error', PAYLOAD_TOO_LARGE_CLOSE_MESSAGE, {
          tag: CONNECTION_TOAST_TAG,
        });
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
    this.router.navigate([notice.route]);
  }

  /** Guarded call so a partial `ToastService` implementation is tolerated. */
  private dismissConnectionToasts(): void {
    this.toastService.dismissByTag?.(CONNECTION_TOAST_TAG);
  }

  /**
   * Close a socket at most once, and never one that already fired `close`
   * (R25.1, R25.2).
   */
  private retire(record: SocketRecord): void {
    if (!record.closeEmitted && !record.closeCalled) {
      record.socket.close();
    }
    record.closeCalled = true;
  }

  private openConnection(): void {
    // Retiring before creating keeps at most one live socket at any time (R25.8).
    if (this.current) {
      this.retire(this.current);
    }

    // The socket is CONNECTING from here until `onopen`, which the indicator reads as
    // `reconnecting` (R11.1). The episode's own counters are untouched.
    this._connectionState.set('reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = this.basePath.getBasePath();
    let url = `${protocol}//${window.location.host}${basePath}?token=${this.token}`;
    if (this.sessionId) {
      url += `&sessionId=${this.sessionId}`;
    }

    const record: SocketRecord = {
      socket: new WebSocket(url),
      closeEmitted: false,
      closeCalled: false,
    };
    this.current = record;
    const socket = record.socket;

    socket.onopen = () => {
      if (record !== this.current) {
        // A Stale_Socket that opened late: close it, dispatch nothing (R25.3).
        this.retire(record);
        return;
      }
      this.ngZone.run(() => {
        // Before `open`, so a consumer reacting to `connected` reads the new
        // generation (R25.7).
        this._generation.update((g) => g + 1);
        this.dispatch({ kind: 'open' });
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      if (record !== this.current) {
        // Not parsed, so no `on<T>()` subscriber sees it (R25.4).
        return;
      }
      this.ngZone.run(() => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.messages$.next(message);
        } catch {
          // Ignore malformed messages
        }
      });
    };

    socket.onclose = (event: CloseEvent) => {
      record.closeEmitted = true;
      if (record !== this.current) {
        // No dispatch, no change to the timer, episode or toasts (R25.5).
        return;
      }
      this.ngZone.run(() => {
        // The record stays the Current_Socket: it is closed, so `send()` returns
        // `false` and the next `openConnection()` does not close it again.
        if (this.manualDisconnect) {
          this.dispatch({ kind: 'manual-disconnect' });
          return;
        }
        this.dispatch({ kind: 'close', code: event?.code });
      });
    };

    socket.onerror = () => {
      // Current_Socket: `onclose` fires after `onerror` and handles reconnection.
      // Stale_Socket: nothing to do (R25.5).
    };
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect) {
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
