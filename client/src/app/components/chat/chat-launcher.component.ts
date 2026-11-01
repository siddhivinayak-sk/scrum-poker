import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Signal,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BoardOverlayLayoutService } from '../../services/board-overlay-layout.service';
import { CHAT_TIMERS, ChatStore } from '../../services/chat-store.service';
import { PanelChunkLoader } from '../../services/panel-chunk-loader';
import {
  AttentionEvent,
  AttentionState,
  attentionOutput,
  createAttentionState,
  reduceAttention,
} from './chat-attention';
import { CHAT_NARROW_QUERY, badgeText, chatPanelId, launcherLabel } from './chat-format';

/** Media query of the operating system's reduced-motion preference (R24.7). */
export const CHAT_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Visible text of the launcher while a Load_Sequence runs (R20.11). */
export const CHAT_LAUNCHER_LOADING_TEXT = 'Loading chat…';

/** The inputs of `reduceAttention` as last reported to it. */
interface AttentionInputs {
  readonly panelState: AttentionState['panelState'];
  readonly visible: boolean;
  readonly reducedMotion: boolean;
  readonly unread: number;
  readonly increases: number;
}

/**
 * Chat_Launcher (design "ChatLauncherComponent"). Always loaded with the Board_Page, outside the
 * Deferred chat chunk (R20.16), so it imports nothing from `chat-panel.component.ts` or its
 * children. It reads the page-scoped `ChatStore` provided by `ChatHostComponent` and the root
 * `PanelChunkLoader`.
 *
 * - Native `<button type="button">`: `aria-controls` names the Chat_Panel, `aria-expanded` is true
 *   only while `open`, the accessible name is `launcherLabel(unread)`, and while a Load_Sequence
 *   runs it has `aria-busy="true"` and the visible text "Loading chat…" (R11.1, R11.2, R20.11).
 *   Every click or native Enter/Space activation emits `activated`; the host decides what it does
 *   (R1.6, R1.7, C16). On a Narrow_Viewport while `open` the button is hidden (R4.4).
 * - Unread_Badge (`aria-hidden`, the name already carries the count, R2.1–R2.3, R24.9), the static
 *   two-tone Unread_Ring while unread > 0 and not `open` (R2.13, R24.5) and a two-tone focus ring
 *   within 7 px (C11, R11.11).
 * - New_Message_Attention_Animation: a pulse span re-keyed by the run of `reduceAttention`, so each
 *   start or restart replays from the first iteration; removed on stop and never rendered under
 *   reduced motion. A timer at the run's end (3,600 ms) dispatches the `tick` (R24.1–R24.12).
 */
@Component({
  selector: 'app-chat-launcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      #button
      type="button"
      class="chat-launcher"
      [class.chat-launcher--ring]="unreadRing()"
      [attr.aria-controls]="panelId"
      [attr.aria-expanded]="open() ? 'true' : 'false'"
      [attr.aria-label]="label()"
      [attr.aria-busy]="busy() ? 'true' : null"
      [hidden]="hidden()"
      (click)="activated.emit()"
    >
      <svg
        class="chat-launcher__icon"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        width="24"
        height="24"
      >
        <path
          fill="currentColor"
          d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"
        />
      </svg>
      @for (run of pulseRuns(); track run) {
        <span class="chat-launcher__pulse" aria-hidden="true"></span>
      }
      @if (badge(); as text) {
        <span class="chat-launcher__badge" aria-hidden="true">{{ text }}</span>
      }
      @if (busy()) {
        <span class="chat-launcher__busy">{{ loadingText }}</span>
      }
    </button>
  `,
  styles: `
    :host { display: contents; }
    .chat-launcher {
      position: fixed; right: 16px; bottom: 16px; z-index: 910;
      display: inline-flex; align-items: center; justify-content: center;
      box-sizing: border-box; width: 56px; height: 56px; margin: 0; padding: 0;
      border: none; border-radius: 50%;
      background: var(--gradient-primary); color: var(--text-on-primary);
      cursor: pointer;
    }
    .chat-launcher[hidden] { display: none; }
    .chat-launcher__icon { display: block; flex: none; }
    .chat-launcher--ring {
      box-shadow: 0 0 0 2px var(--text-on-primary), 0 0 0 4px var(--text-primary);
    }
    .chat-launcher:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--text-on-primary), 0 0 0 6px var(--text-primary);
    }
    .chat-launcher__pulse {
      position: absolute; inset: 0; box-sizing: border-box;
      border: 2px solid var(--text-on-primary); border-radius: 50%;
      pointer-events: none;
      animation-name: chat-pulse;
      animation-duration: 1200ms;
      animation-timing-function: ease-out;
      animation-delay: 0ms;
      animation-iteration-count: 3;
      animation-fill-mode: both;
    }
    .chat-launcher__badge {
      position: absolute; top: -4px; right: -4px; z-index: 1;
      box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 6px;
      border-radius: 10px;
      background: var(--status-fault); color: var(--text-on-status);
      font-size: 0.75rem; font-weight: 700; line-height: 20px; text-align: center;
      pointer-events: none;
    }
    .chat-launcher__busy {
      position: absolute; top: 50%; right: calc(100% + 8px);
      transform: translateY(-50%);
      padding: 4px 8px; border-radius: 4px;
      background: var(--text-primary); color: var(--text-on-primary);
      font-size: 0.875rem; line-height: 1.4; white-space: nowrap;
    }
    @media (max-width: 767px) {
      .chat-launcher { width: 48px; height: 48px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .chat-launcher__pulse { display: none; animation: none; }
    }
  `,
})
export class ChatLauncherComponent {
  private readonly store = inject(ChatStore);
  private readonly loader = inject(PanelChunkLoader);
  private readonly timers = inject(CHAT_TIMERS);
  private readonly layout = inject(BoardOverlayLayoutService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** Click, tap or native Enter/Space activation; `ChatHostComponent` runs the toggle rules. */
  readonly activated = output<void>();

  protected readonly panelId = chatPanelId(this.store.boardKind);
  protected readonly loadingText = CHAT_LAUNCHER_LOADING_TEXT;

  private readonly button = viewChild<ElementRef<HTMLButtonElement>>('button');

  /** True below 768 px; from `matchMedia`, or from the viewport width when it is missing. */
  readonly narrow: Signal<boolean> =
    this.mediaSignal(CHAT_NARROW_QUERY) ?? computed(() => this.layout.viewport().width < 768);
  /** The operating system reports `prefers-reduced-motion: reduce`; false without `matchMedia`. */
  private readonly reducedMotion: Signal<boolean> =
    this.mediaSignal(CHAT_REDUCED_MOTION_QUERY) ?? signal(false).asReadonly();

  protected readonly open = computed(() => this.store.panelState() === 'open');
  protected readonly busy = this.loader.busy;
  protected readonly label = computed(() => launcherLabel(this.store.unreadCount()));
  protected readonly badge = computed(() => badgeText(this.store.unreadCount()));
  /** Hidden on a Narrow_Viewport while `open`, so it cannot be activated (R4.4). */
  protected readonly hidden = computed(() => this.narrow() && this.open());
  /** Static Unread_Ring: unread > 0 and Panel_State `closed` or `minimized` (R2.13, R24.5). */
  protected readonly unreadRing = computed(
    () => this.store.unreadCount() > 0 && this.store.panelState() !== 'open',
  );

  private readonly attentionState = signal<AttentionState>(
    createAttentionState({
      unread: untracked(this.store.unreadCount),
      panelState: untracked(this.store.panelState),
      visible: untracked(this.store.documentVisible),
      reducedMotion: untracked(this.reducedMotion),
    }),
  );
  private readonly attention = computed(() => attentionOutput(this.attentionState()));

  /** Key of the live attention run, or null when no run is live. */
  readonly attentionRun: Signal<number | null> = computed(() => this.attention().attentionRun);
  /** One key while a run is live and motion is allowed; a new key restarts the CSS animation. */
  protected readonly pulseRuns = computed<readonly number[]>(() => {
    const run = this.attentionRun();
    return run === null || this.reducedMotion() ? [] : [run];
  });

  constructor() {
    let seen: AttentionInputs = untracked(() => this.readInputs());

    // Feed the reducer with every change of its inputs, in a fixed order (R24.1–R24.12).
    effect(() => {
      const current = this.readInputs();
      untracked(() => {
        const previous = seen;
        seen = current;
        const now = this.timers.now();
        const events: AttentionEvent[] = [];
        if (current.panelState !== previous.panelState) {
          events.push({ kind: 'panelState', panelState: current.panelState });
        }
        if (current.visible !== previous.visible) {
          events.push({ kind: 'visibility', visible: current.visible, now });
        }
        if (current.reducedMotion !== previous.reducedMotion) {
          events.push({ kind: 'reducedMotion', reducedMotion: current.reducedMotion });
        }
        if (current.increases > previous.increases) {
          events.push({ kind: 'unreadIncrease', unread: current.unread, now });
        } else if (current.unread !== previous.unread) {
          events.push({ kind: 'unread', unread: current.unread });
        }
        this.apply(events);
      });
    });

    // End the live run when its 3,600 ms have elapsed (R24.1); a restart reschedules.
    effect((onCleanup) => {
      const endsAt = this.attention().endsAt;
      if (endsAt === null) return;
      untracked(() => {
        const handle = this.timers.setTimeout(
          () => this.apply([{ kind: 'tick', now: Math.max(this.timers.now(), endsAt) }]),
          Math.max(0, endsAt - this.timers.now()),
        );
        onCleanup(() => this.timers.clearTimeout(handle));
      });
    });
  }

  /** Moves keyboard focus to the launcher button (focus return on close and on "Dismiss"). */
  focus(): void {
    this.button()?.nativeElement.focus();
  }

  private readInputs(): AttentionInputs {
    return {
      panelState: this.store.panelState(),
      visible: this.store.documentVisible(),
      reducedMotion: this.reducedMotion(),
      unread: this.store.unreadCount(),
      increases: this.store.unreadIncreaseCount(),
    };
  }

  private apply(events: readonly AttentionEvent[]): void {
    if (events.length === 0) return;
    let state = this.attentionState();
    for (const event of events) state = reduceAttention(state, event).state;
    this.attentionState.set(state);
  }

  /** A signal following `matchMedia(query)`, or null where `matchMedia` is missing. */
  private mediaSignal(query: string): Signal<boolean> | null {
    const view = this.document.defaultView;
    if (view === null || typeof view.matchMedia !== 'function') return null;
    const list = view.matchMedia(query);
    const matches = signal(list.matches);
    const onChange = (event: MediaQueryListEvent): void => matches.set(event.matches);
    list.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => list.removeEventListener('change', onChange));
    return matches.asReadonly();
  }
}
