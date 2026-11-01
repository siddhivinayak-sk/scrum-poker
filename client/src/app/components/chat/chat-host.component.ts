import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostAttributeToken,
  Signal,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT, NgComponentOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BoardOverlayLayoutService } from '../../services/board-overlay-layout.service';
import { ChatStore } from '../../services/chat-store.service';
import {
  CHAT_TRANSPORT,
  ChatTransport,
  PokerChatTransport,
  RetroChatTransport,
} from '../../services/chat-transport';
import { PanelChunkLoader } from '../../services/panel-chunk-loader';
import { CHAT_NARROW_QUERY, chatPanelId } from './chat-format';
import { ChatLauncherComponent } from './chat-launcher.component';
import { ChatLoadErrorNoticeComponent } from './chat-load-error-notice.component';

/** Static attribute of `<app-chat-host>` that names the Board_Kind (R1.1, R1.2). */
export const CHAT_BOARD_KIND_ATTRIBUTE = 'boardKind';

/**
 * Factory of `CHAT_TRANSPORT` for one `ChatHostComponent`: reads the host's static `boardKind`
 * attribute and returns that board's adapter, so a page can only bind its own connection
 * (R1.1, R1.2). Any other value is a template error and throws.
 */
export function chatTransportFor(): ChatTransport {
  const kind = inject(new HostAttributeToken(CHAT_BOARD_KIND_ATTRIBUTE), { optional: true });
  switch (kind) {
    case 'poker':
      return inject(PokerChatTransport);
    case 'retro':
      return inject(RetroChatTransport);
    default:
      throw new Error(
        `<app-chat-host> needs boardKind="poker" or boardKind="retro", got ${JSON.stringify(kind)}.`,
      );
  }
}

/**
 * Top edge, from the viewport top, of a fixed chat box docked by `bottom` (the minimized
 * Panel_Header or the Chat_Load_Error_Notice). It is derived from the layout `bottom` and
 * `offsetHeight`, which ignore transforms, so the 150 ms entrance animation of the minimized
 * header does not shift the published value. Falls back to the bounding box when the computed
 * `bottom` is not a pixel length.
 */
function dockTopOf(el: HTMLElement, viewportHeight: number): number {
  const view = el.ownerDocument.defaultView;
  const bottom = view === null ? Number.NaN : parseFloat(view.getComputedStyle(el).bottom);
  return Number.isFinite(bottom)
    ? viewportHeight - bottom - el.offsetHeight
    : el.getBoundingClientRect().top;
}

/**
 * Chat host of one Board_Page (design "ChatHostComponent", D8, C3). Mounted by both board pages
 * as `<app-chat-host boardKind="poker|retro" [sessionId]="sessionId()" />`, outside every
 * Interaction_Blocker wrapper (R1.5). It lives in the board page chunks and imports nothing from
 * the Deferred chat chunk: the Chat_Panel class comes from `PanelChunkLoader.panelClass()` and is
 * rendered with `NgComponentOutlet` (R20.4, R20.16).
 *
 * - Provides the page-scoped `ChatStore` and the Board_Kind's `CHAT_TRANSPORT`, so each page
 *   instance starts empty and poker and retro never share a store (R1.8, R1.10, R15.11). Being
 *   part of the page, it is destroyed with the page or with the poker "Session Not Found" switch,
 *   together with any open panel and the store contents (R1.3, R1.9, R9.8).
 * - Resets the store whenever the `sessionId` input changes (R18.11).
 * - Asks the loader for the idle prefetch once and opens the panel when a user-started
 *   Load_Sequence succeeds (R20.4, R20.11, R20.17).
 * - Runs the launcher toggle rules (R1.6, R1.7, R20.11, C16).
 * - Keeps the duties that outlive the panel component: the narrow scroll lock (R4.10), focus
 *   return to the launcher on close and on "Dismiss" (R11.7, R20.14), and the dock top of the
 *   minimized header or the notice for the bottom-left arrangement (R12.12).
 *
 * Panel_State starts `closed` in the store and is never read from storage (R1.8).
 */
@Component({
  selector: 'app-chat-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatLauncherComponent, ChatLoadErrorNoticeComponent, NgComponentOutlet],
  providers: [ChatStore, { provide: CHAT_TRANSPORT, useFactory: chatTransportFor }],
  template: `
    <app-chat-launcher (activated)="toggleFromLauncher()" />
    @if (errorShown()) {
      <app-chat-load-error-notice (dismissed)="focusLauncher()" />
    }
    <ng-container *ngComponentOutlet="panel()" />
  `,
  styles: `
    :host { display: contents; }
  `,
})
export class ChatHostComponent {
  private readonly store = inject(ChatStore);
  private readonly loader = inject(PanelChunkLoader);
  private readonly layout = inject(BoardOverlayLayoutService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host: HTMLElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** The Board_Session the page is bound to; a change resets the store (R18.11, C3). */
  readonly sessionId = input.required<string>();

  private readonly launcher = viewChild.required(ChatLauncherComponent);
  private readonly notice = viewChild(ChatLoadErrorNoticeComponent);

  /** True below 768 px; from `matchMedia`, or from the viewport width when it is missing. */
  private readonly narrow: Signal<boolean> = this.narrowSignal();

  protected readonly errorShown = this.loader.errorShown;
  /** The Chat_Panel class while Panel_State is not `closed` and the class is loaded (R3.3). */
  protected readonly panel = computed(() =>
    this.store.panelState() === 'closed' ? null : this.loader.panelClass(),
  );
  /** The Board_Page behind the panel must not scroll: narrow and `open` (R4.10). */
  private readonly scrollLocked = computed(
    () => this.narrow() && this.store.panelState() === 'open',
  );

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      untracked(() => this.store.reset(sessionId));
    });

    this.loader.prefetchWhenIdle();
    this.loader.opened
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.panelState.set('open'));

    // Narrow scroll lock: record the page scroll position and the root `overflow` before the
    // panel covers the page, restore both when the panel leaves `open`, when the viewport becomes
    // wide and when the host is destroyed (R4.10).
    effect((onCleanup) => {
      if (!this.scrollLocked()) return;
      untracked(() => {
        const view = this.document.defaultView;
        const root = this.document.documentElement;
        const x = view?.scrollX ?? 0;
        const y = view?.scrollY ?? 0;
        const overflow = root.style.overflow;
        root.style.overflow = 'hidden';
        onCleanup(() => {
          root.style.overflow = overflow;
          if (view !== null && (view.scrollX !== x || view.scrollY !== y)) view.scrollTo(x, y);
        });
      });
    });

    // Focus returns to the launcher whenever the panel closes: close control, Escape or the
    // launcher itself (R11.7). Runs after render, when the launcher is shown again on narrow.
    let previous = untracked(this.store.panelState);
    afterRenderEffect(() => {
      const state = this.store.panelState();
      untracked(() => {
        const from = previous;
        previous = state;
        if (state === 'closed' && from !== 'closed') this.focusLauncher();
      });
    });

    // Dock top for the bottom-left arrangement: on a Narrow_Viewport, the top of the
    // Chat_Load_Error_Notice or of the minimized Panel_Header, whichever is shown; otherwise
    // null (R12.12). Re-measured on viewport resizes and on size changes of the docked box.
    afterRenderEffect((onCleanup) => {
      const narrow = this.narrow();
      const notice = this.notice();
      const minimized = this.store.panelState() === 'minimized' && this.panel() !== null;
      const viewportHeight = this.layout.viewport().height;
      untracked(() => {
        const el = !narrow
          ? null
          : notice !== undefined
            ? notice.element
            : minimized
              ? this.panelElement()
              : null;
        if (el === null) {
          this.layout.setChatDockTop(null);
          return;
        }
        const publish = (): void => this.layout.setChatDockTop(dockTopOf(el, viewportHeight));
        publish();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(publish);
        observer.observe(el);
        onCleanup(() => observer.disconnect());
      });
    });
    this.destroyRef.onDestroy(() => this.layout.setChatDockTop(null));
  }

  /**
   * Launcher activation (R1.6, R1.7, R20.11, R20.17, C16): nothing while a Load_Sequence runs;
   * a Load_Sequence while the panel class is not loaded (the loader opens the panel on success);
   * otherwise `closed` / `minimized` → `open`, and `open` → `closed` on a Wide_Viewport. On a
   * Narrow_Viewport the launcher is hidden while `open`, so that case does nothing.
   */
  toggleFromLauncher(): void {
    if (this.loader.busy()) return;
    if (this.loader.panelClass() === null) {
      this.loader.requestOpen();
      return;
    }
    if (this.store.panelState() !== 'open') {
      this.store.panelState.set('open');
    } else if (!this.narrow()) {
      this.store.panelState.set('closed');
    }
  }

  /** Moves keyboard focus to the Chat_Launcher (close, "Dismiss"; R11.7, R20.14). */
  protected focusLauncher(): void {
    this.launcher().focus();
  }

  /** The rendered Chat_Panel shell, found by its id inside this host. */
  private panelElement(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(`[id="${chatPanelId(this.store.boardKind)}"]`);
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
