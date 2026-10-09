import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { RetroSessionSummary, SessionSummary, DEFAULT_SESSION_CONFIG } from '@shared/types';
import {
  RetroResumeListComponent,
  RETRO_SESSIONS_LOAD_FAILED_MESSAGE,
  RETRO_SESSIONS_TIMEOUT_MS,
} from './retro-resume-list.component';
import { SessionResumeListComponent } from '../session-resume-list/session-resume-list.component';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';

/**
 * Example tests for RetroResumeListComponent.
 *
 * Property 26 (`retro-resume-list.property.spec.ts`) already covers entry
 * rendering, ordering, the four displayed values and navigation over generated
 * summaries, so this file stays on the single-outcome cases that a generator
 * cannot express: the one authenticated request, the loading line, the two
 * render-nothing paths, the failure and timeout message, heading association
 * and distinctness, keyboard focus order and the exported constants.
 *
 * Requirements: R8.9, R8.11, R8.12, R8.15, R8.17, R8.18, R8.19, R8.20, R8.21
 */
describe('RetroResumeListComponent', () => {
  const RETRO_ENDPOINT = '/api/retro/sessions/mine';
  const POKER_ENDPOINT = '/api/sessions/mine';

  let httpTesting: HttpTestingController;
  let navigations: unknown[][];
  let storedToken: string | null;

  function configure(): void {
    navigations = [];
    storedToken = 'stored-token-abc';

    TestBed.configureTestingModule({
      imports: [RetroResumeListComponent, SessionResumeListComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { getToken: () => storedToken } },
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

    httpTesting = TestBed.inject(HttpTestingController);
  }

  /** Create the component and run the first change pass, firing the request. */
  function render(): ComponentFixture<RetroResumeListComponent> {
    const fixture = TestBed.createComponent(RetroResumeListComponent);
    fixture.detectChanges();
    return fixture;
  }

  function summary(overrides: Partial<RetroSessionSummary> = {}): RetroSessionSummary {
    return {
      sessionId: 'retro-1',
      boardName: 'Sprint 42 Retro',
      createdAt: '2026-01-15T10:00:00.000Z',
      lastActivityAt: '2026-01-15T11:30:00.000Z',
      participantCount: 4,
      cardCount: 12,
      isCompleted: false,
      ...overrides,
    };
  }

  function pokerSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
      sessionId: 'poker-1',
      createdAt: '2026-01-15T10:00:00.000Z',
      lastActivityAt: '2026-01-15T11:30:00.000Z',
      completedRounds: 3,
      participantCount: 3,
      config: DEFAULT_SESSION_CONFIG,
      ...overrides,
    };
  }

  function root(fixture: ComponentFixture<RetroResumeListComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    configure();
  });

  afterEach(() => {
    httpTesting.verify();
    vi.useRealTimers();
  });

  describe('request shape (R8.9)', () => {
    it('sends exactly one GET carrying the stored token', () => {
      render();

      const req = httpTesting.expectOne(RETRO_ENDPOINT);
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Authorization')).toBe('Bearer stored-token-abc');

      req.flush({ sessions: [summary()] });

      // A single init fires a single request.
      httpTesting.expectNone(RETRO_ENDPOINT);
    });

    it('sends no Authorization header when no token is stored', () => {
      storedToken = null;
      render();

      const req = httpTesting.expectOne(RETRO_ENDPOINT);
      expect(req.request.headers.has('Authorization')).toBe(false);
      req.flush(null, { status: 401, statusText: 'Unauthorized' });
    });
  });

  describe('loading indicator (R8.11)', () => {
    it('renders a status line in place of the list while the request is pending', () => {
      const fixture = render();

      const loading = root(fixture).querySelector('.retro-resume-list__loading');
      expect(loading).not.toBeNull();
      expect(loading?.getAttribute('role')).toBe('status');
      expect(loading?.textContent?.trim().length).toBeGreaterThan(0);

      // The list and the failure message are both absent while pending.
      expect(root(fixture).querySelector('.retro-resume-list')).toBeNull();
      expect(root(fixture).querySelector('[role="alert"]')).toBeNull();
      expect(fixture.componentInstance.loading()).toBe(true);

      httpTesting.expectOne(RETRO_ENDPOINT).flush({ sessions: [summary()] });
      fixture.detectChanges();

      expect(root(fixture).querySelector('.retro-resume-list__loading')).toBeNull();
      expect(fixture.componentInstance.loading()).toBe(false);
      expect(root(fixture).querySelectorAll('.retro-resume-list__item').length).toBe(1);
    });
  });

  describe('render-nothing paths', () => {
    it('renders nothing for a response holding zero entries (R8.17)', () => {
      const fixture = render();

      httpTesting.expectOne(RETRO_ENDPOINT).flush({ sessions: [] });
      fixture.detectChanges();

      expect(root(fixture).querySelectorAll('*').length).toBe(0);
      expect(root(fixture).textContent?.trim()).toBe('');
      expect(fixture.componentInstance.loadFailed()).toBe(false);
    });

    it('renders nothing and no failure message on 401 (R8.18)', () => {
      const fixture = render();

      httpTesting
        .expectOne(RETRO_ENDPOINT)
        .flush({ error: 'UNAUTHORIZED' }, { status: 401, statusText: 'Unauthorized' });
      fixture.detectChanges();

      expect(root(fixture).querySelectorAll('*').length).toBe(0);
      expect(root(fixture).textContent?.trim()).toBe('');
      expect(fixture.componentInstance.sessions()).toEqual([]);
      expect(fixture.componentInstance.loadFailed()).toBe(false);
      expect(fixture.componentInstance.loading()).toBe(false);
    });
  });

  describe('failure message (R8.19, R8.20)', () => {
    for (const status of [400, 403, 404, 500, 503] as const) {
      it(`renders an alert in place of the list for status ${status}`, () => {
        const fixture = render();

        httpTesting
          .expectOne(RETRO_ENDPOINT)
          .flush(null, { status, statusText: `Status ${status}` });
        fixture.detectChanges();

        const alert = root(fixture).querySelector('.retro-resume-list__error');
        expect(alert).not.toBeNull();
        expect(alert?.getAttribute('role')).toBe('alert');
        expect(alert?.textContent?.trim()).toBe(RETRO_SESSIONS_LOAD_FAILED_MESSAGE);
        expect(root(fixture).querySelector('.retro-resume-list')).toBeNull();
        expect(fixture.componentInstance.loading()).toBe(false);
      });
    }

    it('renders an alert when the request fails without a response', () => {
      const fixture = render();

      httpTesting.expectOne(RETRO_ENDPOINT).error(new ProgressEvent('error'));
      fixture.detectChanges();

      const alert = root(fixture).querySelector('.retro-resume-list__error');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(alert?.textContent?.trim()).toBe(RETRO_SESSIONS_LOAD_FAILED_MESSAGE);
      expect(fixture.componentInstance.loading()).toBe(false);
    });

    it('stops the loading indicator and renders an alert when no response arrives within 10 seconds', async () => {
      vi.useFakeTimers();

      const fixture = render();
      const req = httpTesting.expectOne(RETRO_ENDPOINT);

      await vi.advanceTimersByTimeAsync(RETRO_SESSIONS_TIMEOUT_MS - 1);
      fixture.detectChanges();

      // Still pending one millisecond short of the budget.
      expect(fixture.componentInstance.loading()).toBe(true);
      expect(root(fixture).querySelector('[role="status"]')).not.toBeNull();
      expect(root(fixture).querySelector('[role="alert"]')).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      fixture.detectChanges();

      expect(req.cancelled).toBe(true);
      expect(fixture.componentInstance.loading()).toBe(false);
      expect(root(fixture).querySelector('[role="status"]')).toBeNull();

      const alert = root(fixture).querySelector('.retro-resume-list__error');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(alert?.textContent?.trim()).toBe(RETRO_SESSIONS_LOAD_FAILED_MESSAGE);
    });
  });

  describe('heading association and distinctness (R8.12)', () => {
    it('associates the section with its visible heading', () => {
      const fixture = render();

      httpTesting.expectOne(RETRO_ENDPOINT).flush({ sessions: [summary()] });
      fixture.detectChanges();

      const section = root(fixture).querySelector('.retro-resume-list');
      expect(section).not.toBeNull();

      const labelId = section?.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();

      const heading = root(fixture).querySelector(`#${labelId}`);
      expect(heading).not.toBeNull();
      expect(heading?.tagName).toBe('H3');
      expect(heading?.textContent?.trim()).toBe('Your Retrospective Boards');
    });

    it('carries a heading and accessible name that differ from the poker session list', () => {
      const retroFixture = render();
      httpTesting.expectOne(RETRO_ENDPOINT).flush({ sessions: [summary()] });
      retroFixture.detectChanges();

      const pokerFixture = TestBed.createComponent(SessionResumeListComponent);
      pokerFixture.detectChanges();
      httpTesting.expectOne(POKER_ENDPOINT).flush({ sessions: [pokerSummary()] });
      pokerFixture.detectChanges();

      const retroRoot = root(retroFixture);
      const retroSection = retroRoot.querySelector('.retro-resume-list') as HTMLElement;
      const retroHeading = retroRoot
        .querySelector(`#${retroSection.getAttribute('aria-labelledby')}`)
        ?.textContent?.trim();

      const pokerRoot = pokerFixture.nativeElement as HTMLElement;
      const pokerSection = pokerRoot.querySelector('.session-resume-list') as HTMLElement;
      const pokerHeading = pokerRoot
        .querySelector('.session-resume-list__title')
        ?.textContent?.trim();
      // The poker list names itself with aria-label rather than a heading reference.
      const pokerAccessibleName = pokerSection.getAttribute('aria-label')?.trim();

      expect(retroHeading).toBeTruthy();
      expect(pokerHeading).toBeTruthy();
      expect(pokerAccessibleName).toBeTruthy();

      // Visible heading text differs, case aside.
      expect(retroHeading?.toLowerCase()).not.toBe(pokerHeading?.toLowerCase());
      // The accessible name — the referenced heading — differs too.
      expect(retroHeading?.toLowerCase()).not.toBe(pokerAccessibleName?.toLowerCase());
    });
  });

  describe('keyboard focus order (R8.15)', () => {
    it('renders each entry as a natively focusable button in response order', () => {
      const summaries = [
        summary({ sessionId: 'retro-a', boardName: 'Alpha' }),
        summary({ sessionId: 'retro-b', boardName: 'Beta' }),
        summary({ sessionId: 'retro-c', boardName: 'Gamma' }),
      ];

      const fixture = render();
      httpTesting.expectOne(RETRO_ENDPOINT).flush({ sessions: summaries });
      fixture.detectChanges();

      const buttons = Array.from(
        root(fixture).querySelectorAll<HTMLButtonElement>('.retro-resume-list__btn'),
      );
      expect(buttons.length).toBe(summaries.length);

      buttons.forEach((button, index) => {
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('type')).toBe('button');
        // No tabindex override, so the control sits in document order.
        expect(button.hasAttribute('tabindex')).toBe(false);
        expect(button.disabled).toBe(false);

        button.focus();
        expect(document.activeElement).toBe(button);

        expect(button.textContent).toContain(summaries[index].sessionId);
      });

      // Document order equals response order.
      const renderedIds = buttons.map(
        (button) =>
          button.querySelector('.retro-resume-list__session-id')?.textContent?.trim() ?? '',
      );
      expect(renderedIds).toEqual(summaries.map((entry) => entry.sessionId));

      // Keyboard activation of a focused button navigates (R8.15, R8.16).
      buttons[1].click();
      expect(navigations).toEqual([['/retro', 'retro-b']]);
    });
  });

  describe('sibling independence (R8.21)', () => {
    it('leaves the poker session list rendered and enabled when the retro request fails', () => {
      const retroFixture = render();
      const pokerFixture = TestBed.createComponent(SessionResumeListComponent);
      pokerFixture.detectChanges();

      httpTesting
        .expectOne(RETRO_ENDPOINT)
        .flush(null, { status: 500, statusText: 'Server Error' });
      httpTesting.expectOne(POKER_ENDPOINT).flush({ sessions: [pokerSummary()] });
      retroFixture.detectChanges();
      pokerFixture.detectChanges();

      expect(
        root(retroFixture).querySelector('.retro-resume-list__error')?.textContent?.trim(),
      ).toBe(RETRO_SESSIONS_LOAD_FAILED_MESSAGE);

      const pokerRoot = pokerFixture.nativeElement as HTMLElement;
      const pokerButtons = Array.from(
        pokerRoot.querySelectorAll<HTMLButtonElement>('.session-resume-list__btn'),
      );
      expect(pokerButtons.length).toBe(1);
      expect(pokerButtons[0].disabled).toBe(false);
      expect(pokerRoot.querySelector('.session-resume-list__error')).toBeNull();
    });
  });

  describe('exported constants', () => {
    it('declares the 10 second budget and the failure message used by the template', () => {
      expect(RETRO_SESSIONS_TIMEOUT_MS).toBe(10_000);
      expect(RETRO_SESSIONS_LOAD_FAILED_MESSAGE).toBe('Failed to load retrospective boards');

      const fixture = render();
      httpTesting.expectOne(RETRO_ENDPOINT).flush(null, { status: 500, statusText: 'Error' });
      fixture.detectChanges();

      // The rendered message is the exported constant, not a second copy.
      expect(fixture.componentInstance.loadFailedMessage).toBe(RETRO_SESSIONS_LOAD_FAILED_MESSAGE);
      expect(root(fixture).querySelector('.retro-resume-list__error')?.textContent?.trim()).toBe(
        RETRO_SESSIONS_LOAD_FAILED_MESSAGE,
      );
    });
  });
});
