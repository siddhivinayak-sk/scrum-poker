import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { RetroColumnComponent } from './retro-column.component';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroUserMenuComponent } from './retro-user-menu.component';

@Component({
  selector: 'app-retro-board-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RetroColumnComponent,
    RetroToolbarComponent,
    RetroUserMenuComponent,
  ],
  template: `
    <div class="retro-board" [class.retro-board--horizontal]="isHorizontalLayout()">
      <header class="retro-board__header">
        <div class="retro-board__header-left">
          <button
            class="retro-board__lobby-btn"
            type="button"
            title="Back to Lobby"
            aria-label="Back to Lobby"
            (click)="goToLobby()"
          >🏠</button>
          <h1 class="retro-board__title">{{ boardName() }}</h1>
        </div>
        <div class="retro-board__meta">
          <span class="retro-board__votes-remaining"
            title="Your remaining votes"
            aria-label="Your remaining votes: {{ votesRemaining() }}"
          >
            🗳️ {{ votesRemaining() }} votes left
          </span>
          <span class="retro-board__session-id" title="Session ID: {{ sessionId() }}">
            ID: {{ sessionId() }}
          </span>
          <span
            class="retro-board__connection-status"
            [class.retro-board__connection-status--connected]="connectionState() === 'connected'"
            [class.retro-board__connection-status--reconnecting]="connectionState() === 'reconnecting'"
            [title]="connectionState()"
            [attr.aria-label]="'Connection status: ' + connectionState()"
          >
            @if (connectionState() === 'connected') { ● }
            @else if (connectionState() === 'reconnecting') { ◌ }
            @else { ○ }
          </span>
          <button
            class="retro-board__copy-link-btn"
            type="button"
            title="Copy session link"
            aria-label="Copy session link"
            (click)="onCopyLink()"
          >🔗</button>
          <app-retro-user-menu />
        </div>
      </header>

      <app-retro-toolbar
        [isModerator]="isModerator()"
        [isCompleted]="isCompleted()"
      />

      <div class="retro-board__context">
        @if (isModerator()) {
          <input
            type="text"
            class="retro-board__context-input"
            [ngModel]="context()"
            (ngModelChange)="onContextChange($event)"
            placeholder="Set sprint context (e.g., Sprint 14 - User Authentication)"
            aria-label="Sprint context"
          />
        } @else {
          @if (context()) {
            <div class="retro-board__context-display" aria-label="Sprint context">
              {{ context() }}
            </div>
          }
        }
      </div>

      <div
        class="retro-board__columns"
        [class.retro-board__columns--vertical]="!isHorizontalLayout()"
        [class.retro-board__columns--horizontal]="isHorizontalLayout()"
        role="region"
        aria-label="Retrospective columns"
      >
        @for (column of columns(); track column.id) {
          <app-retro-column [column]="column" />
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100dvh;
      overflow: hidden;
    }

    .retro-board {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 0.5rem;
      background: var(--gradient-page-bg, #f5f7fa);
      font-size: 0.8rem;
    }

    /* Header */
    .retro-board__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.375rem 0.75rem;
      background: var(--gradient-primary, linear-gradient(135deg, #667eea 0%, #764ba2 100%));
      border-radius: 8px;
      margin-bottom: 0.375rem;
      flex-shrink: 0;
    }

    .retro-board__header-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    .retro-board__lobby-btn {
      border: none;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      padding: 0.2rem 0.4rem;
      min-width: 28px;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .retro-board__lobby-btn:hover {
      background: rgba(255, 255, 255, 0.25);
    }

    .retro-board__title {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--text-on-primary, #fff);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .retro-board__copy-link-btn {
      border: none;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0.2rem 0.4rem;
      min-width: 28px;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .retro-board__copy-link-btn:hover {
      background: rgba(255, 255, 255, 0.25);
    }

    .retro-board__meta {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .retro-board__votes-remaining {
      font-size: 0.75rem;
      color: rgba(255, 255, 255, 0.9);
      font-weight: 500;
    }

    .retro-board__session-id {
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.7);
      font-family: monospace;
    }

    .retro-board__connection-status {
      font-size: 0.75rem;
      color: rgba(255, 255, 255, 0.6);
    }

    .retro-board__connection-status--connected {
      color: #4caf50;
    }

    .retro-board__connection-status--reconnecting {
      color: #ff9800;
    }

    /* Context */
    .retro-board__context {
      flex-shrink: 0;
      margin-bottom: 0.375rem;
    }

    .retro-board__context-input {
      width: 100%;
      padding: 0.375rem 0.5rem;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      font-size: 0.75rem;
      background: #fff;
      outline: none;
      transition: border-color 0.15s ease;
      box-sizing: border-box;
    }

    .retro-board__context-input:focus {
      border-color: var(--color-primary, #667eea);
      box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.15);
    }

    .retro-board__context-display {
      padding: 0.375rem 0.5rem;
      font-size: 0.75rem;
      color: #555;
      background: #f9fafb;
      border-radius: 6px;
      border: 1px solid #eee;
      min-height: 1.75rem;
      display: flex;
      align-items: center;
    }

    /* Columns container */
    .retro-board__columns {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }

    /* Vertical layout: columns side-by-side in a horizontal row */
    .retro-board__columns--vertical {
      display: flex;
      flex-direction: row;
      gap: 0.5rem;
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* Horizontal layout: columns stacked top-to-bottom */
    .retro-board__columns--horizontal {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      overflow-y: auto;
      overflow-x: hidden;
    }

    /* Ensure columns don't shrink in vertical layout */
    .retro-board__columns--vertical > :host ::ng-deep app-retro-column {
      flex-shrink: 0;
    }

    /* Scrollbar styling */
    .retro-board__columns::-webkit-scrollbar {
      height: 8px;
      width: 8px;
    }

    .retro-board__columns::-webkit-scrollbar-track {
      background: #e0e0e0;
      border-radius: 4px;
    }

    .retro-board__columns::-webkit-scrollbar-thumb {
      background: #888;
      border-radius: 4px;
    }

    .retro-board__columns::-webkit-scrollbar-thumb:hover {
      background: #666;
    }

    @media (prefers-reduced-motion: reduce) {
      .retro-board__context-input {
        transition: none;
      }
    }
  `],
})
export class RetroBoardPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly authService = inject(AuthService);
  private readonly toastService = inject(ToastService);

  private contextDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Session ID from route params */
  readonly sessionId = signal<string>('');

  /** Reactive state from RetroStateService */
  readonly columns = this.retroState.columns;
  readonly votesRemaining = this.retroState.votesRemaining;
  readonly isModerator = this.retroState.isModerator;
  readonly isCompleted = this.retroState.isCompleted;
  readonly context = this.retroState.context;

  /** Connection state from WebSocket service */
  readonly connectionState = this.ws.connectionState;

  /** Board name from config */
  readonly boardName = computed(() => {
    const config = this.retroState.config();
    return config?.boardName ?? 'Retrospective';
  });

  /** Whether the layout is horizontal (stacked) */
  readonly isHorizontalLayout = computed(() => {
    const config = this.retroState.config();
    return config?.columnLayout === 'horizontal';
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('sessionId') ?? '';
    this.sessionId.set(id);

    if (!id) return;

    const token = this.authService.getToken();
    if (!token) {
      // No auth token — redirect to retro login page
      this.router.navigate(['/retro', id, 'login']);
      return;
    }

    this.ws.connect(id, token);
  }

  ngOnDestroy(): void {
    this.ws.disconnect();
    this.retroState.reset();
    if (this.contextDebounceTimer !== null) {
      clearTimeout(this.contextDebounceTimer);
    }
  }

  /**
   * Navigate back to the lobby.
   */
  goToLobby(): void {
    this.router.navigate(['/lobby']);
  }

  /**
   * Copy the session link to clipboard.
   */
  onCopyLink(): void {
    const url = window.location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => this.toastService.show('info', 'Link copied to clipboard'),
        () => this.toastService.show('error', 'Failed to copy link')
      );
    }
  }

  /**
   * Handle context input changes with debounce.
   * Only moderators can edit context (enforced by template).
   */
  onContextChange(text: string): void {
    if (this.contextDebounceTimer !== null) {
      clearTimeout(this.contextDebounceTimer);
    }
    this.contextDebounceTimer = setTimeout(() => {
      this.ws.sendContextUpdate(text);
      this.contextDebounceTimer = null;
    }, 300);
  }
}
