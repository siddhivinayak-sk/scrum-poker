import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { BasePathService } from '../../services/base-path.service';
import { SessionResumeListComponent } from '../session-resume-list/session-resume-list.component';

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [CommonModule, FormsModule, SessionResumeListComponent],
  template: `
    <div class="lobby-container" role="main">
      <div class="lobby-content">
        <h1 class="lobby-title">Scrum Poker</h1>
        <p class="lobby-subtitle">Choose an option to get started</p>

        <div class="lobby-cards">
          <!-- Start New Game -->
          <div class="lobby-card">
            <h2 class="lobby-card__title">Start New Game</h2>
            <p class="lobby-card__description">
              Create a new estimation session and invite your team
            </p>
            <button
              class="lobby-card__btn lobby-card__btn--primary"
              (click)="startNewGame()"
              aria-label="Start a new game"
            >
              Start New Game
            </button>
          </div>

          <!-- Create Retrospective Board -->
          <div class="lobby-card">
            <h2 class="lobby-card__title">Create Retrospective Board</h2>
            <p class="lobby-card__description">
              Run a sprint retrospective with your team using customizable templates
            </p>
            <button
              class="lobby-card__btn lobby-card__btn--primary"
              (click)="createRetroBoard()"
              aria-label="Create a retrospective board"
            >
              Create Retrospective Board
            </button>
          </div>

          <!-- Join Existing Session -->
          <div class="lobby-card lobby-card--full-width">
            <h2 class="lobby-card__title">Join Existing Session</h2>
            <p class="lobby-card__description">
              Enter a session ID or paste a session URL to join
            </p>
            <div class="lobby-card__input-group">
              <input
                class="lobby-card__input"
                type="text"
                [(ngModel)]="sessionInput"
                placeholder="Session ID or URL"
                aria-label="Session ID or URL"
                [attr.aria-invalid]="joinError() ? 'true' : null"
                aria-describedby="join-error"
                (keydown.enter)="joinSession()"
              />
              <button
                class="lobby-card__btn lobby-card__btn--secondary"
                (click)="joinSession()"
                [disabled]="isJoining()"
                aria-label="Join session"
              >
                @if (isJoining()) {
                  <span class="spinner" aria-hidden="true"></span>
                  Joining…
                } @else {
                  Join
                }
              </button>
            </div>
            @if (joinError()) {
              <div id="join-error" class="lobby-card__error" role="alert" aria-live="polite">
                {{ joinError() }}
              </div>
            }
          </div>
        </div>

        <!-- Previous Sessions -->
        <app-session-resume-list />
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100dvh;
      }

      .lobby-container {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100%;
        padding: 1rem;
        background: var(--gradient-page-bg);
      }

      .lobby-content {
        width: 100%;
        max-width: 700px;
      }

      .lobby-title {
        font-size: 2rem;
        font-weight: 700;
        text-align: center;
        margin: 0 0 0.25rem;
        background: var(--gradient-primary);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .lobby-subtitle {
        font-size: 1rem;
        color: var(--text-secondary);
        text-align: center;
        margin: 0 0 2rem;
      }

      .lobby-cards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.5rem;
      }

      .lobby-card--full-width {
        grid-column: 1 / -1;
      }

      @media (max-width: 600px) {
        .lobby-cards {
          grid-template-columns: 1fr;
        }
      }

      .lobby-card {
        background: var(--surface-card-deck);
        border-radius: 12px;
        padding: 2rem 1.5rem;
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .lobby-card__title {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
        margin: 0;
      }

      .lobby-card__description {
        font-size: 0.875rem;
        color: var(--text-secondary);
        margin: 0;
        flex: 1;
      }

      .lobby-card__input-group {
        display: flex;
        gap: 0.5rem;
      }

      .lobby-card__input {
        flex: 1;
        padding: 0.625rem 0.75rem;
        border: 1px solid var(--color-primary-light);
        border-radius: 8px;
        font-size: 0.9rem;
        color: var(--text-primary);
        min-height: 44px;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }

      .lobby-card__input::placeholder {
        color: #9ca3af;
      }

      .lobby-card__input:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
      }

      .lobby-card__input[aria-invalid='true'] {
        border-color: var(--toast-error);
      }

      .lobby-card__btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.75rem 1.5rem;
        border: none;
        border-radius: 8px;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 44px;
        transition: opacity 0.2s ease, transform 0.1s ease;
      }

      .lobby-card__btn:hover:not(:disabled) {
        opacity: 0.9;
      }

      .lobby-card__btn:active:not(:disabled) {
        transform: scale(0.98);
      }

      .lobby-card__btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .lobby-card__btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
      }

      .lobby-card__btn--primary {
        background: var(--gradient-primary);
        color: var(--text-on-primary);
        width: 100%;
      }

      .lobby-card__btn--secondary {
        background: var(--gradient-primary);
        color: var(--text-on-primary);
        white-space: nowrap;
      }

      .lobby-card__error {
        font-size: 0.8125rem;
        color: var(--toast-error);
        padding: 0.5rem;
        background: #fef2f2;
        border-radius: 6px;
        text-align: center;
      }

      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: var(--text-on-primary);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .lobby-card__input {
          transition: none;
        }

        .lobby-card__btn {
          transition: none;
        }

        .spinner {
          animation: none;
        }
      }
    `,
  ],
})
export class LobbyComponent {
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly basePath = inject(BasePathService);

  sessionInput = '';
  readonly isJoining = signal(false);
  readonly joinError = signal<string | null>(null);

  startNewGame(): void {
    this.router.navigate(['/create-session']);
  }

  createRetroBoard(): void {
    this.router.navigate(['/retro/create']);
  }

  joinSession(): void {
    const input = this.sessionInput.trim();
    if (!input) {
      this.joinError.set('Please enter a session ID or URL');
      return;
    }

    // Extract session ID from URL or use as-is
    let sessionId = input;
    let isRetro = false;

    // Check for retro URL pattern: /retro/SESSION_ID
    const retroUrlMatch = input.match(/\/retro\/([^/?#]+)/);
    if (retroUrlMatch) {
      sessionId = retroUrlMatch[1];
      isRetro = true;
    } else {
      // Check for poker URL pattern: /session/SESSION_ID
      const sessionUrlMatch = input.match(/\/session\/([^/?#]+)/);
      if (sessionUrlMatch) {
        sessionId = sessionUrlMatch[1];
      }
    }

    this.joinError.set(null);
    this.isJoining.set(true);

    if (isRetro) {
      // Check retro session
      this.http
        .get<{ exists: boolean }>(this.basePath.getApiUrl(`/api/retro/sessions/${encodeURIComponent(sessionId)}/exists`))
        .subscribe({
          next: (response) => {
            this.isJoining.set(false);
            if (response.exists) {
              this.router.navigate(['/retro', sessionId]);
            } else {
              this.joinError.set('Session not found. Please check the ID and try again.');
            }
          },
          error: () => {
            this.isJoining.set(false);
            this.joinError.set('Failed to check session. Please try again.');
          },
        });
    } else {
      // Check poker session first, then retro
      this.http
        .get<{ exists: boolean }>(this.basePath.getApiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/exists`))
        .subscribe({
          next: (response) => {
            if (response.exists) {
              this.isJoining.set(false);
              this.router.navigate(['/session', sessionId]);
            } else {
              // Try retro session
              this.http
                .get<{ exists: boolean }>(this.basePath.getApiUrl(`/api/retro/sessions/${encodeURIComponent(sessionId)}/exists`))
                .subscribe({
                  next: (retroResponse) => {
                    this.isJoining.set(false);
                    if (retroResponse.exists) {
                      this.router.navigate(['/retro', sessionId]);
                    } else {
                      this.joinError.set('Session not found. Please check the ID and try again.');
                    }
                  },
                  error: () => {
                    this.isJoining.set(false);
                    this.joinError.set('Session not found. Please check the ID and try again.');
                  },
                });
            }
          },
          error: () => {
            this.isJoining.set(false);
            this.joinError.set('Failed to check session. Please try again.');
          },
        });
    }
  }
}
