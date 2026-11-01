/**
 * Pure WebSocket frame guard helpers (design "Frame guard", R23.10).
 *
 * `WebSocketService.send()` and `RetroWebSocketService.send()` serialise the
 * envelope once and check its size here before handing it to the socket, so a
 * frame the server would close with 1009 is never sent.
 *
 * The browser sends a text frame as UTF-8, so the byte count comes from
 * `TextEncoder`. `JSON.stringify` escapes lone surrogates as `\uXXXX`, so a
 * serialised envelope contains none; if one is passed in anyway, `TextEncoder`
 * encodes it as U+FFFD (3 bytes), which is what the browser would send.
 */
import { WS_MAX_PAYLOAD_BYTES } from '@shared/types';

const encoder = new TextEncoder();

/** Number of bytes `json` occupies when encoded as UTF-8. */
export function utf8ByteLength(json: string): number {
  return encoder.encode(json).length;
}

/** True when `json` is larger than the server's maximum WebSocket payload. */
export function exceedsFrameLimit(json: string): boolean {
  return utf8ByteLength(json) > WS_MAX_PAYLOAD_BYTES;
}
