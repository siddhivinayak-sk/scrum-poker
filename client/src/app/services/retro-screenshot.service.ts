import { Injectable, inject, signal } from '@angular/core';
import { ToastService } from './toast.service';
import { enterCaptureMode } from './retro-capture-mode';

/** Budget for producing the PNG image, measured from the activation (R4.8). */
export const CAPTURE_TIMEOUT_MS = 10_000;

/** File name used by the download fallback. */
export const SCREENSHOT_FILENAME = 'retrospective-board.png';

/** Message of the single notification each outcome emits. */
export const COPIED_MESSAGE = 'Screenshot copied to clipboard';
export const DOWNLOADED_MESSAGE = 'Screenshot downloaded';
export const FAILED_MESSAGE = 'Failed to capture screenshot';

/**
 * Rejects when `promise` has not settled within `timeoutMs`.
 *
 * Both outcomes of `promise` are observed, so a render that finishes after the
 * budget expired resolves into a discarded value rather than an unhandled
 * rejection.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Capture exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Service for capturing screenshots of the retrospective board.
 *
 * A capture runs in three phases. First the board enters capture mode, which
 * swaps every card text area for a styled static clone and unclips the scroll
 * containers so `html2canvas` sees the complete card text laid out by the
 * browser's own text engine (R4.1, R4.2, R4.11, R4.12, R4.13). Then the element
 * is rendered to a PNG under a 10-second budget (R4.8). Finally the image is
 * copied to the clipboard, or downloaded when the clipboard is unavailable or
 * refuses the write (R4.5, R4.6).
 *
 * Each of the three outcomes — copied, downloaded, failed — emits exactly one
 * notification, and the failure path writes nothing to the clipboard and
 * triggers no download (R4.4, R4.9). Capture mode is restored in `finally`, so
 * a success, a thrown render and a timed-out render all leave the board with
 * the element count, attribute values, computed styles and scroll offsets it
 * held before the capture started (R4.3). `capturing` stays `true` for the
 * whole run, which the toolbar binds as the screenshot button's disabled state
 * and which makes a second concurrent capture a no-op (R4.10).
 *
 * Requirements: R4.1, R4.3, R4.4, R4.5, R4.6, R4.7, R4.8, R4.9, R4.10
 */
@Injectable({ providedIn: 'root' })
export class RetroScreenshotService {
  private readonly toastService = inject(ToastService);

  private readonly capturingState = signal(false);

  /** True while a capture is in progress. */
  readonly capturing = this.capturingState.asReadonly();

  /**
   * Capture the entire board element as a PNG screenshot.
   *
   * @param element - The HTMLElement representing the board to capture
   */
  async captureBoard(element: HTMLElement): Promise<void> {
    // R4.10: the in-progress capture owns the board's DOM; a second one would
    // enter capture mode over a board already in it.
    if (this.capturingState()) {
      return;
    }
    this.capturingState.set(true);

    // One notification per capture whichever path runs (R4.4, R4.5, R4.9).
    let notified = false;
    const notify = (type: 'info' | 'error', message: string): void => {
      if (notified) {
        return;
      }
      notified = true;
      this.toastService.show(type, message);
    };

    const handle = enterCaptureMode(element);
    try {
      const blob = await withTimeout(this.render(element), CAPTURE_TIMEOUT_MS);

      if (await this.tryClipboardCopy(blob)) {
        notify('info', COPIED_MESSAGE);
        return;
      }

      this.downloadBlob(blob, SCREENSHOT_FILENAME);
      notify('info', DOWNLOADED_MESSAGE);
    } catch (error) {
      // Reached by a failed render, a render that overran the budget, and a
      // failed download — nothing has been written to the clipboard and no
      // download was triggered on any of them (R4.4, R4.8).
      //
      // The cause is logged because the renderer aborts an entire capture over a
      // single declaration it cannot parse, and the notification below is the same
      // text for every outcome. Without this, a parse failure is indistinguishable
      // from a timeout.
      console.error('Board screenshot capture failed', error);
      notify('error', FAILED_MESSAGE);
    } finally {
      handle.restore();
      this.capturingState.set(false);
    }
  }

  /**
   * Render the board element to a PNG blob.
   *
   * Runs while the board is in capture mode, so the off-screen content the
   * scroll containers normally clip is laid out and rasterised too.
   */
  private async render(element: HTMLElement): Promise<Blob> {
    // Dynamic import to keep html2canvas out of the main bundle
    const html2canvas = (await import('html2canvas')).default;

    const canvas = await html2canvas(element, {
      useCORS: true,
      allowTaint: true,
      scrollX: 0,
      scrollY: 0,
      windowWidth: element.scrollWidth,
      windowHeight: element.scrollHeight,
      width: element.scrollWidth,
      height: element.scrollHeight,
    });

    return this.canvasToBlob(canvas);
  }

  /**
   * Convert an HTMLCanvasElement to a PNG Blob.
   */
  private canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert canvas to blob'));
          }
        },
        'image/png'
      );
    });
  }

  /**
   * Attempt to copy a PNG blob to the clipboard using the Clipboard API.
   * Returns true if successful, false if the API is unavailable or the copy fails.
   */
  private async tryClipboardCopy(blob: Blob): Promise<boolean> {
    try {
      if (!navigator.clipboard?.write) {
        return false;
      }
      const clipboardItem = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([clipboardItem]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Trigger a file download for the given blob.
   */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }
}
