import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { ChatStore } from '../../services/chat-store.service';
import { CHAT_TRANSPORT } from '../../services/chat-transport';
import { badgeText, onlineLabel, unreadDescription } from './chat-format';
import { presenceListId } from './chat-presence-list.component';

/**
 * Panel_Header of the Chat_Panel (Deferred chat chunk).
 *
 * Reads and writes the page-scoped `ChatStore` directly, so it keeps no state of its own and can
 * be destroyed and recreated with the panel (R3.13).
 *
 * - `open`: title "Chat", "N online" (R10.1), the Presence_List toggle "Show participants" with
 *   `aria-expanded` (R10.2, R11.3), "Minimize chat" (R3.4) and "Close chat" (R3.6).
 * - `minimized`: one "Restore chat" button covering the title, the online count and the
 *   Unread_Count (R2.9, R3.5), described by a visually hidden "N unread messages" element while
 *   unread > 0 (R11.3), with the static `aria-hidden` Unread_Dot (R24.8); the close control stays
 *   outside it. Nothing here is a live region (R24.9).
 *
 * Every control is at least 44 × 44 px with the two-tone chat focus ring (R11.11, C11). Moving
 * focus to Restore on `open → minimized` is the panel's job (R3.12); it calls `focusRestore()`.
 */
@Component({
  selector: 'app-chat-panel-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chat-header" [class.chat-header--minimized]="minimized()">
      @if (minimized()) {
        <button
          #restoreButton
          type="button"
          class="chat-header__restore chat-header__control"
          aria-label="Restore chat"
          [attr.aria-describedby]="unread() > 0 ? descriptionId : null"
          (click)="restore()"
        >
          <span class="chat-header__title">Chat</span>
          <span class="chat-header__online">{{ online() }}</span>
          @if (unread() > 0) {
            <span class="chat-header__unread">
              <span class="chat-header__count">{{ badge() }}</span>
              <span class="chat-header__dot" aria-hidden="true"></span>
            </span>
          }
        </button>
        @if (unread() > 0) {
          <span class="chat-header__sr-only" [id]="descriptionId">{{ description() }}</span>
        }
      } @else {
        <h2 class="chat-header__title chat-header__heading">Chat</h2>
        <span class="chat-header__online">{{ online() }}</span>
        <span class="chat-header__spacer"></span>
        <button
          type="button"
          class="chat-header__control chat-header__icon"
          aria-label="Show participants"
          [attr.aria-controls]="presenceId"
          [attr.aria-expanded]="store.presenceOpen()"
          (click)="togglePresence()"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
            <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 13.4c2 .9 3.5 2.9 3.5 5.6" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-header__control chat-header__icon"
          aria-label="Minimize chat"
          (click)="minimize()"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M5 12h14" />
          </svg>
        </button>
      }
      <button
        type="button"
        class="chat-header__control chat-header__icon"
        aria-label="Close chat"
        (click)="close()"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: none;
      }

      .chat-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        padding: 8px;
        color: var(--text-primary);
      }

      .chat-header__title {
        margin: 0;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1.3;
      }

      .chat-header__heading {
        padding-left: 4px;
      }

      .chat-header__online {
        font-size: 0.875rem;
        line-height: 1.3;
        color: var(--text-secondary);
      }

      .chat-header__spacer {
        flex: 1 1 0;
      }

      .chat-header__control {
        position: relative;
        box-sizing: border-box;
        min-width: 44px;
        min-height: 44px;
        margin: 0;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        cursor: pointer;
      }

      .chat-header__control:hover {
        background: var(--wash-neutral-weak);
      }

      .chat-header__control:active {
        background: var(--wash-neutral-strong);
      }

      .chat-header__control:focus-visible {
        z-index: 1;
        outline: none;
        box-shadow:
          0 0 0 3px var(--text-on-primary),
          0 0 0 6px var(--text-primary);
      }

      .chat-header__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0;
      }

      .chat-header__icon svg {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .chat-header__restore {
        display: flex;
        flex: 1 1 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        min-width: 0;
        padding: 4px 8px;
        text-align: left;
      }

      .chat-header__unread {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }

      .chat-header__count {
        font-size: 0.875rem;
        font-weight: 700;
        line-height: 1.3;
      }

      .chat-header__dot {
        flex: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        /* --color-primary-dark: at least 3.93:1 against the translucent --surface-board over
           every --gradient-page-bg stop; --color-primary reaches only 2.99:1 there (R24.8). */
        background: var(--color-primary-dark);
      }

      .chat-header__sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        border: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
      }
    `,
  ],
})
export class ChatPanelHeaderComponent {
  protected readonly store = inject(ChatStore);
  private readonly transport = inject(CHAT_TRANSPORT);

  /** Id of the visually hidden Unread_Count description, unique per board kind. */
  protected readonly descriptionId = `chat-unread-description-${this.store.boardKind}`;

  /** Id of the Presence_List this toggle controls. */
  protected readonly presenceId = presenceListId(this.store.boardKind);

  private readonly restoreButton = viewChild<ElementRef<HTMLButtonElement>>('restoreButton');

  protected readonly minimized = computed(() => this.store.panelState() === 'minimized');
  protected readonly unread = this.store.unreadCount;
  protected readonly badge = computed(() => badgeText(this.unread()));
  protected readonly description = computed(() => unreadDescription(this.unread()));
  protected readonly online = computed(() => onlineLabel(this.transport.participants()));

  /** Focuses the Restore control if it is rendered (R3.12, R11.16). */
  focusRestore(): void {
    this.restoreButton()?.nativeElement.focus();
  }

  /** R10.2: flips Presence_List visibility; the value survives Panel_State changes (R10.7). */
  protected togglePresence(): void {
    this.store.presenceOpen.update((open) => !open);
  }

  /** R3.4: `open` → `minimized`, whatever the Connection_State. */
  protected minimize(): void {
    if (this.store.panelState() === 'open') this.store.panelState.set('minimized');
  }

  /** R3.5: `minimized` → `open`, whatever the Connection_State. */
  protected restore(): void {
    if (this.store.panelState() === 'minimized') this.store.panelState.set('open');
  }

  /** R3.6: `open` or `minimized` → `closed`, whatever the Connection_State. */
  protected close(): void {
    this.store.panelState.set('closed');
  }
}
