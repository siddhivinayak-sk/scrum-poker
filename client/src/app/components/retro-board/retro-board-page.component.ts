import {
  Component,
  OnInit,
  OnDestroy,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  computed,
  effect,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { timeout } from 'rxjs';
import {
  ConnectionState,
  RETRO_SESSION_ENDED,
  RetroSessionEndedPayload,
} from '@shared/types';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';
import { ToastService } from '../../services/toast.service';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { RetroColumnComponent } from './retro-column.component';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroUserMenuComponent } from './retro-user-menu.component';

/** Maximum time to wait for the end-session response before failing (R9.13). */
export const END_SESSION_TIMEOUT_MS = 10_000;

/**
 * Visible lifetime of the "session ended" notification. R9.12 asks for at
 * least 5 seconds, and the default toast lifetime is exactly 5 seconds, so
 * this sits above it rather than on the boundary.
 */
export const END_SESSION_TOAST_MS = 6_000;

/** Notification shown to every participant when the moderator ends the session (R9.12). */
export const SESSION_ENDED_MESSAGE = 'The moderator ended the session';

/** Notification shown when the end-session request fails or times out (R9.13). */
export const END_SESSION_FAILED_MESSAGE = 'Failed to end the session';

@Component({
  selector: 'app-retro-board-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ConnectionStatusComponent,
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
          <!-- The indicator lives in the header, a sibling of every blocker
               wrapper, so it stays visible and interactive while interaction is
               paused (R11.2, R11.9). It replaces the inline glyph that read
               2.11:1 and 2.58:1 against the header gradient: the chip carries
               its own neutral surface, where the token pairs reach 5.07:1 and
               6.54:1 (R11.8). -->
          <app-connection-status [state]="displayedConnectionState()" />
          <button
            class="retro-board__copy-link-btn"
            type="button"
            title="Copy session link"
            aria-label="Copy session link"
            (click)="onCopyLink()"
          >🔗</button>
          @if (isModerator()) {
            <button
              #endBtn
              class="retro-board__end-btn"
              type="button"
              title="End session"
              aria-label="End session"
              [disabled]="endInFlight()"
              (click)="openEndDialog()"
            >⏹</button>
          }
          <app-retro-user-menu />
        </div>
      </header>

      <!-- Toolbar and sprint context are session controls, so they sit inside a
           blocker wrapper. Neither row scrolls the page, so wrapping them whole
           costs nothing (R11.9). -->
      <div
        class="retro-board__chrome interaction-blocker"
        [attr.inert]="blocked() ? '' : null"
        [attr.aria-disabled]="blocked()"
      >
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
            <div class="retro-board__context-display" aria-label="Sprint context">
              {{ context() || 'No context set' }}
            </div>
          }
        </div>
      </div>

      <div
        class="retro-board__columns"
        [class.retro-board__columns--vertical]="!isHorizontalLayout()"
        [class.retro-board__columns--horizontal]="isHorizontalLayout()"
        role="region"
        aria-label="Retrospective columns"
      >
        <!-- The wrapper sits INSIDE the scroll container, so the scrollable
             element is never the inert one and the board keeps scrolling while
             interaction is paused (R11.12). -->
        <div
          class="interaction-blocker"
          [attr.inert]="blocked() ? '' : null"
          [attr.aria-disabled]="blocked()"
        >
          @for (column of columns(); track column.id) {
            <app-retro-column [column]="column" />
          }
        </div>
      </div>

      <!-- The status message sits OUTSIDE every wrapper so assistive technology
           still announces it while the wrapped content is inert (R11.11, R11.13). -->
      @if (blocked()) {
        <p class="interaction-blocker__status" role="status" aria-live="polite">
          Interaction is paused until the connection is restored.
        </p>
      }

      <!-- End Session Confirmation Dialog (R9.3) -->
      @if (showEndDialog()) {
        <div class="retro-board__dialog-backdrop">
          <div
            class="retro-board__dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="End session confirmation"
          >
            <p class="retro-board__dialog-text">End this retrospective for all participants?</p>
            <div class="retro-board__dialog-actions">
              <button
                #cancelBtn
                class="retro-board__dialog-btn retro-board__dialog-btn--cancel"
                type="button"
                (click)="closeEndDialog()"
              >Cancel</button>
              <button
                class="retro-board__dialog-btn retro-board__dialog-btn--confirm"
                type="button"
                [disabled]="endInFlight()"
                (click)="confirmEndSession()"
              >End session</button>
            </div>
          </div>
        </div>
      }
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
      box-sizing: border-box;
      padding: 8px;
      background: var(--gradient-page-bg);
      font-size: 0.8rem;
      /* Horizontal overflow is confined to the column container (R7.12) */
      overflow-x: hidden;
    }

    /* Header */
    .retro-board__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--gradient-primary);
      border-radius: 8px;
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .retro-board__header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .retro-board__lobby-btn {
      border: none;
      background: var(--wash-on-primary-weak);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      padding: 4px;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .retro-board__lobby-btn:hover {
      background: var(--wash-on-primary-strong);
    }

    .retro-board__title {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--text-on-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .retro-board__copy-link-btn {
      border: none;
      background: var(--wash-on-primary-weak);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      padding: 4px;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .retro-board__copy-link-btn:hover {
      background: var(--wash-on-primary-strong);
    }

    /* End-session control: same 32px header control as its neighbours (R9.1) */
    .retro-board__end-btn {
      border: none;
      background: var(--wash-on-primary-weak);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      padding: 4px;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .retro-board__end-btn:hover:not(:disabled) {
      background: var(--wash-error-strong);
    }

    .retro-board__end-btn:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .retro-board__meta {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .retro-board__votes-remaining {
      font-size: 0.75rem;
      color: var(--text-on-primary);
      font-weight: 500;
    }

    .retro-board__session-id {
      /* 12px floor for visible text (R7.3) */
      font-size: 0.75rem;
      color: var(--text-on-primary);
      font-family: monospace;
    }

    /* Toolbar + context blocker wrapper: a flex column, which is how those two
       rows already stacked as direct children of the page, so the wrapper is
       invisible to the layout. The inert attribute keeps the content fully
       visible — no opacity, no display change (R11.12). */
    .retro-board__chrome {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    /* Paused-interaction message (R11.11). */
    .interaction-blocker__status {
      flex-shrink: 0;
      margin: 4px 0 0;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--surface-board);
      color: var(--text-primary);
      font-size: 0.75rem;
      font-weight: 500;
      text-align: center;
    }

    /* Context */
    .retro-board__context {
      flex-shrink: 0;
      margin-bottom: 8px;
    }

    .retro-board__context-input {
      width: 100%;
      /* 4px block padding keeps the context row at ~27px so the toolbar (40px)
         plus this row stays inside the 72px budget of R10.11 */
      padding: 4px 12px;
      border: 1px solid var(--color-primary-light);
      border-radius: 6px;
      font-size: 0.75rem;
      line-height: 1.4;
      color: var(--text-primary);
      background: var(--surface-board);
      outline: none;
      transition: border-color 0.15s ease;
      box-sizing: border-box;
    }

    .retro-board__context-input:focus {
      border-color: var(--color-primary);
      box-shadow: 0 0 0 2px var(--focus-ring-primary-weak);
    }

    .retro-board__context-display {
      /* Block with pre-wrap so the full context text renders unclipped (R7.17) */
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      box-sizing: border-box;
      /* 4px block padding: line box (12px x 1.4) + 8px padding + 2px border is
         ~27px, so toolbar + context stays inside the 72px budget (R10.11) */
      padding: 4px 12px;
      font-size: 0.75rem;
      line-height: 1.4;
      min-height: auto;
      color: var(--text-primary);
      background: var(--surface-board);
      border-radius: 6px;
      border: 1px solid var(--color-primary-light);
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
      gap: 8px;
      /* Fills the content area so no unused region sits past the last column (R7.15) */
      width: 100%;
      /* Columns fill the board height and each scrolls its own cards, so the
         column header stays pinned and every card is reachable (R7.16).
         overflow-y stays hidden because nothing overflows the container now. */
      align-items: stretch;
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* The blocker wrapper takes over the column row layout from its scroll
       container, so the container keeps scrolling while the wrapper is inert
       (R11.12). It sizes to its columns and never shrinks below the container
       width, which is what the container's own width: 100% did before (R7.15). */
    .retro-board__columns > .interaction-blocker {
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
      /* Stretches with the container so the chain reaches the column hosts */
      align-items: stretch;
      min-width: 100%;
      min-height: 0;
    }

    .retro-board__columns--vertical > .interaction-blocker {
      flex-direction: row;
    }

    .retro-board__columns--horizontal > .interaction-blocker {
      flex-direction: column;
      width: 100%;
    }

    /* Horizontal layout: columns stacked top-to-bottom */
    .retro-board__columns--horizontal {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      align-items: flex-start;
      overflow-y: auto;
      overflow-x: hidden;
    }

    /* Scrollbar styling */
    .retro-board__columns::-webkit-scrollbar {
      height: 8px;
      width: 8px;
    }

    .retro-board__columns::-webkit-scrollbar-track {
      background: var(--color-primary-light);
      border-radius: 4px;
    }

    .retro-board__columns::-webkit-scrollbar-thumb {
      background: var(--text-secondary);
      border-radius: 4px;
    }

    .retro-board__columns::-webkit-scrollbar-thumb:hover {
      background: var(--text-primary);
    }

    /* End-session confirmation dialog (R9.3) */
    .retro-board__dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--scrim-dialog);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .retro-board__dialog {
      background: var(--surface-card-deck);
      border-radius: 8px;
      padding: 20px;
      min-width: 280px;
      max-width: 400px;
      box-shadow: var(--shadow-lg);
    }

    .retro-board__dialog-text {
      margin: 0 0 16px;
      font-size: 0.875rem;
      line-height: 1.4;
      color: var(--text-primary);
    }

    .retro-board__dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .retro-board__dialog-btn {
      padding: 4px 16px;
      border-radius: 6px;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      min-width: 64px;
      min-height: 32px;
    }

    .retro-board__dialog-btn--cancel {
      border: 1px solid var(--color-primary-light);
      background: var(--surface-card-deck);
      color: var(--text-secondary);
    }

    .retro-board__dialog-btn--cancel:hover {
      background: var(--surface-board);
    }

    .retro-board__dialog-btn--confirm {
      border: none;
      background: var(--error-ink-hover);
      color: var(--text-on-primary);
    }

    .retro-board__dialog-btn--confirm:hover:not(:disabled) {
      background: var(--error-ink-active);
    }

    .retro-board__dialog-btn--confirm:disabled {
      cursor: default;
      opacity: 0.6;
    }

    /* Keyboard focus indicator (R7.14) */
    *:focus-visible {
      outline: 2px solid var(--color-primary-dark);
      outline-offset: 2px;
    }

    /* The header sits on the primary gradient, where a light outline carries
       the 3:1 indicator contrast the dark one cannot (R7.14) */
    .retro-board__header *:focus-visible {
      outline-color: var(--text-on-primary);
    }

    /* Header, toolbar and context rows wrap below 768px (R7.13) */
    @media (max-width: 767px) {
      .retro-board__header {
        flex-wrap: wrap;
        row-gap: 4px;
      }
    }

    /* Every descendant settles into its final state immediately (R7.11) */
    @media (prefers-reduced-motion: reduce) {
      :host,
      :host ::ng-deep *,
      :host ::ng-deep *::before,
      :host ::ng-deep *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    }
  `],
})
export class RetroBoardPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly authService = inject(AuthService);
  private readonly basePath = inject(BasePathService);
  private readonly toastService = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  private contextDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly endButton = viewChild<ElementRef<HTMLButtonElement>>('endBtn');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelBtn');

  /** Session ID from route params */
  readonly sessionId = signal<string>('');

  /** True while the end-session confirmation dialog is open (R9.3). */
  readonly showEndDialog = signal(false);

  /** True while a DELETE is awaiting a response, which disables both controls (R9.6). */
  readonly endInFlight = signal(false);

  /** Reactive state from RetroStateService */
  readonly columns = this.retroState.columns;
  readonly votesRemaining = this.retroState.votesRemaining;
  readonly isModerator = this.retroState.isModerator;
  readonly isCompleted = this.retroState.isCompleted;
  readonly context = this.retroState.context;

  /** Connection state from WebSocket service */
  readonly connectionState = this.ws.connectionState;

  /**
   * Flipped in `ngOnInit`, at the moment the page opens the socket.
   *
   * Requirements: R11.2
   */
  readonly connectAttempted = signal<boolean>(false);

  /**
   * The state the indicator shows. Before the first connection attempt the
   * service still reports its untouched initial `'disconnected'` value, so the
   * page reports `reconnecting` for that window instead — the indicator reads
   * `reconnecting` from the very first render.
   *
   * Requirements: R11.2
   */
  readonly displayedConnectionState = computed<ConnectionState>(() =>
    this.connectAttempted() ? this.connectionState() : 'reconnecting'
  );

  /**
   * True while board interaction is paused, which is exactly while the
   * displayed state is not `connected`. Being a computed signal, the blocker
   * flips in the same change-detection cycle as the state.
   *
   * Requirements: R11.9, R11.10, R11.13
   */
  readonly blocked = computed<boolean>(() => this.displayedConnectionState() !== 'connected');

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

  constructor() {
    // The cancel action takes initial keyboard focus (R9.3). The view child
    // resolves only once the dialog block has rendered, so this runs on the
    // pass after the signal flips, and again every time the dialog reopens.
    effect(() => {
      if (!this.showEndDialog()) {
        return;
      }
      this.cancelButton()?.nativeElement.focus();
    });
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('sessionId') ?? '';
    this.sessionId.set(id);

    this.ws
      .on<RetroSessionEndedPayload>(RETRO_SESSION_ENDED)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.onSessionEnded());

    if (!id) return;

    const token = this.authService.getToken();
    if (!token) {
      // No auth token — redirect to retro login page
      this.router.navigate(['/retro', id, 'login']);
      return;
    }

    // The socket is being opened, so the indicator switches from the
    // pre-connect `reconnecting` reading to the service's own state (R11.2).
    this.connectAttempted.set(true);
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
   * Open the end-session confirmation. Nothing is sent and no session state
   * changes until the confirm action is taken (R9.3).
   */
  openEndDialog(): void {
    this.showEndDialog.set(true);
  }

  /**
   * Dismiss the confirmation and hand keyboard focus back to the control that
   * opened it, leaving the session untouched (R9.4).
   */
  closeEndDialog(): void {
    this.showEndDialog.set(false);
    this.endButton()?.nativeElement.focus();
  }

  /**
   * Send exactly one `DELETE /api/retro/sessions/:sessionId` with the stored
   * token (R9.5). Repeat activation while the request is pending is refused by
   * the in-flight guard as well as by the disabled attribute (R9.6).
   *
   * On an error response or past the 10-second timeout the dialog closes, the
   * control re-enables and a single error notification appears, with the board
   * left exactly as it was (R9.13). On success the board stays put: the
   * `retro:session:ended` broadcast drives the notification and the navigation
   * for every participant, the moderator included (R9.12).
   */
  confirmEndSession(): void {
    if (this.endInFlight()) {
      return;
    }

    const id = this.sessionId();
    const token = this.authService.getToken();
    if (!id || !token) {
      this.failEndSession();
      return;
    }

    this.endInFlight.set(true);
    this.http
      .delete<{ success: boolean }>(this.basePath.getApiUrl(`/api/retro/sessions/${id}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      .pipe(timeout(END_SESSION_TIMEOUT_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // Dismiss the dialog but keep the control disabled: the session is
          // gone, so a second DELETE has nothing left to remove.
          this.showEndDialog.set(false);
        },
        error: () => this.failEndSession(),
      });
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

  /**
   * The moderator ended the session: announce it once for at least 5 seconds
   * and leave for the lobby without asking anything of the user (R9.12).
   */
  private onSessionEnded(): void {
    this.toastService.show('info', SESSION_ENDED_MESSAGE, { durationMs: END_SESSION_TOAST_MS });
    this.router.navigate(['/lobby']);
  }

  /** Error and timeout path of the end-session request (R9.13). */
  private failEndSession(): void {
    this.showEndDialog.set(false);
    this.endInFlight.set(false);
    this.toastService.show('error', END_SESSION_FAILED_MESSAGE);
  }
}
