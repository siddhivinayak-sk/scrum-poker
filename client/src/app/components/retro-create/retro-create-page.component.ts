import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { RetroConfiguration, RetroTemplate, DEFAULT_ALLOWED_FEELINGS } from '@shared/types';
import { RETRO_TEMPLATES } from '@shared/retro-templates';

/**
 * Validator that ensures a positive integer (> 0, no decimals).
 */
function positiveIntegerValidator(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (value === null || value === undefined || value === '') {
    return { required: true };
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return { positiveInteger: true };
  }
  return null;
}

/**
 * Validator that ensures a non-empty trimmed string.
 */
function nonEmptyValidator(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    return { nonEmpty: true };
  }
  return null;
}

@Component({
  selector: 'app-retro-create-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="create-container" role="main">
      <div class="create-card">
        <h1 class="create-title">Create Retrospective Board</h1>
        <p class="create-subtitle">Set up a structured retrospective for your team</p>

        <form
          [formGroup]="retroForm"
          (ngSubmit)="onSubmit()"
          class="create-form"
          aria-label="Retrospective board creation form"
        >
          <!-- Board Name -->
          <div class="form-field">
            <label for="boardName">Board Name</label>
            <input
              id="boardName"
              type="text"
              formControlName="boardName"
              placeholder="e.g. Sprint 42 Retrospective"
              aria-label="Board name"
              class="form-field__input"
              [attr.aria-invalid]="retroForm.get('boardName')?.invalid && retroForm.get('boardName')?.touched"
            />
            @if (retroForm.get('boardName')?.invalid && retroForm.get('boardName')?.touched) {
              <span class="error-text" role="alert">Board name is required</span>
            }
          </div>

          <!-- Max Votes Per User -->
          <div class="form-field">
            <label for="maxVotes">Max Votes Per User</label>
            <input
              id="maxVotes"
              type="number"
              formControlName="maxVotesPerUser"
              min="1"
              step="1"
              aria-label="Maximum votes per user"
              class="form-field__input"
              [attr.aria-invalid]="retroForm.get('maxVotesPerUser')?.invalid && retroForm.get('maxVotesPerUser')?.touched"
            />
            @if (retroForm.get('maxVotesPerUser')?.invalid && retroForm.get('maxVotesPerUser')?.touched) {
              <span class="error-text" role="alert">Must be a positive integer</span>
            }
          </div>

          <!-- Template Selection -->
          <div class="form-field">
            <label for="template">Template</label>
            <select
              id="template"
              formControlName="templateId"
              aria-label="Select retrospective template"
            >
              @for (template of templates; track template.id) {
                <option [value]="template.id">{{ template.name }}</option>
              }
            </select>
          </div>

          <!-- Template Preview -->
          @if (selectedTemplate()) {
            <div class="template-preview" aria-live="polite">
              <span class="template-preview__label">Columns:</span>
              @for (col of selectedTemplate()!.columns; track col) {
                <span class="template-preview__column">{{ col }}</span>
              }
            </div>
          }

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

          <!-- Advanced Settings Section -->
          @if (showAdvanced()) {
            <div id="advanced-settings" class="advanced-settings">
              <fieldset class="form-fieldset">
                <legend>Board Configuration</legend>

                <!-- Hide cards initially -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="hideCardsInitially"
                    aria-label="Hide cards initially until moderator reveals them"
                  />
                  <span class="toggle-text">Hide cards initially</span>
                  <span class="toggle-description">
                    Cards are hidden until the moderator reveals them
                  </span>
                </label>

                <!-- Disable voting initially -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="disableVotingInitially"
                    aria-label="Disable voting initially until moderator enables it"
                  />
                  <span class="toggle-text">Disable voting initially</span>
                  <span class="toggle-description">
                    Voting is disabled until the moderator enables it
                  </span>
                </label>

                <!-- Hide vote count -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="hideVoteCount"
                    aria-label="Hide vote count on cards"
                  />
                  <span class="toggle-text">Hide vote count on cards</span>
                  <span class="toggle-description">
                    Vote counts are not visible on cards
                  </span>
                </label>

                <!-- One vote per card -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="oneVotePerCard"
                    aria-label="Limit to one vote per card per participant"
                  />
                  <span class="toggle-text">One vote per card</span>
                  <span class="toggle-description">
                    Each participant can only vote once per card
                  </span>
                </label>

                <!-- Show card author -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="showCardAuthor"
                    aria-label="Show card author name on cards"
                  />
                  <span class="toggle-text">Show card author</span>
                  <span class="toggle-description">
                    Display the author's name on each card
                  </span>
                </label>

                <!-- Secure with password -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="secureWithPassword"
                    aria-label="Secure board with a password"
                  />
                  <span class="toggle-text">Secure board with password</span>
                  <span class="toggle-description">
                    Require a password to join the board
                  </span>
                </label>

                <!-- Password input (shown when toggle enabled) -->
                @if (retroForm.get('secureWithPassword')?.value) {
                  <div class="form-field password-field">
                    <label for="password">Board Password</label>
                    <input
                      id="password"
                      type="password"
                      formControlName="password"
                      placeholder="Enter board password"
                      aria-label="Board password"
                      class="form-field__input"
                    />
                  </div>
                }

                <!-- Enable GIF/emoji -->
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    formControlName="enableGifEmoji"
                    aria-label="Enable GIF and emoji on cards"
                  />
                  <span class="toggle-text">Enable GIF/emoji</span>
                  <span class="toggle-description">
                    Allow GIF and emoji insertion on cards
                  </span>
                </label>

                <!-- Column layout -->
                <div class="layout-field">
                  <span class="toggle-text">Column layout</span>
                  <div class="layout-options" role="radiogroup" aria-label="Column layout options">
                    <label class="radio-label">
                      <input
                        type="radio"
                        formControlName="columnLayout"
                        value="vertical"
                        aria-label="Vertical column layout (side-by-side)"
                      />
                      <span class="radio-text">Vertical (side-by-side)</span>
                    </label>
                    <label class="radio-label">
                      <input
                        type="radio"
                        formControlName="columnLayout"
                        value="horizontal"
                        aria-label="Horizontal column layout (stacked)"
                      />
                      <span class="radio-text">Horizontal (stacked)</span>
                    </label>
                  </div>
                </div>
              </fieldset>
            </div>
          }

          <!-- Submit -->
          <button
            type="submit"
            class="submit-btn"
            [disabled]="isSubmitting"
            aria-label="Create retrospective board"
            [attr.aria-busy]="isSubmitting"
          >
            @if (isSubmitting) {
              <span class="spinner" aria-hidden="true"></span>
              Creating…
            } @else {
              Create Board
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
        max-width: 520px;
        box-shadow: var(--shadow-lg);
        max-height: 90dvh;
        overflow-y: auto;
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
        input[type='text'],
        input[type='number'],
        input[type='password'] {
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

        input[type='text'],
        input[type='number'],
        input[type='password'] {
          cursor: text;
        }
      }

      .error-text {
        font-size: 0.8125rem;
        color: #dc2626;
        margin-top: 0.125rem;
      }

      .template-preview {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        align-items: center;
        padding: 0.75rem;
        background: #f0f4ff;
        border-radius: 8px;
        border: 1px solid #e0e7ff;
      }

      .template-preview__label {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-secondary);
        margin-right: 0.25rem;
      }

      .template-preview__column {
        font-size: 0.8125rem;
        padding: 0.25rem 0.5rem;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        color: var(--text-primary);
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

      .password-field {
        margin-left: 1.5rem;
        margin-top: 0.25rem;
      }

      .layout-field {
        padding: 0.5rem 0;

        .layout-options {
          display: flex;
          gap: 1rem;
          margin-top: 0.375rem;
        }
      }

      .radio-label {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        cursor: pointer;
        font-size: 0.875rem;
        color: var(--text-primary);

        input[type='radio'] {
          width: 16px;
          height: 16px;
          accent-color: var(--color-primary);
          cursor: pointer;
        }
      }

      .radio-text {
        font-weight: 400;
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
        .form-field select,
        .form-field input {
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
export class RetroCreatePageComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);

  readonly templates: RetroTemplate[] = RETRO_TEMPLATES;
  retroForm!: FormGroup;
  isSubmitting = false;
  readonly showAdvanced = signal(false);
  readonly selectedTemplate = signal<RetroTemplate | null>(RETRO_TEMPLATES[0]);

  toggleAdvanced(): void {
    this.showAdvanced.update((v) => !v);
  }

  ngOnInit(): void {
    this.retroForm = this.fb.group({
      boardName: ['', [nonEmptyValidator]],
      maxVotesPerUser: [6, [positiveIntegerValidator]],
      templateId: [RETRO_TEMPLATES[0].id, Validators.required],
      hideCardsInitially: [true],
      disableVotingInitially: [true],
      hideVoteCount: [true],
      oneVotePerCard: [false],
      showCardAuthor: [false],
      secureWithPassword: [false],
      password: [''],
      enableGifEmoji: [true],
      columnLayout: ['vertical', Validators.required],
    });

    // Update template preview when selection changes
    this.retroForm.get('templateId')?.valueChanges.subscribe((templateId: string) => {
      const template = RETRO_TEMPLATES.find((t) => t.id === templateId) ?? null;
      this.selectedTemplate.set(template);
    });
  }

  onSubmit(): void {
    // Mark all fields as touched to trigger validation display
    this.retroForm.markAllAsTouched();

    if (this.retroForm.invalid) {
      return;
    }

    this.isSubmitting = true;

    const formValue = this.retroForm.value;

    const config: RetroConfiguration = {
      boardName: formValue.boardName.trim(),
      maxVotesPerUser: Number(formValue.maxVotesPerUser),
      templateId: formValue.templateId,
      hideCardsInitially: formValue.hideCardsInitially ?? false,
      disableVotingInitially: formValue.disableVotingInitially ?? false,
      hideVoteCount: formValue.hideVoteCount ?? false,
      oneVotePerCard: formValue.oneVotePerCard ?? false,
      showCardAuthor: formValue.showCardAuthor ?? false,
      password: formValue.secureWithPassword ? (formValue.password || null) : null,
      enableGifEmoji: formValue.enableGifEmoji ?? true,
      columnLayout: formValue.columnLayout ?? 'vertical',
      allowedFeelings: DEFAULT_ALLOWED_FEELINGS,
    };

    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
    });

    this.http
      .post<{ sessionId: string; config: RetroConfiguration }>(
        this.basePath.getApiUrl('/api/retro/sessions'),
        { config },
        { headers }
      )
      .subscribe({
        next: (response) => {
          this.router.navigate(['/retro', response.sessionId]);
        },
        error: () => {
          this.isSubmitting = false;
          this.toastService.show('error', 'Failed to create retrospective board. Please try again.');
        },
      });
  }
}
