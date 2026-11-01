import { ChangeDetectionStrategy, Component, ElementRef, inject, output } from '@angular/core';
import { PanelChunkLoader } from '../../services/panel-chunk-loader';

/** Text of the Chat_Load_Error_Notice (R20.14). */
export const CHAT_LOAD_ERROR_TEXT = 'Chat could not be loaded.';

/**
 * Chat_Load_Error_Notice (design "ChatLoadErrorNoticeComponent", R20.14, R11.11, R12.12).
 *
 * Rendered by `ChatHostComponent` in the board page chunk while `PanelChunkLoader.errorShown()`
 * is true, so it must not import anything from the Deferred chat chunk (the panel and its
 * children). The host element itself is the fixed box, placed where the minimized Panel_Header
 * docks (R4.9): `right: 16px; bottom: 80px`, 360 px wide on a Wide_Viewport; `bottom: 72px` and
 * the viewport width minus 32 px on a Narrow_Viewport (`max-width: 767px`, the panel's
 * `CHAT_NARROW_QUERY`, repeated here as a literal to keep the panel out of this chunk).
 *
 * - "Try again" calls `requestOpen()`, which hides the notice and starts a new Load_Sequence.
 * - "Dismiss" calls `dismissError()` and emits `dismissed`; the host then focuses the launcher.
 *
 * Both buttons are at least 44 × 44 px with the two-tone chat focus ring (R11.11, C11). The host
 * reads `element` to publish the notice's top edge to `BoardOverlayLayoutService.setChatDockTop`
 * on a Narrow_Viewport (R12.12).
 */
@Component({
  selector: 'app-chat-load-error-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p role="alert" class="chat-load-error__text">{{ text }}</p>
    <div class="chat-load-error__actions">
      <button type="button" class="chat-load-error__button" (click)="tryAgain()">Try again</button>
      <button type="button" class="chat-load-error__button" (click)="dismiss()">Dismiss</button>
    </div>
  `,
  styles: `
    :host {
      position: fixed; z-index: 920; right: 16px; bottom: 80px;
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; box-sizing: border-box;
      width: 360px; max-width: calc(100vw - 32px); padding: 12px;
      border-radius: 12px; background: var(--surface-board); color: var(--text-primary);
      box-shadow: var(--shadow-lg);
    }
    .chat-load-error__text { flex: 1 1 auto; margin: 0; font-size: 0.875rem; line-height: 1.4; }
    .chat-load-error__actions { display: flex; flex: none; gap: 8px; margin-left: auto; }
    .chat-load-error__button {
      position: relative; box-sizing: border-box; min-width: 44px; min-height: 44px; margin: 0;
      padding: 0 12px; border: 1px solid var(--text-secondary); border-radius: 8px;
      background: transparent; color: var(--text-primary); font: inherit; cursor: pointer;
    }
    .chat-load-error__button:hover { background: var(--wash-neutral-weak); }
    .chat-load-error__button:active { background: var(--wash-neutral-strong); }
    .chat-load-error__button:focus-visible {
      z-index: 1; outline: none;
      box-shadow: 0 0 0 3px var(--text-on-primary), 0 0 0 6px var(--text-primary);
    }
    @media (max-width: 767px) {
      :host { bottom: 72px; width: calc(100vw - 32px); }
    }
  `,
})
export class ChatLoadErrorNoticeComponent {
  private readonly loader = inject(PanelChunkLoader);

  /** The notice's fixed box; the host reads its top edge for `setChatDockTop` (R12.12). */
  readonly element: HTMLElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** Emits after "Dismiss" hid the notice; the host moves focus to the Chat_Launcher (R20.14). */
  readonly dismissed = output<void>();

  protected readonly text = CHAT_LOAD_ERROR_TEXT;

  /** "Try again": hides the notice and starts a new Load_Sequence (R20.14). */
  protected tryAgain(): void {
    this.loader.requestOpen();
  }

  /** "Dismiss": hides the notice, starts nothing, and asks the host to focus the launcher. */
  protected dismiss(): void {
    this.loader.dismissError();
    this.dismissed.emit();
  }
}
