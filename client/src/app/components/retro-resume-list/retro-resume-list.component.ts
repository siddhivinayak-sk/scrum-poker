import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { timeout } from 'rxjs';
import { RetroSessionSummary, RetroSessionsResponse } from '@shared/types';
import { BasePathService } from '../../services/base-path.service';
import { AuthService } from '../../services/auth.service';

/** Maximum time to wait for the retro session list before failing (R8.20). */
export const RETRO_SESSIONS_TIMEOUT_MS = 10_000;

/** Message rendered in place of the list when the request fails (R8.19, R8.20). */
export const RETRO_SESSIONS_LOAD_FAILED_MESSAGE = 'Failed to load retrospective boards';

/**
 * Lists the retrospective boards owned by the authenticated user and navigates
 * to a board on activation.
 *
 * Renders nothing while the list is empty or the request was rejected as
 * unauthenticated, so the lobby stays unchanged in those cases. The poker
 * session list is an independent sibling component with its own request, so
 * neither list affects the other.
 *
 * Requirements: R8.9, R8.10, R8.11, R8.12, R8.13, R8.14, R8.15, R8.16, R8.17,
 * R8.18, R8.19, R8.20
 */
@Component({
  selector: 'app-retro-resume-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (loading()) {
      <div class="retro-resume-list__loading" role="status">Loading retrospective boards...</div>
    } @else if (loadFailed()) {
      <div class="retro-resume-list__error" role="alert">{{ loadFailedMessage }}</div>
    } @else if (sessions().length > 0) {
      <section class="retro-resume-list" aria-labelledby="retro-resume-list-heading">
        <h3 class="retro-resume-list__title" id="retro-resume-list-heading">
          Your Retrospective Boards
        </h3>
        <ul class="retro-resume-list__list" role="list">
          @for (session of sessions(); track session.sessionId) {
            <li class="retro-resume-list__item" role="listitem">
              <button
                class="retro-resume-list__btn"
                type="button"
                (click)="resumeBoard(session.sessionId)"
              >
                <span
                  class="retro-resume-list__board-name"
                  [title]="session.boardName"
                  [attr.aria-label]="session.boardName"
                  >{{ session.boardName }}</span
                >
                <span class="retro-resume-list__meta">
                  <span class="retro-resume-list__session-id">{{ session.sessionId }}</span>
                  <time class="retro-resume-list__created" [attr.datetime]="session.createdAt">
                    Created: {{ formatDate(session.createdAt) }}
                  </time>
                  <time
                    class="retro-resume-list__activity"
                    [attr.datetime]="session.lastActivityAt"
                  >
                    Last active: {{ formatDate(session.lastActivityAt) }}
                  </time>
                </span>
              </button>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [
    `
      .retro-resume-list {
        margin-top: 1.5rem;
      }

      .retro-resume-list__title {
        font-size: 1rem;
        font-weight: 700;
        margin: 0 0 0.75rem;
      }

      .retro-resume-list__loading,
      .retro-resume-list__error {
        padding: 0.75rem;
        font-size: 0.85rem;
        color: #666;
        text-align: center;
      }

      .retro-resume-list__error {
        color: #d32f2f;
      }

      .retro-resume-list__list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .retro-resume-list__btn {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        padding: 0.75rem;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
        cursor: pointer;
        text-align: left;
        transition:
          background 0.2s,
          border-color 0.2s;
      }

      .retro-resume-list__btn:hover {
        background: #ede7f6;
        border-color: #5e35b1;
      }

      .retro-resume-list__board-name {
        display: block;
        min-width: 0;
        max-width: 100%;
        font-weight: 600;
        font-size: 0.9rem;
        color: #5e35b1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .retro-resume-list__meta {
        display: flex;
        gap: 1rem;
        margin-top: 0.25rem;
        font-size: 0.8rem;
        color: #666;
        flex-wrap: wrap;
      }
    `,
  ],
})
export class RetroResumeListComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly basePath = inject(BasePathService);
  private readonly auth = inject(AuthService);

  /** Summaries in the order the endpoint returned them (R8.10). */
  readonly sessions = signal<RetroSessionSummary[]>([]);
  /** True while the single list request is pending (R8.11). */
  readonly loading = signal(false);
  /** True when the request failed with a status other than 401, or timed out. */
  readonly loadFailed = signal(false);

  readonly loadFailedMessage = RETRO_SESSIONS_LOAD_FAILED_MESSAGE;

  ngOnInit(): void {
    this.fetchSessions();
  }

  /** Navigate to the retro board of an entry (R8.16). */
  resumeBoard(sessionId: string): void {
    this.router.navigate(['/retro', sessionId]);
  }

  /** Render an ISO 8601 timestamp for display. */
  formatDate(isoDate: string): string {
    try {
      return new Date(isoDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  }

  /**
   * Send exactly one `GET /api/retro/sessions/mine` carrying the stored token
   * (R8.9). A 401 leaves the list empty with no message (R8.18); any other
   * status and the 10-second timeout raise the failure message (R8.19, R8.20).
   */
  private fetchSessions(): void {
    this.loading.set(true);
    this.loadFailed.set(false);

    this.http
      .get<RetroSessionsResponse>(this.basePath.getApiUrl('/api/retro/sessions/mine'), {
        headers: this.buildHeaders(),
      })
      .pipe(timeout(RETRO_SESSIONS_TIMEOUT_MS))
      .subscribe({
        next: (response) => {
          this.sessions.set(response.sessions ?? []);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 401) {
            this.sessions.set([]);
          } else {
            this.loadFailed.set(true);
          }
          this.loading.set(false);
        },
      });
  }

  /** Authorization header carrying the stored token, when one is present. */
  private buildHeaders(): HttpHeaders {
    const token = this.auth.getToken();
    return token === null
      ? new HttpHeaders()
      : new HttpHeaders({ Authorization: `Bearer ${token}` });
  }
}
