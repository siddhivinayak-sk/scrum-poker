import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  SessionConfiguration,
  User,
  VotingMetrics,
  VotingRound,
  ExtendedCardValue,
} from '@shared/types';
import { EXIT_REMOVAL_DEADLINE_MS } from './callout-animation';
import { stripGlyphs } from './callout-glyph';
import { COUNTDOWN_DURATION_MS, VoteCalloutLayerComponent } from './vote-callout-layer.component';
import { FarFromAveragePromptComponent } from './far-from-average-prompt.component';
import { NearAverageCalloutComponent } from './near-average-callout.component';
import { UnsentNoteComponent } from './unsent-note.component';
import { CalloutCopyStoreService } from '../../services/callout-copy-store.service';
import { CalloutPersistenceService } from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * Vote_Callout_Layer (R6.4, R6.12, R7.2, R7.5, R7.6, R7.8, R7.11, R7.12, R9.1 to R9.5, R9.8,
 * R9.11, R9.12, R12.6).
 *
 * `SessionStateService` and `WebSocketService` are minimal fakes built from signals and subjects.
 * The persistence and copy-store services are the REAL ones (jsdom-style `sessionStorage`), so the
 * dismissal records, the retained draft and the phrase memo behave exactly as in the application.
 * The three child components are real. Fake timers drive the entrance fallback, the exit
 * deadline, the viewport debounce and the countdown run.
 *
 * Geometry, paint order and contrast are not computed by the test DOM, so those facts are asserted
 * from the declared styles (see the stylesheet task) and from DOM structure only.
 */

const SESSION_ID = 'session-1';
const ROUND_ID = 'round-1';
const NEXT_ROUND_ID = 'round-2';
const VIEWER_ID = 'eve';

const USERS: readonly User[] = ['ann', 'ben', 'cy', 'dee', 'eve'].map((id) => ({
  id,
  displayName: id.charAt(0).toUpperCase() + id.slice(1),
  role: 'participant',
  isAnonymous: false,
}));

/**
 * Fibonacci ladder. The consensus anchor is the mode 8 (ben, cy), at ladder index 5.
 * Near (<= 0.75): ben 0, cy 0 (display order: Ben, Cy). Neither: ann (5) and dee (13), each 1 away.
 * Far (>= 2.0): eve (1), four steps away.
 */
const VOTES: ReadonlyArray<readonly [string, ExtendedCardValue]> = [
  ['ann', 5],
  ['ben', 8],
  ['cy', 8],
  ['dee', 13],
  ['eve', 1],
];
const NEAR_NAMES = ['Ben', 'Cy'];

const METRICS: VotingMetrics = {
  average: 7,
  mode: 8,
  spread: 12,
  distribution: { '1': 1, '5': 1, '8': 2, '13': 1 },
  outliers: [],
  numericVoteCount: 5,
  insufficientData: false,
};

const CONFIG: SessionConfiguration = {
  votingSystem: 'fibonacci',
  revealPermission: { mode: 'all-players', allowedUserIds: [] },
  issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
  autoReveal: false,
  countdownAnimation: true,
  funCallouts: true,
};

function round(id: string, status: VotingRound['status']): VotingRound {
  return {
    id,
    storyDescription: `Story ${id}`,
    status,
    selections: new Map(),
    startedAt: '2026-05-01T10:00:00.000Z',
  };
}

/** Hosts the layer the way the session page does: board content first, layer as the last child. */
@Component({
  selector: 'app-test-host',
  standalone: true,
  imports: [VoteCalloutLayerComponent],
  template: `
    <main id="main-content" tabindex="-1">
      <button type="button" class="board-control">Reveal cards</button>
      <input class="board-control board-input" aria-label="Story title" />
      <button type="button" class="board-control">Next round</button>
    </main>
    @if (showLayer()) {
      <app-vote-callout-layer sessionId="session-1" />
    }
  `,
})
class HostComponent {
  /** Turned off to emulate navigating away from the session page. */
  readonly showLayer = signal<boolean>(true);
}

interface MediaStub {
  readonly listeners: Set<(event: MediaQueryListEvent) => void>;
  setMatches(matches: boolean): void;
}

describe('VoteCalloutLayerComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  // Fake SessionStateService surface (only what the layer and its children read).
  let stateSessionId: WritableSignal<string | null>;
  let sessionConfig: WritableSignal<SessionConfiguration | null>;
  let currentRound: WritableSignal<VotingRound | null>;
  let participants: WritableSignal<User[]>;
  let metrics: WritableSignal<VotingMetrics | null>;
  let selections: WritableSignal<Map<string, ExtendedCardValue>>;
  let isRevealed: WritableSignal<boolean>;
  let countdownActive: WritableSignal<boolean>;
  let currentUser: WritableSignal<User | null>;
  let hasRevealPermission: WritableSignal<boolean>;
  let send: ReturnType<typeof vi.fn>;
  let persistence: CalloutPersistenceService;
  let copyStore: CalloutCopyStoreService;
  let media: MediaStub;
  let originalMatchMedia: PropertyDescriptor | undefined;
  let originalVisualViewport: PropertyDescriptor | undefined;
  let visualViewportListeners: Set<() => void>;
  /** Direct callers of `requestAnimationFrame`; the framework's own scheduler also appears here. */
  let rafCalls: string[];

  /** Frame requests made by the callout code itself rather than by Angular's scheduler. */
  const calloutRafCalls = (): string[] =>
    rafCalls.filter((caller) => caller.includes('/vote-callout/') && !caller.includes('.spec.'));

  const windows = (): Window[] => {
    const view = document.defaultView;
    return view !== null && view !== window ? [window, view] : [window];
  };

  function installMatchMedia(initial: boolean): MediaStub {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const state = { matches: initial };
    const list = {
      get matches(): boolean {
        return state.matches;
      },
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
        if (type === 'change') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
        if (type === 'change') listeners.delete(listener);
      },
    };
    for (const win of windows()) {
      Object.defineProperty(win, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => list,
      });
    }
    return {
      listeners,
      setMatches(matches: boolean): void {
        state.matches = matches;
        const event = Object.assign(new Event('change'), { matches }) as MediaQueryListEvent;
        for (const listener of [...listeners]) listener(event);
      },
    };
  }

  /**
   * The test DOM reports `window.visualViewport` as `undefined`, which the layer does not guard
   * against (it only handles `null`). A full-height, unzoomed viewport stands in for it.
   */
  function installVisualViewport(): Set<() => void> {
    const listeners = new Set<() => void>();
    const viewport = {
      scale: 1,
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: (_type: string, listener: () => void): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void): void => {
        listeners.delete(listener);
      },
    };
    for (const win of windows()) {
      Object.defineProperty(win, 'visualViewport', {
        configurable: true,
        writable: true,
        value: viewport,
      });
    }
    return listeners;
  }

  function mount(): void {
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    flush();
  }

  /** Change detection until effects, reconciliation and re-renders settle. */
  function flush(): void {
    for (let i = 0; i < 4; i += 1) fixture.detectChanges();
  }

  function advance(ms: number): void {
    vi.advanceTimersByTime(ms);
    flush();
  }

  function reveal(): void {
    selections.set(new Map(VOTES));
    participants.set([...USERS]);
    currentRound.set(round(ROUND_ID, 'revealed'));
    metrics.set(METRICS);
    isRevealed.set(true);
    flush();
  }

  function startNextRound(): void {
    currentRound.set(round(NEXT_ROUND_ID, 'voting'));
    metrics.set(null);
    selections.set(new Map());
    isRevealed.set(false);
    flush();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const layer = (): HTMLElement => el().querySelector<HTMLElement>('.vote-callout-layer') as HTMLElement;
  const liveRegions = (): HTMLElement[] =>
    Array.from(el().querySelectorAll<HTMLElement>('.vote-callout-layer__sr'));
  const near = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout--near');
  const far = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout--far');
  const main = (): HTMLElement => el().querySelector<HTMLElement>('#main-content') as HTMLElement;
  const boardInput = (): HTMLInputElement =>
    el().querySelector<HTMLInputElement>('.board-input') as HTMLInputElement;
  const normalise = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

  /** Keyboard tab sequence in document order; no positive tabindex is used in these fixtures. */
  function tabSequence(): HTMLElement[] {
    return Array.from(
      el().querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
    ).filter((node) => !node.hasAttribute('disabled') && node.getAttribute('tabindex') !== '-1');
  }

  function accessibleName(node: Element): string {
    return normalise(node.getAttribute('aria-label') ?? node.textContent);
  }

  /** Everything a viewer can read or operate, for before/after comparison. */
  function contentSignature(): string[] {
    const texts = (selector: string): string[] =>
      Array.from(el().querySelectorAll(selector)).map((n) => normalise(n.textContent));
    const controls = Array.from(layer().querySelectorAll('button, textarea')).map((n) =>
      [n.tagName, accessibleName(n), n.textContent === null ? '' : normalise(n.textContent)].join('|')
    );
    return [
      ...texts('.callout__phrase'),
      ...texts('.callout__name'),
      ...Array.from(el().querySelectorAll('.callout__name')).map((n) => n.getAttribute('aria-label') ?? ''),
      ...texts('.callout__summary'),
      ...liveRegions().map((n) => normalise(n.textContent)),
      ...controls,
    ];
  }

  function cssOf(component: unknown): string {
    const def = (component as { ɵcmp: { styles: readonly string[] } }).ɵcmp;
    return def.styles.join('\n');
  }

  /** Declaration block of the first rule for `selector`, tolerant of Angular's scoping attribute. */
  function rule(css: string, selector: string): string {
    const escaped = selector.replace(/[.]/g, '\\.');
    return new RegExp(`${escaped}(?:\\[[^\\]]*\\])*\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();

    originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    media = installMatchMedia(false);
    visualViewportListeners = installVisualViewport();

    rafCalls = [];
    for (const win of windows()) {
      const original = win.requestAnimationFrame?.bind(win);
      Object.defineProperty(win, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: (callback: FrameRequestCallback): number => {
          // Line 0 is the message, line 1 is this wrapper, line 2 is whoever called it.
          rafCalls.push((new Error('raf').stack ?? '').split('\n')[2] ?? '');
          return original ? original(callback) : 0;
        },
      });
    }

    stateSessionId = signal<string | null>(SESSION_ID);
    sessionConfig = signal<SessionConfiguration | null>(CONFIG);
    currentRound = signal<VotingRound | null>(round(ROUND_ID, 'voting'));
    participants = signal<User[]>([...USERS]);
    metrics = signal<VotingMetrics | null>(null);
    selections = signal<Map<string, ExtendedCardValue>>(new Map());
    isRevealed = signal<boolean>(false);
    countdownActive = signal<boolean>(false);
    currentUser = signal<User | null>(USERS.find((u) => u.id === VIEWER_ID) ?? null);
    hasRevealPermission = signal<boolean>(true);
    send = vi.fn();

    const added$ = new Subject<CalloutNoteAddedPayload>();
    const rejected$ = new Subject<CalloutNoteRejectedPayload>();

    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: SessionStateService,
          useValue: {
            stateSessionId,
            sessionConfig,
            currentRound,
            participants,
            metrics,
            selections,
            isRevealed,
            countdownActive,
            currentUser,
            hasRevealPermission,
            calloutNoteAdded$: added$.asObservable(),
            calloutNoteRejected$: rejected$.asObservable(),
          },
        },
        {
          provide: WebSocketService,
          useValue: {
            send,
            on: <T>(): Observable<T> => new Subject<T>().asObservable(),
            connectionState: signal('connected'),
          },
        },
      ],
    });
    persistence = TestBed.inject(CalloutPersistenceService);
    copyStore = TestBed.inject(CalloutCopyStoreService);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
    for (const win of windows()) {
      if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(win, 'matchMedia');
      if (originalVisualViewport) Object.defineProperty(win, 'visualViewport', originalVisualViewport);
      else Reflect.deleteProperty(win, 'visualViewport');
    }
  });

  // -------------------------------------------------------------------------------------------

  describe('live regions (R9.2, R9.3, R9.11)', () => {
    it('renders two polite, atomic status regions that are siblings of the animated subtree', () => {
      mount();

      const regions = liveRegions();
      expect(regions).toHaveLength(2);
      for (const region of regions) {
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.getAttribute('aria-atomic')).toBe('true');
        expect(region.closest('.vote-callout-layer')).toBeNull();
        expect(region.parentElement).toBe(layer().parentElement);
      }
    });

    it('is empty while nothing is shown and keeps the same nodes when callouts come and go', () => {
      mount();
      const before = liveRegions();
      expect(before.map((r) => normalise(r.textContent))).toEqual(['', '']);

      reveal();
      advance(500);
      expect(near()).not.toBeNull();
      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      const after = liveRegions();
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(after.map((r) => normalise(r.textContent))).toEqual(['', '']);
    });

    it('announces the glyph-free phrase, then every full name, in the near region', () => {
      mount();
      reveal();

      const phrase = copyStore.phraseFor('nearAverage', ROUND_ID) as string;
      const expected = `${stripGlyphs(phrase)}. ${NEAR_NAMES.join(', ')}`;
      expect(normalise(liveRegions()[0].textContent)).toBe(expected);
      // No decorative glyph reaches assistive technology.
      expect(stripGlyphs(expected)).toBe(expected);
    });

    it('announces the glyph-free far phrase in the far region only', () => {
      mount();
      reveal();

      const phrase = copyStore.phraseFor('farFromAverage', ROUND_ID) as string;
      expect(normalise(liveRegions()[1].textContent)).toBe(normalise(stripGlyphs(phrase)));
      expect(normalise(liveRegions()[0].textContent)).not.toContain(normalise(stripGlyphs(phrase)));
    });

    it('announces the "and N more" summary after the names when names are collapsed', () => {
      const crowd: User[] = Array.from({ length: 11 }, (_, i) => ({
        id: `p${i}`,
        displayName: `Person${String(i).padStart(2, '0')}`,
        role: 'participant',
        isAnonymous: false,
      }));
      mount();
      participants.set([...crowd, ...USERS]);
      selections.set(new Map([...crowd.map((u): [string, ExtendedCardValue] => [u.id, 8]), ...VOTES]));
      currentRound.set(round(ROUND_ID, 'revealed'));
      metrics.set({ ...METRICS, average: 8, numericVoteCount: 16 });
      isRevealed.set(true);
      flush();

      const text = normalise(liveRegions()[0].textContent);
      expect(text).toMatch(/and \d+ more$/);
      expect(el().querySelectorAll('.callout__name')).toHaveLength(8);
    });

    it('writes each region exactly once per appearance, however long the callouts rest', () => {
      mount();
      const regions = liveRegions();
      const observers = regions.map((region) => {
        const observer = new MutationObserver(() => undefined);
        observer.observe(region, { characterData: true, childList: true, subtree: true });
        return observer;
      });

      reveal();
      const written = observers.map((o) => o.takeRecords().length);
      expect(written).toEqual([1, 1]);

      // Staggered names, entrance fallback, idle loop and unrelated state churn: no new writes.
      advance(500);
      participants.set([...USERS]);
      selections.set(new Map(VOTES));
      flush();
      advance(60_000);

      expect(observers.map((o) => o.takeRecords().length)).toEqual([0, 0]);
      observers.forEach((o) => o.disconnect());
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('focus (R9.1, R9.8, R9.12, R7.11)', () => {
    it('leaves focus, caret and selection untouched when callouts appear, and never calls focus()', () => {
      mount();
      const input = boardInput();
      input.value = 'Planning for checkout';
      input.focus();
      input.setSelectionRange(3, 9);
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

      reveal();
      advance(1000);

      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(9);
      expect(layer().contains(document.activeElement)).toBe(false);
    });

    it('moves focus to #main-content when the focused callout is removed', () => {
      mount();
      reveal();
      advance(1000);
      const dismiss = near()?.querySelector<HTMLButtonElement>('.callout__dismiss') as HTMLButtonElement;
      dismiss.focus();
      expect(layer().contains(document.activeElement)).toBe(true);

      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(document.activeElement).toBe(main());
    });

    it('moves focus to #main-content when the focused prompt control is removed', () => {
      mount();
      reveal();
      advance(1000);
      (far()?.querySelector('textarea') as HTMLTextAreaElement).focus();
      expect(layer().contains(document.activeElement)).toBe(true);

      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(far()).toBeNull();
      expect(document.activeElement).toBe(main());
    });

    it('leaves focus, caret and selection alone when a callout is removed from elsewhere', () => {
      mount();
      reveal();
      advance(1000);
      const input = boardInput();
      input.value = 'Planning for checkout';
      input.focus();
      input.setSelectionRange(2, 7);

      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(7);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('tab order and accessible names (R9.4, R9.5, R7.11)', () => {
    beforeEach(() => {
      // A retained draft from an earlier round makes the Unsent_Note_Element appear as well.
      persistence.dispatchDraft({
        kind: 'typed',
        sessionId: SESSION_ID,
        roundId: 'older-round',
        text: 'kept from an earlier round',
      });
    });

    it('places every callout control after every board control, with no positive tabindex', () => {
      mount();
      const boardOnly = tabSequence().filter((n) => !layer().contains(n));

      reveal();
      advance(1000);
      const sequence = tabSequence();
      const inLayer = sequence.filter((n) => layer().contains(n));
      const outside = sequence.filter((n) => !layer().contains(n));

      expect(inLayer.length).toBeGreaterThanOrEqual(5);
      expect(outside).toEqual(boardOnly);
      // Callout controls form one contiguous tail of the sequence.
      expect(sequence.slice(0, outside.length)).toEqual(outside);
      expect(sequence.slice(outside.length)).toEqual(inLayer);

      for (const node of Array.from(layer().querySelectorAll('[tabindex]'))) {
        expect(Number(node.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
      }
    });

    it('exposes only buttons and the note field to the tab sequence', () => {
      mount();
      reveal();
      advance(1000);

      const tabbable = tabSequence().filter((n) => layer().contains(n));
      expect(tabbable.length).toBeGreaterThan(0);
      for (const node of tabbable) {
        expect(['BUTTON', 'TEXTAREA']).toContain(node.tagName);
      }
    });

    it('keeps the board tab sequence in its existing order when callouts come and go', () => {
      mount();
      const boardControls = (): HTMLElement[] => tabSequence().filter((n) => !layer().contains(n));
      const before = boardControls();
      expect(before).toHaveLength(3);

      reveal();
      advance(1000);
      expect(boardControls()).toEqual(before);

      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(boardControls()).toEqual(before);
    });

    it('gives every control a non-empty accessible name, unique within the layer', () => {
      mount();
      reveal();
      advance(1000);

      const controls = Array.from(layer().querySelectorAll('button, textarea'));
      expect(controls.length).toBeGreaterThanOrEqual(5);
      const names = controls.map(accessibleName);
      for (const name of names) expect(name.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    });

    it('has no axe violations for the layer with all three elements showing', async () => {
      mount();
      reveal();
      advance(1000);

      // axe schedules its own work with timers, which the fake clock would never fire.
      vi.useRealTimers();
      const results = await axe.run(layer().parentElement as HTMLElement, {
        rules: {
          // Components are tested in isolation, and the test DOM does not compute colours; the
          // contrast of the tokens is recorded in the design instead.
          region: { enabled: false },
          'color-contrast': { enabled: false },
        },
      });
      expect(results.violations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('non-blocking behaviour (R7.2, R7.8)', () => {
    it('changes neither scroll geometry nor page chrome as callouts mount and unmount', () => {
      mount();
      const doc = document.documentElement;
      const snapshot = (): unknown[] => [
        doc.scrollTop,
        doc.scrollHeight,
        document.body.scrollTop,
        document.body.scrollHeight,
        window.scrollY,
        document.body.style.overflow,
        document.documentElement.style.overflow,
        document.body.className,
      ];
      const before = snapshot();

      reveal();
      advance(1000);
      expect(snapshot()).toEqual(before);

      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(snapshot()).toEqual(before);
    });

    it('applies no inert, aria-modal, backdrop or scroll lock while callouts are showing', () => {
      persistence.dispatchDraft({
        kind: 'typed',
        sessionId: SESSION_ID,
        roundId: 'older-round',
        text: 'kept',
      });
      mount();
      reveal();
      advance(1000);

      expect(document.querySelector('[inert]')).toBeNull();
      expect(document.querySelector('[aria-modal]')).toBeNull();
      expect(el().querySelector('[class*="backdrop"], [class*="overlay"], dialog')).toBeNull();
      expect(document.body.style.overflow).toBe('');
      expect(main().hasAttribute('inert')).toBe(false);
      expect(layer().hasAttribute('inert')).toBe(false);
    });

    it('takes no pointer events on the layer or the panels, and only on the controls', () => {
      const layerCss = cssOf(VoteCalloutLayerComponent);
      const nearCss = cssOf(NearAverageCalloutComponent);
      const farCss = cssOf(FarFromAveragePromptComponent);
      const unsentCss = cssOf(UnsentNoteComponent);

      expect(rule(layerCss, '.vote-callout-layer')).toMatch(/pointer-events:\s*none/);
      expect(rule(nearCss, '.callout')).toMatch(/pointer-events:\s*none/);
      expect(rule(farCss, '.callout')).toMatch(/pointer-events:\s*none/);
      expect(rule(unsentCss, '.unsent-note')).toMatch(/pointer-events:\s*none/);

      expect(rule(nearCss, '.callout__action')).toMatch(/pointer-events:\s*auto/);
      expect(rule(farCss, '.callout__action')).toMatch(/pointer-events:\s*auto/);
      expect(rule(farCss, '.callout__input')).toMatch(/pointer-events:\s*auto/);
      expect(rule(unsentCss, '.unsent-note__action')).toMatch(/pointer-events:\s*auto/);

      // No pointer-events declaration other than `none` on a non-control selector.
      for (const css of [layerCss, nearCss, farCss, unsentCss]) {
        const autoRules = css.match(/[^{}]+\{[^}]*pointer-events:\s*auto[^}]*\}/g) ?? [];
        for (const declared of autoRules) {
          expect(declared).toMatch(/__action|__input|button|textarea/);
        }
      }
    });

    it('marks every rendered interactive element with one of the auto-pointer control classes', () => {
      persistence.dispatchDraft({
        kind: 'typed',
        sessionId: SESSION_ID,
        roundId: 'older-round',
        text: 'kept',
      });
      mount();
      reveal();
      advance(1000);

      const controls = Array.from(layer().querySelectorAll<HTMLElement>('button, textarea'));
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.className).toMatch(/callout__action|callout__input|unsent-note__action/);
      }
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('dual-panel order (R7.6)', () => {
    it('renders the near callout first, then the prompt, then the unsent note', () => {
      persistence.dispatchDraft({
        kind: 'typed',
        sessionId: SESSION_ID,
        roundId: 'older-round',
        text: 'kept',
      });
      mount();
      reveal();
      advance(1000);

      const order = Array.from(layer().children).map((child) => child.tagName.toLowerCase());
      expect(order).toEqual([
        'app-near-average-callout',
        'app-far-from-average-prompt',
        'app-unsent-note',
      ]);
      const position = (a: Element, b: Element): number => a.compareDocumentPosition(b);
      expect(position(near() as HTMLElement, far() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('stacks along the anchored edge with a gap and the near callout nearest the edge', () => {
      const css = rule(cssOf(VoteCalloutLayerComponent), '.vote-callout-layer');
      expect(css).toMatch(/flex-direction:\s*column-reverse/);
      expect(css).toMatch(/gap:\s*8px/);
    });

    it('does not mount the prompt for a viewer who is not far from the average', () => {
      currentUser.set(USERS.find((u) => u.id === 'ben') ?? null);
      mount();
      reveal();
      advance(1000);

      expect(near()).not.toBeNull();
      expect(far()).toBeNull();
      expect(normalise(liveRegions()[1].textContent)).toBe('');
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('countdown (R7.5, R7.12)', () => {
    it('shows nothing while the countdown runs and restores the callouts when it ends', () => {
      mount();
      countdownActive.set(true);
      reveal();
      advance(1000);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(layer().querySelectorAll('button, textarea')).toHaveLength(0);
      expect(liveRegions().map((r) => normalise(r.textContent))).toEqual(['', '']);

      advance(COUNTDOWN_DURATION_MS - 1001);
      expect(near()).toBeNull();

      advance(1001);
      advance(500);
      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
      expect(normalise(liveRegions()[0].textContent)).not.toBe('');
    });

    it('hides visible callouts when a countdown starts and restores them after it', () => {
      mount();
      reveal();
      advance(1000);
      expect(near()).not.toBeNull();

      countdownActive.set(true);
      flush();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(layer().querySelectorAll('button, textarea')).toHaveLength(0);

      advance(COUNTDOWN_DURATION_MS);
      advance(500);
      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
    });

    it('restores the callouts at once when the countdown flag goes inactive', () => {
      mount();
      countdownActive.set(true);
      reveal();
      advance(500);
      expect(near()).toBeNull();

      countdownActive.set(false);
      flush();
      advance(500);

      expect(near()).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('reduced motion (R6.4, R6.12)', () => {
    it('keeps text, names and controls identical to full motion', () => {
      mount();
      reveal();
      advance(1000);
      const fullMotion = contentSignature();
      expect(fullMotion.length).toBeGreaterThan(0);
      expect(layer().classList.contains('vote-callout-layer--still')).toBe(false);
      fixture.destroy();

      media = installMatchMedia(true);
      mount();
      reveal();
      advance(1000);

      expect(layer().classList.contains('vote-callout-layer--still')).toBe(true);
      expect(contentSignature()).toEqual(fullMotion);
    });

    it('applies a live OS preference change to visible callouts without losing content', () => {
      mount();
      reveal();
      advance(1000);
      expect(near()?.classList.contains('callout--idle')).toBe(true);
      const before = contentSignature();
      const nearNode = near();

      media.setMatches(true);
      flush();

      expect(layer().classList.contains('vote-callout-layer--still')).toBe(true);
      expect(near()?.classList.contains('callout--idle')).toBe(false);
      expect(near()).toBe(nearNode);
      expect(contentSignature()).toEqual(before);
      // Every control is still present and operable.
      const controls = Array.from(layer().querySelectorAll<HTMLButtonElement>('button'));
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        if (control.className.includes('--submit')) continue; // disabled until text is typed
        expect(control.disabled).toBe(false);
      }

      media.setMatches(false);
      flush();
      expect(layer().classList.contains('vote-callout-layer--still')).toBe(false);
      expect(contentSignature()).toEqual(before);
    });

    it('starts no idle loop at all while the OS preference is reduced', () => {
      media = installMatchMedia(true);
      mount();
      reveal();
      advance(60_000);

      expect(near()).not.toBeNull();
      expect(layer().querySelector('.callout--idle')).toBeNull();
    });

    it('treats funCallouts turned off as reduced motion and removes the callouts once', () => {
      mount();
      reveal();
      advance(1000);
      expect(near()).not.toBeNull();

      sessionConfig.set({ ...CONFIG, funCallouts: false });
      flush();
      expect(layer().classList.contains('vote-callout-layer--still')).toBe(true);
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(liveRegions().map((r) => normalise(r.textContent))).toEqual(['', '']);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('teardown (R12.6)', () => {
    it('leaves no pending timer and no layer frame request after destroy', () => {
      mount();
      reveal();
      // Entrance fallbacks are pending; a resize arms the viewport debounce.
      window.dispatchEvent(new Event('resize'));
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      fixture.destroy();

      expect(vi.getTimerCount()).toBe(0);
      expect(calloutRafCalls()).toEqual([]);
    });

    it('leaves no pending countdown timer after destroy', () => {
      mount();
      countdownActive.set(true);
      flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      fixture.destroy();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('requests no animation frame from the layer over its whole life', () => {
      mount();
      reveal();
      advance(1000);
      media.setMatches(true);
      flush();
      window.dispatchEvent(new Event('resize'));
      advance(500);
      startNextRound();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      fixture.destroy();

      // The spy is live (Angular's own scheduler calls it), yet none of the calls come from here.
      expect(rafCalls.length).toBeGreaterThan(0);
      expect(calloutRafCalls()).toEqual([]);
    });

    it('removes its listeners, so later preference and resize events do nothing', () => {
      mount();
      reveal();
      expect(media.listeners.size).toBe(1);
      expect(visualViewportListeners.size).toBe(1);

      fixture.destroy();
      expect(media.listeners.size).toBe(0);
      expect(visualViewportListeners.size).toBe(0);

      window.dispatchEvent(new Event('resize'));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('removes visible callouts on navigation away without playing an exit, leaving no timer', () => {
      mount();
      reveal();
      advance(1000);
      expect(near()).not.toBeNull();
      window.dispatchEvent(new Event('resize'));

      fixture.componentInstance.showLayer.set(false);
      fixture.detectChanges();

      // Gone in the same turn: no exit class, no waiting for the 700 ms deadline.
      expect(el().querySelector('.callout')).toBeNull();
      expect(el().querySelector('.callout--exiting')).toBeNull();
      expect(el().querySelector('.vote-callout-layer')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
