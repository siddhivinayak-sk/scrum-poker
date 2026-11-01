import { CHAT_MESSAGE_MAX_LENGTH, CHAT_RAW_TEXT_MAX_LENGTH } from './types';

/**
 * Chat_Validator (R14.1–R14.8). Pure: no clock reads, no global mutable state,
 * no input mutation. Shared by the client composer and both server handlers,
 * which gives client-server parity by construction (R14.14).
 */
export type ChatTextResult =
  | { ok: true; text: string } // Normalised_Text, 1..CHAT_MESSAGE_MAX_LENGTH code units
  | { ok: false; code: 'CHAT_INVALID' | 'CHAT_TOO_LONG' | 'CHAT_EMPTY' };

const LINE_BREAK_RE = /\r\n?/g;

/** Disallowed_Characters: C0 controls except tab and LF, DEL, bidi embedding/override/isolate controls. */
const DISALLOWED_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/** Trim set of R14.4, tested against a single UTF-16 code unit. Every Zs code point is in the BMP. */
const TRIM_CHAR_RE = /[\u0009\u000A\uFEFF\u2028\u2029\p{Zs}]/u;

function isTrimChar(codeUnit: string): boolean {
  return TRIM_CHAR_RE.test(codeUnit);
}

/**
 * Steps 1–3 of R14.4 only, with no length checks: convert `\r\n` and lone `\r`
 * to `\n`, remove Disallowed_Characters, then trim the R14.4 whitespace set from
 * both ends. The trim uses two index loops (O(n)) instead of an end-anchored
 * regex, which backtracks quadratically on long runs of whitespace.
 */
export function normaliseChatText(raw: string): string {
  const cleaned = raw.replace(LINE_BREAK_RE, '\n').replace(DISALLOWED_RE, '');

  let start = 0;
  let end = cleaned.length;
  while (start < end && isTrimChar(cleaned[start])) start++;
  while (end > start && isTrimChar(cleaned[end - 1])) end--;

  return cleaned.slice(start, end);
}

/** Classifies an untrusted value as Normalised_Text or exactly one rejection code (R14.2–R14.6). */
export function validateChatText(value: unknown): ChatTextResult {
  if (typeof value !== 'string') return { ok: false, code: 'CHAT_INVALID' };
  if (value.length > CHAT_RAW_TEXT_MAX_LENGTH) return { ok: false, code: 'CHAT_TOO_LONG' };

  const text = normaliseChatText(value);
  if (text.length === 0) return { ok: false, code: 'CHAT_EMPTY' };
  if (text.length > CHAT_MESSAGE_MAX_LENGTH) return { ok: false, code: 'CHAT_TOO_LONG' };

  return { ok: true, text };
}
