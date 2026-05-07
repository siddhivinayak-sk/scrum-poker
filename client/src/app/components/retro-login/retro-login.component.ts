import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';

@Component({
  selector: 'app-retro-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="login-container" role="main">
      <div class="login-card">
        <h1 class="login-title">Join Retrospective</h1>
        <p class="login-subtitle">Enter your display name to join the board</p>

        @if (sessionNotFound()) {
          <div class="error-message" role="alert" aria-live="assertive">
            This retrospective session was not found. It may have expired or been removed.
          </div>
        } @else {
          <form
            [formGroup]="loginForm"
            (ngSubmit)="onSubmit()"
            class="login-form"
            aria-label="Retrospective login form"
          >
            <!-- Display Name -->
            <div class="form-field">
              <label for="displayName">Display Name</label>
              <input
                id="displayName"
                type="text"
                formControlName="displayName"
                placeholder="Enter your display name"
                aria-label="Enter your display name"
                [attr.aria-invalid]="loginForm.get('displayName')?.touched && loginForm.get('displayName')?.invalid"
                [attr.aria-describedby]="loginForm.get('displayName')?.touched && loginForm.get('displayName')?.invalid ? 'displayName-error' : null"
                autocomplete="username"
              />
              @if (loginForm.get('displayName')?.touched && loginForm.get('displayName')?.invalid) {
                <div id="displayName-error" class="error-text" role="alert" aria-live="polite">
                  A display name is required.
                </div>
              }
            </div>

            <!-- Password (shown only for password-protected boards) -->
            @if (requiresPassword()) {
              <div class="form-field">
                <label for="password">Board Password</label>
                <input
                  id="password"
                  type="password"
                  formControlName="password"
                  placeholder="Enter board password"
                  aria-label="Enter board password"
                  [attr.aria-invalid]="loginForm.get('password')?.touched && loginForm.get('password')?.invalid"
                  [attr.aria-describedby]="loginForm.get('password')?.touched && loginForm.get('password')?.invalid ? 'password-error' : null"
                />
                @if (loginForm.get('password')?.touched && loginForm.get('password')?.invalid) {
                  <div id="password-error" class="error-text" role="alert" aria-live="polite">
                    Password is required for this board.
                  </div>
                }
              </div>
            }

            <!-- Error message -->
            @if (loginError()) {
              <div class="error-message" role="alert" aria-live="assertive">
                {{ loginError() }}
              </div>
            }

            <!-- Submit -->
            <button
              type="submit"
              class="submit-btn"
              [disabled]="isSubmitting()"
              aria-label="Join retrospective board"
              [attr.aria-busy]="isSubmitting()"
            >
              @if (isSubmitting()) {
                <span class="spinner" aria-hidden="true"></span>
                Joining…
              } @else {
                Join Board
              }
            </button>
          </form>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100dvh;
      }

      .login-container {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100%;
        padding: 1rem;
        background: var(--gradient-page-bg);
      }

      .login-card {
        background: var(--surface-card-deck);
        border-radius: 12px;
        padding: 2.5rem 2rem;
        width: 100%;
        max-width: 420px;
        box-shadow: var(--shadow-lg);
      }

      .login-title {
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

      .login-subtitle {
        font-size: 0.95rem;
        color: var(--text-secondary);
        text-align: center;
        margin: 0 0 1.5rem;
      }

      .login-form {
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

        input {
          padding: 0.625rem 0.75rem;
          border: 1px solid var(--color-primary-light);
          border-radius: 8px;
          font-size: 1rem;
          color: var(--text-primary);
          background: #fff;
          min-height: 44px;
          cursor: text;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;

          &:focus {
            outline: none;
            border-color: var(--color-primary);
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
          }
        }
      }

      .error-text {
        font-size: 0.8125rem;
        color: #dc2626;
        margin-top: 0.125rem;
      }

      .error-message {
        padding: 0.75rem 1rem;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 8px;
        color: #dc2626;
        font-size: 0.875rem;
        text-align: center;
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

      @media (prefers-reduced-motion: reduce) {
        .form-field input {
          transition: none;
        }

        .submit-btn {
          transition: none;
        }

        .spinner {
          animation: none;
        }
      }
    `,
  ],
})
export class RetroLoginComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly basePath = inject(BasePathService);

  loginForm!: FormGroup;
  readonly sessionNotFound = signal(false);
  readonly requiresPassword = signal(false);
  readonly isSubmitting = signal(false);
  readonly loginError = signal<string | null>(null);

  private sessionId = '';

  ngOnInit(): void {
    this.sessionId = this.route.snapshot.paramMap.get('sessionId') ?? '';

    this.loginForm = this.fb.group({
      displayName: ['', [Validators.required, Validators.minLength(1)]],
      password: [''],
    });

    if (!this.sessionId) {
      this.sessionNotFound.set(true);
      return;
    }

    // Check if session exists and whether it requires a password
    this.http
      .get<{ exists: boolean; hasPassword?: boolean }>(
        this.basePath.getApiUrl(`/api/retro/sessions/${this.sessionId}/exists`)
      )
      .subscribe({
        next: (response) => {
          if (!response.exists) {
            this.sessionNotFound.set(true);
            return;
          }
          if (response.hasPassword) {
            this.requiresPassword.set(true);
            this.loginForm.get('password')?.setValidators([Validators.required]);
            this.loginForm.get('password')?.updateValueAndValidity();
          }
        },
        error: () => {
          this.sessionNotFound.set(true);
        },
      });
  }

  onSubmit(): void {
    this.loginForm.markAllAsTouched();

    if (this.loginForm.invalid) {
      return;
    }

    const displayName = this.loginForm.value.displayName.trim();
    if (!displayName) {
      this.loginForm.get('displayName')?.setErrors({ required: true });
      return;
    }

    this.isSubmitting.set(true);
    this.loginError.set(null);

    // If password-protected, verify password first
    if (this.requiresPassword()) {
      const password = this.loginForm.value.password;
      this.http
        .post<{ valid: boolean }>(
          this.basePath.getApiUrl(`/api/retro/sessions/${this.sessionId}/verify-password`),
          { password }
        )
        .subscribe({
          next: (response) => {
            if (response.valid) {
              this.authenticateAndJoin(displayName);
            } else {
              this.isSubmitting.set(false);
              this.loginError.set('Incorrect password. Please try again.');
            }
          },
          error: (err) => {
            this.isSubmitting.set(false);
            if (err?.status === 403) {
              this.loginError.set('Incorrect password. Please try again.');
            } else if (err?.status === 404) {
              this.sessionNotFound.set(true);
            } else {
              this.loginError.set('Failed to verify password. Please try again.');
            }
          },
        });
    } else {
      this.authenticateAndJoin(displayName);
    }
  }

  private authenticateAndJoin(displayName: string): void {
    // Use existing auth service to get JWT token with the display name
    this.authService.login(displayName, false).subscribe({
      next: () => {
        this.router.navigate(['/retro', this.sessionId]);
      },
      error: (err) => {
        this.isSubmitting.set(false);
        if (err?.error?.error === 'DISPLAY_NAME_TAKEN' || err?.error?.error === 'DUPLICATE_NAME') {
          this.loginError.set('This display name is already taken. Please choose another.');
        } else {
          this.loginError.set('Failed to join the board. Please try again.');
        }
      },
    });
  }
}
