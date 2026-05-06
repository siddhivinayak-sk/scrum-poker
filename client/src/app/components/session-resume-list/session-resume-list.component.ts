import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { SessionSummary } from '@shared/types';
import { BasePathService } from '../../services/base-path.service';

@Component({
  selector: 'app-session-resume-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (loading()) {
      <div class="session-resume-list__loading" role="status">Loading sessions...</div>
    } @else if (error()) {
      <div class="session-resume-list__error" role="alert">{{ error() }}</div>
    } @else if (sessions().length > 0) {
      <section class="session-resume-list" aria-label="Your previous sessions">
        <h3 class="session-resume-list__title">Your Previous Sessions</h3>
        <ul class="session-resume-list__list" role="list">
          @for (session of sessions(); track session.sessionId) {
            <li class="session-resume-list__item" role="listitem">
              <button
                class="session-resume-list__btn"
                (click)="resumeSession(session.sessionId)"
                type="button"
                [attr.aria-label]="'Resume session ' + session.sessionId"
              >
                <span class="session-resume-list__session-id">{{ session.sessionId }}</span>
                <span class="session-resume-list__meta">
                  <span class="session-resume-list__date">{{ formatDate(session.createdAt) }}</span>
                  <span class="session-resume-list__rounds">{{ session.completedRounds }} rounds</span>
                  <span class="session-resume-list__activity">Last active: {{ formatDate(session.lastActivityAt) }}</span>
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
      .session-resume-list {
        margin-top: 1.5rem;
      }

      .session-resume-list__title {
        font-size: 1rem;
        font-weight: 700;
        margin: 0 0 0.75rem;
      }

      .session-resume-list__loading,
      .session-resume-list__error {
        padding: 0.75rem;
        font-size: 0.85rem;
        color: #666;
        text-align: center;
      }

      .session-resume-list__error {
        color: #d32f2f;
      }

      .session-resume-list__list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .session-resume-list__btn {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 0.75rem;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
        cursor: pointer;
        text-align: left;
        transition: background 0.2s, border-color 0.2s;
      }

      .session-resume-list__btn:hover {
        background: #e3f2fd;
        border-color: #1976d2;
      }

      .session-resume-list__session-id {
        font-weight: 600;
        font-size: 0.9rem;
        color: #1976d2;
      }

      .session-resume-list__meta {
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
export class SessionResumeListComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly basePath = inject(BasePathService);

  readonly sessions = signal<SessionSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.fetchSessions();
  }

  resumeSession(sessionId: string): void {
    this.router.navigate(['/session', sessionId]);
  }

  formatDate(isoDate: string): string {
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  }

  private fetchSessions(): void {
    this.loading.set(true);
    this.error.set(null);

    const apiUrl = this.basePath.getApiUrl('/api/sessions/mine');
    this.http.get<{ sessions: SessionSummary[] }>(apiUrl).subscribe({
      next: (response) => {
        this.sessions.set(response.sessions);
        this.loading.set(false);
      },
      error: (err) => {
        if (err.status === 401) {
          // Not authenticated — just show empty
          this.sessions.set([]);
        } else {
          this.error.set('Failed to load sessions');
        }
        this.loading.set(false);
      },
    });
  }
}
