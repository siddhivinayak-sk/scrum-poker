import { Component, input, inject, effect, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { SessionStateService } from '../../services/session-state.service';
import { BasePathService } from '../../services/base-path.service';
import {
  SessionConfiguration,
  VotingSystemType,
  PermissionMode,
} from '@shared/types';

@Component({
  selector: 'app-session-settings-panel',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    @if (isOwner()) {
      <div class="settings-wrapper">
        <button
          class="toggle-btn"
          (click)="togglePanel()"
          [attr.aria-expanded]="isOpen()"
          aria-controls="settings-panel"
          title="Session settings"
        >
          <span class="toggle-icon-gear">⚙</span>
        </button>

        @if (isOpen()) {
          <div class="settings-backdrop" (click)="togglePanel()" aria-hidden="true"></div>
          <div id="settings-panel" class="settings-panel" role="region" aria-label="Session settings">
            <div class="settings-panel__header">
              <span class="settings-panel__title">Session Settings</span>
              <button class="settings-panel__close" (click)="togglePanel()" aria-label="Close settings" title="Close settings">✕</button>
            </div>
            <form [formGroup]="settingsForm" class="settings-form" aria-label="Session settings form">
              <!-- Voting System (primary visible field) -->
              <div class="form-field">
                <label for="settings-votingSystem">Voting System</label>
                <select
                  id="settings-votingSystem"
                  formControlName="votingSystem"
                  (change)="onFieldChange()"
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
                aria-controls="advanced-settings-panel"
              >
                <span class="advanced-toggle__icon" [class.open]="showAdvanced()">▶</span>
                Advanced Settings
              </button>

              @if (showAdvanced()) {
                <div id="advanced-settings-panel" class="advanced-settings">
                  <!-- Reveal Permission -->
                  <fieldset class="form-fieldset">
                    <legend>Reveal Permission</legend>
                    <div class="radio-group" role="radiogroup" aria-label="Reveal permission options">
                      <label class="radio-label">
                        <input
                          type="radio"
                          formControlName="revealPermission"
                          value="moderator-only"
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">Moderator only</span>
                      </label>
                      <label class="radio-label">
                        <input
                          type="radio"
                          formControlName="revealPermission"
                          value="all-players"
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">All players</span>
                      </label>
                      <label class="radio-label">
                        <input
                          type="radio"
                          formControlName="revealPermission"
                          value="select-specific"
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">Select specific participants</span>
                      </label>
                    </div>
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
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">Moderator only</span>
                      </label>
                      <label class="radio-label">
                        <input
                          type="radio"
                          formControlName="issuePermission"
                          value="all-players"
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">All players</span>
                      </label>
                      <label class="radio-label">
                        <input
                          type="radio"
                          formControlName="issuePermission"
                          value="select-specific"
                          (change)="onFieldChange()"
                        />
                        <span class="radio-text">Select specific participants</span>
                      </label>
                    </div>
                  </fieldset>

                  <!-- Toggles -->
                  <fieldset class="form-fieldset">
                    <legend>Additional Options</legend>

                    <label class="toggle-label">
                      <input
                        type="checkbox"
                        formControlName="autoReveal"
                        (change)="onFieldChange()"
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
                        (change)="onFieldChange()"
                      />
                      <span class="toggle-text">Countdown animation</span>
                      <span class="toggle-description">
                        Show a 3-2-1 countdown before revealing cards
                      </span>
                    </label>
                  </fieldset>
                </div>
              }
            </form>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .settings-wrapper {
        position: relative;
      }

      .toggle-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.15);
        color: var(--text-on-primary, #fff);
        font-size: 1.2rem;
        cursor: pointer;
        transition: background 0.15s ease;

        &:hover {
          background: rgba(255, 255, 255, 0.25);
        }
      }

      .toggle-icon-gear {
        font-size: 1.2rem;
        line-height: 1;
      }

      .settings-backdrop {
        position: fixed;
        inset: 0;
        z-index: 49;
      }

      .settings-panel {
        position: absolute;
        top: 100%;
        right: 0;
        width: 340px;
        max-height: 70vh;
        overflow-y: auto;
        z-index: 50;
        margin-top: 0.5rem;
        padding: 1rem;
        border: 1px solid #c5cae9;
        border-radius: 10px;
        background: #e8eaf6;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      }

      .settings-panel__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.75rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid #c5cae9;
      }

      .settings-panel__title {
        font-size: 0.9rem;
        font-weight: 700;
        color: var(--text-primary, #1a1a2e);
      }

      .settings-panel__close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.08);
        font-size: 0.9rem;
        cursor: pointer;
        color: var(--text-secondary, #555);
        transition: background 0.15s ease;
      }

      .settings-panel__close:hover {
        background: rgba(0, 0, 0, 0.15);
      }

      .settings-form {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;

        label {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--text-secondary);
        }

        select {
          padding: 0.5rem 0.625rem;
          border: 1px solid var(--color-primary-light);
          border-radius: 8px;
          font-size: 0.875rem;
          color: var(--text-primary);
          background: #fff;
          min-height: 44px;
          cursor: pointer;

          &:focus {
            outline: none;
            border-color: var(--color-primary);
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
          }
        }
      }

      .form-fieldset {
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 0.75rem;
        margin: 0;

        legend {
          font-size: 0.8rem;
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
        font-size: 0.8rem;
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
        font-size: 0.8rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .toggle-description {
        font-size: 0.75rem;
        color: var(--text-secondary);
        grid-column: 2;
      }

      @media (prefers-reduced-motion: reduce) {
        .toggle-btn {
          transition: none;
        }

        .advanced-toggle {
          transition: none;
        }

        .advanced-toggle__icon {
          transition: none;
        }
      }

      .advanced-toggle {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        background: #f9fafb;
        color: var(--text-primary);
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 36px;
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
        font-size: 0.65rem;
        transition: transform 0.2s ease;
      }

      .advanced-toggle__icon.open {
        transform: rotate(90deg);
      }

      .advanced-settings {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        background: #f9fafb;
      }
    `,
  ],
})
export class SessionSettingsPanelComponent implements OnInit, OnDestroy {
  readonly sessionId = input.required<string>();
  readonly config = input<SessionConfiguration | null>(null);
  readonly isOwner = input<boolean>(false);

  private readonly fb = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);
  private readonly sessionState = inject(SessionStateService);
  private readonly basePath = inject(BasePathService);

  readonly isOpen = signal<boolean>(false);
  readonly showAdvanced = signal<boolean>(false);

  readonly autoRevealEnabled = computed(() => {
    const cfg = this.config();
    return cfg?.autoReveal ?? false;
  });

  settingsForm!: FormGroup;
  private isSyncing = false;
  private previousVotingSystem: VotingSystemType | null = null;

  constructor() {
    // Sync form when config input changes (e.g., from WebSocket updates)
    effect(() => {
      const cfg = this.config();
      if (cfg && this.settingsForm && !this.isSyncing) {
        this.isSyncing = true;
        this.settingsForm.patchValue(
          {
            votingSystem: cfg.votingSystem,
            revealPermission: cfg.revealPermission.mode,
            issuePermission: cfg.issuePermission.mode,
            autoReveal: cfg.autoReveal,
            countdownAnimation: cfg.countdownAnimation,
          },
          { emitEvent: false }
        );
        this.previousVotingSystem = cfg.votingSystem;
        this.isSyncing = false;
      }
    });
  }

  ngOnInit(): void {
    const cfg = this.config();
    this.settingsForm = this.fb.group({
      votingSystem: [cfg?.votingSystem ?? 'fibonacci'],
      revealPermission: [cfg?.revealPermission.mode ?? 'moderator-only'],
      issuePermission: [cfg?.issuePermission.mode ?? 'moderator-only'],
      autoReveal: [cfg?.autoReveal ?? false],
      countdownAnimation: [cfg?.countdownAnimation ?? false],
    });
    this.previousVotingSystem = cfg?.votingSystem ?? 'fibonacci';
  }

  ngOnDestroy(): void {
    // No subscriptions to clean up — using effect() and direct event handlers
  }

  togglePanel(): void {
    this.isOpen.update((v) => !v);
  }

  toggleAdvanced(): void {
    this.showAdvanced.update((v) => !v);
  }

  onFieldChange(): void {
    if (this.isSyncing) return;

    const formValue = this.settingsForm.value;

    // Warn if voting system changed during active round
    const currentRound = this.sessionState.currentRound();
    if (
      formValue.votingSystem !== this.previousVotingSystem &&
      currentRound &&
      currentRound.status === 'voting'
    ) {
      this.toastService.show(
        'warning',
        'Changing the voting system during an active round may invalidate existing votes.'
      );
    }
    this.previousVotingSystem = formValue.votingSystem;

    const updatedConfig: Partial<SessionConfiguration> = {
      votingSystem: formValue.votingSystem as VotingSystemType,
      revealPermission: {
        mode: formValue.revealPermission as PermissionMode,
        allowedUserIds: this.config()?.revealPermission.allowedUserIds ?? [],
      },
      issuePermission: {
        mode: formValue.issuePermission as PermissionMode,
        allowedUserIds: this.config()?.issuePermission.allowedUserIds ?? [],
      },
      autoReveal: formValue.autoReveal ?? false,
      countdownAnimation: formValue.countdownAnimation ?? false,
    };

    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
    });

    this.http
      .put<{ config: SessionConfiguration }>(
        this.basePath.getApiUrl(`/api/sessions/${this.sessionId()}/config`),
        { config: updatedConfig },
        { headers }
      )
      .subscribe({
        error: () => {
          this.toastService.show('error', 'Failed to update session settings.');
        },
      });
  }
}
