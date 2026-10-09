import { Injectable, signal, Signal, OnDestroy } from '@angular/core';

export type ToastType = 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
  /** Optional grouping label, used by {@link ToastService.dismissByTag}. */
  tag?: string;
}

/**
 * Optional display options for {@link ToastService.show}.
 * Both fields are optional, so existing two-argument calls behave exactly as before.
 */
export interface ToastOptions {
  /** Auto-dismiss delay in milliseconds. Defaults to 5000. */
  durationMs?: number;
  /** Grouping label so related toasts can be dismissed together. */
  tag?: string;
}

const MAX_VISIBLE_TOASTS = 3;
const AUTO_DISMISS_MS = 5000;

@Injectable({ providedIn: 'root' })
export class ToastService implements OnDestroy {
  private readonly _toasts = signal<ToastMessage[]>([]);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly toasts: Signal<ToastMessage[]> = this._toasts.asReadonly();

  ngOnDestroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Show a new toast notification.
   * Auto-dismisses after 5 seconds unless `options.durationMs` overrides it.
   * Enforces a maximum of 3 visible toasts.
   */
  show(type: ToastType, message: string, options?: ToastOptions): void {
    const toast: ToastMessage = {
      id: crypto.randomUUID(),
      type,
      message,
      createdAt: Date.now(),
      ...(options?.tag !== undefined ? { tag: options.tag } : {}),
    };

    const durationMs =
      options?.durationMs !== undefined && Number.isFinite(options.durationMs) && options.durationMs > 0
        ? options.durationMs
        : AUTO_DISMISS_MS;

    this._toasts.update((current) => {
      const updated = [...current, toast];
      // Enforce max visible toasts — remove oldest when exceeding limit
      if (updated.length > MAX_VISIBLE_TOASTS) {
        const removed = updated.shift()!;
        this.clearTimer(removed.id);
      }
      return updated;
    });

    // Schedule auto-dismiss
    const timer = setTimeout(() => {
      this.dismiss(toast.id);
    }, durationMs);
    this.timers.set(toast.id, timer);
  }

  /**
   * Manually dismiss a toast by its ID.
   */
  dismiss(id: string): void {
    this.clearTimer(id);
    this._toasts.update((current) => current.filter((t) => t.id !== id));
  }

  /**
   * Dismiss every visible toast carrying the given tag.
   * A tag with no matching toast is a no-op.
   */
  dismissByTag(tag: string): void {
    const matching = this._toasts().filter((t) => t.tag === tag);
    if (matching.length === 0) {
      return;
    }
    for (const toast of matching) {
      this.clearTimer(toast.id);
    }
    this._toasts.update((current) => current.filter((t) => t.tag !== tag));
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}
