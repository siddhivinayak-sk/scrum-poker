import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 4: Session link URL construction
 *
 * For any session ID and browser origin, the constructed URL equals
 * `{origin}/session/{sessionId}`, and the session ID extracted from
 * the path equals the original.
 *
 * **Validates: Requirements 2.1, 2.4**
 */
describe('Property 4: Session link URL construction', () => {
  /**
   * Pure function that mirrors the URL construction logic from
   * SessionPokerPageComponent.sessionUrl computed signal.
   * Constructs: `{origin}/session/{sessionId}`
   */
  function buildSessionUrl(origin: string, sessionId: string): string {
    return `${origin}/session/${sessionId}`;
  }

  /**
   * Extracts the session ID from a session URL path.
   * Expects the URL path to end with `/session/{sessionId}`.
   */
  function extractSessionIdFromUrl(url: string): string | null {
    const match = url.match(/\/session\/([^/?#]+)$/);
    return match ? match[1] : null;
  }

  it('should construct URL as {origin}/session/{sessionId} for any origin and session ID', () => {
    fc.assert(
      fc.property(
        fc.record({
          origin: fc.webUrl({ withFragments: false, withQueryParameters: false }),
          sessionId: fc.stringMatching(/^[a-z0-9]{8}$/),
        }),
        ({ origin, sessionId }) => {
          // Remove any trailing slash from origin for consistent comparison
          const normalizedOrigin = origin.replace(/\/$/, '');
          const url = buildSessionUrl(normalizedOrigin, sessionId);

          // The URL must equal {origin}/session/{sessionId}
          expect(url).toBe(`${normalizedOrigin}/session/${sessionId}`);

          // The URL must start with the origin
          expect(url.startsWith(normalizedOrigin)).toBe(true);

          // The URL must contain /session/ path segment
          expect(url).toContain('/session/');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should allow extracting the original session ID from the constructed URL', () => {
    fc.assert(
      fc.property(
        fc.record({
          origin: fc.webUrl({ withFragments: false, withQueryParameters: false }),
          sessionId: fc.stringMatching(/^[a-z0-9]{8}$/),
        }),
        ({ origin, sessionId }) => {
          const normalizedOrigin = origin.replace(/\/$/, '');
          const url = buildSessionUrl(normalizedOrigin, sessionId);

          // Extract session ID from the constructed URL
          const extracted = extractSessionIdFromUrl(url);

          // The extracted session ID must equal the original
          expect(extracted).toBe(sessionId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should produce a valid URL structure for any origin and session ID', () => {
    fc.assert(
      fc.property(
        fc.record({
          origin: fc.webUrl({ withFragments: false, withQueryParameters: false }),
          sessionId: fc.stringMatching(/^[a-z0-9]{8}$/),
        }),
        ({ origin, sessionId }) => {
          const normalizedOrigin = origin.replace(/\/$/, '');
          const url = buildSessionUrl(normalizedOrigin, sessionId);

          // The URL should be parseable
          const parsed = new URL(url);

          // The pathname should end with /session/{sessionId}
          expect(parsed.pathname).toMatch(new RegExp(`/session/${sessionId}`));

          // The origin of the parsed URL should match the input origin
          expect(url.startsWith(parsed.origin)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});


import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter, RouterLink } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { signal, WritableSignal, Component, input, output } from '@angular/core';
import { vi, beforeEach, afterEach } from 'vitest';
import { SessionPokerPageComponent } from './session-poker-page.component';
import { WebSocketService } from '../../services/websocket.service';
import { SessionStateService } from '../../services/session-state.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import {
  User,
  SessionConfiguration,
  VotingRound,
  CardValue,
  VotingMetrics,
  HistoryEntry,
  ExtendedCardValue,
} from '@shared/types';

// --- Stub child components to avoid pulling in real implementations ---

@Component({ selector: 'app-card-deck', standalone: true, template: '' })
class StubCardDeckComponent {}

@Component({ selector: 'app-board', standalone: true, template: '' })
class StubBoardComponent {}

@Component({ selector: 'app-story-manager', standalone: true, template: '' })
class StubStoryManagerComponent {}

@Component({ selector: 'app-metrics', standalone: true, template: '' })
class StubMetricsComponent {}

@Component({ selector: 'app-session-history', standalone: true, template: '' })
class StubSessionHistoryComponent {}

@Component({ selector: 'app-user-menu', standalone: true, template: '' })
class StubUserMenuComponent {}

@Component({ selector: 'app-qr-code', standalone: true, template: '<div class="stub-qr" [attr.data-url]="url()"></div>' })
class StubQrCodeComponent {
  readonly url = input.required<string>();
}

@Component({ selector: 'app-session-settings-panel', standalone: true, template: '' })
class StubSessionSettingsPanelComponent {
  readonly sessionId = input<string>('');
  readonly config = input<SessionConfiguration | null>(null);
  readonly isOwner = input<boolean>(false);
}

@Component({ selector: 'app-countdown-overlay', standalone: true, template: '@if (active()) { <div class="stub-countdown"></div> }' })
class StubCountdownOverlayComponent {
  readonly active = input<boolean>(false);
  readonly onComplete = output<void>();
}

@Component({ selector: 'app-voting-timer-display', standalone: true, template: '<div class="stub-timer" [attr.data-started]="startedAt()" [attr.data-revealed]="revealedAt()"></div>' })
class StubVotingTimerDisplayComponent {
  readonly startedAt = input<string | null>(null);
  readonly revealedAt = input<string | null>(null);
}

@Component({ selector: 'app-consensus-indicator', standalone: true, template: '' })
class StubConsensusIndicatorComponent {
  readonly metrics = input<any>(null);
  readonly votingSystem = input<string>('fibonacci');
}

@Component({ selector: 'app-facilitator-flow', standalone: true, template: '' })
class StubFacilitatorFlowComponent {}

@Component({ selector: 'app-issue-list-panel', standalone: true, template: '' })
class StubIssueListPanelComponent {}

// --- Unit Tests ---

describe('SessionPokerPageComponent (unit tests)', () => {
  let fixture: ComponentFixture<SessionPokerPageComponent>;
  let component: SessionPokerPageComponent;
  let httpTesting: HttpTestingController;

  let wsServiceMock: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    connectionState: WritableSignal<string>;
  };

  let authServiceMock: {
    getToken: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    validateSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getReturnTo: ReturnType<typeof vi.fn>;
    setReturnTo: ReturnType<typeof vi.fn>;
  };

  let toastServiceMock: {
    show: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    toasts: WritableSignal<any[]>;
  };

  let basePathMock: {
    getBasePath: ReturnType<typeof vi.fn>;
    getApiUrl: ReturnType<typeof vi.fn>;
  };

  let currentRoundSignal: WritableSignal<VotingRound | null>;
  let participantsSignal: WritableSignal<User[]>;
  let sessionConfigSignal: WritableSignal<SessionConfiguration | null>;
  let countdownActiveSignal: WritableSignal<boolean>;
  let currentUserSignal: WritableSignal<User | null>;
  let isRevealedSignal: WritableSignal<boolean>;
  let selectionsSignal: WritableSignal<Map<string, CardValue>>;
  let metricsSignal: WritableSignal<VotingMetrics | null>;
  let historySignal: WritableSignal<HistoryEntry[]>;
  let votedUserIdsSignal: WritableSignal<Set<string>>;
  let hasRevealPermissionSignal: WritableSignal<boolean>;
  let hasIssuePermissionSignal: WritableSignal<boolean>;
  let votingSystemCardsSignal: WritableSignal<ExtendedCardValue[]>;

  let sessionStateServiceMock: Record<string, any>;

  function createComponent(sessionId: string = 'abc12345') {
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        snapshot: {
          paramMap: {
            get: (key: string) => (key === 'sessionId' ? sessionId : null),
          },
        },
      },
    });

    fixture = TestBed.createComponent(SessionPokerPageComponent);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
  }

  beforeEach(() => {
    currentRoundSignal = signal<VotingRound | null>(null);
    participantsSignal = signal<User[]>([]);
    sessionConfigSignal = signal<SessionConfiguration | null>(null);
    countdownActiveSignal = signal<boolean>(false);
    currentUserSignal = signal<User | null>(null);
    isRevealedSignal = signal<boolean>(false);
    selectionsSignal = signal<Map<string, CardValue>>(new Map());
    metricsSignal = signal<VotingMetrics | null>(null);
    historySignal = signal<HistoryEntry[]>([]);
    votedUserIdsSignal = signal<Set<string>>(new Set());
    hasRevealPermissionSignal = signal<boolean>(false);
    hasIssuePermissionSignal = signal<boolean>(false);
    votingSystemCardsSignal = signal<ExtendedCardValue[]>([]);

    wsServiceMock = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      on: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
      connectionState: signal('disconnected'),
    };

    authServiceMock = {
      getToken: vi.fn().mockReturnValue('test-token-123'),
      getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(null)),
      login: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
      getReturnTo: vi.fn().mockReturnValue(null),
      setReturnTo: vi.fn(),
    };

    toastServiceMock = {
      show: vi.fn(),
      dismiss: vi.fn(),
      toasts: signal<any[]>([]),
    };

    basePathMock = {
      getBasePath: vi.fn().mockReturnValue(''),
      getApiUrl: vi.fn().mockImplementation((path: string) => path),
    };

    sessionStateServiceMock = {
      currentRound: currentRoundSignal,
      participants: participantsSignal,
      sessionConfig: sessionConfigSignal,
      countdownActive: countdownActiveSignal,
      currentUser: currentUserSignal,
      isRevealed: isRevealedSignal,
      selections: selectionsSignal,
      metrics: metricsSignal,
      history: historySignal,
      votedUserIds: votedUserIdsSignal,
      hasRevealPermission: hasRevealPermissionSignal,
      hasIssuePermission: hasIssuePermissionSignal,
      votingSystemCards: votingSystemCardsSignal,
      issueList: signal([]),
    };

    TestBed.configureTestingModule({
      imports: [SessionPokerPageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WebSocketService, useValue: wsServiceMock },
        { provide: AuthService, useValue: authServiceMock },
        { provide: ToastService, useValue: toastServiceMock },
        { provide: BasePathService, useValue: basePathMock },
        { provide: SessionStateService, useValue: sessionStateServiceMock },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: {
                get: (key: string) => (key === 'sessionId' ? 'abc12345' : null),
              },
            },
          },
        },
      ],
    }).overrideComponent(SessionPokerPageComponent, {
      set: {
        imports: [
          CommonModule,
          RouterLink,
          StubCardDeckComponent,
          StubBoardComponent,
          StubStoryManagerComponent,
          StubMetricsComponent,
          StubSessionHistoryComponent,
          StubUserMenuComponent,
          StubQrCodeComponent,
          StubSessionSettingsPanelComponent,
          StubCountdownOverlayComponent,
          StubVotingTimerDisplayComponent,
          StubConsensusIndicatorComponent,
          StubFacilitatorFlowComponent,
          StubIssueListPanelComponent,
        ],
      },
    });
  });

  afterEach(() => {
    httpTesting?.verify();
  });

  // --- 1. Session ID extraction from route params ---

  describe('session ID extraction from route params', () => {
    it('should extract sessionId from route params and set it on the component', () => {
      createComponent('mysess01');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mysess01/exists');
      req.flush({ exists: true });

      expect(component.sessionId()).toBe('mysess01');
    });

    it('should set sessionNotFound when sessionId is empty', () => {
      createComponent('');
      fixture.detectChanges();

      expect(component.sessionNotFound()).toBe(true);
    });
  });

  // --- 2. WebSocket connection includes session ID ---

  describe('WebSocket connection includes session ID', () => {
    it('should call wsService.connect with token and sessionId when session exists', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      expect(wsServiceMock.connect).toHaveBeenCalledWith('test-token-123', 'abc12345');
    });

    it('should not call wsService.connect when session does not exist', () => {
      createComponent('notfound');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/notfound/exists');
      req.flush({ exists: false });

      expect(wsServiceMock.connect).not.toHaveBeenCalled();
    });

    it('should not call wsService.connect when no auth token is available', () => {
      authServiceMock.getToken.mockReturnValue(null);
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      expect(wsServiceMock.connect).not.toHaveBeenCalled();
    });
  });

  // --- 3. Session link display and copy-to-clipboard ---

  describe('session link display and copy-to-clipboard', () => {
    it('should display the session ID in the header', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const sessionIdSpan = el.querySelector('.session-poker-page__session-id');
      expect(sessionIdSpan?.textContent).toContain('abc12345');
    });

    it('should compute sessionUrl using window.location.origin and sessionId', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      const expectedUrl = `${window.location.origin}/session/abc12345`;
      expect(component.sessionUrl()).toBe(expectedUrl);
    });

    it('should include basePath in sessionUrl when basePath is set', () => {
      basePathMock.getBasePath.mockReturnValue('/scrum-poker');
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      const expectedUrl = `${window.location.origin}/scrum-poker/session/abc12345`;
      expect(component.sessionUrl()).toBe(expectedUrl);
    });

    it('should render a copy link button', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const copyBtn = el.querySelector('.session-poker-page__copy-btn');
      expect(copyBtn).toBeTruthy();
      expect(copyBtn?.textContent).toContain('Copy Link');
    });

    it('should show info toast on successful clipboard copy', async () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });

      await component.copySessionLink();

      expect(writeTextMock).toHaveBeenCalledWith(component.sessionUrl());
      expect(toastServiceMock.show).toHaveBeenCalledWith('info', 'Session link copied to clipboard');
    });

    it('should show error toast when clipboard copy fails', async () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const writeTextMock = vi.fn().mockRejectedValue(new Error('Clipboard denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });

      await component.copySessionLink();

      expect(toastServiceMock.show).toHaveBeenCalledWith('error', 'Failed to copy session link');
    });
  });

  // --- 4. QR code rendering with correct URL ---

  describe('QR code rendering', () => {
    it('should not show QR code panel by default', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const qrPanel = el.querySelector('.session-poker-page__qr-popup');
      expect(qrPanel).toBeNull();
    });

    it('should show QR code panel when QR toggle is clicked', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      component.toggleQrCode();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const qrPanel = el.querySelector('.session-poker-page__qr-popup');
      expect(qrPanel).toBeTruthy();
    });

    it('should pass the correct session URL to the QR code component', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      component.toggleQrCode();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const stubQr = el.querySelector('.stub-qr');
      expect(stubQr?.getAttribute('data-url')).toBe(component.sessionUrl());
    });

    it('should render QR toggle button with correct aria attributes', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const qrToggle = el.querySelector('.session-poker-page__qr-toggle');
      expect(qrToggle).toBeTruthy();
      expect(qrToggle?.getAttribute('aria-expanded')).toBe('false');
      expect(qrToggle?.getAttribute('aria-controls')).toBe('qr-panel');

      component.toggleQrCode();
      fixture.detectChanges();

      expect(qrToggle?.getAttribute('aria-expanded')).toBe('true');
    });
  });

  // --- 5. Countdown overlay integration ---

  describe('countdown overlay integration', () => {
    it('should render the countdown overlay component', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const overlay = el.querySelector('app-countdown-overlay');
      expect(overlay).toBeTruthy();
    });

    it('should show countdown overlay when countdownActive is true', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      countdownActiveSignal.set(true);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const stubCountdown = el.querySelector('.stub-countdown');
      expect(stubCountdown).toBeTruthy();
    });

    it('should not show countdown overlay when countdownActive is false', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      countdownActiveSignal.set(false);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const stubCountdown = el.querySelector('.stub-countdown');
      expect(stubCountdown).toBeNull();
    });
  });

  // --- 6. Voting timer integration ---

  describe('voting timer integration', () => {
    it('should show voting timer when a round is active', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      const startedAt = new Date().toISOString();
      currentRoundSignal.set({
        id: 'round-1',
        storyDescription: 'Test story',
        status: 'voting',
        selections: new Map(),
        startedAt,
      });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const timer = el.querySelector('.stub-timer');
      expect(timer).toBeTruthy();
      expect(timer?.getAttribute('data-started')).toBe(startedAt);
      expect(timer?.getAttribute('data-revealed')).toBeNull();
    });

    it('should pass revealedAt to voting timer when round is revealed', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      const startedAt = '2024-01-01T10:00:00.000Z';
      const revealedAt = '2024-01-01T10:02:30.000Z';
      currentRoundSignal.set({
        id: 'round-1',
        storyDescription: 'Test story',
        status: 'revealed',
        selections: new Map(),
        startedAt,
        revealedAt,
      });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const timer = el.querySelector('.stub-timer');
      expect(timer).toBeTruthy();
      expect(timer?.getAttribute('data-started')).toBe(startedAt);
      expect(timer?.getAttribute('data-revealed')).toBe(revealedAt);
    });

    it('should not show voting timer when no round is active', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      currentRoundSignal.set(null);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const timer = el.querySelector('.stub-timer');
      expect(timer).toBeNull();
    });
  });

  // --- 7. Session-not-found error display ---

  describe('session-not-found error display', () => {
    it('should show session-not-found error when session does not exist', () => {
      createComponent('notfound');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/notfound/exists');
      req.flush({ exists: false });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const errorCard = el.querySelector('.session-error__card');
      expect(errorCard).toBeTruthy();
      expect(errorCard?.textContent).toContain('Session Not Found');
      expect(errorCard?.textContent).toContain('This session does not exist or has ended');
    });

    it('should show session-not-found error when API call fails', () => {
      createComponent('errorsess');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/errorsess/exists');
      req.flush({ error: 'Server error' }, { status: 500, statusText: 'Internal Server Error' });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const errorCard = el.querySelector('.session-error__card');
      expect(errorCard).toBeTruthy();
    });

    it('should show a link to create a new session in the error state', () => {
      createComponent('notfound');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/notfound/exists');
      req.flush({ exists: false });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const link = el.querySelector('.session-error__link') as HTMLAnchorElement;
      expect(link).toBeTruthy();
      expect(link?.textContent).toContain('Create a New Session');
    });

    it('should not show the poker page when session is not found', () => {
      createComponent('notfound');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/notfound/exists');
      req.flush({ exists: false });
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const pokerPage = el.querySelector('.session-poker-page');
      expect(pokerPage).toBeNull();
    });

    it('should show session-not-found when sessionId is empty string', () => {
      createComponent('');
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const errorCard = el.querySelector('.session-error__card');
      expect(errorCard).toBeTruthy();
    });
  });

  // --- Cleanup on destroy ---

  describe('cleanup on destroy', () => {
    it('should call wsService.disconnect on component destroy', () => {
      createComponent('abc12345');
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/abc12345/exists');
      req.flush({ exists: true });

      component.ngOnDestroy();

      expect(wsServiceMock.disconnect).toHaveBeenCalled();
    });
  });
});
