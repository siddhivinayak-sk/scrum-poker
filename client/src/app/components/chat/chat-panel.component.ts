import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Signal,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BoardOverlayLayoutService } from '../../services/board-overlay-layout.service';
import { CHAT_TIMERS, ChatPanelState, ChatStore } from '../../services/chat-store.service';
import { CHAT_NARROW_QUERY, chatPanelId, rateLimitSeconds } from './chat-format';
import { ChatComposerComponent, chatRateLimitText } from './chat-composer.component';
import { ChatMessageListComponent } from './chat-message-list.component';
import { ChatPanelHeaderComponent } from './chat-panel-header.component';
import { ChatPresenceListComponent } from './chat-presence-list.component';

/** Offline status text of R9.1, shown above the Composer while not `connected`. */
export const CHAT_OFFLINE_TEXT = 'Chat is offline until the connection is restored.';

/** Defined in `chat-format.ts` (outside the Deferred chat chunk) so the launcher can use them. */
export { CHAT_NARROW_QUERY, chatPanelId };

/**
 * Elements outside the panel that may take focus while the narrow focus trap is active: page
 * dialogs, menus and the countdown overlay (R12.10).
 */
const TRAP_EXCEPTIONS = '[role="dialog"], [role="alertdialog"], [role="menu"], app-countdown-overlay';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Content of the `role="status"` region; `key` re-creates the text node on each change. */
interface StatusContent {
  readonly key: string;
  readonly text: string;
  /** Only the offline text is visible (above the Composer); the others are for screen readers. */
  readonly visible: boolean;
}

/**
 * Chat_Panel shell (design "ChatPanelComponent and children"). Lives in the Deferred chat chunk
 * and is created by `ChatHostComponent` only while `panelState !== 'closed'` (R3.3). All state is
 * read from `ChatStore`, so the panel can be destroyed and recreated without losing anything
 * (R3.13); the children restore the Draft, caret and scroll position themselves (R3.8).
 *
 * - `role="dialog"` named "Session chat", `aria-modal` true only on a Narrow_Viewport while
 *   `open` (R11.3–R11.5), z-index 920 (R12.2).
 * - Layouts: wide open, narrow open (full viewport, following `visualViewport` when present) and
 *   minimized (header only). The breakpoint is a `matchMedia` signal, so the panel stays mounted
 *   across the switch (R4.1–R4.3, R4.5, R4.6, R4.9, R4.11).
 * - One `role="status"` region while `open` holding the offline text, the rate-limit text or the
 *   last announcement (R9.1, R11.18).
 * - Focus to the Composer on entering `open`, to Restore on `open → minimized` (R3.12, R11.6,
 *   R11.16); narrow focus containment with the page dialog / menu / countdown exception (R11.5,
 *   R12.10); Escape closes outside an IME composition (R3.7).
 *
 * Left to `ChatHostComponent`: focus return to the launcher on close (R11.7), the narrow scroll
 * lock (R4.10) and publishing the minimized header top to `BoardOverlayLayoutService`.
 */
@Component({
  selector: 'app-chat-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChatPanelHeaderComponent,
    ChatPresenceListComponent,
    ChatMessageListComponent,
    ChatComposerComponent,
  ],
  template: `
    <section
      #shell
      class="chat-panel"
      role="dialog"
      aria-label="Session chat"
      [id]="panelId"
      [attr.aria-modal]="modal() ? 'true' : 'false'"
      [class.chat-panel--narrow]="narrow()"
      [class.chat-panel--open]="open()"
      [class.chat-panel--minimized]="!open()"
      [style.--chat-header-clearance]="headerClearance()"
      (keydown)="onKeydown($event)"
    >
      <app-chat-panel-header />
      <div class="chat-panel__body" [hidden]="!open()">
        <app-chat-presence-list />
        <app-chat-message-list (focusComposer)="focusComposer()" />
        <p role="status" class="chat-status" [class.chat-status--visible]="status()?.visible">
          @for (item of statusItems(); track item.key) {
            <span [class.chat-status__sr]="!item.visible">{{ item.text }}</span>
          }
        </p>
        <app-chat-composer />
      </div>
    </section>
  `,
  styles: `
    :host { display: contents; }
    .chat-panel {
      position: fixed; z-index: 920; right: 16px; bottom: 80px;
      display: flex; flex-direction: column; box-sizing: border-box;
      width: 360px; max-width: calc(100vw - 32px);
      max-height: min(520px, 70vh, calc(100vh - 80px - var(--chat-header-clearance, 8px)));
      border-radius: 12px; overflow: hidden;
      background: var(--surface-board); color: var(--text-primary); box-shadow: var(--shadow-lg);
      animation: chat-panel-open 150ms ease-out;
    }
    .chat-panel--minimized { max-height: none; animation-name: chat-panel-minimize; }
    .chat-panel--narrow.chat-panel--minimized { bottom: 72px; width: calc(100vw - 32px); }
    .chat-panel--narrow.chat-panel--open {
      inset: 0; width: 100vw; max-width: 100%; height: 100vh; height: 100dvh; max-height: none;
      border-radius: 0;
    }
    .chat-panel__body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    .chat-panel__body[hidden] { display: none; }
    .chat-panel__body > app-chat-presence-list { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
    .chat-status { flex: none; margin: 0; }
    .chat-status--visible { padding: 8px 12px 0; font-size: 0.875rem; line-height: 1.4; }
    .chat-status__sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    @keyframes chat-panel-open {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes chat-panel-minimize {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .chat-panel { animation: none; }
    }
  `,
})
export class ChatPanelComponent {
  protected readonly store = inject(ChatStore);
  private readonly layout = inject(BoardOverlayLayoutService);
  private readonly timers = inject(CHAT_TIMERS);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly panelId = chatPanelId(this.store.boardKind);

  /** Optional so the document listeners stay safe before the first render. */
  private readonly shell = viewChild<ElementRef<HTMLElement>>('shell');
  private readonly header = viewChild.required(ChatPanelHeaderComponent);
  private readonly composer = viewChild.required(ChatComposerComponent);

  /** True below 768 px; from `matchMedia`, or from the viewport width when it is missing. */
  protected readonly narrow: Signal<boolean> = this.narrowSignal();
  protected readonly open = computed(() => this.store.panelState() === 'open');
  /** Modal only on a Narrow_Viewport while `open` (R11.4, R11.5). */
  protected readonly modal = computed(() => this.narrow() && this.open());
  /** Minimum gap between the panel top and the viewport top: header bottom + 8 px (R4.2). */
  protected readonly headerClearance = computed(() => `${this.layout.headerBottomPx() + 8}px`);

  /** False for the first render, so the status region exists before any text (R11.18). */
  private readonly ready = signal(false);
  /** Rate-limit text at the moment the limit was set; cleared when it elapses (R8.9). */
  private readonly rateLimitStatus = signal('');
  private rateLimitTimer: number | null = null;
  /** Announcements made before this panel instance existed are not repeated. */
  private readonly firstAnnouncementId = untracked(this.store.announcement)?.id ?? 0;

  protected readonly status = computed<StatusContent | null>(() => {
    if (!this.ready()) return null;
    if (this.store.connectionState() !== 'connected') {
      return { key: 'offline', text: CHAT_OFFLINE_TEXT, visible: true };
    }
    const rateLimit = this.rateLimitStatus();
    if (rateLimit) return { key: 'rate-limit', text: rateLimit, visible: false };
    const announcement = this.store.announcement();
    if (announcement !== null && announcement.id > this.firstAnnouncementId) {
      return { key: `announce-${announcement.id}`, text: announcement.text, visible: false };
    }
    return null;
  });
  protected readonly statusItems = computed(() => {
    const status = this.status();
    return status === null ? [] : [status];
  });

  /** Last element inside the panel that had focus; the trap returns focus there. */
  private lastFocused: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => this.ready.set(true));

    // Rate-limit text for the status region, announced once per limit (R8.9, R11.18).
    effect(() => {
      const until = this.store.rateLimitUntil();
      untracked(() => this.updateRateLimitStatus(until));
    });

    // Focus on Panel_State changes, after the new state is rendered (R3.12, R11.6, R11.16).
    let previous: ChatPanelState | null = null;
    afterRenderEffect(() => {
      const state = this.store.panelState();
      untracked(() => {
        const from = previous;
        previous = state;
        if (state === from) return;
        if (state === 'open') {
          this.store.everOpened.set(true);
          this.composer().focusTextArea();
        } else if (state === 'minimized' && from === 'open') {
          this.header().focusRestore();
        }
      });
    });

    // Narrow open: follow the visual viewport so the Composer stays above the keyboard (R4.5).
    // Without `visualViewport` only the 100dvh layout applies (R4.11).
    afterRenderEffect((onCleanup) => {
      const active = this.modal();
      const el = this.shell()?.nativeElement;
      untracked(() => {
        const viewport = this.document.defaultView?.visualViewport ?? null;
        if (!active || el === undefined || viewport === null) return;
        const apply = (): void => {
          el.style.top = `${viewport.offsetTop}px`;
          el.style.height = `${viewport.height}px`;
        };
        apply();
        viewport.addEventListener('resize', apply);
        viewport.addEventListener('scroll', apply);
        onCleanup(() => {
          viewport.removeEventListener('resize', apply);
          viewport.removeEventListener('scroll', apply);
          el.style.top = '';
          el.style.height = '';
        });
      });
    });

    const onFocusIn = (event: FocusEvent): void => this.onDocumentFocusIn(event);
    const onKeydown = (event: KeyboardEvent): void => this.onDocumentKeydown(event);
    this.document.addEventListener('focusin', onFocusIn);
    this.document.addEventListener('keydown', onKeydown);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('focusin', onFocusIn);
      this.document.removeEventListener('keydown', onKeydown);
      this.clearRateLimitTimer();
    });
  }

  /** New_Messages_Indicator activation moves focus to the Composer (R6.4). */
  protected focusComposer(): void {
    this.composer().focusTextArea();
  }

  /** Escape while focus is inside the panel closes it, outside an IME composition (R3.7). */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (event.isComposing || event.keyCode === 229) return;
    if (this.store.panelState() === 'closed') return;
    event.preventDefault();
    this.store.panelState.set('closed');
  }

  /**
   * Narrow `open`: Tab on the last focusable element goes to the first and Shift+Tab on the first
   * goes to the last; Tab from outside the panel (for example from `body`) enters it. Focus in a
   * page dialog, a menu or the countdown overlay is left alone (R11.5, R12.10).
   */
  private onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !untracked(this.modal)) return;
    const shell = untracked(this.shell)?.nativeElement;
    if (shell === undefined) return;
    const active = this.document.activeElement;
    const inside = active !== null && shell.contains(active);
    if (!inside && active !== null && this.isTrapException(active, shell)) return;
    const focusables = this.focusables(shell);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Narrow `open`: focus that lands outside the panel returns to it, unless it lands in a page
   * dialog, a menu or the countdown overlay (R11.5, R12.10).
   */
  private onDocumentFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const shell = untracked(this.shell)?.nativeElement;
    if (shell === undefined) return;
    if (shell.contains(target)) {
      this.lastFocused = target;
      return;
    }
    if (!untracked(this.modal) || this.isTrapException(target, shell)) return;
    const back = this.lastFocused;
    if (back !== null && shell.contains(back) && this.focusables(shell).includes(back)) {
      back.focus();
    } else {
      this.composer().focusTextArea();
    }
  }

  /** True when `el` is inside a page dialog, a menu or the countdown overlay outside the panel. */
  private isTrapException(el: Element, shell: HTMLElement): boolean {
    const match = el.closest(TRAP_EXCEPTIONS);
    return match !== null && !shell.contains(match);
  }

  /** Focusable elements inside the panel in DOM order, skipping hidden subtrees. */
  private focusables(shell: HTMLElement): HTMLElement[] {
    return Array.from(shell.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.tabIndex >= 0 && el.closest('[hidden], [inert]') === null,
    );
  }

  private updateRateLimitStatus(until: number | null): void {
    this.clearRateLimitTimer();
    const now = this.timers.now();
    const seconds = until === null ? 0 : rateLimitSeconds(until, now);
    if (until === null || seconds <= 0) {
      this.rateLimitStatus.set('');
      return;
    }
    this.rateLimitStatus.set(chatRateLimitText(seconds));
    this.rateLimitTimer = this.timers.setTimeout(() => {
      this.rateLimitTimer = null;
      this.rateLimitStatus.set('');
    }, until - now);
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitTimer === null) return;
    this.timers.clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = null;
  }

  private narrowSignal(): Signal<boolean> {
    const view = this.document.defaultView;
    if (view === null || typeof view.matchMedia !== 'function') {
      return computed(() => this.layout.viewport().width < 768);
    }
    const query = view.matchMedia(CHAT_NARROW_QUERY);
    const matches = signal(query.matches);
    const onChange = (event: MediaQueryListEvent): void => matches.set(event.matches);
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => query.removeEventListener('change', onChange));
    return matches.asReadonly();
  }
}
