import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS, CHAT_PANEL_LOAD_RETRY_DELAYS_MS } from '@shared/types';
import { PANEL_CHUNK_LOADER_DEPS, PanelChunkLoader, PanelChunkLoaderDeps } from './panel-chunk-loader';

// Feature: session-chat, Property 39: The Panel_Chunk_Loader follows its retry schedule
// **Validates: Requirements 20.10, 20.11, 20.13, 20.14, 20.15, 20.17**

const RUNS = { numRuns: 100 };
const BASE_URL = 'https://example.test/base/chunk-IMPORTER.js';
/** The Chunk_URL that `BASE_URL` and the specifier of `readableImporter` resolve to. */
const CHUNK_URL = 'https://example.test/base/chunk-ABC123.js';
const MAX_ACTIONS = 6;
/** One idle prefetch plus one Load_Sequence per action, each with at most 1 + retries attempts. */
const MAX_CALLS = (1 + MAX_ACTIONS) * (1 + CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length);

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** How the n-th import call of the document settles, `after` ms after it was made. */
type Outcome =
  | { readonly kind: 'resolve'; readonly after: number }
  | { readonly kind: 'reject'; readonly after: number }
  | { readonly kind: 'never' };

/** `open` is a Chat_Launcher activation; `tryAgain` and `dismiss` are the notice buttons. */
type ActionKind = 'open' | 'tryAgain' | 'dismiss';

interface Action {
  readonly at: number;
  readonly kind: ActionKind;
}

interface Scenario {
  /** The importer's source holds a readable chunk specifier (else the R20.18 fallback). */
  readonly readable: boolean;
  /** `requestIdleCallback` exists and reports idle at time 0 (R20.4). */
  readonly idle: boolean;
  /** Outcome of each import call, in the order the calls are made. */
  readonly outcomes: readonly Outcome[];
  readonly actions: readonly Action[];
}

interface Snapshot {
  readonly busy: boolean;
  readonly errorShown: boolean;
  /** Index of the import call whose class is the loaded `panelClass`, or `null`. */
  readonly loaded: number | null;
  readonly calls: number;
  readonly opened: number;
}

/** One import call: when it was made and the Cache_Busted_Import URL, or `null` for the importer. */
interface CallRecord {
  readonly at: number;
  readonly url: string | null;
}

interface Step {
  readonly at: number;
  readonly action: ActionKind | null;
  readonly expected: Snapshot;
}

interface ModelResult {
  readonly steps: readonly Step[];
  readonly calls: readonly CallRecord[];
  readonly final: Snapshot;
}

// ---------------------------------------------------------------------------
// Reference scheduler
// ---------------------------------------------------------------------------

type ModelEvent =
  | { readonly at: number; readonly type: 'settle'; readonly call: number }
  | { readonly at: number; readonly type: 'timeout'; readonly call: number }
  | { readonly at: number; readonly type: 'retry'; readonly seq: number; readonly next: number };

interface ModelSequence {
  readonly id: number;
  user: boolean;
  /** Index of the latest started attempt within the sequence. */
  attempt: number;
}

/**
 * Discrete-event reference of R20.10–R20.15, R20.17 and R20.18. Returns `null` when two timed
 * events fall on the same millisecond, because their order is then not defined by the
 * requirements. Actions at time t run after every event at t, as in the test driver.
 */
function runModel(s: Scenario): ModelResult | null {
  const calls: CallRecord[] = [];
  const steps: Step[] = [];
  const callSequence: number[] = [];
  const failed = new Set<number>();
  let queue: ModelEvent[] = [];
  let now = 0;
  let loaded: number | null = null;
  let anyFailed = false;
  let retryCounter = 0;
  let busy = false;
  let errorShown = false;
  let opened = 0;
  let sequence: ModelSequence | null = null;
  let sequenceIds = 0;

  const outcomeOf = (call: number): Outcome => s.outcomes[call] ?? { kind: 'never' };
  const snapshot = (): Snapshot => ({ busy, errorShown, loaded, calls: calls.length, opened });

  function startAttempt(seq: ModelSequence, attempt: number): void {
    seq.attempt = attempt;
    const call = calls.length;
    let url: string | null = null;
    if (anyFailed && s.readable) {
      retryCounter += 1;
      url = `${CHUNK_URL}?retry=${retryCounter}`;
    }
    calls.push({ at: now, url });
    callSequence.push(seq.id);
    const outcome = outcomeOf(call);
    if (outcome.kind !== 'never') {
      queue.push({ at: now + outcome.after, type: 'settle', call });
    }
    queue.push({ at: now + CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS, type: 'timeout', call });
  }

  function startSequence(user: boolean): void {
    sequenceIds += 1;
    const seq: ModelSequence = { id: sequenceIds, user, attempt: 0 };
    sequence = seq;
    if (user) {
      busy = true;
    }
    startAttempt(seq, 0);
  }

  function endSequence(): void {
    const ended = sequence;
    if (ended !== null) {
      queue = queue.filter((e) => !(e.type === 'retry' && e.seq === ended.id));
    }
    sequence = null;
  }

  function fail(call: number): void {
    failed.add(call);
    anyFailed = true;
    // The other way this attempt could fail is now moot.
    queue = queue.filter(
      (e) => !(e.type !== 'retry' && e.call === call && (e.type === 'timeout' || outcomeOf(call).kind === 'reject')),
    );
    const seq = sequence;
    if (seq === null || seq.id !== callSequence[call]) {
      return;
    }
    if (!seq.user) {
      // A failed idle prefetch nobody adopted: no retry, no notice (R20.15).
      endSequence();
      return;
    }
    const k = seq.attempt;
    if (k < CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length) {
      queue.push({ at: now + CHAT_PANEL_LOAD_RETRY_DELAYS_MS[k], type: 'retry', seq: seq.id, next: k + 1 });
      return;
    }
    endSequence();
    busy = false;
    errorShown = true;
  }

  function succeed(call: number): void {
    loaded = call;
    errorShown = false;
    // Once loaded, no timer of the loader matters any more (R20.17).
    queue = [];
    const seq = sequence;
    if (seq !== null) {
      endSequence();
      busy = false;
      if (seq.user) {
        opened += 1;
      }
    }
  }

  function handleEvent(e: ModelEvent): void {
    if (e.type === 'retry') {
      if (sequence !== null && sequence.id === e.seq && loaded === null) {
        startAttempt(sequence, e.next);
      }
      return;
    }
    if (e.type === 'timeout') {
      if (!failed.has(e.call)) {
        fail(e.call);
      }
      return;
    }
    const outcome = outcomeOf(e.call);
    if (outcome.kind === 'resolve') {
      // A late success counts too while nothing has loaded yet (R20.10, C15).
      if (loaded === null) {
        succeed(e.call);
      }
    } else if (!failed.has(e.call)) {
      fail(e.call);
    }
  }

  function activate(): void {
    if (loaded !== null) {
      opened += 1;
      return;
    }
    if (sequence !== null && sequence.user) {
      return;
    }
    errorShown = false;
    if (sequence !== null) {
      // Adopt the running idle prefetch as the initial attempt (R20.15).
      sequence.user = true;
      busy = true;
      return;
    }
    startSequence(true);
  }

  /** Runs `kind` at `now`; `false` when its button is not shown, so nothing is done. */
  function handleAction(kind: ActionKind): boolean {
    if (kind === 'open') {
      activate();
      return true;
    }
    if (!errorShown) {
      return false;
    }
    if (kind === 'tryAgain') {
      activate();
    } else {
      errorShown = false;
    }
    return true;
  }

  if (s.idle) {
    startSequence(false);
  }
  steps.push({ at: 0, action: null, expected: snapshot() });

  const actions = [...s.actions].sort((a, b) => a.at - b.at);
  let nextAction = 0;
  for (;;) {
    let next: ModelEvent | null = null;
    for (const e of queue) {
      if (next === null || e.at < next.at) {
        next = e;
      }
    }
    const action = actions[nextAction];
    if (next !== null && (action === undefined || next.at <= action.at)) {
      const event = next;
      if (queue.some((e) => e !== event && e.at === event.at)) {
        return null;
      }
      queue = queue.filter((e) => e !== event);
      now = event.at;
      handleEvent(event);
      steps.push({ at: now, action: null, expected: snapshot() });
    } else if (action !== undefined) {
      nextAction += 1;
      now = action.at;
      if (handleAction(action.kind)) {
        steps.push({ at: now, action: action.kind, expected: snapshot() });
      }
    } else {
      break;
    }
  }
  return { steps, calls, final: snapshot() };
}

// ---------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------

interface Deferred {
  readonly promise: Promise<Type<unknown>>;
  resolve(cls: Type<unknown>): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (cls: Type<unknown>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Type<unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A real function whose source text holds a bundled-style `import("./chunk-ABC123.js")`, which
 * `resolveChunkUrl` reads, but which calls `next` instead (the `import()` is never evaluated).
 */
function readableImporter(next: () => Promise<Type<unknown>>): () => Promise<Type<unknown>> {
  return new Function('next', 'return () => (false && import("./chunk-ABC123.js"), next())')(next) as () => Promise<
    Type<unknown>
  >;
}

async function runScenario(s: Scenario, model: ModelResult): Promise<void> {
  vi.useFakeTimers();
  try {
    const t0 = Date.now();
    const log: CallRecord[] = [];
    const classes: Type<unknown>[] = [];
    const idleCallbacks: (() => void)[] = [];
    let opened = 0;

    /** Records one import call and settles it at the generated time on the fake clock. */
    const importCall = (url: string | null): Promise<Type<unknown>> => {
      const call = log.length;
      log.push({ at: Date.now() - t0, url });
      const cls: Type<unknown> = class {};
      classes.push(cls);
      const d = deferred();
      const outcome = s.outcomes[call] ?? { kind: 'never' };
      if (outcome.kind === 'resolve') {
        setTimeout(() => d.resolve(cls), outcome.after);
      } else if (outcome.kind === 'reject') {
        setTimeout(() => d.reject(new Error('chunk load failed')), outcome.after);
      }
      return d.promise;
    };

    const next = vi.fn((): Promise<Type<unknown>> => importCall(null));
    const deps: PanelChunkLoaderDeps = {
      importer: s.readable ? readableImporter(next) : next,
      baseUrl: BASE_URL,
      importUrl: vi.fn((url: string): Promise<Type<unknown>> => importCall(url)),
      timers: {
        now: () => Date.now(),
        setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
        clearTimeout: (handle: number) => window.clearTimeout(handle),
      },
      requestIdle: s.idle ? (callback) => idleCallbacks.push(callback) : null,
    };
    TestBed.configureTestingModule({ providers: [{ provide: PANEL_CHUNK_LOADER_DEPS, useValue: deps }] });
    const loader = TestBed.inject(PanelChunkLoader);
    loader.opened.subscribe(() => {
      opened += 1;
    });

    const actual = (): Snapshot => {
      const cls = loader.panelClass();
      return {
        busy: loader.busy(),
        errorShown: loader.errorShown(),
        loaded: cls === null ? null : classes.indexOf(cls),
        calls: log.length,
        opened,
      };
    };

    // The browser reports idle at time 0.
    loader.prefetchWhenIdle();
    expect(idleCallbacks).toHaveLength(s.idle ? 1 : 0);
    idleCallbacks.forEach((callback) => callback());

    let now = 0;
    for (const step of model.steps) {
      if (step.at > now) {
        await vi.advanceTimersByTimeAsync(step.at - now);
        now = step.at;
      }
      if (step.action === 'open' || step.action === 'tryAgain') {
        loader.requestOpen();
      } else if (step.action === 'dismiss') {
        loader.dismissError();
      }
      expect({ at: step.at, action: step.action, state: actual() }).toEqual({
        at: step.at,
        action: step.action,
        state: step.expected,
      });
    }

    // Nothing more happens once the model is quiet, however long the page stays open.
    await vi.advanceTimersByTimeAsync(10 * CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS);
    expect(actual()).toEqual(model.final);
    expect(log).toEqual(model.calls);

    // No URL is imported twice (R20.13).
    const urls = log.flatMap((c) => (c.url === null ? [] : [c.url]));
    expect(new Set(urls).size).toBe(urls.length);
  } finally {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 12_000 }).map((after) => ({ kind: 'reject' as const, after })) },
  { weight: 2, arbitrary: fc.constant({ kind: 'never' as const }) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 1, max: CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS - 1 })
      .map((after) => ({ kind: 'resolve' as const, after })),
  },
  {
    // Resolves after the attempt timed out (R20.10, C15).
    weight: 1,
    arbitrary: fc
      .integer({ min: CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + 1, max: 2 * CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS })
      .map((after) => ({ kind: 'resolve' as const, after })),
  },
);

const actionArb: fc.Arbitrary<Action> = fc.record({
  at: fc.integer({ min: 1, max: 80_000 }),
  kind: fc.oneof(
    { weight: 3, arbitrary: fc.constant<ActionKind>('open') },
    { weight: 2, arbitrary: fc.constant<ActionKind>('tryAgain') },
    { weight: 1, arbitrary: fc.constant<ActionKind>('dismiss') },
  ),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  readable: fc.boolean(),
  idle: fc.boolean(),
  outcomes: fc.array(outcomeArb, { minLength: MAX_CALLS, maxLength: MAX_CALLS }),
  actions: fc.array(actionArb, { maxLength: MAX_ACTIONS }),
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 39: The Panel_Chunk_Loader follows its retry schedule', () => {
  it('matches the reference scheduler for any outcomes, idle prefetch and activations', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const model = runModel(scenario);
        fc.pre(model !== null);
        if (model === null) {
          return;
        }
        await runScenario(scenario, model);
      }),
      RUNS,
    );
  }, 300_000);

  it('the reference scheduler retries 1,000 / 2,000 / 4,000 ms after each failure and caps a sequence at 4 attempts', () => {
    const model = runModel({
      readable: true,
      idle: false,
      outcomes: Array.from({ length: MAX_CALLS }, () => ({ kind: 'reject' as const, after: 100 })),
      actions: [{ at: 1, kind: 'open' }],
    });
    expect(model?.calls).toEqual([
      { at: 1, url: null },
      { at: 1101, url: `${CHUNK_URL}?retry=1` },
      { at: 3201, url: `${CHUNK_URL}?retry=2` },
      { at: 7301, url: `${CHUNK_URL}?retry=3` },
    ]);
    expect(model?.final).toEqual({ busy: false, errorShown: true, loaded: null, calls: 4, opened: 0 });
  });
});
