import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import fc from 'fast-check';
import { RetroSessionSummary } from '@shared/types';
import { RetroResumeListComponent } from './retro-resume-list.component';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';

const ENDPOINT = '/api/retro/sessions/mine';

/**
 * Session identifiers as the server mints them: uuid values plus short
 * hexadecimal ids, both of which must survive rendering unchanged.
 */
const arbSessionId: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.string({
    unit: fc.constantFrom(...'0123456789abcdef'.split('')),
    minLength: 6,
    maxLength: 12,
  }),
);

/**
 * Board names of 1 through 300 characters, mixing ascii with unicode
 * graphemes and names that are nothing but whitespace.
 */
const arbBoardName: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 300, size: 'max' }) },
  {
    weight: 2,
    arbitrary: fc.string({ minLength: 1, maxLength: 300, unit: 'grapheme', size: 'max' }),
  },
  { weight: 1, arbitrary: fc.stringMatching(/^[ \t]{1,20}$/) },
);

/** ISO 8601 timestamps inside the range the endpoint can report. */
const arbIsoTimestamp: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T23:59:59.000Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

const arbSummary: fc.Arbitrary<RetroSessionSummary> = fc.record({
  sessionId: arbSessionId,
  boardName: arbBoardName,
  createdAt: arbIsoTimestamp,
  lastActivityAt: arbIsoTimestamp,
  participantCount: fc.nat({ max: 20 }),
  cardCount: fc.nat({ max: 100 }),
  isCompleted: fc.boolean(),
});

/**
 * 1 through 30 summaries. `size: 'max'` defeats the default fast-check sizing
 * that would otherwise cap the array at 10 entries and never exercise the
 * stated range.
 */
const arbSummaries: fc.Arbitrary<RetroSessionSummary[]> = fc.uniqueArray(arbSummary, {
  selector: (summary) => summary.sessionId,
  minLength: 1,
  maxLength: 30,
  size: 'max',
});

interface RenderedList {
  readonly navigations: unknown[][];
  readonly items: HTMLElement[];
  readonly destroy: () => void;
}

/**
 * Render the component against a flushed 200 response, returning the rendered
 * entries and the navigation sink.
 */
function renderList(summaries: RetroSessionSummary[]): RenderedList {
  const navigations: unknown[][] = [];

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RetroResumeListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { getToken: () => 'token-abc' } },
      {
        provide: BasePathService,
        useValue: { getBasePath: () => '', getApiUrl: (path: string) => path },
      },
      {
        provide: Router,
        useValue: {
          navigate: (commands: unknown[]) => {
            navigations.push(commands);
            return Promise.resolve(true);
          },
        },
      },
    ],
  });

  const httpTesting = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(RetroResumeListComponent);
  fixture.detectChanges();

  httpTesting.expectOne(ENDPOINT).flush({ sessions: summaries });
  fixture.detectChanges();
  httpTesting.verify();

  const items = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      '.retro-resume-list__item',
    ),
  );

  return { navigations, items, destroy: () => fixture.destroy() };
}

function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  expect(element, `expected ${selector} inside entry`).not.toBeNull();
  return element as HTMLElement;
}

/**
 * Property 26: Retro session list entries render and navigate
 *
 * For any array of retro session summaries, the lobby renders one focusable
 * control per summary in response order, each displaying the board name,
 * session id, creation timestamp and last-activity timestamp, exposing the
 * complete board name as both `title` and accessible name, and activating a
 * navigation to `/retro/<sessionId>`.
 *
 * **Validates: Requirements 8.10, 8.13, 8.14, 8.16**
 */
describe('Property 26: retro session list entries render and navigate', () => {
  /**
   * Each of the 100 runs tears down and rebuilds the testing module and renders
   * up to 30 entries, so the whole property needs far more than the 5 second
   * default per-test budget. The timeout is raised rather than the run count or
   * the entry range lowered, which would weaken the property.
   */
  it('renders one control per summary in response order, shows all four values, exposes the full board name and navigates on activation', () => {
    let maxEntryCount = 0;
    let minEntryCount = Number.POSITIVE_INFINITY;
    let maxBoardNameLength = 0;
    let longBoardNameRuns = 0;

    fc.assert(
      fc.property(arbSummaries, (summaries) => {
        maxEntryCount = Math.max(maxEntryCount, summaries.length);
        minEntryCount = Math.min(minEntryCount, summaries.length);
        for (const summary of summaries) {
          maxBoardNameLength = Math.max(maxBoardNameLength, summary.boardName.length);
          if (summary.boardName.length > 100) {
            longBoardNameRuns += 1;
          }
        }

        const { navigations, items, destroy } = renderList(summaries);

        try {
          // One entry per summary (R8.10).
          expect(items.length).toBe(summaries.length);

          // Order matches the response order (R8.10).
          const renderedIds = items.map(
            (item) => requireElement(item, '.retro-resume-list__session-id').textContent,
          );
          expect(renderedIds).toEqual(summaries.map((summary) => summary.sessionId));

          summaries.forEach((summary, index) => {
            const item = items[index];

            // All four values appear in the entry (R8.13).
            const boardName = requireElement(item, '.retro-resume-list__board-name');
            expect(boardName.textContent).toBe(summary.boardName);

            const created = requireElement(item, '.retro-resume-list__created');
            expect(created.getAttribute('datetime')).toBe(summary.createdAt);
            expect(created.textContent?.trim().length).toBeGreaterThan(0);

            const activity = requireElement(item, '.retro-resume-list__activity');
            expect(activity.getAttribute('datetime')).toBe(summary.lastActivityAt);
            expect(activity.textContent?.trim().length).toBeGreaterThan(0);

            // title === accessible name === the complete board name (R8.14).
            expect(boardName.getAttribute('title')).toBe(summary.boardName);
            expect(boardName.getAttribute('aria-label')).toBe(summary.boardName);

            // The entry is a focusable, activatable control (R8.15).
            const button = requireElement(item, '.retro-resume-list__btn');
            expect(button.tagName).toBe('BUTTON');
            expect(button.hasAttribute('disabled')).toBe(false);
          });

          // Activation navigates to /retro/<sessionId> (R8.16).
          for (const item of items) {
            requireElement(item, '.retro-resume-list__btn').click();
          }
          expect(navigations).toEqual(
            summaries.map((summary) => ['/retro', summary.sessionId]),
          );
        } finally {
          destroy();
        }
      }),
      { numRuns: 100 },
    );

    // Fail loudly if the generators collapsed below the stated ranges.
    expect(maxEntryCount).toBeGreaterThanOrEqual(20);
    expect(minEntryCount).toBeLessThanOrEqual(3);
    expect(maxBoardNameLength).toBeGreaterThanOrEqual(150);
    expect(longBoardNameRuns).toBeGreaterThan(0);
  }, 120_000);
});
