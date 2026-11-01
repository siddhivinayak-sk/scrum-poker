import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, filter, map } from 'rxjs';
import { CHAT_EVENTS, ConnectionState, User } from '@shared/types';
import { AuthService } from './auth.service';
import { PokerChatTransport, RetroChatTransport } from './chat-transport';
import { RetroStateService } from './retro-state.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';

/** Stands in for a board WebSocket service at the socket boundary. */
class SocketStub {
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly sent: { event: string; data: unknown }[] = [];
  accept = true;
  private readonly incoming = new Subject<{ event: string; data: unknown }>();

  send(event: string, data: unknown): boolean {
    this.sent.push({ event, data });
    return this.accept;
  }

  on<T>(event: string): Observable<T> {
    return this.incoming.pipe(
      filter((m) => m.event === event),
      map((m) => m.data as T)
    );
  }

  emit(event: string, data: unknown): void {
    this.incoming.next({ event, data });
  }
}

const alice: User = { id: 'u1', displayName: 'Alice', role: 'moderator', isAnonymous: false };
const bob: User = { id: 'u2', displayName: 'Bob', role: 'participant', isAnonymous: false };

describe('PokerChatTransport', () => {
  let ws: SocketStub;
  const participants = signal<User[]>([alice]);
  const authUser = signal<User | null>(null);

  beforeEach(() => {
    ws = new SocketStub();
    participants.set([alice]);
    authUser.set(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: WebSocketService, useValue: ws },
        { provide: SessionStateService, useValue: { participants: participants.asReadonly() } },
        { provide: AuthService, useValue: { getCurrentUser: () => authUser.asReadonly() } },
      ],
    });
  });

  it('re-exposes the poker connection signals, participants and current user id', () => {
    const t = TestBed.inject(PokerChatTransport);
    expect(t.boardKind).toBe('poker');
    expect(t.connectionState()).toBe('connected');
    expect(t.connectionGeneration()).toBe(1);
    expect(t.currentUserId()).toBeNull();

    ws.connectionState.set('reconnecting');
    ws.connectionGeneration.set(2);
    participants.set([alice, bob]);
    authUser.set(bob);

    expect(t.connectionState()).toBe('reconnecting');
    expect(t.connectionGeneration()).toBe(2);
    expect(t.participants()).toEqual([alice, bob]);
    expect(t.currentUserId()).toBe('u2');
  });

  it('routes the poker chat events and returns the send result', () => {
    const t = TestBed.inject(PokerChatTransport);
    const added: unknown[] = [];
    const history: unknown[] = [];
    const rejected: unknown[] = [];
    t.added$.subscribe((p) => added.push(p));
    t.history$.subscribe((p) => history.push(p));
    t.rejected$.subscribe((p) => rejected.push(p));

    ws.emit(CHAT_EVENTS.poker.added, { a: 1 });
    ws.emit(CHAT_EVENTS.poker.history, { h: 1 });
    ws.emit(CHAT_EVENTS.poker.rejected, { r: 1 });
    ws.emit(CHAT_EVENTS.retro.added, { wrong: true });

    expect(added).toEqual([{ a: 1 }]);
    expect(history).toEqual([{ h: 1 }]);
    expect(rejected).toEqual([{ r: 1 }]);

    const payload = { sessionId: 's1', clientMessageId: 'c1', text: 'hi' };
    expect(t.send(payload)).toBe(true);
    ws.accept = false;
    expect(t.send(payload)).toBe(false);
    expect(ws.sent).toEqual([
      { event: CHAT_EVENTS.poker.send, data: payload },
      { event: CHAT_EVENTS.poker.send, data: payload },
    ]);
  });
});

describe('RetroChatTransport', () => {
  let ws: SocketStub;
  const participants = signal<User[]>([]);
  const currentUserId = signal<string | null>(null);

  beforeEach(() => {
    ws = new SocketStub();
    participants.set([]);
    currentUserId.set(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: RetroWebSocketService, useValue: ws },
        {
          provide: RetroStateService,
          useValue: {
            participants: participants.asReadonly(),
            currentUserId: currentUserId.asReadonly(),
          },
        },
      ],
    });
  });

  it('re-exposes the retro state and routes only the retro chat events', () => {
    const t = TestBed.inject(RetroChatTransport);
    expect(t.boardKind).toBe('retro');

    participants.set([bob]);
    currentUserId.set('u2');
    expect(t.participants()).toEqual([bob]);
    expect(t.currentUserId()).toBe('u2');

    const added: unknown[] = [];
    t.added$.subscribe((p) => added.push(p));
    ws.emit(CHAT_EVENTS.poker.added, { wrong: true });
    ws.emit(CHAT_EVENTS.retro.added, { ok: true });
    expect(added).toEqual([{ ok: true }]);

    const payload = { sessionId: 'r1', clientMessageId: 'c1', text: 'hi' };
    expect(t.send(payload)).toBe(true);
    expect(ws.sent).toEqual([{ event: CHAT_EVENTS.retro.send, data: payload }]);
  });
});
