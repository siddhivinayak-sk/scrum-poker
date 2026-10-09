import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from 'vitest';
import fc from 'fast-check';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { EMPTY } from 'rxjs';
import { RetroCard, RetroConfiguration } from '@shared/types';
import { RetroCardComponent } from './retro-card.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';

/**
 * Properties 14 and 15 — the scroll, caret and value behaviour of the retro card text
 * area, exercised through a really rendered `RetroCardComponent`.
 *
 * The test environment performs no layout, so a text area can never acquire a non-zero
 * scroll offset on its own and `scrollTop` would read 0 whatever the component did.
 * `scrollTop` is therefore re-defined on `HTMLTextAreaElement.prototype` with a
 * WeakMap-backed accessor that both *remembers* the offset (so a scroll the user
 * performed survives until something resets it) and *records every write*. The `value`
 * accessor is wrapped around the environment's own one — same semantics, writes logged.
 * Together they let the properties below distinguish "the component reset the offset"
 * from "the offset happened to be 0", and "the component left the element alone" from
 * "the component wrote the same text back".
 */

// --- DOM instrumentation -----------------------------------------------------------

interface ElementProbe {
  /** The offset the element currently reports. */
  scrollTop: number;
  /** Every value written through `el.scrollTop = …`. */
  scrollTopWrites: number[];
  /** Every value written through `el.value = …`. */
  valueWrites: string[];
}

const probes = new WeakMap<HTMLTextAreaElement, ElementProbe>();

function probeOf(el: HTMLTextAreaElement): ElementProbe {
  let probe = probes.get(el);
  if (!probe) {
    probe = { scrollTop: 0, scrollTopWrites: [], valueWrites: [] };
    probes.set(el, probe);
  }
  return probe;
}

/** Walks the prototype chain for the environment's own accessor. */
function findDescriptor(start: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = start;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

const restoreDom: (() => void)[] = [];
let valueWritesObservable = false;

beforeAll(() => {
  const proto = HTMLTextAreaElement.prototype;

  const ownScrollTop = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get(this: HTMLTextAreaElement): number {
      return probeOf(this).scrollTop;
    },
    set(this: HTMLTextAreaElement, next: number) {
      const probe = probeOf(this);
      probe.scrollTopWrites.push(next);
      probe.scrollTop = next;
    },
  });
  restoreDom.push(() => {
    if (ownScrollTop) {
      Object.defineProperty(proto, 'scrollTop', ownScrollTop);
    } else {
      Reflect.deleteProperty(proto, 'scrollTop');
    }
  });

  const valueDescriptor = findDescriptor(proto, 'value');
  const readValue = valueDescriptor?.get;
  const writeValue = valueDescriptor?.set;
  if (readValue && writeValue) {
    const ownValue = Object.getOwnPropertyDescriptor(proto, 'value');
    Object.defineProperty(proto, 'value', {
      configurable: true,
      enumerable: true,
      get(this: HTMLTextAreaElement): string {
        return readValue.call(this) as string;
      },
      set(this: HTMLTextAreaElement, next: string) {
        probeOf(this).valueWrites.push(next);
        writeValue.call(this, next);
      },
    });
    valueWritesObservable = true;
    restoreDom.push(() => {
      if (ownValue) {
        Object.defineProperty(proto, 'value', ownValue);
      } else {
        Reflect.deleteProperty(proto, 'value');
      }
    });
  }
});

afterAll(() => {
  while (restoreDom.length > 0) {
    restoreDom.pop()?.();
  }
});

/** A scroll the user performed: it moves the offset without counting as a component write. */
function scrollByUser(el: HTMLTextAreaElement, offset: number): void {
  probeOf(el).scrollTop = offset;
}

function clearProbe(el: HTMLTextAreaElement): void {
  const probe = probeOf(el);
  probe.scrollTopWrites.length = 0;
  probe.valueWrites.length = 0;
}

// --- Fixtures ----------------------------------------------------------------------

const CARD_ID = 'card-scroll-1';
const LAST_RECEIVED = 'Initial text';

function makeCard(text: string): RetroCard {
  return {
    id: CARD_ID,
    text,
    authorId: 'user-1',
    authorName: 'Alice',
    votes: 0,
    votedBy: [],
    comments: [],
    columnId: 'col-1',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

function makeConfig(fluid: boolean): RetroConfiguration {
  return {
    boardName: 'Board',
    maxVotesPerUser: 6,
    templateId: 'default',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: false,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Satisfaction'],
    fluidCardHeight: fluid,
  };
}

interface CardHarness {
  readonly textArea: HTMLTextAreaElement;
  readonly sendCardEdit: Mock;
  /** Delivers an inbound WebSocket text update for this card. */
  update(text: string): Promise<void>;
  /** Flushes change detection and the render effects it schedules. */
  settle(): Promise<void>;
  focus(): void;
  blur(): void;
  teardown(): void;
}

async function renderCard(initialText: string, fluid: boolean): Promise<CardHarness> {
  const sendCardEdit = vi.fn();
  const retroState = {
    lastAddedOwnCardId: signal<string | null>(null),
    ownNewCardIds: signal(new Set<string>()).asReadonly(),
    isCompleted: signal(false).asReadonly(),
    votingEnabled: signal(true).asReadonly(),
    votesRemaining: signal(5).asReadonly(),
    config: signal(makeConfig(fluid)).asReadonly(),
    currentUserId: signal('user-1').asReadonly(),
    isModerator: signal(false).asReadonly(),
  };
  const ws = {
    send: vi.fn(),
    on: vi.fn().mockReturnValue(EMPTY),
    sendCardEdit,
    sendCardVote: vi.fn(),
    sendCardRemove: vi.fn(),
    sendCommentAdd: vi.fn(),
    sendCommentRemove: vi.fn(),
  };

  const view = await render(RetroCardComponent, {
    inputs: { card: makeCard(initialText) },
    providers: [
      { provide: RetroStateService, useValue: retroState },
      { provide: RetroWebSocketService, useValue: ws },
    ],
  });

  const settle = async (): Promise<void> => {
    view.detectChanges();
    await view.fixture.whenStable();
  };
  await settle();

  const textArea = view.getByLabelText('Card text') as HTMLTextAreaElement;

  return {
    textArea,
    sendCardEdit,
    async update(text: string): Promise<void> {
      await view.rerender({ inputs: { card: makeCard(text) }, partialUpdate: true });
      await settle();
    },
    settle,
    // Dispatched rather than driven through `focus()`/`blur()`: the native methods are
    // no-ops in some environments and fire a second event in others, which would run
    // the blur handler twice and double any edit it sends.
    focus(): void {
      textArea.dispatchEvent(new FocusEvent('focus'));
    },
    blur(): void {
      textArea.dispatchEvent(new FocusEvent('blur'));
    },
    teardown(): void {
      view.fixture.destroy();
      TestBed.resetTestingModule();
    },
  };
}

// --- Generators --------------------------------------------------------------------

const MAX_TEXT_LENGTH = 2000;

/** Units deliberately include a single and a double line break, spaces and non-ASCII. */
const textUnitArb = fc.constantFrom('a', 'b', 'c', 'Z', ' ', '  ', '\t', '\n', '\n\n', 'é', '🙂', '.', ',');

const freeTextArb = fc
  .string({ unit: textUnitArb, minLength: 0, maxLength: 300, size: 'max' })
  .map(text => text.slice(0, MAX_TEXT_LENGTH));

/** A single word far wider than the text area, with text around it. */
const oversizedTokenTextArb = fc
  .tuple(
    fc.string({ unit: textUnitArb, maxLength: 20, size: 'max' }),
    fc.integer({ min: 60, max: 600 }),
    fc.string({ unit: textUnitArb, maxLength: 20, size: 'max' })
  )
  .map(([before, width, after]) => `${before}${'W'.repeat(width)}${after}`.slice(0, MAX_TEXT_LENGTH));

/** Paragraphs separated by runs of consecutive line breaks. */
const breakHeavyTextArb = fc
  .array(fc.string({ unit: fc.constantFrom('x', 'y', ' '), maxLength: 20, size: 'max' }), {
    minLength: 1,
    maxLength: 10,
    size: 'max',
  })
  .map(parts => parts.join('\n\n\n').slice(0, MAX_TEXT_LENGTH));

/** Texts at the top of the stated range. */
const nearMaxTextArb = fc
  .integer({ min: 1500, max: MAX_TEXT_LENGTH })
  .map(length => 'lorem ipsum '.repeat(Math.ceil(length / 12)).slice(0, length));

const cardTextArb = fc.oneof(
  { arbitrary: freeTextArb, weight: 5 },
  { arbitrary: breakHeavyTextArb, weight: 2 },
  { arbitrary: oversizedTokenTextArb, weight: 2 },
  { arbitrary: nearMaxTextArb, weight: 2 },
  { arbitrary: fc.constant(''), weight: 1 }
);

/**
 * Exact run lengths. `fc.array(…, { maxLength: n })` is subject to fast-check's own
 * sizing and would rarely reach the stated upper bound, so the length is drawn first and
 * then fixed — which also makes the coverage assertions below deterministic enough.
 */
function listOfLength(min: number, max: number): fc.Arbitrary<string[]> {
  return fc
    .integer({ min, max })
    .chain(count => fc.array(cardTextArb, { minLength: count, maxLength: count, size: 'max' }));
}

const typedEntryArb = fc
  .string({ unit: textUnitArb, minLength: 0, maxLength: 60, size: 'max' })
  .map(text => text.slice(0, 200))
  .chain(text => fc.record({ text: fc.constant(text), caret: fc.nat({ max: text.length }) }));

function hasOversizedToken(text: string): boolean {
  return text.split(/\s/).some(token => token.length >= 60);
}

// --- Property 14 -------------------------------------------------------------------

/**
 * Property 14: Unfocused card text area is pinned to its first line
 *
 * For any card text (0–2,000 characters, including consecutive line breaks and a token
 * wider than the element) and either `fluidCardHeight` value, a card text area that does
 * not hold keyboard focus reports a vertical scroll offset of 0 on first render, after
 * any inbound text update, and after focus loss, with the text unchanged by the reset.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.10**
 */
describe('Property 14: Unfocused card text area is pinned to its first line', () => {
  it(
    'reports a zero scroll offset on first render, after every inbound update and after focus loss',
    async () => {
      const seen = {
        minUpdates: Number.POSITIVE_INFINITY,
        maxUpdates: 0,
        fluidValues: new Set<boolean>(),
        consecutiveBreaks: 0,
        oversizedTokens: 0,
        longTexts: 0,
      };

      await fc.assert(
        fc.asyncProperty(
          cardTextArb,
          listOfLength(0, 5),
          fc.boolean(),
          async (initialText, updates, fluid) => {
            seen.minUpdates = Math.min(seen.minUpdates, updates.length);
            seen.maxUpdates = Math.max(seen.maxUpdates, updates.length);
            seen.fluidValues.add(fluid);
            for (const text of [initialText, ...updates]) {
              if (text.includes('\n\n')) seen.consecutiveBreaks++;
              if (hasOversizedToken(text)) seen.oversizedTokens++;
              if (text.length >= 1000) seen.longTexts++;
            }

            const harness = await renderCard(initialText, fluid);
            try {
              // First render: the first line is the topmost visible line.
              expect(harness.textArea.scrollTop).toBe(0);
              expect(harness.textArea.value).toBe(initialText);

              let latest = initialText;
              for (const next of updates) {
                // The user had scrolled this unfocused card down before the update landed.
                scrollByUser(harness.textArea, 37);
                await harness.update(next);
                latest = next;

                expect(harness.textArea.scrollTop).toBe(0);
                expect(harness.textArea.value).toBe(latest);
              }

              // Focus loss resets the offset in the same turn and leaves the text alone.
              harness.focus();
              await harness.settle();
              scrollByUser(harness.textArea, 53);
              const textAtBlur = harness.textArea.value;

              harness.blur();
              expect(harness.textArea.scrollTop).toBe(0);
              expect(harness.textArea.value).toBe(textAtBlur);

              await harness.settle();
              expect(harness.textArea.scrollTop).toBe(0);
              expect(harness.textArea.value).toBe(latest);
            } finally {
              harness.teardown();
            }
          }
        ),
        { numRuns: 100 }
      );

      // The runs actually covered the stated input space.
      expect(seen.minUpdates).toBe(0);
      expect(seen.maxUpdates).toBe(5);
      expect(seen.fluidValues.size).toBe(2);
      expect(seen.consecutiveBreaks).toBeGreaterThan(0);
      expect(seen.oversizedTokens).toBeGreaterThan(0);
      expect(seen.longTexts).toBeGreaterThan(0);
    },
    300_000
  );
});

// --- Property 15 -------------------------------------------------------------------

/**
 * Property 15: A focused card text area is never written by the component
 *
 * For any sequence of inbound card-text updates delivered while a card text area holds
 * keyboard focus, the component writes neither the scroll offset, nor the caret
 * position, nor the element value, and the edit it later sends on blur carries exactly
 * the text then present in the element.
 *
 * **Validates: Requirements 5.6, 5.8, 5.9**
 */
describe('Property 15: A focused card text area is never written by the component', () => {
  it(
    'leaves a focused text area untouched and sends the text then present on blur',
    async () => {
      const seen = {
        minInbound: Number.POSITIVE_INFINITY,
        maxInbound: 0,
        fluidValues: new Set<boolean>(),
        editsSent: 0,
        editsSkipped: 0,
        caretsInsideText: 0,
      };

      await fc.assert(
        fc.asyncProperty(
          listOfLength(1, 10),
          typedEntryArb,
          fc.boolean(),
          async (inbound, typedEntry, fluid) => {
            seen.minInbound = Math.min(seen.minInbound, inbound.length);
            seen.maxInbound = Math.max(seen.maxInbound, inbound.length);
            seen.fluidValues.add(fluid);
            if (typedEntry.caret > 0 && typedEntry.caret < typedEntry.text.length) {
              seen.caretsInsideText++;
            }

            const harness = await renderCard(LAST_RECEIVED, fluid);
            const el = harness.textArea;
            try {
              harness.focus();
              await harness.settle();

              // The user types and places the caret, then scrolls within the box.
              el.value = typedEntry.text;
              el.setSelectionRange(typedEntry.caret, typedEntry.caret);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              await harness.settle();
              scrollByUser(el, 29);

              const expectedValue = el.value;
              const expectedCaret = el.selectionStart;
              const expectedScrollTop = el.scrollTop;
              clearProbe(el);

              for (const text of inbound) {
                await harness.update(text);

                expect(el.value).toBe(expectedValue);
                expect(el.selectionStart).toBe(expectedCaret);
                expect(el.scrollTop).toBe(expectedScrollTop);
                expect(probeOf(el).scrollTopWrites).toEqual([]);
                if (valueWritesObservable) {
                  expect(probeOf(el).valueWrites).toEqual([]);
                }
              }

              // On blur the edit carries exactly the text then present in the element.
              const lastReceived = inbound[inbound.length - 1];
              const textAtBlur = el.value;
              harness.blur();

              if (textAtBlur === lastReceived) {
                seen.editsSkipped++;
                expect(harness.sendCardEdit).not.toHaveBeenCalled();
              } else {
                seen.editsSent++;
                expect(harness.sendCardEdit).toHaveBeenCalledTimes(1);
                expect(harness.sendCardEdit).toHaveBeenCalledWith(CARD_ID, textAtBlur);
              }
            } finally {
              harness.teardown();
            }
          }
        ),
        { numRuns: 100 }
      );

      expect(seen.minInbound).toBe(1);
      expect(seen.maxInbound).toBe(10);
      expect(seen.fluidValues.size).toBe(2);
      expect(seen.caretsInsideText).toBeGreaterThan(0);
      expect(seen.editsSent).toBeGreaterThan(0);
    },
    300_000
  );
});
