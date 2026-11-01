/**
 * Largest-legitimate-frame integration test (R22.12; R23.6).
 *
 * The largest legitimate client-to-server frame is the poker bulk import: an
 * `issue:add` with 200 titles of 500 characters each. With every character a
 * 3-byte UTF-8 code point, the frame must still pass `WS_MAX_PAYLOAD_BYTES`,
 * reach the handler and cause an `issue:list-updated` broadcast.
 */
import WebSocket from 'ws';
import { login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { DEFAULT_SESSION_CONFIG, IssueItem, WS_MAX_PAYLOAD_BYTES } from '../../../../shared/types';
import { startWsHarness, WsHarness } from './ws-harness';

jest.setTimeout(20_000);

const TITLE_COUNT = 200;
const TITLE_LENGTH = 500;

/**
 * 200 distinct titles of 500 UTF-16 code units, every one a 3-byte UTF-8
 * CJK character (U+4E00 onward), so each title is 1,500 UTF-8 bytes.
 */
function bulkTitles(): string[] {
  return Array.from(
    { length: TITLE_COUNT },
    (_, i) => String.fromCharCode(0x4e00 + i) + '\u6f22'.repeat(TITLE_LENGTH - 1)
  );
}

describe('WebSocket bulk import (integration, real sockets on localhost)', () => {
  let h: WsHarness;

  beforeEach(async () => {
    h = await startWsHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('accepts an issue:add of 200 titles of 500 three-byte characters and broadcasts issue:list-updated (R22.12, R23.6)', async () => {
    const owner = login('Owner', false);
    const other = login('Observer', false);
    const { sessionId } = sessionRegistry.createSession(owner.user.id, DEFAULT_SESSION_CONFIG);
    const session = sessionRegistry.getSession(sessionId)!;

    const sender = await h.connect('poker', owner.token, sessionId);
    const observer = await h.connect('poker', other.token, sessionId);

    const titles = bulkTitles();
    for (const t of titles) {
      expect(t.length).toBe(TITLE_LENGTH);
      expect(Buffer.byteLength(t, 'utf8')).toBe(3 * TITLE_LENGTH);
    }
    const frame = JSON.stringify({
      event: 'issue:add',
      data: { titles },
      timestamp: new Date().toISOString(),
    });
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    // Titles alone are 300,000 bytes; the frame fits under the limit.
    expect(frameBytes).toBeGreaterThan(TITLE_COUNT * TITLE_LENGTH * 3);
    expect(frameBytes).toBeLessThanOrEqual(WS_MAX_PAYLOAD_BYTES);

    const senderMark = sender.frames.length;
    const observerMark = observer.frames.length;
    await sender.sendRaw(frame);

    const isFullList = (m: { event: string; data: unknown }): boolean =>
      m.event === 'issue:list-updated' && (m.data as { issues: IssueItem[] }).issues.length === TITLE_COUNT;
    const received = await observer.waitFor(isFullList, { from: observerMark });
    await sender.waitFor(isFullList, { from: senderMark });

    // Every title arrives intact and in order.
    const broadcastTitles = (received.data as { issues: IssueItem[] }).issues.map((i) => i.title);
    expect(broadcastTitles).toEqual(titles);
    expect(session.getIssueList().map((i) => i.title)).toEqual(titles);

    // The frame reached the handler whole, and nothing rejected it.
    expect(sender.server.messageBytes).toEqual([frameBytes]);
    expect(sender.eventsSince(senderMark)).toEqual(['issue:list-updated']);
    expect(observer.eventsSince(observerMark)).toEqual(['issue:list-updated']);
    expect(sender.ws.readyState).toBe(WebSocket.OPEN);
    expect(observer.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.logLines.filter((l) => l.startsWith('WebSocket error:'))).toEqual([]);
    expect(h.uncaughtExceptions).toEqual([]);
  });
});
