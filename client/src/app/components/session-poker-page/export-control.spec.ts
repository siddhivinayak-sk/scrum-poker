/**
 * Export control contract for the poker session page (Stream 1, Requirement 1).
 *
 * Covers owner-only rendering (R1.1, R1.2), the disabled state with zero
 * completed estimates and while an export request is in flight (R1.3), the
 * enabled state otherwise (R1.22), and the declared 32 px target size (R1.1).
 *
 * The client test environment performs no layout, so the target size is
 * asserted against the component's compiled style blocks — the declarations the
 * browser applies — rather than measured geometry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { Component, input, output, signal, WritableSignal } from '@angular/core';
import { ActivatedRoute, provideRouter, RouterLink } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionPokerPageComponent } from './session-poker-page.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { EstimateExportService } from '../../services/estimate-export.service';
import {
  CardValue,
  ConnectionState,
  ExtendedCardValue,
  HistoryEntry,
  SessionConfiguration,
  User,
  VotingMetrics,
  VotingRound,
} from '@shared/types';

const EXPORT_BTN = '.session-poker-page__export-btn';
const EXPORT_NAME = 'Export estimates';

// --- Declared style assertions ---

/** Minimal view of the compiled component definition's style blocks. */
interface StyledComponentType {
  readonly ɵcmp?: { readonly styles?: readonly string[] };
}

/** All compiled style blocks of the component, whitespace-normalised. */
function componentCss(): string {
  const styles = (SessionPokerPageComponent as unknown as StyledComponentType).ɵcmp?.styles ?? [];
  return styles.join('\n').replace(/\s+/g, ' ');
}

/**
 * Declaration body of the rule whose selector targets exactly `className`,
 * carrying no pseudo-class. The negative lookahead keeps a longer class name or
 * a `:disabled` / `:hover` variant from matching, and tolerates the
 * `[_ngcontent-…]` scoping attribute the compiler appends to each selector.
 */
function ruleBody(className: string): string {
  const pattern = new RegExp(`\\.${className}(?![\\w-])(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`);
  const match = pattern.exec(componentCss());
  expect(match, `no CSS rule found for .${className}`).not.toBeNull();
  return match === null ? '' : match[1];
}

// --- Child component stubs ---

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

@Component({ selector: 'app-qr-code', standalone: true, template: '' })
class StubQrCodeComponent {
  readonly url = input.required<string>();
}

@Component({ selector: 'app-session-settings-panel', standalone: true, template: '' })
class StubSessionSettingsPanelComponent {
  readonly sessionId = input<string>('');
  readonly config = input<SessionConfiguration | null>(null);
  readonly isOwner = input<boolean>(false);
}

@Component({ selector: 'app-countdown-overlay', standalone: true, template: '' })
class StubCountdownOverlayComponent {
  readonly active = input<boolean>(false);
  readonly onComplete = output<void>();
}

@Component({ selector: 'app-voting-timer-display', standalone: true, template: '' })
class StubVotingTimerDisplayComponent {
  readonly startedAt = input<string | null>(null);
  readonly revealedAt = input<string | null>(null);
}

@Component({ selector: 'app-consensus-indicator', standalone: true, template: '' })
class StubConsensusIndicatorComponent {
  readonly metrics = input<VotingMetrics | null>(null);
  readonly votingSystem = input<string>('fibonacci');
}

@Component({ selector: 'app-facilitator-flow', standalone: true, template: '' })
class StubFacilitatorFlowComponent {}

@Component({ selector: 'app-issue-list-panel', standalone: true, template: '' })
class StubIssueListPanelComponent {}

@Component({ selector: 'app-connection-status', standalone: true, template: '' })
class StubConnectionStatusComponent {
  readonly state = input.required<ConnectionState>();
}

describe('SessionPokerPageComponent export control', () => {
  const SESSION_ID = 'abc12345';
  const OWNER: User = {
    id: 'owner-1',
    displayName: 'Owner',
    role: 'moderator',
    isAnonymous: false,
  };
  const GUEST: User = {
    id: 'guest-1',
    displayName: 'Guest',
    role: 'participant',
    isAnonymous: false,
  };

  let fixture: ComponentFixture<SessionPokerPageComponent>;
  let httpTesting: HttpTestingController;

  let ownerIdSignal: WritableSignal<string | null>;
  let currentUserSignal: WritableSignal<User | null>;
  let historySignal: WritableSignal<HistoryEntry[]>;
  let inFlightSignal: WritableSignal<boolean>;
  let exportEstimates: ReturnType<typeof vi.fn>;

  function completedEstimate(roundId: string): HistoryEntry {
    return {
      roundId,
      storyDescription: `Story ${roundId}`,
      participants: [{ userId: OWNER.id, displayName: OWNER.displayName, cardValue: 5 }],
      metrics: {
        average: 5,
        mode: 5,
        spread: 0,
        distribution: { '5': 1 },
        outliers: [],
        numericVoteCount: 1,
        insufficientData: false,
      },
      completedAt: '2024-01-01T10:00:00.000Z',
    };
  }

  function exportButton(): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(EXPORT_BTN);
  }

  /** Every control in the rendered page whose accessible name is `EXPORT_NAME`. */
  function controlsNamedExport(): Element[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        `[aria-label="${EXPORT_NAME}"], [title="${EXPORT_NAME}"]`
      )
    );
  }

  function render(): void {
    fixture = TestBed.createComponent(SessionPokerPageComponent);
    httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpTesting.expectOne(`/api/sessions/${SESSION_ID}/exists`).flush({ exists: true });
    fixture.detectChanges();
  }

  beforeEach(() => {
    ownerIdSignal = signal<string | null>(OWNER.id);
    currentUserSignal = signal<User | null>(OWNER);
    historySignal = signal<HistoryEntry[]>([completedEstimate('r1')]);
    inFlightSignal = signal<boolean>(false);
    exportEstimates = vi.fn().mockResolvedValue(undefined);

    const sessionStateMock: Record<string, unknown> = {
      currentRound: signal<VotingRound | null>(null),
      participants: signal<User[]>([OWNER]),
      sessionConfig: signal<SessionConfiguration | null>(null),
      countdownActive: signal<boolean>(false),
      currentUser: currentUserSignal,
      isRevealed: signal<boolean>(false),
      selections: signal<Map<string, CardValue>>(new Map()),
      metrics: signal<VotingMetrics | null>(null),
      history: historySignal,
      votedUserIds: signal<Set<string>>(new Set()),
      hasRevealPermission: signal<boolean>(false),
      hasIssuePermission: signal<boolean>(false),
      votingSystemCards: signal<ExtendedCardValue[]>([]),
      issueList: signal([]),
      ownerId: ownerIdSignal,
    };

    TestBed.configureTestingModule({
      imports: [SessionPokerPageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WebSocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            send: vi.fn(),
            on: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
            connectionState: signal('disconnected'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            getToken: vi.fn().mockReturnValue('test-token-123'),
            getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(OWNER)),
            logout: vi.fn(),
          },
        },
        { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), toasts: signal([]) } },
        {
          provide: BasePathService,
          useValue: {
            getBasePath: vi.fn().mockReturnValue(''),
            getApiUrl: vi.fn().mockImplementation((path: string) => path),
          },
        },
        { provide: SessionStateService, useValue: sessionStateMock },
        {
          provide: EstimateExportService,
          useValue: { inFlight: inFlightSignal, exportEstimates },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: (key: string) => (key === 'sessionId' ? SESSION_ID : null) } },
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
          StubConnectionStatusComponent,
        ],
      },
    });
  });

  afterEach(() => {
    httpTesting?.verify();
  });

  // --- R1.1: owner rendering and accessible name ---

  describe('owner rendering (R1.1)', () => {
    it('renders the export control in the session header for the session owner', () => {
      render();

      const button = exportButton();
      expect(button).toBeTruthy();
      expect(button?.closest('.session-poker-page__header')).toBeTruthy();
    });

    it('names the control "Export estimates" through both aria-label and title', () => {
      render();

      const button = exportButton();
      expect(button?.getAttribute('aria-label')).toBe(EXPORT_NAME);
      expect(button?.getAttribute('title')).toBe(EXPORT_NAME);
    });

    it('activates the export service with the session id when clicked', () => {
      render();

      exportButton()?.click();

      expect(exportEstimates).toHaveBeenCalledTimes(1);
      expect(exportEstimates).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  // --- R1.2: non-owner rendering ---

  describe('non-owner rendering (R1.2)', () => {
    it('renders no control named "Export estimates" for a non-owner', () => {
      currentUserSignal.set(GUEST);
      render();

      expect(exportButton()).toBeNull();
      expect(controlsNamedExport()).toHaveLength(0);
    });

    it('renders no control named "Export estimates" while the owner is unknown', () => {
      ownerIdSignal.set(null);
      currentUserSignal.set(null);
      render();

      expect(exportButton()).toBeNull();
      expect(controlsNamedExport()).toHaveLength(0);
    });

    it('shows the control once the state reports the signed-in user as the owner', () => {
      currentUserSignal.set(GUEST);
      render();
      expect(exportButton()).toBeNull();

      ownerIdSignal.set(GUEST.id);
      fixture.detectChanges();

      expect(exportButton()).toBeTruthy();
    });
  });

  // --- R1.3 / R1.22: disabled and enabled states ---

  describe('disabled state (R1.3)', () => {
    it('disables the control while the session holds zero completed estimates', () => {
      historySignal.set([]);
      render();

      expect(exportButton()?.disabled).toBe(true);
    });

    it('sends no export request when a disabled control is activated', () => {
      historySignal.set([]);
      render();

      exportButton()?.click();

      expect(exportEstimates).not.toHaveBeenCalled();
    });

    it('disables the control while an export request is awaiting a response', () => {
      render();
      expect(exportButton()?.disabled).toBe(false);

      inFlightSignal.set(true);
      fixture.detectChanges();

      expect(exportButton()?.disabled).toBe(true);
    });

    it('sends no second request while the first is still in flight', () => {
      render();

      inFlightSignal.set(true);
      fixture.detectChanges();
      exportButton()?.click();

      expect(exportEstimates).not.toHaveBeenCalled();
    });
  });

  describe('enabled state (R1.22)', () => {
    it('enables the control with completed estimates and no request in flight', () => {
      render();

      const button = exportButton();
      expect(button?.disabled).toBe(false);
      expect(button?.hasAttribute('disabled')).toBe(false);
    });

    it('re-enables the control once the in-flight request settles', () => {
      inFlightSignal.set(true);
      render();
      expect(exportButton()?.disabled).toBe(true);

      inFlightSignal.set(false);
      fixture.detectChanges();

      expect(exportButton()?.disabled).toBe(false);
    });

    it('enables the control as soon as the first completed estimate arrives', () => {
      historySignal.set([]);
      render();
      expect(exportButton()?.disabled).toBe(true);

      historySignal.set([completedEstimate('r1')]);
      fixture.detectChanges();

      expect(exportButton()?.disabled).toBe(false);
    });
  });

  // --- R1.1: declared 32 px target size ---

  describe('declared target size (R1.1)', () => {
    it('declares a minimum width and height of at least 32 px on the export control', () => {
      const body = ruleBody('session-poker-page__export-btn');

      const minWidth = /min-width:\s*(\d+)px/.exec(body);
      const minHeight = /min-height:\s*(\d+)px/.exec(body);

      expect(minWidth, 'export control declares no px min-width').not.toBeNull();
      expect(minHeight, 'export control declares no px min-height').not.toBeNull();
      expect(Number(minWidth?.[1])).toBeGreaterThanOrEqual(32);
      expect(Number(minHeight?.[1])).toBeGreaterThanOrEqual(32);
    });

    it('declares the control as an inline flex box so the min size applies', () => {
      const body = ruleBody('session-poker-page__export-btn');

      expect(body).toMatch(/display:\s*inline-flex/);
    });
  });
});
