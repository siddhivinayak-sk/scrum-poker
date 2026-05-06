import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketService, calculateBackoff } from './websocket.service';
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

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
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

describe('WebSocketService', () => {
  let service: WebSocketService;
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
    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    (globalThis as any).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  function getLatestMockWs(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  describe('calculateBackoff', () => {
    it('should return 1000ms for attempt 0', () => {
      expect(calculateBackoff(0)).toBe(1000);
    });

    it('should return 2000ms for attempt 1', () => {
      expect(calculateBackoff(1)).toBe(2000);
    });

    it('should cap at 30000ms', () => {
      expect(calculateBackoff(15)).toBe(30000);
      expect(calculateBackoff(20)).toBe(30000);
    });

    it('should return 4000ms for attempt 2', () => {
      expect(calculateBackoff(2)).toBe(4000);
    });
  });

  describe('connect', () => {
    it('should create a WebSocket connection with the correct URL', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      expect(ws).toBeDefined();
      expect(ws.url).toContain('token=test-token');
    });

    it('should set connectionState to connected on open', () => {
      expect(service.connectionState()).toBe('disconnected');
      service.connect('test-token');
      getLatestMockWs().simulateOpen();
      expect(service.connectionState()).toBe('connected');
    });

    it('should use ws:// for http pages and wss:// for https pages', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      // Default location.protocol is http: in test environment
      expect(ws.url).toMatch(/^wss?:\/\//);
    });

    it('should include sessionId in connection URL when provided', () => {
      service.connect('test-token', 'abc12345');
      const ws = getLatestMockWs();
      expect(ws.url).toContain('token=test-token');
      expect(ws.url).toContain('sessionId=abc12345');
    });

    it('should not include sessionId in connection URL when not provided', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      expect(ws.url).toContain('token=test-token');
      expect(ws.url).not.toContain('sessionId');
    });

    it('should include sessionId as a query parameter after token', () => {
      service.connect('my-token', 'sess0001');
      const ws = getLatestMockWs();
      // URL should have both params separated by &
      expect(ws.url).toMatch(/token=my-token&sessionId=sess0001/);
    });
  });

  describe('disconnect', () => {
    it('should close the WebSocket and set state to disconnected', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();
      expect(service.connectionState()).toBe('connected');

      service.disconnect();
      expect(service.connectionState()).toBe('disconnected');
    });

    it('should not attempt to reconnect after manual disconnect', () => {
      vi.useFakeTimers();
      try {
        service.connect('test-token');
        const ws = getLatestMockWs();
        ws.simulateOpen();

        service.disconnect();
        // Simulate close event that would normally trigger reconnect
        ws.simulateClose();

        vi.advanceTimersByTime(5000);
        // Should still be disconnected, no new WebSocket created
        expect(service.connectionState()).toBe('disconnected');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('send', () => {
    it('should send a JSON message with event, data, and timestamp', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      service.send('card:select', { cardValue: 5 });

      expect(ws.sentMessages.length).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.event).toBe('card:select');
      expect(sent.data).toEqual({ cardValue: 5 });
      expect(sent.timestamp).toBeDefined();
    });

    it('should not send when WebSocket is not open', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      // Don't call simulateOpen — readyState stays at OPEN by default in mock
      ws.readyState = MockWebSocket.CLOSED;

      service.send('card:select', { cardValue: 5 });
      expect(ws.sentMessages.length).toBe(0);
    });
  });

  describe('on', () => {
    it('should emit data for matching events', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const received: any[] = [];
      service.on<{ userId: string }>('card:voted').subscribe((data) => received.push(data));

      ws.simulateMessage({ event: 'card:voted', data: { userId: 'u1' }, timestamp: new Date().toISOString() });

      expect(received.length).toBe(1);
      expect(received[0]).toEqual({ userId: 'u1' });
    });

    it('should not emit data for non-matching events', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const received: any[] = [];
      service.on('card:voted').subscribe((data) => received.push(data));

      ws.simulateMessage({ event: 'round:started', data: { round: {} }, timestamp: new Date().toISOString() });

      expect(received.length).toBe(0);
    });

    it('should handle multiple subscribers for the same event', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const received1: any[] = [];
      const received2: any[] = [];
      service.on('card:voted').subscribe((data) => received1.push(data));
      service.on('card:voted').subscribe((data) => received2.push(data));

      ws.simulateMessage({ event: 'card:voted', data: { userId: 'u1' }, timestamp: new Date().toISOString() });

      expect(received1.length).toBe(1);
      expect(received2.length).toBe(1);
    });
  });

  describe('reconnection', () => {
    it('should set connectionState to reconnecting on unexpected close', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();
      expect(service.connectionState()).toBe('connected');

      ws.simulateClose();
      expect(service.connectionState()).toBe('reconnecting');
    });

    it('should attempt reconnection with exponential backoff', () => {
      vi.useFakeTimers();
      try {
        service.connect('test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        // Simulate unexpected close
        ws1.simulateClose();
        expect(service.connectionState()).toBe('reconnecting');

        // After 1000ms (2^0 * 1000), a new connection should be attempted
        vi.advanceTimersByTime(1000);
        expect(MockWebSocket.instances.length).toBe(2);

        // Simulate second connection also failing
        const ws2 = getLatestMockWs();
        ws2.simulateClose();

        // After 2000ms (2^1 * 1000), another attempt
        vi.advanceTimersByTime(2000);
        expect(MockWebSocket.instances.length).toBe(3);

        // Clean up timers
        service.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset reconnect attempt counter on successful connection', () => {
      vi.useFakeTimers();
      try {
        service.connect('test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        // Simulate unexpected close
        ws1.simulateClose();
        vi.advanceTimersByTime(1000);

        // New connection succeeds
        const ws2 = getLatestMockWs();
        ws2.simulateOpen();
        expect(service.connectionState()).toBe('connected');

        // Simulate another close — backoff should restart from 0
        ws2.simulateClose();
        vi.advanceTimersByTime(1000); // 2^0 * 1000 = 1000ms
        expect(MockWebSocket.instances.length).toBe(3);

        service.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('toast notifications', () => {
    it('should show error toast on unexpected connection close', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.simulateClose();

      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Connection lost. Attempting to reconnect...'
      );
    });

    it('should not show error toast on manual disconnect', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      service.disconnect();

      expect(mockToastService.show).not.toHaveBeenCalled();
    });

    it('should show warning toast during reconnection attempts', () => {
      vi.useFakeTimers();
      try {
        service.connect('test-token');
        const ws1 = getLatestMockWs();
        ws1.simulateOpen();

        ws1.simulateClose();
        // Clear the error toast call from onclose
        mockToastService.show.mockClear();

        // Advance past the first reconnect delay (1000ms)
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

    it('should show error toast when send throws for card:select event', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      // Make send throw an error
      ws.send = () => {
        throw new Error('send failed');
      };

      service.send('card:select', { cardValue: 5 });

      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Your vote was not recorded. Please try selecting your card again.'
      );
    });

    it('should show generic error toast when send throws for non-card events', () => {
      service.connect('test-token');
      const ws = getLatestMockWs();
      ws.simulateOpen();

      ws.send = () => {
        throw new Error('send failed');
      };

      service.send('story:submit', { storyDescription: 'test' });

      expect(mockToastService.show).toHaveBeenCalledWith(
        'error',
        'Failed to send message to server. Please try again.'
      );
    });
  });
});
