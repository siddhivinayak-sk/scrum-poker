/**
 * End Session on the poker page goes through the final weight gate.
 *
 * Validates: Requirements 4.4, 4.5, 4.6, 8.1, 13.4
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { Component, input, output, signal, WritableSignal } from '@angular/core';
import { ActivatedRoute, provideRouter, RouterLink } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Observable, Subject } from 'rxjs';
import { FINAL_WEIGHT_PAGE_IMPORTS, SessionPokerPageComponent } from './session-poker-page.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { EstimateExportService } from '../../services/estimate-export.service';
import {
  DEFAULT_SESSION_CONFIG,
  type ConnectionState,
  type ExtendedCardValue,
  type HistoryEntry,
  type SessionConfiguration,
  type User,
  type VotingMetrics,
  type VotingRound,
} from '@shared/types';

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
  readonly isGameOwner = input<boolean>(false);
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
@Component({ selector: 'app-vote-callout-layer', standalone: true, template: '' })
class StubVoteCalloutLayerComponent {
  readonly sessionId = input.required<string>();
}
@Component({ selector: 'app-moderator-note-balloon', standalone: true, template: '' })
class StubModeratorNoteBalloonComponent {
  readonly sessionId = input.required<string>();
}
@Component({ selector: 'app-chat-host', standalone: true, template: '' })
class StubChatHostComponent {
  readonly sessionId = input.required<string>();
}

const SESSION_ID = 'abc12345';
const MOD: User = { id: 'm', displayName: 'Mod', role: 'moderator', isAnonymous: false };
const PLAYER: User = { id: 'p', displayName: 'Pat', role: 'participant', isAnonymous: false };

describe('SessionPokerPageComponent End Session and final weight', () => {
  let fixture: ComponentFixture<SessionPokerPageComponent>;
  let http: HttpTestingController;
  let subjects: Map<string, Subject<unknown>>;
  let send: ReturnType<typeof vi.fn>;
  let enabled: WritableSignal<boolean>;
  let user: WritableSignal<User | null>;
  let revealed: WritableSignal<boolean>;
  let currentRound: WritableSignal<VotingRound | null>;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const settle = (): void => {
    for (let i = 0; i < 4; i += 1) fixture.detectChanges();
  };
  const emit = (event: string, data: unknown): void => {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  };
  const deletes = () => http.match((r) => r.method === 'DELETE');

  function build(): void {
    const config: SessionConfiguration = { ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true };
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
            send,
            on: <T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            },
            connectionState: signal<ConnectionState>('connected'),
          },
        },
        {
          provide: AuthService,
          useValue: {
            getToken: vi.fn().mockReturnValue('tok'),
            getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(MOD)),
            logout: vi.fn(),
          },
        },
        { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), toasts: signal([]) } },
        {
          provide: BasePathService,
          useValue: { getBasePath: () => '', getApiUrl: (p: string) => p },
        },
        {
          provide: SessionStateService,
          useValue: {
            stateSessionId: signal<string | null>(SESSION_ID),
            currentRound,
            participants: signal<User[]>([MOD, PLAYER]),
            sessionConfig: signal<SessionConfiguration | null>(config),
            finalWeightEnabled: enabled,
            latestAccuracy: signal(null),
            accuracyAnnounced$: new Subject().asObservable(),
            countdownActive: signal(false),
            currentUser: user,
            isRevealed: revealed,
            selections: signal(new Map<string, ExtendedCardValue>([['m', 3], ['p', 8]])),
            metrics: signal<VotingMetrics | null>(null),
            history: signal<HistoryEntry[]>([]),
            votedUserIds: signal<Set<string>>(new Set()),
            hasRevealPermission: signal(true),
            hasIssuePermission: signal(false),
            votingSystemCards: signal<ExtendedCardValue[]>([]),
            issueList: signal([]),
            ownerId: signal<string | null>(MOD.id),
            calloutNoteAdded$: new Subject().asObservable(),
            calloutNoteRejected$: new Subject().asObservable(),
          },
        },
        {
          provide: EstimateExportService,
          useValue: { inFlight: signal(false), exportEstimates: vi.fn() },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: (k: string) => (k === 'sessionId' ? SESSION_ID : null) } },
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
          StubModeratorNoteBalloonComponent,
          ...FINAL_WEIGHT_PAGE_IMPORTS,
          StubChatHostComponent,
          StubVoteCalloutLayerComponent,
        ],
      },
    });
    fixture = TestBed.createComponent(SessionPokerPageComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne(`/api/sessions/${SESSION_ID}/exists`).flush({ exists: true });
    settle();
  }

  beforeEach(() => {
    subjects = new Map();
    send = vi.fn().mockReturnValue(true);
    enabled = signal(true);
    user = signal<User | null>(MOD);
    revealed = signal(true);
    currentRound = signal<VotingRound | null>({
      id: 'r1',
      storyDescription: 'Story',
      status: 'revealed',
      selections: new Map(),
      startedAt: '2026-05-01T10:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('feature off: End Session deletes right away, no dialog, no header button', () => {
    enabled.set(false);
    build();
    expect(root().querySelector('app-final-weight-header-button button')).toBeNull();
    expect(root().querySelector('app-final-weight-dialog')).toBeNull();

    fixture.componentInstance.confirmEndSession();
    const reqs = deletes();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].request.url).toBe(`/api/sessions/${SESSION_ID}`);
    expect(send).not.toHaveBeenCalled();
  });

  it('on + moderator + revealed: opens the dialog and defers the delete until board:cleared', () => {
    build();
    expect(root().querySelector('app-final-weight-header-button button')).not.toBeNull();

    fixture.componentInstance.confirmEndSession();
    settle();
    expect(root().querySelector('.fw-dialog')).not.toBeNull();
    expect(deletes()).toHaveLength(0);

    const skip = Array.from(root().querySelectorAll('.fw-dialog button')).find(
      (b) => b.textContent?.trim() === 'Skip'
    ) as HTMLButtonElement;
    skip.click();
    settle();
    expect(send).toHaveBeenCalledWith('board:clear', {});
    expect(deletes()).toHaveLength(0);

    emit('board:cleared', {});
    expect(deletes()).toHaveLength(1);
  });

  it('delete proceeds after the 3 s clear timeout when board:cleared never arrives', () => {
    build();
    fixture.componentInstance.confirmEndSession();
    settle();
    vi.useFakeTimers();
    (Array.from(root().querySelectorAll('.fw-dialog button')).find(
      (b) => b.textContent?.trim() === 'Skip'
    ) as HTMLButtonElement).click();
    expect(deletes()).toHaveLength(0);
    vi.advanceTimersByTime(3001);
    expect(deletes()).toHaveLength(1);
  });

  it('Cancel keeps the session', () => {
    build();
    fixture.componentInstance.confirmEndSession();
    settle();
    (Array.from(root().querySelectorAll('.fw-dialog button')).find(
      (b) => b.textContent?.trim() === 'Cancel'
    ) as HTMLButtonElement).click();
    settle();
    expect(deletes()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(root().querySelector('.fw-dialog')).toBeNull();
  });

  it('non-moderator: deletes right away', () => {
    user.set(PLAYER);
    build();
    fixture.componentInstance.confirmEndSession();
    expect(deletes()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('moderator with an unrevealed round: deletes right away', () => {
    revealed.set(false);
    build();
    fixture.componentInstance.confirmEndSession();
    expect(deletes()).toHaveLength(1);
  });
});
