import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { CardDeckComponent } from '../card-deck/card-deck.component';
import { BoardComponent } from '../board/board.component';
import { StoryManagerComponent } from '../story-manager/story-manager.component';
import { MetricsComponent } from '../metrics/metrics.component';
import { SessionHistoryComponent } from '../session-history/session-history.component';
import { UserMenuComponent } from '../user-menu/user-menu.component';
import { QrCodeDisplayComponent } from '../qr-code/qr-code.component';
import { SessionSettingsPanelComponent } from '../session-settings/session-settings-panel.component';
import { CountdownOverlayComponent } from '../countdown-overlay/countdown-overlay.component';
import { VotingTimerDisplayComponent } from '../voting-timer/voting-timer-display.component';
import { ConsensusIndicatorComponent } from '../consensus-indicator/consensus-indicator.component';
import { FacilitatorFlowComponent } from '../facilitator-flow/facilitator-flow.component';
import { IssueListPanelComponent } from '../issue-list-panel/issue-list-panel.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';

@Component({
  selector: 'app-session-poker-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CardDeckComponent,
    BoardComponent,
    StoryManagerComponent,
    MetricsComponent,
    SessionHistoryComponent,
    UserMenuComponent,
    QrCodeDisplayComponent,
    SessionSettingsPanelComponent,
    CountdownOverlayComponent,
    VotingTimerDisplayComponent,
    ConsensusIndicatorComponent,
    FacilitatorFlowComponent,
    IssueListPanelComponent,
  ],
  template: `
    @if (sessionNotFound()) {
      <div class="session-error">
        <div class="session-error__card">
          <h1>Session Not Found</h1>
          <p>This session does not exist or has ended.</p>
          <a routerLink="/create-session" class="session-error__link">Create a New Session</a>
        </div>
      </div>
    } @else {
      <div class="session-poker-page">
        <header class="session-poker-page__header">
          <button
            class="session-poker-page__lobby-btn"
            type="button"
            title="Back to Lobby"
            aria-label="Back to Lobby"
            (click)="goToLobby()"
          >🏠</button>
          <h1>{{ sessionState.sessionConfig()?.gameName || 'Scrum Poker' }}</h1>
          @if (currentRoundStartedAt()) {
            <app-voting-timer-display
              [startedAt]="currentRoundStartedAt()"
              [revealedAt]="currentRoundRevealedAt()"
            />
          }
          <div class="session-poker-page__header-right">
            <span class="session-poker-page__session-id">Session: {{ sessionId() }}</span>
            @if (isSessionOwner()) {
              <button
                class="session-poker-page__end-btn"
                (click)="showEndSessionDialog.set(true)"
                aria-label="End session"
                title="End this session"
              >
                End Session
              </button>
            }
            <button
              class="session-poker-page__copy-btn"
              (click)="copySessionLink()"
              aria-label="Copy session link to clipboard"
              title="Copy session link to clipboard"
            >
              Copy Link
            </button>
            <button
              class="session-poker-page__qr-toggle"
              (click)="toggleQrCode()"
              [attr.aria-expanded]="showQrCode()"
              aria-controls="qr-panel"
              aria-label="Toggle QR code display"
              title="Show QR code"
            >
              QR Code
            </button>
            <app-session-settings-panel
              [sessionId]="sessionId()"
              [config]="sessionState.sessionConfig()"
              [isOwner]="isSessionOwner()"
            />
            <app-user-menu />
          </div>
        </header>

        @if (showQrCode()) {
          <div class="session-poker-page__qr-backdrop" (click)="toggleQrCode()" aria-hidden="true"></div>
          <div id="qr-panel" class="session-poker-page__qr-popup" role="dialog" aria-label="QR code for session link">
            <app-qr-code [url]="sessionUrl()" />
            <button class="session-poker-page__qr-copy-btn" (click)="copySessionLink()" title="Copy session link to clipboard">
              Copy Link
            </button>
          </div>
        }

        <main class="session-poker-page__main">
          <section class="session-poker-page__board-area" id="main-content">
            <div class="session-poker-page__section session-poker-page__section--story">
              <app-story-manager />
              <app-facilitator-flow />
            </div>
            <div class="session-poker-page__section session-poker-page__section--board">
              <app-board />
            </div>
            @if (sessionState.currentRound() || sessionState.metrics()) {
              <div class="session-poker-page__section session-poker-page__section--metrics">
                <app-metrics />
                <app-consensus-indicator
                  [metrics]="sessionState.metrics()"
                  [votingSystem]="sessionState.sessionConfig()?.votingSystem ?? 'fibonacci'"
                />
              </div>
            }
            <div class="session-poker-page__section session-poker-page__section--card-deck">
              <app-card-deck />
            </div>
          </section>

          <!-- Desktop sidebar -->
          <aside class="session-poker-page__sidebar session-poker-page__sidebar--desktop">
            <details class="session-poker-page__accordion" open>
              <summary class="session-poker-page__accordion-header">Issues</summary>
              <div class="session-poker-page__accordion-content">
                <app-issue-list-panel />
              </div>
            </details>
            <details class="session-poker-page__accordion">
              <summary class="session-poker-page__accordion-header">History</summary>
              <div class="session-poker-page__accordion-content">
                <app-session-history />
              </div>
            </details>
          </aside>

          <!-- Mobile overlay toggle + overlay -->
          <div class="session-poker-page__mobile-history">
            <button
              class="session-poker-page__history-toggle"
              (click)="toggleHistoryOverlay()"
              [attr.aria-expanded]="historyOverlayOpen()"
              aria-controls="history-overlay"
              aria-label="Toggle session history"
            >
              History
            </button>

            @if (historyOverlayOpen()) {
              <div
                class="session-poker-page__overlay-backdrop"
                (click)="toggleHistoryOverlay()"
                aria-hidden="true"
              ></div>
              <aside
                id="history-overlay"
                class="session-poker-page__sidebar-overlay"
                role="complementary"
                aria-label="Session history overlay"
              >
                <div class="session-poker-page__overlay-header">
                  <h2>History</h2>
                  <button
                    class="session-poker-page__overlay-close"
                    (click)="toggleHistoryOverlay()"
                    aria-label="Close session history"
                  >
                    ✕
                  </button>
                </div>
                <app-session-history />
              </aside>
            }
          </div>
        </main>

        <app-countdown-overlay
          [active]="sessionState.countdownActive()"
          (onComplete)="onCountdownComplete()"
        />

        <!-- End Session Confirmation Dialog -->
        @if (showEndSessionDialog()) {
          <div class="session-poker-page__dialog-backdrop" (click)="showEndSessionDialog.set(false)">
            <div class="session-poker-page__dialog" (click)="$event.stopPropagation()" role="alertdialog" aria-label="End session confirmation">
              <p class="session-poker-page__dialog-text">Are you sure you want to end this session? This will remove the session for all participants.</p>
              <div class="session-poker-page__dialog-actions">
                <button class="session-poker-page__dialog-btn session-poker-page__dialog-btn--cancel" (click)="showEndSessionDialog.set(false)">Cancel</button>
                <button class="session-poker-page__dialog-btn session-poker-page__dialog-btn--confirm" (click)="confirmEndSession()">End Session</button>
              </div>
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100dvh;
        overflow: hidden;
      }

      /* Error state */
      .session-error {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 1.5rem;
        background: var(--gradient-page-bg);
      }

      .session-error__card {
        text-align: center;
        padding: 2.5rem;
        border-radius: 12px;
        background: var(--surface-board);
        box-shadow: var(--shadow-lg);
        max-width: 480px;
        width: 100%;
      }

      .session-error__card h1 {
        margin: 0 0 0.75rem;
        font-size: 1.5rem;
        color: var(--text-primary);
      }

      .session-error__card p {
        margin: 0 0 1.5rem;
        color: var(--text-secondary);
        font-size: 1rem;
      }

      .session-error__link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.75rem 1.5rem;
        border-radius: 8px;
        background: var(--gradient-primary);
        color: var(--text-on-primary);
        font-size: 1rem;
        font-weight: 600;
        text-decoration: none;
        min-height: 44px;
        min-width: 44px;
        transition: box-shadow 200ms ease, transform 100ms ease;
      }

      .session-error__link:hover {
        box-shadow: var(--shadow-md);
      }

      .session-error__link:active {
        transform: scale(0.97);
      }

      /* Page background with gradient */
      .session-poker-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 0.75rem;
        background: var(--gradient-page-bg);
        overflow: hidden;
        position: relative;
      }

      /* Header with gradient styling */
      .session-poker-page__header {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.5rem 1rem;
        background: var(--gradient-primary);
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        margin-bottom: 0.5rem;
        flex-wrap: wrap;
      }

      .session-poker-page__header h1 {
        margin: 0;
        font-size: 1.1rem;
        color: var(--text-on-primary);
        font-weight: 700;
        letter-spacing: 0.02em;
      }

      .session-poker-page__lobby-btn {
        border: none;
        background: rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        cursor: pointer;
        font-size: 1rem;
        padding: 0.3rem 0.5rem;
        min-width: 36px;
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }

      .session-poker-page__lobby-btn:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .session-poker-page__header-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .session-poker-page__session-id {
        font-size: 0.875rem;
        color: rgba(255, 255, 255, 0.85);
        font-weight: 500;
        letter-spacing: 0.02em;
      }

      .session-poker-page__copy-btn,
      .session-poker-page__qr-toggle {
        padding: 0.5rem 0.875rem;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.15);
        color: var(--text-on-primary);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
        transition: background-color 200ms ease, box-shadow 200ms ease, transform 100ms ease;
      }

      .session-poker-page__end-btn {
        padding: 0.5rem 0.875rem;
        border: 1px solid rgba(255, 100, 100, 0.5);
        border-radius: 6px;
        background: rgba(220, 38, 38, 0.7);
        color: #fff;
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
        transition: background-color 200ms ease, box-shadow 200ms ease, transform 100ms ease;
      }

      .session-poker-page__end-btn:hover {
        background: rgba(220, 38, 38, 0.9);
      }

      .session-poker-page__copy-btn:hover,
      .session-poker-page__qr-toggle:hover {
        background: rgba(255, 255, 255, 0.25);
        box-shadow: var(--shadow-sm);
      }

      .session-poker-page__copy-btn:active,
      .session-poker-page__qr-toggle:active {
        transform: scale(0.97);
      }

      /* QR code floating popup */
      .session-poker-page__qr-backdrop {
        position: fixed;
        inset: 0;
        z-index: 99;
      }

      .session-poker-page__qr-popup {
        position: absolute;
        top: 56px;
        right: 1rem;
        z-index: 100;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
      }

      .session-poker-page__qr-copy-btn {
        padding: 0.5rem 1.25rem;
        border: none;
        border-radius: 6px;
        background: var(--gradient-primary, #667eea);
        color: #fff;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 40px;
        min-width: 44px;
        transition: opacity 0.2s ease, transform 0.1s ease;
      }

      .session-poker-page__qr-copy-btn:hover {
        opacity: 0.9;
      }

      .session-poker-page__qr-copy-btn:active {
        transform: scale(0.97);
      }

      .session-poker-page__main {
        display: flex;
        flex: 1;
        gap: 1rem;
        overflow: hidden;
      }

      .session-poker-page__board-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
        overflow-y: auto;
      }

      /* Section containers with distinct surface colors */
      .session-poker-page__section {
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        padding: 0.75rem;
      }

      .session-poker-page__section--story {
        background: var(--surface-story);
      }

      .session-poker-page__section--board {
        background: var(--surface-board);
      }

      .session-poker-page__section--metrics {
        background: var(--surface-metrics);
      }

      .session-poker-page__section--card-deck {
        background: var(--surface-card-deck);
      }

      /* Desktop sidebar */
      .session-poker-page__sidebar--desktop {
        width: 280px;
        flex-shrink: 0;
        background: var(--surface-sidebar);
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        padding: 0.5rem;
        overflow-x: hidden;
        overflow-y: auto;
      }

      /* Accordion sections */
      .session-poker-page__accordion {
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        margin-bottom: 0.5rem;
        overflow: hidden;
      }

      .session-poker-page__accordion-header {
        padding: 0.5rem 0.75rem;
        font-size: 0.875rem;
        font-weight: 600;
        cursor: pointer;
        background: #f9fafb;
        user-select: none;
        list-style: none;
      }

      .session-poker-page__accordion-header::-webkit-details-marker {
        display: none;
      }

      .session-poker-page__accordion-header::before {
        content: '▶';
        display: inline-block;
        margin-right: 0.5rem;
        font-size: 0.7rem;
        transition: transform 0.2s ease;
      }

      .session-poker-page__accordion[open] > .session-poker-page__accordion-header::before {
        transform: rotate(90deg);
      }

      .session-poker-page__accordion-content {
        padding: 0.25rem;
        overflow: hidden;
        word-wrap: break-word;
      }

      /* Mobile history elements hidden on desktop */
      .session-poker-page__mobile-history {
        display: none;
      }

      /* Themed button base styles */
      .session-poker-page :deep(button),
      .session-poker-page__history-toggle {
        transition: background-color 200ms ease, box-shadow 200ms ease, transform 100ms ease;
      }

      .session-poker-page :deep(button:hover) {
        box-shadow: var(--shadow-md);
      }

      .session-poker-page :deep(button:active) {
        transform: scale(0.97);
      }

      /* ---- Mobile breakpoint < 768px ---- */
      @media (max-width: 767px) {
        .session-poker-page {
          padding: 0.5rem;
        }

        .session-poker-page__header {
          border-radius: 8px;
          padding: 0.75rem 1rem;
          margin-bottom: 0.5rem;
        }

        .session-poker-page__header h1 {
          font-size: 1.25rem;
        }

        .session-poker-page__section {
          padding: 0.75rem;
          border-radius: 8px;
        }

        .session-poker-page__main {
          flex-direction: column;
        }

        /* Hide desktop sidebar on mobile */
        .session-poker-page__sidebar--desktop {
          display: none;
        }

        /* Show mobile history toggle */
        .session-poker-page__mobile-history {
          display: block;
        }

        .session-poker-page__history-toggle {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          padding: 0.75rem 1rem;
          border: 2px solid var(--color-primary);
          border-radius: 8px;
          background: var(--surface-card-deck);
          color: var(--color-primary);
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
        }

        .session-poker-page__history-toggle:hover {
          background: var(--color-primary);
          color: var(--text-on-primary);
          box-shadow: var(--shadow-md);
        }

        .session-poker-page__history-toggle:active {
          transform: scale(0.97);
        }

        .session-poker-page__history-toggle:focus-visible {
          outline: 2px solid var(--color-primary-light);
          outline-offset: 2px;
        }

        /* Overlay backdrop */
        .session-poker-page__overlay-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          z-index: 999;
        }

        /* Overlay panel */
        .session-poker-page__sidebar-overlay {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          max-height: 70vh;
          background: var(--surface-sidebar);
          border-radius: 16px 16px 0 0;
          box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
          z-index: 1000;
          overflow-y: auto;
          padding: 0 1rem 1rem;
        }

        .session-poker-page__overlay-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 0 0.5rem;
          position: sticky;
          top: 0;
          background: var(--surface-sidebar);
          z-index: 1;
        }

        .session-poker-page__overlay-header h2 {
          margin: 0;
          font-size: 1.1rem;
          color: var(--text-primary);
        }

        .session-poker-page__overlay-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          border: none;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.08);
          font-size: 1.1rem;
          cursor: pointer;
          color: var(--text-secondary);
          min-height: 44px;
          min-width: 44px;
          transition: background-color 200ms ease;
        }

        .session-poker-page__overlay-close:hover {
          background: rgba(0, 0, 0, 0.15);
        }

        .session-poker-page__overlay-close:active {
          transform: scale(0.95);
        }

        .session-poker-page__overlay-close:focus-visible {
          outline: 2px solid var(--color-primary);
          outline-offset: 2px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .session-poker-page__copy-btn,
        .session-poker-page__qr-toggle,
        .session-poker-page__history-toggle,
        .session-poker-page__overlay-close,
        .session-error__link {
          transition: none;
        }
      }

      /* End Session Dialog */
      .session-poker-page__dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .session-poker-page__dialog {
        background: #fff;
        border-radius: 10px;
        padding: 1.5rem;
        min-width: 320px;
        max-width: 400px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      }

      .session-poker-page__dialog-text {
        margin: 0 0 1.25rem;
        font-size: 0.95rem;
        color: #333;
        line-height: 1.4;
      }

      .session-poker-page__dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      .session-poker-page__dialog-btn {
        padding: 0.5rem 1.25rem;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        min-height: 36px;
      }

      .session-poker-page__dialog-btn--cancel {
        border: 1px solid #d0d5dd;
        background: #fff;
        color: #555;
      }

      .session-poker-page__dialog-btn--cancel:hover {
        background: #f5f5f5;
      }

      .session-poker-page__dialog-btn--confirm {
        border: none;
        background: #dc2626;
        color: #fff;
      }

      .session-poker-page__dialog-btn--confirm:hover {
        background: #b91c1c;
      }
    `,
  ],
})
export class SessionPokerPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly wsService = inject(WebSocketService);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);
  readonly sessionState = inject(SessionStateService);

  readonly sessionId = signal<string>('');
  readonly sessionNotFound = signal<boolean>(false);
  readonly showQrCode = signal<boolean>(false);
  readonly historyOverlayOpen = signal<boolean>(false);
  readonly showEndSessionDialog = signal<boolean>(false);

  readonly sessionUrl = computed(() => {
    const id = this.sessionId();
    if (!id) return '';
    const basePath = this.basePath.getBasePath();
    return `${window.location.origin}${basePath}/session/${id}`;
  });

  readonly isSessionOwner = computed(() => {
    const user = this.sessionState.currentUser();
    const config = this.sessionState.sessionConfig();
    if (!user || !config) return false;
    // The owner is determined by checking if the user is a moderator
    // (the session creator is always assigned as moderator/owner)
    return user.role === 'moderator';
  });

  readonly currentRoundStartedAt = computed(() => {
    const round = this.sessionState.currentRound();
    return round?.startedAt ?? null;
  });

  readonly currentRoundRevealedAt = computed(() => {
    const round = this.sessionState.currentRound();
    return round?.revealedAt ?? null;
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('sessionId') ?? '';
    this.sessionId.set(id);

    if (!id) {
      this.sessionNotFound.set(true);
      return;
    }

    // Check if session exists before connecting
    this.http.get<{ exists: boolean }>(this.basePath.getApiUrl(`/api/sessions/${id}/exists`)).subscribe({
      next: (response) => {
        if (!response.exists) {
          this.sessionNotFound.set(true);
          return;
        }
        this.connectToSession(id);
      },
      error: () => {
        this.sessionNotFound.set(true);
      },
    });
  }

  ngOnDestroy(): void {
    this.wsService.disconnect();
  }

  toggleQrCode(): void {
    this.showQrCode.update((v) => !v);
  }

  goToLobby(): void {
    this.router.navigate(['/lobby']);
  }

  endSession(): void {
    this.showEndSessionDialog.set(true);
  }

  confirmEndSession(): void {
    this.showEndSessionDialog.set(false);
    const id = this.sessionId();
    const token = this.authService.getToken();
    if (token && id) {
      this.http.delete(this.basePath.getApiUrl(`/api/sessions/${id}`), {
        headers: { Authorization: `Bearer ${token}` },
      }).subscribe({
        next: () => {
          this.toastService.show('info', 'Session ended');
          this.router.navigate(['/lobby']);
        },
        error: () => {
          this.toastService.show('error', 'Failed to end session');
        },
      });
    }
  }

  toggleHistoryOverlay(): void {
    this.historyOverlayOpen.update((v) => !v);
  }

  async copySessionLink(): Promise<void> {
    const url = this.sessionUrl();
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      this.toastService.show('info', 'Session link copied to clipboard');
    } catch {
      this.toastService.show('error', 'Failed to copy session link');
    }
  }

  onCountdownComplete(): void {
    // The countdown overlay has finished. The cards:revealed event
    // will have already been processed by SessionStateService,
    // so the board will update automatically.
  }

  private connectToSession(id: string): void {
    const token = this.authService.getToken();
    if (token) {
      this.wsService.connect(token, id);
    }
  }
}
