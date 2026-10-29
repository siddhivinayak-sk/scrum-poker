import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  CalloutPersistenceService,
  DISMISSAL_LIMIT,
  DismissalRecord,
  DraftEvent,
  NoteDraft,
  reduceNoteDraft,
} from './callout-persistence.service';

const DISMISSAL_KEY = 'scrum-poker-callout-dismissals';
const DRAFT_KEY = 'scrum-poker-callout-draft';

function dismissal(
  sessionId: string,
  roundId: string,
  callout: 'near' | 'far',
  at: number
): DismissalRecord {
  return { sessionId, roundId, callout, at };
}

function createService(): CalloutPersistenceService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(CalloutPersistenceService);
}

interface SpiedStorage {
  readonly data: Map<string, string>;
  readonly getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  readonly setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
  readonly removeItem: ReturnType<typeof vi.fn<(key: string) => void>>;
}

/**
 * Installs an in-memory `sessionStorage` whose methods are spies, so a test can make any method
 * throw and can assert on calls. (The happy-dom storage object does not honour prototype spies.)
 */
function installSpiedSessionStorage(initial: Record<string, string> = {}): SpiedStorage {
  const data = new Map<string, string>(Object.entries(initial));
  const getItem = vi.fn((key: string): string | null => data.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string): void => {
    data.set(key, value);
  });
  const removeItem = vi.fn((key: string): void => {
    data.delete(key);
  });
  vi.stubGlobal('sessionStorage', {
    getItem,
    setItem,
    removeItem,
    clear: () => data.clear(),
  });
  return { data, getItem, setItem, removeItem };
}

describe('reduceNoteDraft', () => {
  const draft: NoteDraft = { sessionId: 's1', roundId: 'r1', text: 'I saw a risk' };

  it('typed: stores non-whitespace text against the round it was written for', () => {
    const next = reduceNoteDraft(null, {
      kind: 'typed',
      sessionId: 's1',
      roundId: 'r1',
      text: 'hello',
    });
    expect(next).toEqual({ sessionId: 's1', roundId: 'r1', text: 'hello' });
  });

  it('typed: replaces an earlier draft and does not trim the text', () => {
    const next = reduceNoteDraft(draft, {
      kind: 'typed',
      sessionId: 's1',
      roundId: 'r2',
      text: '  padded  ',
    });
    expect(next).toEqual({ sessionId: 's1', roundId: 'r2', text: '  padded  ' });
  });

  it.each(['', ' ', ' \t\n  '])('typed: empty or whitespace-only text (%j) clears the draft', (text) => {
    expect(reduceNoteDraft(draft, { kind: 'typed', sessionId: 's1', roundId: 'r1', text })).toBeNull();
    expect(reduceNoteDraft(null, { kind: 'typed', sessionId: 's1', roundId: 'r1', text })).toBeNull();
  });

  it('round-changed: keeps the draft with the round id it was written for (R10.13, R10.14)', () => {
    const next = reduceNoteDraft(draft, { kind: 'round-changed', roundId: 'r2' });
    expect(next).toBe(draft);
    expect(next?.roundId).toBe('r1');
  });

  it('round-changed: stays null when there is no draft', () => {
    expect(reduceNoteDraft(null, { kind: 'round-changed', roundId: 'r2' })).toBeNull();
  });

  it('submitted: keeps the draft until the server accepts (R10.15)', () => {
    expect(reduceNoteDraft(draft, { kind: 'submitted' })).toBe(draft);
  });

  it('accepted: clears the draft', () => {
    expect(reduceNoteDraft(draft, { kind: 'accepted' })).toBeNull();
  });

  it('rejected: keeps the draft so the text is not lost', () => {
    expect(reduceNoteDraft(draft, { kind: 'rejected' })).toBe(draft);
  });

  it('discarded: clears the draft (R10.18)', () => {
    expect(reduceNoteDraft(draft, { kind: 'discarded' })).toBeNull();
  });

  it('session-changed: clears the draft', () => {
    expect(reduceNoteDraft(draft, { kind: 'session-changed', sessionId: 's2' })).toBeNull();
  });

  it('signed-out: clears the draft (R12.7)', () => {
    expect(reduceNoteDraft(draft, { kind: 'signed-out' })).toBeNull();
  });

  it('does not mutate the state it is given', () => {
    const snapshot = { ...draft };
    const events: DraftEvent[] = [
      { kind: 'typed', sessionId: 's1', roundId: 'r9', text: 'x' },
      { kind: 'round-changed', roundId: 'r2' },
      { kind: 'accepted' },
      { kind: 'signed-out' },
    ];
    events.forEach((event) => reduceNoteDraft(draft, event));
    expect(draft).toEqual(snapshot);
  });
});

describe('CalloutPersistenceService', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  describe('construction and hydration (R12.9, R12.10)', () => {
    it('starts empty when storage holds nothing', () => {
      const service = createService();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();
    });

    it('restores dismissals and the draft before the first read', () => {
      const stored = [dismissal('s1', 'r1', 'near', 10), dismissal('s1', 'r2', 'far', 20)];
      sessionStorage.setItem(DISMISSAL_KEY, JSON.stringify(stored));
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sessionId: 's1', roundId: 'r1', text: 'unsent' })
      );

      const service = createService();

      expect(service.dismissals()).toEqual(stored);
      expect(service.isDismissed('s1', 'r1', 'near')).toBe(true);
      expect(service.isDismissed('s1', 'r2', 'far')).toBe(true);
      expect(service.draft()).toEqual({ sessionId: 's1', roundId: 'r1', text: 'unsent' });
    });

    it('keeps a restored draft attached to the round it was written for', () => {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sessionId: 's1', roundId: 'old-round', text: 'carry over' })
      );
      const service = createService();
      service.dispatchDraft({ kind: 'round-changed', roundId: 'new-round' });
      expect(service.draft()?.roundId).toBe('old-round');
      expect(service.draft()?.text).toBe('carry over');
    });

    it('restores state written by a previous instance (page reload)', () => {
      const first = createService();
      first.recordDismissal(dismissal('s1', 'r1', 'far', 5));
      first.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });

      const reloaded = createService();
      expect(reloaded.isDismissed('s1', 'r1', 'far')).toBe(true);
      expect(reloaded.draft()).toEqual({ sessionId: 's1', roundId: 'r1', text: 'draft' });
    });

    it('only the exact (sessionId, roundId, callout) triple counts as dismissed', () => {
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      expect(service.isDismissed('s1', 'r1', 'near')).toBe(true);
      expect(service.isDismissed('s1', 'r1', 'far')).toBe(false);
      expect(service.isDismissed('s1', 'r2', 'near')).toBe(false);
      expect(service.isDismissed('s2', 'r1', 'near')).toBe(false);
    });

    it('trims an over-long stored dismissal list to the 50 most recent', () => {
      const stored = Array.from({ length: DISMISSAL_LIMIT + 7 }, (_, i) =>
        dismissal('s1', `r${i}`, 'near', i)
      );
      sessionStorage.setItem(DISMISSAL_KEY, JSON.stringify(stored));
      const service = createService();
      expect(service.dismissals()).toEqual(stored.slice(-DISMISSAL_LIMIT));
    });

    it('does not use localStorage', () => {
      const local = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
      vi.stubGlobal('localStorage', local);
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'x' });
      service.sessionChanged('s2');
      service.clearAll();
      expect(local.getItem).not.toHaveBeenCalled();
      expect(local.setItem).not.toHaveBeenCalled();
      expect(local.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('malformed storage is treated as absent', () => {
    it.each(['not json', '{"a":1}', '"text"', '42', 'null'])(
      'ignores unusable dismissal payload %j',
      (raw) => {
        sessionStorage.setItem(DISMISSAL_KEY, raw);
        const service = createService();
        expect(service.dismissals()).toEqual([]);
      }
    );

    it('drops invalid entries and keeps valid ones', () => {
      const valid = dismissal('s1', 'r1', 'near', 1);
      sessionStorage.setItem(
        DISMISSAL_KEY,
        JSON.stringify([
          valid,
          null,
          'x',
          [],
          { sessionId: 's1', roundId: 'r2', callout: 'bogus', at: 2 },
          { sessionId: 's1', roundId: 'r3', callout: 'far', at: 'late' },
          { sessionId: 's1', roundId: 'r4', callout: 'far' },
          { sessionId: 1, roundId: 'r5', callout: 'far', at: 5 },
        ])
      );
      const service = createService();
      expect(service.dismissals()).toEqual([valid]);
    });

    it.each([
      'not json',
      '[]',
      'null',
      '"text"',
      JSON.stringify({ sessionId: 's1', roundId: 'r1' }),
      JSON.stringify({ sessionId: 's1', roundId: 'r1', text: 42 }),
      JSON.stringify({ sessionId: 's1', roundId: 'r1', text: '   ' }),
      JSON.stringify({ sessionId: 's1', text: 'no round' }),
    ])('ignores unusable draft payload %j', (raw) => {
      sessionStorage.setItem(DRAFT_KEY, raw);
      const service = createService();
      expect(service.draft()).toBeNull();
    });

    it('a malformed dismissal payload does not prevent the draft from restoring', () => {
      sessionStorage.setItem(DISMISSAL_KEY, '{broken');
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sessionId: 's1', roundId: 'r1', text: 'kept' })
      );
      const service = createService();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()?.text).toBe('kept');
    });

    it('strips unknown properties from a restored draft', () => {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sessionId: 's1', roundId: 'r1', text: 'hi', extra: 'ignored' })
      );
      const service = createService();
      expect(service.draft()).toEqual({ sessionId: 's1', roundId: 'r1', text: 'hi' });
    });

    it('keeps working normally after discarding malformed data', () => {
      sessionStorage.setItem(DISMISSAL_KEY, 'garbage');
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      expect(JSON.parse(sessionStorage.getItem(DISMISSAL_KEY) ?? 'null')).toEqual([
        dismissal('s1', 'r1', 'near', 1),
      ]);
    });
  });

  describe('storage that throws degrades to memory (R12.8)', () => {
    it('a throwing setItem keeps the dismissed callout withheld and surfaces no error', () => {
      const service = createService();
      const setItem = installSpiedSessionStorage().setItem.mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(() => service.recordDismissal(dismissal('s1', 'r1', 'far', 1))).not.toThrow();

      expect(setItem).toHaveBeenCalled();
      expect(service.isDismissed('s1', 'r1', 'far')).toBe(true);
      expect(service.dismissals()).toEqual([dismissal('s1', 'r1', 'far', 1)]);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it('after a failed write, later dismissals and drafts are still served from memory', () => {
      const service = createService();
      installSpiedSessionStorage().setItem.mockImplementation(() => {
        throw new Error('blocked');
      });

      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.recordDismissal(dismissal('s1', 'r2', 'far', 2));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r2', text: 'memo' });

      expect(service.isDismissed('s1', 'r1', 'near')).toBe(true);
      expect(service.isDismissed('s1', 'r2', 'far')).toBe(true);
      expect(service.draft()).toEqual({ sessionId: 's1', roundId: 'r2', text: 'memo' });
    });

    it('stops writing once storage has failed', () => {
      const service = createService();
      const setItem = installSpiedSessionStorage().setItem.mockImplementation(() => {
        throw new Error('blocked');
      });

      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      const callsAfterFirstFailure = setItem.mock.calls.length;
      service.recordDismissal(dismissal('s1', 'r2', 'near', 2));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r2', text: 'x' });

      expect(setItem.mock.calls.length).toBe(callsAfterFirstFailure);
    });

    it('a throwing draft write keeps the draft in memory', () => {
      const service = createService();
      installSpiedSessionStorage().setItem.mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(() =>
        service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'keep me' })
      ).not.toThrow();
      expect(service.draft()?.text).toBe('keep me');
    });

    it('a throwing removeItem while clearing the draft does not escape', () => {
      const service = createService();
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'x' });
      installSpiedSessionStorage().removeItem.mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(() => service.dispatchDraft({ kind: 'accepted' })).not.toThrow();
      expect(service.draft()).toBeNull();
    });

    it('a throwing getItem during construction yields an empty, working service', () => {
      installSpiedSessionStorage({
        [DISMISSAL_KEY]: JSON.stringify([dismissal('s1', 'r1', 'near', 1)]),
      }).getItem.mockImplementation(() => {
        throw new Error('blocked');
      });

      let service!: CalloutPersistenceService;
      expect(() => (service = createService())).not.toThrow();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();

      service.recordDismissal(dismissal('s1', 'r9', 'far', 9));
      expect(service.isDismissed('s1', 'r9', 'far')).toBe(true);
    });

    it('fully unavailable storage (every method throws) works from memory', () => {
      const boom = () => {
        throw new Error('SecurityError');
      };
      vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });

      let service!: CalloutPersistenceService;
      expect(() => (service = createService())).not.toThrow();

      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'mem' });
      expect(service.isDismissed('s1', 'r1', 'near')).toBe(true);
      expect(service.draft()?.text).toBe('mem');
      expect(() => service.clearAll()).not.toThrow();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();
    });

    it('missing sessionStorage works from memory', () => {
      vi.stubGlobal('sessionStorage', undefined);
      let service!: CalloutPersistenceService;
      expect(() => (service = createService())).not.toThrow();
      service.recordDismissal(dismissal('s1', 'r1', 'far', 1));
      expect(service.isDismissed('s1', 'r1', 'far')).toBe(true);
    });
  });

  describe('dispatchDraft persistence (R10.13 to R10.18)', () => {
    it('typed text is written to the draft key', () => {
      const service = createService();
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null')).toEqual({
        sessionId: 's1',
        roundId: 'r1',
        text: 'abc',
      });
    });

    it.each<[string, DraftEvent]>([
      ['accepted', { kind: 'accepted' }],
      ['discarded', { kind: 'discarded' }],
      ['signed-out', { kind: 'signed-out' }],
      ['typed whitespace', { kind: 'typed', sessionId: 's1', roundId: 'r1', text: '   ' }],
    ])('%s clears the signal and removes the draft key', (_name, event) => {
      const service = createService();
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      service.dispatchDraft(event);
      expect(service.draft()).toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it.each<[string, DraftEvent]>([
      ['submitted', { kind: 'submitted' }],
      ['rejected', { kind: 'rejected' }],
      ['round-changed', { kind: 'round-changed', roundId: 'r2' }],
    ])('%s keeps the signal and the stored draft', (_name, event) => {
      const { setItem, data } = installSpiedSessionStorage();
      const service = createService();
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      const before = service.draft();
      setItem.mockClear();
      service.dispatchDraft(event);
      expect(service.draft()).toBe(before);
      expect(setItem).not.toHaveBeenCalled();
      expect(JSON.parse(data.get(DRAFT_KEY) ?? 'null')).toEqual(before);
    });
  });

  describe('eviction at the limit (R12.2)', () => {
    it('keeps only the 50 most recent records and persists them', () => {
      const service = createService();
      const all = Array.from({ length: DISMISSAL_LIMIT + 3 }, (_, i) =>
        dismissal('s1', `r${i}`, 'near', i)
      );
      all.forEach((r) => service.recordDismissal(r));

      expect(service.dismissals()).toEqual(all.slice(-DISMISSAL_LIMIT));
      expect(service.isDismissed('s1', 'r0', 'near')).toBe(false);
      expect(service.isDismissed('s1', 'r2', 'near')).toBe(false);
      expect(service.isDismissed('s1', 'r3', 'near')).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(DISMISSAL_KEY) ?? 'null')).toEqual(
        all.slice(-DISMISSAL_LIMIT)
      );
    });
  });

  describe('sessionChanged (R12.5)', () => {
    it('clears the draft and removes its key', () => {
      const service = createService();
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      service.sessionChanged('s2');
      expect(service.draft()).toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('prunes dismissal records of other sessions and keeps the new sessionÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢s', () => {
      const service = createService();
      const keep = dismissal('s2', 'r1', 'near', 2);
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.recordDismissal(keep);
      service.recordDismissal(dismissal('s3', 'r1', 'far', 3));

      service.sessionChanged('s2');

      expect(service.dismissals()).toEqual([keep]);
      expect(service.isDismissed('s1', 'r1', 'near')).toBe(false);
      expect(service.isDismissed('s2', 'r1', 'near')).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(DISMISSAL_KEY) ?? 'null')).toEqual([keep]);
    });

    it('does not rewrite dismissals when nothing needs pruning', () => {
      const { setItem } = installSpiedSessionStorage();
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      setItem.mockClear();
      service.sessionChanged('s1');
      expect(setItem).not.toHaveBeenCalled();
      expect(service.dismissals()).toEqual([dismissal('s1', 'r1', 'near', 1)]);
    });

    it('is a harmless no-op on an empty service', () => {
      const service = createService();
      expect(() => service.sessionChanged('s1')).not.toThrow();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();
    });
  });

  describe('clearAll (R12.7)', () => {
    it('empties both signals and removes both storage keys', () => {
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      expect(sessionStorage.getItem(DISMISSAL_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();

      service.clearAll();

      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();
      expect(service.isDismissed('s1', 'r1', 'near')).toBe(false);
      expect(sessionStorage.getItem(DISMISSAL_KEY)).toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('leaves nothing for a subsequent instance to restore', () => {
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      service.clearAll();

      const reloaded = createService();
      expect(reloaded.dismissals()).toEqual([]);
      expect(reloaded.draft()).toBeNull();
    });

    it('leaves unrelated sessionStorage keys alone', () => {
      sessionStorage.setItem('other-key', 'value');
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.clearAll();
      expect(sessionStorage.getItem('other-key')).toBe('value');
    });

    it('makes no HTTP, fetch, XHR or WebSocket call', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      const fetchSpy = vi.fn();
      const wsSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      vi.stubGlobal('WebSocket', wsSpy);
      const xhrSend = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined);

      const service = TestBed.inject(CalloutPersistenceService);
      const http = TestBed.inject(HttpTestingController);
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });

      service.clearAll();

      http.verify();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(wsSpy).not.toHaveBeenCalled();
      expect(xhrSend).not.toHaveBeenCalled();
    });

    it('is safe to call twice', () => {
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.clearAll();
      expect(() => service.clearAll()).not.toThrow();
      expect(service.dismissals()).toEqual([]);
    });

    it('still empties the signals when removeItem throws', () => {
      const service = createService();
      service.recordDismissal(dismissal('s1', 'r1', 'near', 1));
      service.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'abc' });
      installSpiedSessionStorage().removeItem.mockImplementation(() => {
        throw new Error('blocked');
      });

      expect(() => service.clearAll()).not.toThrow();
      expect(service.dismissals()).toEqual([]);
      expect(service.draft()).toBeNull();
    });
  });
});
