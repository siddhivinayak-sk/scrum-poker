import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetroWebSocketService, calculateRetroBackoff } from './retro-websocket.service';
import { ToastService } from './toast.service';

/**
 * Minimal mock for the browser WebSocket API.
 */
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code?: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  }

  simulateError(): void {
    this.onerror?.({});
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

const mockToastService = {
  show: vi.fn(),
  dismiss: vi.fn(),
};

describe('RetroWebSocketService', () => {
  let service: RetroWebSocketService;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
    mockToastService.show.mockClear();
    mockToastService.dismiss.mockClear();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;

    TestBed.configureTestingModule({
      providers: [{ provide: ToastService, useValue: mockToastService }],
    });
    service = TestBed.inject(RetroWebSocketService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    (globalThis as any).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  function getLatestMockWs(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  describe('calculateRetroBackoff', () => {
    it('should return 1000ms for attempt 0', () => {
      expect(calculateRetroBackoff(0)).toBe(1000);
    });

    it('should return 2000ms for attempt 1', () => {
      expect(calculateRetroBackoff(1)).toBe(2000);
    });

    it('should cap at 30000ms', () => {
      expect(calculateRetroBackoff(15)).toBe(30000);
      expect(calculateRetroBackoff(20)).toBe(30000);
    });
  });

  describe('connect', () => {
    it('should create a WebSocket connection with the correct URL including /retro path', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      expect(ws).toBeDefined();
      expect(ws.url).toContain('/retro?');
      expect(ws.url).toContain('token=test-token');
      expect(ws.url).toContain('sessionId=session-123');
    });

    it('should set connectionState to connected on open', () => {
      expect(service.connectionState()).toBe('disconnected');
      service.connect('session-123', 'test-token');
      getLatestMockWs().simulateOpen();
      expect(service.connectionState()).toBe('connected');
    });

    it('should use ws:// for http pages and wss:// for https pages', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      expect(ws.url).toMatch(/^wss?:\/\//);
    });
  });

  describe('disconnect', () => {
    it('should close the WebSocket and set state to disconnected', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();
      expect(service.connectionState()).toBe('connected');

      service.disconnect();
      expect(service.connectionState()).toBe('disconnected');
    });

    it('should not attempt to reconnect after manual disconnect', () => {
      vi.useFakeTimers();
      try {
        service.connect('session-123', 'test-token');
        const ws = getLatestMockWs();
        ws.simulateOpen();

        service.disconnect();
        ws.simulateClose();

        vi.advanceTimersByTime(5000);
        expect(service.connectionState()).toBe('disconnected');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('send', () => {
    it('should send a JSON message with event, data, and timestamp', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      service.send('retro:card:add', { columnId: 'col-1', text: 'test card' });

      expect(ws.sentMessages.length).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.event).toBe('retro:card:add');
      expect(sent.data).toEqual({ columnId: 'col-1', text: 'test card' });
      expect(sent.timestamp).toBeDefined();
    });

    it('should not send when WebSocket is not open', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.readyState = MockWebSocket.CLOSED;

      service.send('retro:card:add', { columnId: 'col-1', text: 'test' });
      expect(ws.sentMessages.length).toBe(0);
    });

    it('should show error toast when send throws', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.send = () => {
        throw new Error('send failed');
      };

      service.send('retro:card:add', { columnId: 'col-1', text: 'test' });

      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Failed to send message to server. Please try again.'
      );
    });
  });

  describe('on', () => {
    it('should emit data for matching events', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const received: any[] = [];
      service.on<{ cardId: string }>('retro:card:added').subscribe((data) => received.push(data));

      ws.simulateMessage({ event: 'retro:card:added', data: { cardId: 'c1' }, timestamp: new Date().toISOString() });

      expect(received.length).toBe(1);
      expect(received[0]).toEqual({ cardId: 'c1' });
    });

    it('should not emit data for non-matching events', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const received: any[] = [];
      service.on('retro:card:added').subscribe((data) => received.push(data));

      ws.simulateMessage({ event: 'retro:card:removed', data: { cardId: 'c1' }, timestamp: new Date().toISOString() });

      expect(received.length).toBe(0);
    });
  });

  describe('client→server event methods', () => {
    beforeEach(() => {
      service.connect('session-123', 'test-token');
      getLatestMockWs().simulateOpen();
    });

    it('sendCardAdd sends retro:card:add event', () => {
      service.sendCardAdd('col-1', 'my card text');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:add');
      expect(sent.data).toEqual({ columnId: 'col-1', text: 'my card text' });
    });

    it('sendCardEdit sends retro:card:edit event', () => {
      service.sendCardEdit('card-1', 'updated text');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:edit');
      expect(sent.data).toEqual({ cardId: 'card-1', text: 'updated text' });
    });

    it('sendCardRemove sends retro:card:remove event', () => {
      service.sendCardRemove('card-1');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:remove');
      expect(sent.data).toEqual({ cardId: 'card-1' });
    });

    it('sendCardMove sends retro:card:move event', () => {
      service.sendCardMove('card-1', 'col-2', 3);
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:move');
      expect(sent.data).toEqual({ cardId: 'card-1', targetColumnId: 'col-2', targetIndex: 3 });
    });

    it('sendCardVote sends retro:card:vote event', () => {
      service.sendCardVote('card-1');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:vote');
      expect(sent.data).toEqual({ cardId: 'card-1' });
    });

    it('sendCardUnvote sends retro:card:unvote event', () => {
      service.sendCardUnvote('card-1');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:unvote');
      expect(sent.data).toEqual({ cardId: 'card-1' });
    });

    it('sendCommentAdd sends retro:comment:add event', () => {
      service.sendCommentAdd('card-1', 'nice point');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:comment:add');
      expect(sent.data).toEqual({ cardId: 'card-1', text: 'nice point' });
    });

    it('sendCommentRemove sends retro:comment:remove event', () => {
      service.sendCommentRemove('card-1', 'comment-1');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:comment:remove');
      expect(sent.data).toEqual({ cardId: 'card-1', commentId: 'comment-1' });
    });

    it('sendColumnAdd sends retro:column:add event', () => {
      service.sendColumnAdd('New Column');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:column:add');
      expect(sent.data).toEqual({ name: 'New Column' });
    });

    it('sendColumnRemove sends retro:column:remove event', () => {
      service.sendColumnRemove('col-1');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:column:remove');
      expect(sent.data).toEqual({ columnId: 'col-1' });
    });

    it('sendColumnReorder sends retro:column:reorder event', () => {
      service.sendColumnReorder(['col-2', 'col-1', 'col-3']);
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:column:reorder');
      expect(sent.data).toEqual({ orderedIds: ['col-2', 'col-1', 'col-3'] });
    });

    it('sendColumnRename sends retro:column:rename event', () => {
      service.sendColumnRename('col-1', 'Renamed Column');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:column:rename');
      expect(sent.data).toEqual({ columnId: 'col-1', name: 'Renamed Column' });
    });

    it('sendContextUpdate sends retro:context:update event', () => {
      service.sendContextUpdate('Sprint 42 retrospective');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:context:update');
      expect(sent.data).toEqual({ text: 'Sprint 42 retrospective' });
    });

    it('sendCardsReveal sends retro:cards:reveal event', () => {
      service.sendCardsReveal();
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:cards:reveal');
      expect(sent.data).toEqual({});
    });

    it('sendVotingEnable sends retro:voting:enable event', () => {
      service.sendVotingEnable();
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:voting:enable');
      expect(sent.data).toEqual({});
    });

    it('sendBoardComplete sends retro:board:complete event', () => {
      service.sendBoardComplete();
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:board:complete');
      expect(sent.data).toEqual({});
    });

    it('sendCardMerge sends retro:card:merge event', () => {
      service.sendCardMerge('source-card-1', 'target-card-2');
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:card:merge');
      expect(sent.data).toEqual({ sourceCardId: 'source-card-1', targetCardId: 'target-card-2' });
    });

    it('sendConfigUpdate sends retro:config:update event', () => {
      service.sendConfigUpdate({ hideVoteCount: true, columnLayout: 'horizontal' });
      const sent = JSON.parse(getLatestMockWs().sentMessages[0]);
      expect(sent.event).toBe('retro:config:update');
      expect(sent.data).toEqual({ config: { hideVoteCount: true, columnLayout: 'horizontal' } });
    });
  });

  describe('reconnection', () => {
    it('should set connectionState to reconnecting on unexpected close', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();
      expect(service.connectionState()).toBe('connected');

      ws.simulateClose();
      expect(service.connectionState()).toBe('reconnecting');
    });

    it('should attempt reconnection with exponential backoff', () => {
      vi.useFakeTimers();
      try {
        service.connect('session-123', 'test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        ws1.simulateClose();
        expect(service.connectionState()).toBe('reconnecting');

        vi.advanceTimersByTime(1000);
        expect(MockWebSocket.instances.length).toBe(2);

        const ws2 = getLatestMockWs();
        ws2.simulateClose();

        vi.advanceTimersByTime(2000);
        expect(MockWebSocket.instances.length).toBe(3);

        service.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset reconnect attempt counter on successful connection', () => {
      vi.useFakeTimers();
      try {
        service.connect('session-123', 'test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        ws1.simulateClose();
        vi.advanceTimersByTime(1000);

        const ws2 = getLatestMockWs();
        ws2.simulateOpen();
        expect(service.connectionState()).toBe('connected');

        ws2.simulateClose();
        vi.advanceTimersByTime(1000);
        expect(MockWebSocket.instances.length).toBe(3);

        service.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('special close codes', () => {
    it('should handle duplicate display name (code 4009)', () => {
      const routerSpy = vi.spyOn(TestBed.inject(Router) as any, 'navigate').mockResolvedValue(true);

      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.onclose?.({ code: 4009 } as any);

      expect(service.connectionState()).toBe('disconnected');
      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'This name is already taken in the session. Please choose a different name.'
      );
      expect(routerSpy).toHaveBeenCalledWith(['/retro/session-123/login']);
    });

    it('should handle session not found (code 4004)', () => {
      const routerSpy = vi.spyOn(TestBed.inject(Router) as any, 'navigate').mockResolvedValue(true);

      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.onclose?.({ code: 4004 } as any);

      expect(service.connectionState()).toBe('disconnected');
      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Retrospective session not found.'
      );
      expect(routerSpy).toHaveBeenCalledWith(['/lobby']);
    });
  });

  describe('toast notifications', () => {
    it('should show error toast on unexpected connection close', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.simulateClose();

      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Connection lost. Attempting to reconnect...'
      );
    });

    it('should not show error toast on manual disconnect', () => {
      service.connect('session-123', 'test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      service.disconnect();

      expect(mockToastService.show).not.toHaveBeenCalled();
    });

    it('should show warning toast during reconnection attempts', () => {
      vi.useFakeTimers();
      try {
        service.connect('session-123', 'test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        ws1.simulateClose();
        mockToastService.show.mockClear();

        vi.advanceTimersByTime(1000);

        expect(mockToastService.show).toHaveBeenCalledWith(
          'warning',
          'Reconnecting... (attempt 1)'
        );

        service.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
