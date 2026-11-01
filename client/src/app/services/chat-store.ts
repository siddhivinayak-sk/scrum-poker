/**
 * Pure chat store reducer (design "reduceChat (pure)" and Data Models "Client state").
 *
 * `reduceChat(state, action)` returns the next `ChatState` and the effects the page-scoped
 * `ChatStore` service must run (send a frame, start or cancel an acknowledgement timer, write the
 * Read_Marker, announce a status text). The module reads no clock, generates no ids, touches no
 * DOM, storage or timer and imports nothing from Angular: time, ids, the Connection_Generation and
 * the stored Read_Marker all enter through actions. Inbound `added`, `history` and `rejected`
 * payloads arrive as `unknown` and are validated here (R5.14, R13.12, R13.13).
 *
 * A reduction that changes nothing returns the input `state` object itself and no effects.
 */

import {
  BoardKind,
  CHAT_ACK_TIMEOUT_MS,
  CHAT_HISTORY_LIMIT,
  ChatMessage,
  ChatMessageSendPayload,
  ChatRejection,
  ConnectionState,
  isCanonicalUuid,
  isChatMessage,
} from '@shared/types';
import { validateChatText } from '@shared/chat-text';

// --- State ---------------------------------------------------------------------------------

export type ChatHistoryStatus = 'loading' | 'loaded' | 'timed-out';
export type OutboxState = 'pending' | 'failed' | 'sent';

export interface ChatState {
  readonly boardKind: BoardKind;
  readonly sessionId: string;
  /** Current user ID; null while unknown. */
  readonly me: string | null;
  /** Ascending seq (ties by id), unique id, at most `CHAT_HISTORY_LIMIT` (R16.8, R18.12). */
  readonly confirmed: readonly ChatMessage[];
  /** Unsequenced_Own_Messages in first-send order (R5.1). */
  readonly outbox: readonly OutboxEntry[];
  readonly historyStatus: ChatHistoryStatus;
  /** Highest Connection_Generation applied; null after render or reset (R25.9). */
  readonly historyGeneration: number | null;
  readonly connection: ConnectionState;
  /** Highest seq shown while open and visible; never decreases (R2.4). */
  readonly readMarker: number | null;
  /** Epoch ms until which the rate-limit notice applies (R8.9). */
  readonly rateLimitUntil: number | null;
}

export interface OutboxEntry {
  readonly clientMessageId: string;
  /** Normalised_Text. */
  readonly text: string;
  /** Epoch ms of the first send; the shown timestamp after `CHAT_DUPLICATE` (R8.3). */
  readonly firstSentAt: number;
  readonly state: OutboxState;
  /** Connected time accumulated since the last (re)send, excluding the running segment. */
  readonly ackElapsedMs: number;
  /** Start of the current connected segment; null while not counting. */
  readonly segmentStart: number | null;
  /** Rejection or timeout text shown next to the entry. */
  readonly notice: string | null;
}

export type ChatEntry =
  | { readonly key: string; readonly kind: 'confirmed'; readonly message: ChatMessage; readonly own: boolean }
  | { readonly key: string; readonly kind: 'outbox'; readonly entry: OutboxEntry };

// --- Actions and effects -------------------------------------------------------------------

export type ChatAction =
  /** Session change (R18.11). `readMarker` is the value the service read for `(kind, sessionId)`. */
  | { readonly kind: 'reset'; readonly sessionId: string; readonly readMarker: number | null }
  /** The current user ID became known or changed. */
  | { readonly kind: 'identity'; readonly me: string | null }
  | { readonly kind: 'connection'; readonly state: ConnectionState; readonly now: number }
  | { readonly kind: 'send'; readonly clientMessageId: string; readonly text: string; readonly now: number }
  | { readonly kind: 'added'; readonly raw: unknown }
  /** `generation` is `connectionGeneration` at receipt (R25.9); `now` starts resent timers. */
  | { readonly kind: 'history'; readonly raw: unknown; readonly generation: number; readonly now: number }
  /** `now` is the receipt time, the base of `rateLimitUntil` (R8.9). */
  | { readonly kind: 'rejected'; readonly raw: unknown; readonly now: number }
  | { readonly kind: 'ackTimeout'; readonly clientMessageId: string }
  | { readonly kind: 'retry'; readonly clientMessageId: string; readonly now: number }
  | { readonly kind: 'discard'; readonly clientMessageId: string }
  | { readonly kind: 'markRead'; readonly seq: number }
  | { readonly kind: 'historyTimeout' };

export type ChatEffect =
  | { readonly kind: 'send'; readonly payload: ChatMessageSendPayload }
  /** Starts the timer of this id, replacing any running timer of the same id. */
  | { readonly kind: 'startAckTimer'; readonly clientMessageId: string; readonly ms: number }
  | { readonly kind: 'cancelAckTimer'; readonly clientMessageId: string }
  /** The Read_Marker changed; the service writes it through `ReadMarkerStore` (R2.10). */
  | { readonly kind: 'writeReadMarker'; readonly boardKind: BoardKind; readonly sessionId: string; readonly seq: number }
  /** Text for the panel's `role="status"` region (R11.18). */
  | { readonly kind: 'announce'; readonly text: string };

export interface ChatReduction {
  readonly state: ChatState;
  readonly effects: readonly ChatEffect[];
}

// --- Texts ---------------------------------------------------------------------------------

/** Announced whenever an Own_Message changes to `failed` (R11.18). */
export const CHAT_NOT_SENT_ANNOUNCEMENT = 'Message not sent.';
/** Shown next to an entry whose acknowledgement timed out (R8.5). */
export const CHAT_ACK_TIMEOUT_NOTICE = 'Delivery could not be confirmed.';

const CHAT_REJECTION_CODES: ReadonlySet<string> = new Set<ChatRejection>([
  'CHAT_SESSION_MISMATCH',
  'CHAT_INVALID',
  'CHAT_EMPTY',
  'CHAT_TOO_LONG',
  'CHAT_RATE_LIMITED',
  'CHAT_DUPLICATE',
]);

// --- Construction --------------------------------------------------------------------------

export interface ChatStateInit {
  readonly boardKind: BoardKind;
  readonly sessionId: string;
  readonly me?: string | null;
  readonly readMarker?: number | null;
  readonly connection?: ConnectionState;
}

/** The empty state of a Board_Page before any history (R5.11, R18.13). */
export function createChatState(init: ChatStateInit): ChatState {
  return {
    boardKind: init.boardKind,
    sessionId: init.sessionId,
    me: init.me ?? null,
    confirmed: [],
    outbox: [],
    historyStatus: 'loading',
    historyGeneration: null,
    connection: init.connection ?? 'disconnected',
    readMarker: validReadMarker(init.readMarker),
    rateLimitUntil: null,
  };
}

// --- Merge helpers -------------------------------------------------------------------------

/** Seq order; ties (never produced by a correct server) by id so the order is total. */
export function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Union by id of two confirmed lists, sorted by seq, keeping the `CHAT_HISTORY_LIMIT` highest
 * seqs (D6, R16.8, R16.9, R18.12). An id already in `existing` is kept as is. Returns `existing`
 * itself when `incoming` adds no new id.
 */
export function mergeConfirmed(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): readonly ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of existing) byId.set(message.id, message);
  let addedAny = false;
  for (const message of incoming) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
      addedAny = true;
    }
  }
  if (!addedAny) return existing;
  const sorted = [...byId.values()].sort(compareChatMessages);
  return sorted.length > CHAT_HISTORY_LIMIT ? sorted.slice(sorted.length - CHAT_HISTORY_LIMIT) : sorted;
}

// --- Selectors -----------------------------------------------------------------------------

/** Confirmed messages by seq, then outbox entries in first-send order (R5.1). */
export function selectEntries(state: ChatState): ChatEntry[] {
  const result: ChatEntry[] = state.confirmed.map((message) => ({
    key: message.id,
    kind: 'confirmed' as const,
    message,
    own: isOwn(state, message),
  }));
  for (const entry of state.outbox) {
    result.push({ key: `outbox:${entry.clientMessageId}`, kind: 'outbox', entry });
  }
  return result;
}

/** Non-own confirmed messages with a seq above the Read_Marker (D5, R2.5–R2.8). */
export function selectUnreadCount(state: ChatState): number {
  const marker = state.readMarker ?? 0;
  let count = 0;
  for (const message of state.confirmed) {
    if (message.authorId !== state.me && message.seq > marker) count++;
  }
  return count;
}

/** Design names of the selectors. */
export const entries = selectEntries;
export const unreadCount = selectUnreadCount;

// --- Reducer -------------------------------------------------------------------------------

export function reduceChat(state: ChatState, action: ChatAction): ChatReduction {
  switch (action.kind) {
    case 'reset':
      return reduceReset(state, action.sessionId, action.readMarker);
    case 'identity':
      return reduceIdentity(state, action.me);
    case 'connection':
      return reduceConnection(state, action.state, action.now);
    case 'send':
      return reduceSend(state, action.clientMessageId, action.text, action.now);
    case 'added':
      return reduceAdded(state, action.raw);
    case 'history':
      return reduceHistory(state, action.raw, action.generation, action.now);
    case 'rejected':
      return reduceRejected(state, action.raw, action.now);
    case 'ackTimeout':
      return reduceAckTimeout(state, action.clientMessageId);
    case 'retry':
      return reduceRetry(state, action.clientMessageId, action.now);
    case 'discard':
      return reduceDiscard(state, action.clientMessageId);
    case 'markRead':
      return reduceMarkRead(state, action.seq);
    case 'historyTimeout':
      return state.historyStatus === 'loading'
        ? { state: { ...state, historyStatus: 'timed-out' }, effects: [] }
        : unchanged(state);
  }
}

/**
 * Empty state for the new session (R18.11): no messages, no outbox, no generation, loading.
 * Board_Kind, the current user and the Connection_State carry over; every timer is cancelled and
 * nothing is resent.
 */
function reduceReset(state: ChatState, sessionId: string, readMarker: number | null): ChatReduction {
  return {
    state: createChatState({
      boardKind: state.boardKind,
      sessionId,
      me: state.me,
      readMarker,
      connection: state.connection,
    }),
    effects: state.outbox.map((entry) => cancelTimer(entry.clientMessageId)),
  };
}

/**
 * Records the current user. Outbox entries whose id now matches an own confirmed message are
 * removed, which keeps one entry per Client_Message_Id (R16.12).
 */
function reduceIdentity(state: ChatState, me: string | null): ChatReduction {
  const nextMe = typeof me === 'string' && me.length > 0 ? me : null;
  if (nextMe === state.me) return unchanged(state);
  const ownIds = new Set(
    state.confirmed.filter((m) => m.authorId === nextMe).map((m) => m.clientMessageId),
  );
  const effects: ChatEffect[] = [];
  const outbox = state.outbox.filter((entry) => {
    if (!ownIds.has(entry.clientMessageId)) return true;
    effects.push(cancelTimer(entry.clientMessageId));
    return false;
  });
  return {
    state: { ...state, me: nextMe, outbox: effects.length > 0 ? outbox : state.outbox },
    effects,
  };
}

/**
 * Connected-time-only acknowledgement accounting (R8.5, R9.3). Leaving `connected` banks the
 * running segment of each pending entry and cancels its timer; an entry whose banked time has
 * reached `CHAT_ACK_TIMEOUT_MS` fails there. Entering `connected` starts a segment and a timer
 * for the remaining time of each pending entry.
 */
function reduceConnection(state: ChatState, next: ConnectionState, now: number): ChatReduction {
  if (next === state.connection) return unchanged(state);
  const wasConnected = state.connection === 'connected';
  const isConnected = next === 'connected';
  if (wasConnected === isConnected) return { state: { ...state, connection: next }, effects: [] };

  const effects: ChatEffect[] = [];
  const outbox = state.outbox.map((entry) => {
    if (entry.state !== 'pending') return entry;
    if (isConnected) {
      effects.push(startTimer(entry.clientMessageId, Math.max(0, CHAT_ACK_TIMEOUT_MS - entry.ackElapsedMs)));
      return { ...entry, segmentStart: now };
    }
    effects.push(cancelTimer(entry.clientMessageId));
    const ackElapsedMs =
      entry.ackElapsedMs + (entry.segmentStart === null ? 0 : Math.max(0, now - entry.segmentStart));
    if (ackElapsedMs >= CHAT_ACK_TIMEOUT_MS) {
      effects.push(announceNotSent());
      return { ...entry, state: 'failed' as const, ackElapsedMs, segmentStart: null, notice: CHAT_ACK_TIMEOUT_NOTICE };
    }
    return { ...entry, ackElapsedMs, segmentStart: null };
  });
  return { state: { ...state, connection: next, outbox }, effects };
}

/**
 * Appends a `pending` entry and sends it (R8.1). Ignored when the id is not a canonical UUID,
 * when the id is already held for the current user (R16.12) or when the text is not sendable
 * (R7.6). While not connected the entry is held without a frame or timer and goes out with the
 * reconnect resend (R9.6).
 */
function reduceSend(state: ChatState, clientMessageId: string, text: string, now: number): ChatReduction {
  if (!isCanonicalUuid(clientMessageId) || holdsOwnId(state, clientMessageId)) return unchanged(state);
  const validated = validateChatText(text);
  if (!validated.ok) return unchanged(state);

  const connected = state.connection === 'connected';
  const entry: OutboxEntry = {
    clientMessageId,
    text: validated.text,
    firstSentAt: now,
    state: 'pending',
    ackElapsedMs: 0,
    segmentStart: connected ? now : null,
    notice: null,
  };
  return {
    state: { ...state, outbox: [...state.outbox, entry] },
    effects: connected ? [sendEffect(state, entry), startTimer(clientMessageId, CHAT_ACK_TIMEOUT_MS)] : [],
  };
}

/**
 * A confirmed message (R8.2, R16.8, R18.12, R13.12). An own message replaces the outbox entry of
 * its Client_Message_Id, whatever its state, so one entry per id remains (R16.12).
 */
function reduceAdded(state: ChatState, raw: unknown): ChatReduction {
  const message = readAddedMessage(raw);
  if (message === null) return unchanged(state);

  const confirmed = mergeConfirmed(state.confirmed, [message]);
  const index = isOwn(state, message)
    ? state.outbox.findIndex((entry) => entry.clientMessageId === message.clientMessageId)
    : -1;
  if (index < 0) {
    return confirmed === state.confirmed ? unchanged(state) : { state: { ...state, confirmed }, effects: [] };
  }
  return {
    state: { ...state, confirmed, outbox: state.outbox.filter((_, i) => i !== index) },
    effects: [cancelTimer(message.clientMessageId)],
  };
}

/**
 * A Chat_History behind the generation gate (R25.9, R25.11, R25.12):
 * - first since render or reset: merge and replace own entries, resend nothing (R18.13);
 * - higher generation: the same, then resend each remaining `pending` entry once in send order
 *   with a fresh timer; `failed` entries stay (R9.4–R9.7);
 * - equal or lower generation: unchanged, no effects.
 * A payload without a `messages` array is ignored; invalid entries are dropped (R13.13, R5.14).
 */
function reduceHistory(state: ChatState, raw: unknown, generation: number, now: number): ChatReduction {
  const messages = readHistoryMessages(raw);
  if (messages === null || !Number.isSafeInteger(generation) || generation < 0) return unchanged(state);
  const first = state.historyGeneration === null;
  if (!first && generation <= (state.historyGeneration as number)) return unchanged(state);

  const confirmed = mergeConfirmed(state.confirmed, messages);
  const ownIds = new Set(messages.filter((m) => isOwn(state, m)).map((m) => m.clientMessageId));
  const connected = state.connection === 'connected';
  const effects: ChatEffect[] = [];
  const outbox: OutboxEntry[] = [];
  for (const entry of state.outbox) {
    if (ownIds.has(entry.clientMessageId)) {
      effects.push(cancelTimer(entry.clientMessageId));
      continue;
    }
    if (first || entry.state !== 'pending') {
      outbox.push(entry);
      continue;
    }
    const resent: OutboxEntry = { ...entry, ackElapsedMs: 0, segmentStart: connected ? now : null };
    effects.push(sendEffect(state, resent));
    if (connected) effects.push(startTimer(entry.clientMessageId, CHAT_ACK_TIMEOUT_MS));
    outbox.push(resent);
  }
  return {
    state: { ...state, confirmed, outbox, historyGeneration: generation, historyStatus: 'loaded' },
    effects,
  };
}

/**
 * A rejection (R8.3, R8.4, R8.9, R8.12). Only a `pending` or `failed` entry with the same id
 * changes; `CHAT_RATE_LIMITED` sets `rateLimitUntil` whether or not an entry matches.
 */
function reduceRejected(state: ChatState, raw: unknown, now: number): ChatReduction {
  const rejection = readRejection(raw);
  if (rejection === null) return unchanged(state);

  let next = state;
  if (rejection.code === 'CHAT_RATE_LIMITED' && rejection.retryAfterMs !== null) {
    next = { ...next, rateLimitUntil: now + rejection.retryAfterMs };
  }
  const index = state.outbox.findIndex(
    (entry) =>
      entry.clientMessageId === rejection.clientMessageId && (entry.state === 'pending' || entry.state === 'failed'),
  );
  if (index < 0) return { state: next, effects: [] };

  const entry = state.outbox[index];
  const effects: ChatEffect[] = [cancelTimer(entry.clientMessageId)];
  let updated: OutboxEntry;
  if (rejection.code === 'CHAT_DUPLICATE') {
    updated = { ...entry, state: 'sent', segmentStart: null, notice: null };
  } else {
    updated = { ...entry, state: 'failed', segmentStart: null, notice: rejection.message };
    if (entry.state === 'pending') effects.push(announceNotSent());
  }
  return { state: { ...next, outbox: replaceAt(state.outbox, index, updated) }, effects };
}

/**
 * The acknowledgement timer fired (R8.5). The service starts timers only while connected and
 * cancels them on leaving, so a firing while not connected is stale and ignored (R9.3).
 */
function reduceAckTimeout(state: ChatState, clientMessageId: string): ChatReduction {
  if (state.connection !== 'connected') return unchanged(state);
  const index = state.outbox.findIndex((e) => e.clientMessageId === clientMessageId && e.state === 'pending');
  if (index < 0) return unchanged(state);
  const entry = state.outbox[index];
  const updated: OutboxEntry = {
    ...entry,
    state: 'failed',
    ackElapsedMs: CHAT_ACK_TIMEOUT_MS,
    segmentStart: null,
    notice: CHAT_ACK_TIMEOUT_NOTICE,
  };
  return { state: { ...state, outbox: replaceAt(state.outbox, index, updated) }, effects: [announceNotSent()] };
}

/** Retry of a `failed` entry while connected: same id and text, timer from 0 (R8.7). */
function reduceRetry(state: ChatState, clientMessageId: string, now: number): ChatReduction {
  if (state.connection !== 'connected') return unchanged(state);
  const index = state.outbox.findIndex((e) => e.clientMessageId === clientMessageId && e.state === 'failed');
  if (index < 0) return unchanged(state);
  const updated: OutboxEntry = {
    ...state.outbox[index],
    state: 'pending',
    ackElapsedMs: 0,
    segmentStart: now,
    notice: null,
  };
  return {
    state: { ...state, outbox: replaceAt(state.outbox, index, updated) },
    effects: [sendEffect(state, updated), startTimer(clientMessageId, CHAT_ACK_TIMEOUT_MS)],
  };
}

/** Discard of a `failed` entry (R8.8). A later arrival of the id is an ordinary confirmed message. */
function reduceDiscard(state: ChatState, clientMessageId: string): ChatReduction {
  const index = state.outbox.findIndex((e) => e.clientMessageId === clientMessageId && e.state === 'failed');
  if (index < 0) return unchanged(state);
  return {
    state: { ...state, outbox: state.outbox.filter((_, i) => i !== index) },
    effects: [cancelTimer(clientMessageId)],
  };
}

/** `readMarker = max(readMarker ?? 0, seq)`; written only when it changes (R2.4, R2.10). */
function reduceMarkRead(state: ChatState, seq: number): ChatReduction {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq <= (state.readMarker ?? 0)) return unchanged(state);
  return {
    state: { ...state, readMarker: seq },
    effects: [{ kind: 'writeReadMarker', boardKind: state.boardKind, sessionId: state.sessionId, seq }],
  };
}

// --- Inbound payload readers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A detached copy holding only the `ChatMessage` fields (extra fields are ignored, R13.7). */
function copyMessage(m: ChatMessage): ChatMessage {
  return {
    id: m.id,
    seq: m.seq,
    clientMessageId: m.clientMessageId,
    authorId: m.authorId,
    authorName: m.authorName,
    text: m.text,
    sentAt: m.sentAt,
  };
}

/** The `message` of an added payload, or null when it fails `isChatMessage` (R13.12). */
function readAddedMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  const message = raw['message'];
  return isChatMessage(message) ? copyMessage(message) : null;
}

/** The valid entries of a history payload, or null when `messages` is not an array (R13.13). */
function readHistoryMessages(raw: unknown): ChatMessage[] | null {
  if (!isRecord(raw)) return null;
  const messages = raw['messages'];
  if (!Array.isArray(messages)) return null;
  const valid: ChatMessage[] = [];
  for (const item of messages as unknown[]) {
    if (isChatMessage(item)) valid.push(copyMessage(item));
  }
  return valid;
}

interface InboundRejection {
  readonly clientMessageId: string;
  readonly code: ChatRejection;
  readonly message: string;
  /** A finite, non-negative `retryAfterMs`, or null when absent or invalid. */
  readonly retryAfterMs: number | null;
}

function readRejection(raw: unknown): InboundRejection | null {
  if (!isRecord(raw)) return null;
  const { clientMessageId, code, message, retryAfterMs } = raw;
  if (typeof clientMessageId !== 'string' || typeof message !== 'string') return null;
  if (typeof code !== 'string' || !CHAT_REJECTION_CODES.has(code)) return null;
  return {
    clientMessageId,
    code: code as ChatRejection,
    message,
    retryAfterMs:
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null,
  };
}

// --- Small helpers -------------------------------------------------------------------------

function unchanged(state: ChatState): ChatReduction {
  return { state, effects: [] };
}

function validReadMarker(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isOwn(state: ChatState, message: ChatMessage): boolean {
  return state.me !== null && message.authorId === state.me;
}

/** True when the outbox or an own confirmed message already holds this id (R16.12). */
function holdsOwnId(state: ChatState, clientMessageId: string): boolean {
  return (
    state.outbox.some((entry) => entry.clientMessageId === clientMessageId) ||
    state.confirmed.some((m) => isOwn(state, m) && m.clientMessageId === clientMessageId)
  );
}

function replaceAt(outbox: readonly OutboxEntry[], index: number, entry: OutboxEntry): OutboxEntry[] {
  const next = outbox.slice();
  next[index] = entry;
  return next;
}

function sendEffect(state: ChatState, entry: OutboxEntry): ChatEffect {
  return {
    kind: 'send',
    payload: { sessionId: state.sessionId, clientMessageId: entry.clientMessageId, text: entry.text },
  };
}

function startTimer(clientMessageId: string, ms: number): ChatEffect {
  return { kind: 'startAckTimer', clientMessageId, ms };
}

function cancelTimer(clientMessageId: string): ChatEffect {
  return { kind: 'cancelAckTimer', clientMessageId };
}

function announceNotSent(): ChatEffect {
  return { kind: 'announce', text: CHAT_NOT_SENT_ANNOUNCEMENT };
}
