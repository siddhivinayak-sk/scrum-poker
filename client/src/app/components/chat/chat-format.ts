import { BoardKind, CHAT_MESSAGE_MAX_LENGTH, User } from '@shared/types';

/**
 * Pure presentation helpers for the session chat (no Angular, no DOM).
 * Every function returns the same output for the same input.
 */

/**
 * The Narrow_Viewport media query (below the 768 px breakpoint, R4.3, R4.4, R4.6). Lives here,
 * outside the Deferred chat chunk, so the launcher and the panel share it.
 */
export const CHAT_NARROW_QUERY = '(max-width: 767px)';

/** Id of the Chat_Panel for one Board_Kind; the launcher's `aria-controls` target (R11.1). */
export function chatPanelId(kind: BoardKind): string {
  return `chat-panel-${kind}`;
}

/** Avatar background colours; each reaches at least 5.0:1 against `#ffffff` (R5.4, R12.1). */
export const AVATAR_PALETTE: readonly string[] = [
  '#2b6cb0',
  '#276749',
  '#6b46c1',
  '#c53030',
  '#b83280',
  '#2c7a7b',
  '#975a16',
  '#4a5568',
];

/** Draft length from which the Composer shows the `<length>/500` counter (R7.9). */
export const CHAT_COUNTER_THRESHOLD = 400;

const ENGLISH_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Upper-cased first code point of each of the first two whitespace-separated
 * words of `authorName`; `?` when the name has no non-whitespace character (R5.3).
 */
export function avatarInitials(authorName: string): string {
  const words = authorName.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return '?';
  }
  return words
    .slice(0, 2)
    .map((word) => String.fromCodePoint(word.codePointAt(0) as number).toUpperCase())
    .join('');
}

/** FNV-1a 32-bit hash over the UTF-16 code units of `authorId`, mod 8 (R5.3). */
export function avatarColorIndex(authorId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < authorId.length; i++) {
    hash ^= authorId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_PALETTE.length;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * `HH:mm` (24-hour, zero-padded, local time) when `sentAt` and `now` fall on the
 * same local calendar day, otherwise `MMM d, HH:mm` with an English three-letter
 * month and an unpadded day (R5.5). Returns `''` for an unparseable `sentAt`.
 */
export function formatChatTime(sentAt: string | Date, now: Date | number): string {
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt);
  const ref = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(sent.getTime())) {
    return '';
  }
  const time = `${pad2(sent.getHours())}:${pad2(sent.getMinutes())}`;
  const sameDay =
    sent.getFullYear() === ref.getFullYear() &&
    sent.getMonth() === ref.getMonth() &&
    sent.getDate() === ref.getDate();
  if (sameDay) {
    return time;
  }
  return `${ENGLISH_MONTHS[sent.getMonth()]} ${sent.getDate()}, ${time}`;
}

/** Unread_Badge text: `''` for 0, `'1'`…`'99'`, `'99+'` above 99 (R2.1–R2.3, R2.9). */
export function badgeText(n: number): string {
  if (n <= 0) {
    return '';
  }
  return n > 99 ? '99+' : String(n);
}

/** Chat_Launcher accessible name with the exact count (R11.2). */
export function launcherLabel(n: number): string {
  if (n <= 0) {
    return 'Open chat';
  }
  return n === 1 ? 'Open chat, 1 unread message' : `Open chat, ${n} unread messages`;
}

/** Description referenced by the minimized restore control; `''` at 0 (R11.3). */
export function unreadDescription(n: number): string {
  if (n <= 0) {
    return '';
  }
  return n === 1 ? '1 unread message' : `${n} unread messages`;
}

/** New_Messages_Indicator text; `''` at 0, where the indicator is hidden (R6.7). */
export function indicatorText(n: number): string {
  if (n <= 0) {
    return '';
  }
  if (n === 1) {
    return '1 new message';
  }
  return n > 99 ? '99+ new messages' : `${n} new messages`;
}

/** Composer counter `<length>/500` from 400 code units, `''` below (R7.9). */
export function counterText(draftLength: number): string {
  return draftLength >= CHAT_COUNTER_THRESHOLD
    ? `${draftLength}/${CHAT_MESSAGE_MAX_LENGTH}`
    : '';
}

export type PresenceParticipant = Pick<User, 'id' | 'displayName' | 'role'>;

export interface PresenceEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly isYou: boolean;
  readonly isModerator: boolean;
}

function distinctParticipants(
  participants: readonly PresenceParticipant[],
): PresenceParticipant[] {
  const seen = new Set<string>();
  const result: PresenceParticipant[] = [];
  for (const p of participants) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      result.push(p);
    }
  }
  return result;
}

/** "N online", N = number of distinct user IDs (R10.1). */
export function onlineLabel(participants: readonly PresenceParticipant[]): string {
  return `${new Set(participants.map((p) => p.id)).size} online`;
}

/**
 * One entry per distinct user ID (the first occurrence wins), sorted
 * case-insensitively by display name (accents significant) and then by user ID
 * ascending (R10.3, R10.6).
 */
export function presenceEntries(
  participants: readonly PresenceParticipant[],
  me: string | null,
): PresenceEntry[] {
  return distinctParticipants(participants)
    .map((p) => ({
      userId: p.id,
      displayName: p.displayName,
      isYou: me !== null && p.id === me,
      isModerator: p.role === 'moderator',
    }))
    .sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: 'accent',
      });
      if (byName !== 0) {
        return byName;
      }
      if (a.userId === b.userId) {
        return 0;
      }
      return a.userId < b.userId ? -1 : 1;
    });
}

export interface ClampedPaste {
  readonly draft: string;
  readonly caret: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Replaces the selection of `draft` with the longest prefix of `pasted` that keeps
 * the draft at most `CHAT_MESSAGE_MAX_LENGTH` code units, one code unit shorter when
 * the cut would split a surrogate pair. The caret ends after the inserted text (R7.12).
 */
export function clampPaste(
  draft: string,
  selStart: number,
  selEnd: number,
  pasted: string,
): ClampedPaste {
  const a = Math.min(Math.max(0, selStart), draft.length);
  const b = Math.min(Math.max(0, selEnd), draft.length);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const space = Math.max(0, CHAT_MESSAGE_MAX_LENGTH - before.length - after.length);
  let insert = pasted.slice(0, space);
  if (
    insert.length > 0 &&
    insert.length < pasted.length &&
    isHighSurrogate(insert.charCodeAt(insert.length - 1)) &&
    isLowSurrogate(pasted.charCodeAt(insert.length))
  ) {
    insert = insert.slice(0, -1);
  }
  return { draft: before + insert + after, caret: start + insert.length };
}

/** Whole seconds left of a rate limit: `ceil(max(0, until - now) / 1000)` (R8.9). */
export function rateLimitSeconds(until: number, now: number): number {
  return Math.ceil(Math.max(0, until - now) / 1000);
}
