import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CONNECTION_LABEL, ConnectionState } from '@shared/types';

/**
 * Compact connection status indicator (R11.3-R11.8).
 *
 * Input-driven on purpose: the component imports neither WebSocket service, so
 * the poker and retro pages can each feed it their own derived state without the
 * two features sharing anything.
 *
 * The chip is painted on the neutral `--status-chip-bg` surface because both
 * session headers use `--gradient-primary`, against which a saturated green or
 * red cannot reach 3:1. The fill colours are therefore measured against that
 * adjacent chip surface, and the visible label text is measured against the
 * fill it sits on (R11.8).
 */
@Component({
  selector: 'app-connection-status',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span
      class="connection-status"
      [class.connection-status--healthy]="healthy()"
      [title]="label()"
      [attr.aria-label]="label()"
      role="status"
    >
      <span class="connection-status__dot" aria-hidden="true"></span>
      <span class="connection-status__label">{{ label() }}</span>
    </span>
  `,
  styles: [
    `
      /* 24 px tall (R11.3: at most 32 px) on the neutral chip surface, with the
         label inline so the rendered width stays well above 1.5 x the height. */
      .connection-status {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        box-sizing: border-box;
        height: 24px;
        min-width: 36px;
        padding: 4px;
        border-radius: 6px;
        background: var(--status-chip-bg);
        line-height: 16px;
        font-size: 0.75rem;
        font-weight: 600;
      }

      /* Fill colour comes from a design token and defaults to the fault red, so
         both the reconnecting and the disconnected state render red
         (R11.5, R11.6). */
      .connection-status__dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--status-fault);
      }

      .connection-status__label {
        display: inline-block;
        padding: 0 6px;
        border-radius: 4px;
        background: var(--status-fault);
        color: var(--text-on-status);
        white-space: nowrap;
      }

      /* Healthy green only while the state is connected (R11.4). */
      .connection-status--healthy .connection-status__dot,
      .connection-status--healthy .connection-status__label {
        background: var(--status-connected);
      }
    `,
  ],
})
export class ConnectionStatusComponent {
  /** The connection state to display; the component derives everything from it. */
  readonly state = input.required<ConnectionState>();

  /**
   * The indicator text, used verbatim as the `title`, the accessible name and
   * the visible label so the state is conveyed by text as well as colour
   * (R11.4-R11.7).
   */
  readonly label = computed<string>(() => CONNECTION_LABEL[this.state()]);

  /** True exactly when the state is `connected`, which selects the green fill. */
  readonly healthy = computed<boolean>(() => this.state() === 'connected');
}
