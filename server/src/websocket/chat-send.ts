import {
  BoardKind,
  ChatMessage,
  ChatMessageRejectedPayload,
  ChatRejection,
  isCanonicalUuid,
} from '../../../shared/types';
import { validateChatText } from '../../../shared/chat-text';
import { ChatRoom } from '../services/chat-room';

/**
 * The chat send decision shared by the poker and retro chat handlers (D3).
 *
 * Pure apart from `room.prepare`, which itself mutates nothing: every state
 * change waits for the caller to run `commit()` on an `accepted` outcome.
 *
 * This module imports neither handler and no poker module, so the retro
 * handler can use it without breaking the import scan of `isolation.spec.ts`.
 */

export interface ChatSendContext {
  /** Board_Session ID of the sending Board_Connection. */
  connectionSessionId: string;
  /** Authenticated_Identity of the sending Board_Connection (R15.1). */
  author: { id: string; displayName: string };
  room: ChatRoom;
}

export type ChatSendOutcome =
  | { kind: 'accepted'; message: ChatMessage; commit: () => void }
  | { kind: 'replay'; message: ChatMessage }
  | { kind: 'rejected'; payload: ChatMessageRejectedPayload };

/** Fixed rejection texts; none contains any submitted text (R14.15). */
export const CHAT_REJECTION_MESSAGES: Readonly<Record<ChatRejection, string>> = Object.freeze({
  CHAT_SESSION_MISMATCH: 'This message was addressed to a different session.',
  CHAT_INVALID: 'The message could not be read.',
  CHAT_EMPTY: 'Message text is required.',
  CHAT_TOO_LONG: 'Messages can be at most 500 characters long.',
  CHAT_RATE_LIMITED: "You're sending messages too fast.",
  CHAT_DUPLICATE: 'This message was already delivered.',
});

function reject(
  clientMessageId: unknown,
  code: ChatRejection,
  retryAfterMs?: number,
): ChatSendOutcome {
  const payload: ChatMessageRejectedPayload = {
    clientMessageId: typeof clientMessageId === 'string' ? clientMessageId : '',
    code,
    message: CHAT_REJECTION_MESSAGES[code],
  };
  // retryAfterMs is present only for CHAT_RATE_LIMITED (R13.5).
  if (code === 'CHAT_RATE_LIMITED' && retryAfterMs !== undefined) {
    payload.retryAfterMs = retryAfterMs;
  }
  return { kind: 'rejected', payload };
}

/**
 * Applies the checks of R14.11 in order and stops at the first failure:
 * (1) non-array object, (2) session match, (3) `clientMessageId` form,
 * (4) Chat_Validator on `text`, (5) duplicate and (6) rate limit via
 * `room.prepare`. Author fields of the payload are never read (R15.1).
 */
export function evaluateChatSend(raw: unknown, ctx: ChatSendContext): ChatSendOutcome {
  // (1) R14.10: null, primitives and arrays are unreadable.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject(undefined, 'CHAT_INVALID');
  }

  const payload = raw as Record<string, unknown>;
  const clientMessageId = payload['clientMessageId'];

  // (2) R15.2: sessionId must be a string equal to the connection's session.
  const sessionId = payload['sessionId'];
  if (typeof sessionId !== 'string' || sessionId !== ctx.connectionSessionId) {
    return reject(clientMessageId, 'CHAT_SESSION_MISMATCH');
  }

  // (3) R14.9: canonical 8-4-4-4-12 hex UUID, any version, any case.
  if (!isCanonicalUuid(clientMessageId)) {
    return reject(clientMessageId, 'CHAT_INVALID');
  }

  // (4) R14.2–R14.6.
  const textResult = validateChatText(payload['text']);
  if (!textResult.ok) {
    return reject(clientMessageId, textResult.code);
  }

  // (5) and (6): duplicate check, then rate limit (R16.5, R16.6, R17.2, R17.4).
  const author = { id: ctx.author.id, displayName: ctx.author.displayName };
  const decision = ctx.room.prepare(author, clientMessageId, textResult.text);
  switch (decision.kind) {
    case 'accepted':
      return { kind: 'accepted', message: decision.message, commit: decision.commit };
    case 'replay':
      return { kind: 'replay', message: decision.message };
    case 'rejected':
      return reject(clientMessageId, decision.code, decision.retryAfterMs);
  }
}

/**
 * The only fields a chat log line may carry (R19.2). There is deliberately no
 * field for text, author name, payload or token (R19.1, R19.6, D11).
 */
export interface ChatLogFields {
  boardKind: BoardKind;
  sessionId: string;
  event: string;
  code?: ChatRejection;
  bufferSize?: number;
  broadcastCount?: number;
  textLength?: number;
  errorName?: string;
}

/**
 * Builds `chat <boardKind> session=<id> event=<name> [code=…] [buffer=…]
 * [broadcast=…] [textLength=…] [error=<name>]`. Only the whitelisted keys are
 * read, so extra properties on the argument never reach the log.
 */
export function formatChatLogLine(fields: ChatLogFields): string {
  const parts = [
    'chat',
    fields.boardKind,
    `session=${fields.sessionId}`,
    `event=${fields.event}`,
  ];
  if (fields.code !== undefined) parts.push(`code=${fields.code}`);
  if (fields.bufferSize !== undefined) parts.push(`buffer=${fields.bufferSize}`);
  if (fields.broadcastCount !== undefined) parts.push(`broadcast=${fields.broadcastCount}`);
  if (fields.textLength !== undefined) parts.push(`textLength=${fields.textLength}`);
  if (fields.errorName !== undefined) parts.push(`error=${fields.errorName}`);
  return parts.join(' ');
}
