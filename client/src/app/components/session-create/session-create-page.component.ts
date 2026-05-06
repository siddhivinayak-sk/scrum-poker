import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import {
  VotingSystemType,
  PermissionMode,
  SessionConfiguration,
} from '@shared/types';

@Component({
  selector: 'app-session-create-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="create-container" role="main">
      <div class="create-card">
        <h1 class="create-title">Create Session</h1>
        <p class="create-subtitle">Configure your estimation session</p>

        <form
          [formGroup]="sessionForm"
          (ngSubmit)="onSubmit()"
          class="create-form"
          aria-label="Session creation form"
        >
          <!-- Game Name (optional) -->
          <div class="form-field">
            <label for="gameName">Game Name (optional)</label>
            <input
              id="gameName"
              type="text"
              formControlName="gameName"
              placeholder="e.g. Sprint 42 Planning"
              aria-label="Game name"
              class="form-field__input"
            />
          </div>

          <!-- Voting System (primary visible field) -->
          <div class="form-field">
            <label for="votingSystem">Voting System</label>
            <select
              id="votingSystem"
              formControlName="votingSystem"
              aria-label="Select voting system"
            >
              <option value="fibonacci">Fibonacci (0, 1, 2, 3, 5, 8, 13…)</option>
              <option value="modified-fibonacci">
                Modified Fibonacci (0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100)
              </option>
              <option value="t-shirt">T-Shirt (XS, S, M, L, XL, XXL)</option>
              <option value="power-of-2">Power of 2 (0, 1, 2, 4, 8, 16, 32, 64)</option>
            </select>
          </div>

          <!-- Advanced Settings Toggle -->
          <button
            type="button"
            class="advanced-toggle"
            (click)="toggleAdvanced()"
            [attr.aria-expanded]="showAdvanced()"
            aria-controls="advanced-settings"
          >
            <span class="advanced-toggle__icon" [class.open]="showAdvanced()">▶</span>
            Advanced Settings
          </button>

          <!-- Advanced Settings Section (collapsed by default) -->
          @if (showAdvanced()) {
            <div id="advanced-settings" class="advanced-settings">
              <!-- Reveal Permission -->
              <fieldset class="form-fieldset">
                <legend>Reveal Permission</legend>
                <div class="radio-group" role="radiogroup" aria-label="Reveal permission options">
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="revealPermission"
                      value="moderator-only"
                      aria-label="Moderator only can reveal cards"
                    />
                    <span class="radio-text">Moderator only</span>
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="revealPermission"
                      value="all-players"
                      aria-label="All players can reveal cards"
                    />
                    <span class="radio-text">All players</span>
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="revealPermission"
                      value="select-specific"
                      aria-label="Select specific participants to reveal cards"
                    />
                    <span class="radio-text">Select specific participants</span>
                  </label>
                </div>
                @if (sessionForm.get('revealPermission')?.value === 'select-specific') {
                  <p class="hint-text" role="note">
                    You can select specific participants after the session is created.
                  </p>
                }
              </fieldset>

              <!-- Issue Permission -->
              <fieldset class="form-fieldset">
                <legend>Issue Permission</legend>
                <div class="radio-group" role="radiogroup" aria-label="Issue permission options">
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="issuePermission"
                      value="moderator-only"
                      aria-label="Moderator only can manage issues"
                    />
                    <span class="radio-text">Moderator only</span>
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="issuePermission"
                      value="all-players"
                      aria-label="All players can manage issues"
                    />
                    <span class="radio-text">All players</span>
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      formControlName="issuePermission"
                      value="select-specific"
                      aria-label="Select specific participants to manage issues"
                    />
                    <span class="radio-text">Select specific participants</span>
                  </label>
                </div>
                @if (sessionForm.get('issuePermission')?.value === 'select-specific') {
                  <p class="hint-text" role="note">
                    You can select specific participants after the session is created.
                  </p>
                }
              </fieldset>

              <!-- Toggles -->
              <fieldset class="form-fieldset">
                <legend>Additional Options</legend>

                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="autoReveal"
                    aria-label="Enable auto-reveal when all participants have voted"
                  />
                  <span class="toggle-text">Auto-reveal</span>
                  <span class="toggle-description">
                    Automatically reveal cards when all participants have voted
                  </span>
                </label>

                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="countdownAnimation"
                    aria-label="Enable countdown animation before card reveal"
                  />
                  <span class="toggle-text">Countdown animation</span>
                  <span class="toggle-description">
                    Show a 3-2-1 countdown before revealing cards
                  </span>
                </label>
              </fieldset>
            </div>
          }

          <!-- Submit -->
          <button
            type="submit"
            class="submit-btn"
            [disabled]="isSubmitting"
            aria-label="Create session"
            [attr.aria-busy]="isSubmitting"
          >
            @if (isSubmitting) {
              <span class="spinner" aria-hidden="true"></span>
              Creating…
            } @else {
              Create Session
            }
          </button>
        </form>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100dvh;
      }

      .create-container {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100%;
        padding: 1rem;
        background: var(--gradient-page-bg);
      }

      .create-card {
        background: var(--surface-card-deck);
        border-radius: 12px;
        padding: 2.5rem 2rem;
        width: 100%;
        max-width: 480px;
        box-shadow: var(--shadow-lg);
      }

      .create-title {
        font-size: 1.75rem;
        font-weight: 700;
        color: var(--text-primary);
        text-align: center;
        margin: 0 0 0.25rem;
        background: var(--gradient-primary);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .create-subtitle {
        font-size: 0.95rem;
        color: var(--text-secondary);
        text-align: center;
        margin: 0 0 1.5rem;
      }

      .create-form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;

        label {
          font-size: 0.875rem;
          font-weight: 500;
          color: var(--text-secondary);
        }

        select,
        input[type='text'] {
          padding: 0.625rem 0.75rem;
          border: 1px solid var(--color-primary-light);
          border-radius: 8px;
          font-size: 1rem;
          color: var(--text-primary);
          background: #fff;
          min-height: 44px;
          cursor: pointer;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;

          &:focus {
            outline: none;
            border-color: var(--color-primary);
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
          }
        }

        input[type='text'] {
          cursor: text;
        }
      }

      .form-fieldset {
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 1rem;
        margin: 0;

        legend {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--text-primary);
          padding: 0 0.5rem;
        }
      }

      .radio-group {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .radio-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
        font-size: 0.875rem;
        color: var(--text-primary);
        min-height: 44px;

        input[type='radio'] {
          width: 18px;
          height: 18px;
          accent-color: var(--color-primary);
          cursor: pointer;
        }
      }

      .radio-text {
        font-weight: 400;
      }

      .hint-text {
        font-size: 0.8125rem;
        color: var(--text-secondary);
        margin: 0.5rem 0 0;
        padding: 0.5rem;
        background: #f3f4f6;
        border-radius: 6px;
        font-style: italic;
      }

      .toggle-label {
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
        gap: 0 0.5rem;
        align-items: center;
        cursor: pointer;
        min-height: 44px;
        padding: 0.375rem 0;

        input[type='checkbox'] {
          grid-row: 1 / 3;
          width: 18px;
          height: 18px;
          accent-color: var(--color-primary);
          cursor: pointer;
        }
      }

      .toggle-text {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .toggle-description {
        font-size: 0.8125rem;
        color: var(--text-secondary);
        grid-column: 2;
      }

      .submit-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.75rem 1.5rem;
        border: none;
        border-radius: 8px;
        background: var(--gradient-primary);
        color: var(--text-on-primary);
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s ease, transform 0.1s ease;
        min-height: 44px;
        margin-top: 0.5rem;

        &:hover:not(:disabled) {
          opacity: 0.9;
        }

        &:active:not(:disabled) {
          transform: scale(0.98);
        }

        &:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        &:focus-visible {
          outline: 2px solid var(--color-primary);
          outline-offset: 2px;
        }
      }

      .spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
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

      .advanced-toggle {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.75rem 1rem;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #f9fafb;
        color: var(--text-primary);
        font-size: 0.875rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 44px;
        transition: background 0.15s ease;
      }

      .advanced-toggle:hover {
        background: #f3f4f6;
      }

      .advanced-toggle:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
      }

      .advanced-toggle__icon {
        display: inline-block;
        font-size: 0.75rem;
        transition: transform 0.2s ease;
      }

      .advanced-toggle__icon.open {
        transform: rotate(90deg);
      }

      .advanced-settings {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        padding: 1rem;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #f9fafb;
      }

      @media (prefers-reduced-motion: reduce) {
        .form-field select {
          transition: none;
        }

        .submit-btn {
          transition: none;
        }

        .spinner {
          animation: none;
        }

        .advanced-toggle {
          transition: none;
        }

        .advanced-toggle__icon {
          transition: none;
        }
      }
    `,
  ],
})
export class SessionCreatePageComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);

  sessionForm!: FormGroup;
  isSubmitting = false;
  readonly showAdvanced = signal(false);

  toggleAdvanced(): void {
    this.showAdvanced.update((v) => !v);
  }

  ngOnInit(): void {
    this.sessionForm = this.fb.group({
      gameName: [''],
      votingSystem: ['fibonacci', Validators.required],
      revealPermission: ['moderator-only', Validators.required],
      issuePermission: ['moderator-only', Validators.required],
      autoReveal: [false],
      countdownAnimation: [true],
    });
  }

  onSubmit(): void {
    if (this.sessionForm.invalid) {
      return;
    }

    this.isSubmitting = true;

    const formValue = this.sessionForm.value;

    const config: SessionConfiguration = {
      votingSystem: formValue.votingSystem as VotingSystemType,
      revealPermission: {
        mode: formValue.revealPermission as PermissionMode,
        allowedUserIds: [],
      },
      issuePermission: {
        mode: formValue.issuePermission as PermissionMode,
        allowedUserIds: [],
      },
      autoReveal: formValue.autoReveal ?? false,
      countdownAnimation: formValue.countdownAnimation ?? false,
      ...(formValue.gameName?.trim() ? { gameName: formValue.gameName.trim() } : {}),
    };

    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
    });

    this.http
      .post<{ sessionId: string; config: SessionConfiguration; createdAt: string }>(
        this.basePath.getApiUrl('/api/sessions'),
        { config },
        { headers }
      )
      .subscribe({
        next: (response) => {
          this.router.navigate(['/session', response.sessionId]);
        },
        error: () => {
          this.isSubmitting = false;
          this.toastService.show('error', 'Failed to create session. Please try again.');
        },
      });
  }
}
