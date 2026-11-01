import { Injectable, InjectionToken, Signal, computed, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  BoardKind,
  CHAT_EVENTS,
  ChatMessageSendPayload,
  ConnectionState,
  User,
} from '@shared/types';
import { AuthService } from './auth.service';
import { RetroStateService } from './retro-state.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';

/**
 * The chat's view of one board's connection (R1.1, R1.2, R15.6).
 *
 * An adapter only re-exposes signals and `on<T>()` streams that the board's
 * WebSocket and state services already own (R10.5, R20.5). It holds no state of
 * its own and adds no presence event: presence is derived from the board's
 * participant list (R10.4). Incoming payloads are typed `unknown` and are
 * validated by the chat reducer (R19.5).
 */
export interface ChatTransport {
  readonly boardKind: BoardKind;
  readonly connectionState: Signal<ConnectionState>;
  readonly connectionGeneration: Signal<number>;
  readonly participants: Signal<readonly User[]>;
  readonly currentUserId: Signal<string | null>;
  /** `ws.on(CHAT_EVENTS[kind].added)` */
  readonly added$: Observable<unknown>;
  /** `ws.on(CHAT_EVENTS[kind].history)` */
  readonly history$: Observable<unknown>;
  /** `ws.on(CHAT_EVENTS[kind].rejected)` */
  readonly rejected$: Observable<unknown>;
  /** Sends `CHAT_EVENTS[kind].send`; `false` when the frame was not handed to the socket. */
  send(payload: ChatMessageSendPayload): boolean;
}

export const CHAT_TRANSPORT = new InjectionToken<ChatTransport>('CHAT_TRANSPORT');

/** Chat transport over the poker board's `WebSocketService`. */
@Injectable({ providedIn: 'root' })
export class PokerChatTransport implements ChatTransport {
  private readonly ws = inject(WebSocketService);
  private readonly sessionState = inject(SessionStateService);
  private readonly currentUser = inject(AuthService).getCurrentUser();
  private readonly events = CHAT_EVENTS.poker;

  readonly boardKind: BoardKind = 'poker';
  readonly connectionState: Signal<ConnectionState> = this.ws.connectionState;
  readonly connectionGeneration: Signal<number> = this.ws.connectionGeneration;
  readonly participants: Signal<readonly User[]> = this.sessionState.participants;
  readonly currentUserId: Signal<string | null> = computed(() => this.currentUser()?.id ?? null);
  readonly added$: Observable<unknown> = this.ws.on<unknown>(this.events.added);
  readonly history$: Observable<unknown> = this.ws.on<unknown>(this.events.history);
  readonly rejected$: Observable<unknown> = this.ws.on<unknown>(this.events.rejected);

  send(payload: ChatMessageSendPayload): boolean {
    return this.ws.send(this.events.send, payload);
  }
}

/** Chat transport over the retro board's `RetroWebSocketService`. */
@Injectable({ providedIn: 'root' })
export class RetroChatTransport implements ChatTransport {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly events = CHAT_EVENTS.retro;

  readonly boardKind: BoardKind = 'retro';
  readonly connectionState: Signal<ConnectionState> = this.ws.connectionState;
  readonly connectionGeneration: Signal<number> = this.ws.connectionGeneration;
  readonly participants: Signal<readonly User[]> = this.retroState.participants;
  readonly currentUserId: Signal<string | null> = this.retroState.currentUserId;
  readonly added$: Observable<unknown> = this.ws.on<unknown>(this.events.added);
  readonly history$: Observable<unknown> = this.ws.on<unknown>(this.events.history);
  readonly rejected$: Observable<unknown> = this.ws.on<unknown>(this.events.rejected);

  send(payload: ChatMessageSendPayload): boolean {
    return this.ws.send(this.events.send, payload);
  }
}
