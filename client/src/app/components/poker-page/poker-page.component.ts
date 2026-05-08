import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CardDeckComponent } from '../card-deck/card-deck.component';
import { BoardComponent } from '../board/board.component';
import { StoryManagerComponent } from '../story-manager/story-manager.component';
import { MetricsComponent } from '../metrics/metrics.component';
import { SessionHistoryComponent } from '../session-history/session-history.component';
import { UserMenuComponent } from '../user-menu/user-menu.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-poker-page',
  standalone: true,
  imports: [
    CommonModule,
    CardDeckComponent,
    BoardComponent,
    StoryManagerComponent,
    MetricsComponent,
    SessionHistoryComponent,
    UserMenuComponent,
  ],
  template: `
    <div class="poker-page">
      <header class="poker-page__header">
        <div class="poker-page__header-left">
          <button
            class="poker-page__lobby-btn"
            type="button"
            title="Back to Lobby"
            aria-label="Back to Lobby"
            (click)="goToLobby()"
          >🏠</button>
          <h1>Scrum Poker</h1>
        </div>
        <app-user-menu />
      </header>

      <main class="poker-page__main">
        <section class="poker-page__board-area" id="main-content">
          <div class="poker-page__section poker-page__section--story">
            <app-story-manager />
          </div>
          <div class="poker-page__section poker-page__section--board">
            <app-board />
          </div>
          <div class="poker-page__section poker-page__section--metrics">
            <app-metrics />
          </div>
          <div class="poker-page__section poker-page__section--card-deck">
            <app-card-deck />
          </div>
        </section>

        <!-- Desktop sidebar -->
        <aside class="poker-page__sidebar poker-page__sidebar--desktop">
          <app-session-history />
        </aside>

        <!-- Mobile overlay toggle + overlay -->
        <div class="poker-page__mobile-history">
          <button
            class="poker-page__history-toggle"
            (click)="toggleHistoryOverlay()"
            [attr.aria-expanded]="historyOverlayOpen()"
            aria-controls="history-overlay"
            aria-label="Toggle session history"
          >
            History
          </button>

          @if (historyOverlayOpen()) {
            <div
              class="poker-page__overlay-backdrop"
              (click)="toggleHistoryOverlay()"
              aria-hidden="true"
            ></div>
            <aside
              id="history-overlay"
              class="poker-page__sidebar-overlay"
              role="complementary"
              aria-label="Session history overlay"
            >
              <div class="poker-page__overlay-header">
                <h2>History</h2>
                <button
                  class="poker-page__overlay-close"
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
    </div>
  `,
  styles: [
    `
      /* Page background with gradient */
      .poker-page {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
        padding: 1.5rem;
        background: var(--gradient-page-bg);
      }

      /* Header with gradient styling */
      .poker-page__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem 1.5rem;
        background: var(--gradient-primary);
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        margin-bottom: 1rem;
      }

      .poker-page__header h1 {
        margin: 0;
        font-size: 1.5rem;
        color: var(--text-on-primary);
        font-weight: 700;
        letter-spacing: 0.02em;
      }

      .poker-page__header-left {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .poker-page__lobby-btn {
        border: none;
        background: rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        cursor: pointer;
        font-size: 1.1rem;
        padding: 0.3rem 0.5rem;
        min-width: 36px;
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }

      .poker-page__lobby-btn:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .poker-page__main {
        display: flex;
        flex: 1;
        gap: 1rem;
      }

      .poker-page__board-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        min-width: 0;
      }

      /* Section containers with distinct surface colors */
      .poker-page__section {
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        padding: 1.25rem;
      }

      .poker-page__section--story {
        background: var(--surface-story);
      }

      .poker-page__section--board {
        background: var(--surface-board);
      }

      .poker-page__section--metrics {
        background: var(--surface-metrics);
      }

      .poker-page__section--card-deck {
        background: var(--surface-card-deck);
      }

      /* Desktop sidebar */
      .poker-page__sidebar--desktop {
        width: 300px;
        flex-shrink: 0;
        background: var(--surface-sidebar);
        border-radius: 12px;
        box-shadow: var(--shadow-md);
        padding: 1rem;
      }

      /* Mobile history elements hidden on desktop */
      .poker-page__mobile-history {
        display: none;
      }

      /* Themed button base styles */
      .poker-page :deep(button),
      .poker-page__history-toggle {
        transition: background-color 200ms ease, box-shadow 200ms ease, transform 100ms ease;
      }

      .poker-page :deep(button:hover) {
        box-shadow: var(--shadow-md);
      }

      .poker-page :deep(button:active) {
        transform: scale(0.97);
      }

      /* ---- Mobile breakpoint < 768px ---- */
      @media (max-width: 767px) {
        .poker-page {
          padding: 0.5rem;
        }

        .poker-page__header {
          border-radius: 8px;
          padding: 0.75rem 1rem;
          margin-bottom: 0.5rem;
        }

        .poker-page__section {
          padding: 0.75rem;
          border-radius: 8px;
        }

        .poker-page__main {
          flex-direction: column;
        }

        /* Hide desktop sidebar on mobile */
        .poker-page__sidebar--desktop {
          display: none;
        }

        /* Show mobile history toggle */
        .poker-page__mobile-history {
          display: block;
        }

        .poker-page__history-toggle {
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

        .poker-page__history-toggle:hover {
          background: var(--color-primary);
          color: var(--text-on-primary);
          box-shadow: var(--shadow-md);
        }

        .poker-page__history-toggle:active {
          transform: scale(0.97);
        }

        .poker-page__history-toggle:focus-visible {
          outline: 2px solid var(--color-primary-light);
          outline-offset: 2px;
        }

        /* Overlay backdrop */
        .poker-page__overlay-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          z-index: 999;
        }

        /* Overlay panel */
        .poker-page__sidebar-overlay {
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

        .poker-page__overlay-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 0 0.5rem;
          position: sticky;
          top: 0;
          background: var(--surface-sidebar);
          z-index: 1;
        }

        .poker-page__overlay-header h2 {
          margin: 0;
          font-size: 1.1rem;
          color: var(--text-primary);
        }

        .poker-page__overlay-close {
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

        .poker-page__overlay-close:hover {
          background: rgba(0, 0, 0, 0.15);
        }

        .poker-page__overlay-close:active {
          transform: scale(0.95);
        }

        .poker-page__overlay-close:focus-visible {
          outline: 2px solid var(--color-primary);
          outline-offset: 2px;
        }
      }
    `,
  ],
})
export class PokerPageComponent implements OnInit, OnDestroy {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  readonly historyOverlayOpen = signal(false);

  toggleHistoryOverlay(): void {
    this.historyOverlayOpen.update((v) => !v);
  }

  goToLobby(): void {
    this.router.navigate(['/lobby']);
  }

  ngOnInit(): void {
    const token = this.authService.getToken();
    if (token) {
      this.wsService.connect(token);
    }
  }

  ngOnDestroy(): void {
    this.wsService.disconnect();
  }
}
