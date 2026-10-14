import { Injectable, signal } from '@angular/core';

/** Tab-scoped `sessionStorage` keys (R12.2, R12.3). Nothing from this feature touches `localStorage`. */
const DISMISSAL_KEY = 'scrum-poker-callout-dismissals';
const DRAFT_KEY = 'scrum-poker-callout-draft';

/** Maximum number of Dismissal_Records retained per tab; the oldest is evicted first (R12.2). */
export const DISMISSAL_LIMIT = 50;

/** Identity of a callout for dismissal purposes. */
export type DismissedCallout = 'near' | 'far';

/**
 * One callout dismissal, keyed by the `(sessionId, roundId, callout)` triple (R12.2).
 * Carries no Ladder_Distance, score or cumulative statistic (R4.8).
 */
export interface DismissalRecord {
  readonly sessionId: string;
  readonly roundId: string;
  readonly callout: DismissedCallout;
  /** Epoch milliseconds; the explicit eviction ordering key. */
  readonly at: number;
}

/** The single retained, unsent note text of this tab (R10.13). */
export interface NoteDraft {
  readonly sessionId: string;
  /** The round the text was WRITTEN FOR, not the round currently in progress (R10.15). */
  readonly roundId: string;
  readonly text: string;
}

export type DraftEvent =
  | { kind: 'typed'; sessionId: string; roundId: string; text: string }
  | { kind: 'round-changed'; roundId: string }
  | { kind: 'submitted' } // optimistic; the draft survives until the server accepts (R10.15)
  | { kind: 'accepted' } // R10.15: cleared only after the server accepts
  | { kind: 'rejected' }
  | { kind: 'discarded' } // R10.18
  | { kind: 'session-changed'; sessionId: string } // R12.5
  | { kind: 'signed-out' }; // R12.7

/**
 * Pure transition function for the unsent-note draft.
 *
 * - `typed`: non-whitespace text is stored against the round it was typed for; text that is empty
 *   or whitespace-only clears the draft.
 * - `round-changed`: the draft is untouched. It already carries its own round id, so a new round
 *   simply no longer matches it, which is what makes it surface as an unsent note (R10.13, R10.14).
 * - `submitted`: no change. The in-flight flag is component state, and the draft must remain until
 *   the server accepts so a rejection or timeout never loses the text (R10.15).
 * - `accepted`: clears. `rejected`: keeps. `discarded`: clears (R10.18).
 * - `session-changed` / `signed-out`: clear (R12.5, R12.7).
 */
export function reduceNoteDraft(state: NoteDraft | null, event: DraftEvent): NoteDraft | null {
  switch (event.kind) {
    case 'typed':
      return event.text.trim().length > 0
        ? { sessionId: event.sessionId, roundId: event.roundId, text: event.text }
        : null;
    case 'round-changed':
    case 'submitted':
    case 'rejected':
      return state;
    case 'accepted':
    case 'discarded':
    case 'session-changed':
    case 'signed-out':
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDismissalRecord(value: unknown): value is DismissalRecord {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['roundId'] === 'string' &&
    (value['callout'] === 'near' || value['callout'] === 'far') &&
    typeof value['at'] === 'number' &&
    Number.isFinite(value['at'])
  );
}

function isNoteDraft(value: unknown): value is NoteDraft {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['roundId'] === 'string' &&
    typeof value['text'] === 'string' &&
    value['text'].trim().length > 0
  );
}

/**
 * Tab-scoped persistence for callout dismissals and the unsent-note draft.
 *
 * State lives in an in-memory mirror (signals) that is hydrated from `sessionStorage` in the
 * constructor. Every read goes through the mirror, so restore-before-evaluate (R12.9) is guaranteed
 * by injection order: anything that injects this service sees restored state on first read.
 *
 * If storage is unavailable or a write throws, the service silently stops writing and keeps
 * serving from the mirror for the lifetime of the page (R12.8). No error is surfaced.
 */
@Injectable({ providedIn: 'root' })
export class CalloutPersistenceService {
  private readonly _dismissals = signal<readonly DismissalRecord[]>([]);
  private readonly _draft = signal<NoteDraft | null>(null);
  private storageAvailable = true;

  readonly dismissals = this._dismissals.asReadonly();
  readonly draft = this._draft.asReadonly();

  constructor() {
    this.hydrate();
  }

  /** True when a Dismissal_Record exists for exactly this `(sessionId, roundId, callout)` triple (R12.3). */
  isDismissed(sessionId: string, roundId: string, callout: DismissedCallout): boolean {
    return this._dismissals().some(
      (r) => r.sessionId === sessionId && r.roundId === roundId && r.callout === callout
    );
  }

  /** Appends, then evicts oldest-first so the 50 most recent survive (R12.2). */
  recordDismissal(record: DismissalRecord): void {
    this._dismissals.update((current) => [...current, record].slice(-DISMISSAL_LIMIT));
    this.persistDismissals();
  }

  /** Applies a draft event through the reducer and persists the result (R10.13 to R10.18). */
  dispatchDraft(event: DraftEvent): void {
    const next = reduceNoteDraft(this._draft(), event);
    if (next === this._draft()) return;
    this._draft.set(next);
    this.persistDraft();
  }

  /**
   * The routed session changed (R12.5): drops the draft and prunes dismissal records that belong
   * to any other session, so nothing from a previously routed session is evaluated.
   */
  sessionChanged(sessionId: string): void {
    this.dispatchDraft({ kind: 'session-changed', sessionId });
    const kept = this._dismissals().filter((r) => r.sessionId === sessionId);
    if (kept.length !== this._dismissals().length) {
      this._dismissals.set(kept);
      this.persistDismissals();
    }
  }

  /**
   * Sign-out (R12.7): removes both keys and resets both signals. Purely local, so nothing is
   * transmitted to the server.
   */
  clearAll(): void {
    this._dismissals.set([]);
    this._draft.set(null);
    const store = this.getStorage();
    if (!store) return;
    try {
      store.removeItem(DISMISSAL_KEY);
      store.removeItem(DRAFT_KEY);
    } catch {
      this.storageAvailable = false;
    }
  }

  /** Reads `sessionStorage` at call time; null when it is unavailable or access throws. */
  private getStorage(): Storage | null {
    if (!this.storageAvailable) return null;
    try {
      return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      this.storageAvailable = false;
      return null;
    }
  }

  /** R12.9: runs once in the constructor. Malformed stored data is treated as absent. */
  private hydrate(): void {
    const store = this.getStorage();
    if (!store) {
      this.storageAvailable = false;
      return;
    }
    try {
      const rawDismissals = store.getItem(DISMISSAL_KEY);
      if (rawDismissals !== null) {
        const parsed: unknown = JSON.parse(rawDismissals);
        if (Array.isArray(parsed)) {
          this._dismissals.set(parsed.filter(isDismissalRecord).slice(-DISMISSAL_LIMIT));
        }
      }
    } catch {
      // Unparseable dismissals are treated as absent.
    }
    try {
      const rawDraft = store.getItem(DRAFT_KEY);
      if (rawDraft !== null) {
        const parsed: unknown = JSON.parse(rawDraft);
        if (isNoteDraft(parsed)) {
          this._draft.set({
            sessionId: parsed.sessionId,
            roundId: parsed.roundId,
            text: parsed.text,
          });
        }
      }
    } catch {
      // An unparseable draft is treated as absent.
    }
  }

  /** R12.8: a failed write degrades to the in-memory mirror, silently. */
  private persistDismissals(): void {
    const store = this.getStorage();
    if (!store) return;
    try {
      store.setItem(DISMISSAL_KEY, JSON.stringify(this._dismissals()));
    } catch {
      this.storageAvailable = false;
    }
  }

  private persistDraft(): void {
    const store = this.getStorage();
    if (!store) return;
    try {
      const draft = this._draft();
      if (draft === null) {
        store.removeItem(DRAFT_KEY);
      } else {
        store.setItem(DRAFT_KEY, JSON.stringify(draft));
      }
    } catch {
      this.storageAvailable = false;
    }
  }
}
