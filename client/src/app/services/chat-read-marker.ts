import { InjectionToken } from '@angular/core';
import type { BoardKind } from '@shared/types';

/**
 * Read_Marker persistence (design "Read_Marker storage", R2.10–R2.12, R19.3, R19.7).
 *
 * The Read_Marker is the only chat value written to browser storage. It lives in `sessionStorage`
 * (tab-scoped) under `scrum-poker-chat-read:<boardKind>:<sessionId>` and holds nothing but the
 * Sequence_Number as a decimal string. Nothing here touches `localStorage` or the console.
 */

/** Prefix of every Read_Marker key. */
export const READ_MARKER_KEY_PREFIX = 'scrum-poker-chat-read';

/** The only accepted stored form: a positive decimal integer without sign, leading zeros or spaces. */
const READ_MARKER_PATTERN = /^[1-9]\d*$/;

/** The subset of `Storage` the wrapper uses, so tests can supply a fake or throwing store. */
export type ReadMarkerStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Returns the backing store, or null when there is none. It is called inside `try`, so it may
 * throw (for example a `SecurityError` from `window.sessionStorage` when storage is blocked).
 */
export type ReadMarkerStorageProvider = () => ReadMarkerStorage | null;

/** `sessionStorage` when the environment has one. Never `localStorage` (R19.7). */
export const defaultReadMarkerStorage: ReadMarkerStorageProvider = () =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage;

/** The key for one Board_Kind and Board_Session ID (R2.10). */
export function readMarkerKey(kind: BoardKind, sessionId: string): string {
  return `${READ_MARKER_KEY_PREFIX}:${kind}:${sessionId}`;
}

/** True for a positive safe integer, the only valid Read_Marker value. */
export function isValidReadMarker(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Parses a stored value. Only the decimal form of a positive safe integer is a Read_Marker;
 * anything else (null, empty, signed, zero, leading zeros, fractions, exponents, whitespace,
 * above `Number.MAX_SAFE_INTEGER`) is "no Read_Marker" and returns null (R2.11).
 */
export function parseReadMarker(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !READ_MARKER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Serialises a Read_Marker as a decimal integer string (R2.10).
 * @throws RangeError when `seq` is not a positive safe integer.
 */
export function serializeReadMarker(seq: number): string {
  if (!isValidReadMarker(seq)) {
    throw new RangeError('Read_Marker must be a positive safe integer');
  }
  return seq.toString(10);
}

/**
 * Safe `sessionStorage` wrapper for Read_Markers.
 *
 * Every storage access is inside `try/catch`. Each write is also kept in memory, and the memory
 * value wins on read, so a failed write or a later failing read never loses or lowers the marker
 * for the life of the page (R2.12). No error is thrown or shown.
 */
export class ReadMarkerStore {
  private readonly memory = new Map<string, number>();

  constructor(private readonly storage: ReadMarkerStorageProvider = defaultReadMarkerStorage) {}

  /** The Read_Marker for `(kind, sessionId)`, or null when the tab holds no valid one. */
  read(kind: BoardKind, sessionId: string): number | null {
    const key = readMarkerKey(kind, sessionId);
    const remembered = this.memory.get(key);
    if (remembered !== undefined) return remembered;
    try {
      return parseReadMarker(this.storage()?.getItem(key));
    } catch {
      return null;
    }
  }

  /**
   * Records a changed Read_Marker. Invalid values are ignored. A stored junk value is overwritten
   * here (R2.11); a throwing store leaves the value in memory only (R2.12).
   */
  write(kind: BoardKind, sessionId: string, seq: number): void {
    if (!isValidReadMarker(seq)) return;
    const key = readMarkerKey(kind, sessionId);
    this.memory.set(key, seq);
    try {
      this.storage()?.setItem(key, serializeReadMarker(seq));
    } catch {
      // Kept in memory only; no error is shown (R2.12).
    }
  }
}

/**
 * The Read_Marker store used by the chat store service. Tests override it with a
 * `ReadMarkerStore` built over a fake or throwing storage provider.
 */
export const CHAT_READ_MARKER_STORE = new InjectionToken<ReadMarkerStore>('CHAT_READ_MARKER_STORE', {
  providedIn: 'root',
  factory: () => new ReadMarkerStore(),
});
