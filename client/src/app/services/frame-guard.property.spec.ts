// Feature: session-chat, Property 34: The frame guard sends exactly the frames that fit
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { WS_MAX_PAYLOAD_BYTES } from '@shared/types';
import { exceedsFrameLimit, utf8ByteLength } from './frame-guard';
import { WebSocketService } from './websocket.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { ToastService } from './toast.service';
import { EpisodeState } from './connection-episode';

/**
 * Property 34: for any event name and JSON-serialisable data sent while the socket is
 * `OPEN`, `send()` writes the frame and returns true iff the UTF-8 length of the
 * serialised envelope is at most `WS_MAX_PAYLOAD_BYTES`. Each rejected call shows
 * exactly one untagged error toast, and the guard never touches Connection_State, the
 * 1009 count or the socket. `utf8ByteLength` equals the `TextEncoder` output length.
 *
 * **Validates: Requirements 23.10**
 *
 * The socket is a `MockWebSocket` stand-in and `Date` is faked, so the envelope
 * timestamp has a fixed length and a frame of an exact byte size can be built
 * (technique of `websocket.service.stale-socket.spec.ts`, copied here).
 */

const FIXED_NOW = '2026-05-01T12:00:00.000Z';
const FRAME_TOO_LARGE_MESSAGE = 'This change is too large to send.';

// --- Independent UTF-8 model -------------------------------------------------------

/**
 * UTF-8 byte count by a code-point walk, independent of `TextEncoder`: a lone
 * surrogate counts as U+FFFD (3 bytes), which is what a UTF-8 encoder emits for it.
 */
function modelUtf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < s.length &&
      (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// --- Generators --------------------------------------------------------------------

/** One "character" of each UTF-8 width, plus lone high and low surrogates. */
const charArb: fc.Arbitrary<string> = fc.oneof(
  // 1 byte, including control characters, quote and backslash (JSON escapes them).
  fc.integer({ min: 0x00, max: 0x7f }).map((c) => String.fromCharCode(c)),
  // 2 bytes.
  fc.integer({ min: 0x80, max: 0x7ff }).map((c) => String.fromCharCode(c)),
  // 3 bytes, BMP outside the surrogate range.
  fc
    .oneof(fc.integer({ min: 0x800, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0xffff }))
    .map((c) => String.fromCharCode(c)),
  // 4 bytes: emoji range and the rest of the supplementary planes.
  fc
    .oneof(fc.integer({ min: 0x1f300, max: 0x1faff }), fc.integer({ min: 0x10000, max: 0x10ffff }))
    .map((c) => String.fromCodePoint(c)),
  // Lone high surrogate.
  fc.integer({ min: 0xd800, max: 0xdbff }).map((c) => String.fromCharCode(c)),
  // Lone low surrogate.
  fc.integer({ min: 0xdc00, max: 0xdfff }).map((c) => String.fromCharCode(c))
);

const mixedStringArb = (maxLength: number) =>
  fc.array(charArb, { maxLength }).map((chars) => chars.join(''));

/** Short non-empty unit that is repeated to build a frame near 1 MiB. */
const unitArb = fc.array(charArb, { minLength: 1, maxLength: 12 }).map((chars) => chars.join(''));

/** Where the frame size lands: around the limit, or a small frame far below it. */
type SizeChoice = { kind: 'near-limit'; delta: number } | { kind: 'small'; extra: number };

const sizeArb: fc.Arbitrary<SizeChoice> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -16, max: 16 }).map((delta) => ({ kind: 'near-limit' as const, delta })) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 256 }).map((extra) => ({ kind: 'small' as const, extra })) }
);

// --- Frame construction ------------------------------------------------------------

/** The serialised envelope `send()` builds under the fixed clock. */
function envelope(event: string, data: unknown): string {
  return JSON.stringify({ event, data, timestamp: FIXED_NOW });
}

/** UTF-8 bytes `text` contributes inside a JSON document (its escaped form, no quotes). */
function jsonStringBodyBytes(text: string): number {
  return utf8ByteLength(JSON.stringify(text)) - 2;
}

/**
 * `{ meta, text }` whose envelope for `event` is `targetBytes` long: `unit` repeated as
 * often as fits, then ASCII padding. Repeating can join a trailing high and a leading
 * low surrogate into a pair (12 escaped bytes become 4), which only lowers the size, so
 * the padding is never negative.
 */
function dataForFrameOf(
  event: string,
  meta: unknown,
  unit: string,
  targetBytes: number
): { meta: unknown; text: string } {
  const overhead = utf8ByteLength(envelope(event, { meta, text: '' }));
  const body = targetBytes - overhead;
  const repeated = unit.repeat(Math.floor(body / jsonStringBodyBytes(unit)));
  const pad = body - jsonStringBodyBytes(repeated);
  return { meta, text: repeated + 'a'.repeat(pad) };
}

// --- Mock socket -------------------------------------------------------------------

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  closeCalls = 0;
  readonly sent: string[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSING;
    }
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  emitClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  static latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

// --- Services under test -----------------------------------------------------------

interface SendingService {
  send(event: string, data: unknown): boolean;
  connectionState(): string;
  ngOnDestroy(): void;
}

interface ServiceCase {
  name: string;
  create(): SendingService;
  connect(service: SendingService): void;
}

const SERVICES: ServiceCase[] = [
  {
    name: 'WebSocketService',
    create: () => TestBed.inject(WebSocketService),
    connect: (s) => (s as WebSocketService).connect('test-token', 'sess0001'),
  },
  {
    name: 'RetroWebSocketService',
    create: () => TestBed.inject(RetroWebSocketService),
    connect: (s) => (s as RetroWebSocketService).connect('retro0001', 'test-token'),
  },
];

/** The private episode state, read to show the 1009 count is untouched. */
function episodeOf(service: SendingService): EpisodeState {
  return (service as unknown as { episode: EpisodeState }).episode;
}

// --- Properties --------------------------------------------------------------------

describe('Property 34: The frame guard sends exactly the frames that fit', () => {
  it('utf8ByteLength equals the TextEncoder length and the code-point model, including lone surrogates', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(mixedStringArb(64), (s) => {
        const bytes = utf8ByteLength(s);
        expect(bytes).toBe(encoder.encode(s).length);
        expect(bytes).toBe(modelUtf8Bytes(s));
        expect(exceedsFrameLimit(s)).toBe(bytes > WS_MAX_PAYLOAD_BYTES);
      }),
      { numRuns: 200 }
    );
  });

  describe.each(SERVICES.map((s) => [s.name, s] as const))('%s.send()', (_name, serviceCase) => {
    let service: SendingService;
    let originalWebSocket: typeof globalThis.WebSocket;
    let toast: {
      show: ReturnType<typeof vi.fn>;
      dismiss: ReturnType<typeof vi.fn>;
      dismissByTag: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      MockWebSocket.instances = [];
      originalWebSocket = globalThis.WebSocket;
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      vi.setSystemTime(new Date(FIXED_NOW));

      toast = { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() };
      TestBed.configureTestingModule({
        providers: [
          { provide: ToastService, useValue: toast },
          { provide: Router, useValue: { navigate: vi.fn() } },
        ],
      });
      service = serviceCase.create();
    });

    afterEach(() => {
      service.ngOnDestroy();
      vi.useRealTimers();
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    });

    it('writes and returns true iff the serialised envelope fits; each rejection shows one untagged toast and changes nothing else', () => {
      // One 1009 close followed by a successful reconnect, so the 1009 count is non-zero
      // and a reset by the guard would be visible.
      serviceCase.connect(service);
      MockWebSocket.latest().emitOpen();
      MockWebSocket.latest().emitClose(1009);
      vi.advanceTimersByTime(1000);
      const socket = MockWebSocket.latest();
      socket.emitOpen();
      // The reconnect delay moved the fake clock; put it back so envelopes match.
      vi.setSystemTime(new Date(FIXED_NOW));
      expect(service.connectionState()).toBe('connected');
      const episodeBefore = { ...episodeOf(service) };
      expect(episodeBefore.consecutiveTooLarge).toBe(1);
      const socketCount = MockWebSocket.instances.length;
      toast.show.mockClear();
      toast.dismissByTag.mockClear();
      toast.dismiss.mockClear();

      fc.assert(
        fc.property(
          mixedStringArb(16),
          fc.jsonValue({ maxDepth: 2 }),
          unitArb,
          sizeArb,
          (event, meta, unit, size) => {
            socket.sent.length = 0;
            toast.show.mockClear();

            const overhead = utf8ByteLength(envelope(event, { meta, text: '' }));
            const target =
              size.kind === 'near-limit' ? WS_MAX_PAYLOAD_BYTES + size.delta : overhead + size.extra;
            const data = dataForFrameOf(event, meta, unit, target);
            const frame = envelope(event, data);
            const frameBytes = utf8ByteLength(frame);
            // Builder sanity and the independent cross-check on the real frame.
            expect(frameBytes).toBe(target);
            expect(modelUtf8Bytes(frame)).toBe(frameBytes);

            const fits = frameBytes <= WS_MAX_PAYLOAD_BYTES;
            expect(service.send(event, data)).toBe(fits);

            if (fits) {
              expect(socket.sent).toEqual([frame]);
              expect(toast.show).not.toHaveBeenCalled();
            } else {
              expect(socket.sent).toEqual([]);
              expect(toast.show.mock.calls).toEqual([['error', FRAME_TOO_LARGE_MESSAGE]]);
            }

            // The guard never touches the socket, the state or the episode.
            expect(toast.dismissByTag).not.toHaveBeenCalled();
            expect(toast.dismiss).not.toHaveBeenCalled();
            expect(socket.readyState).toBe(MockWebSocket.OPEN);
            expect(socket.closeCalls).toBe(0);
            expect(MockWebSocket.instances.length).toBe(socketCount);
            expect(service.connectionState()).toBe('connected');
            expect(episodeOf(service)).toEqual(episodeBefore);
            expect(vi.getTimerCount()).toBe(0);
          }
        ),
        { numRuns: 60 }
      );
    }, 120_000);
  });
});
