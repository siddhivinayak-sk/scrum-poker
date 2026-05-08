import { Injectable, inject } from '@angular/core';
import { ToastService } from './toast.service';

/**
 * Service for capturing screenshots of the retrospective board.
 * Uses html2canvas to render the board element as a PNG image,
 * then copies it to the clipboard or falls back to file download.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6
 */
@Injectable({ providedIn: 'root' })
export class RetroScreenshotService {
  private readonly toastService = inject(ToastService);

  /**
   * Capture the entire board element as a PNG screenshot.
   * Attempts to copy the image to the clipboard. If the Clipboard API
   * is not available or fails, falls back to triggering a file download.
   *
   * @param element - The HTMLElement representing the board to capture
   */
  async captureBoard(element: HTMLElement): Promise<void> {
    try {
      // Dynamic import to keep html2canvas out of the main bundle
      const html2canvas = (await import('html2canvas')).default;

      // Render the entire element including off-screen content
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

      // Convert canvas to PNG blob
      const blob = await this.canvasToBlob(canvas);

      // Try clipboard first, fallback to download
      const copied = await this.tryClipboardCopy(blob);
      if (copied) {
        this.toastService.show('info', 'Screenshot copied to clipboard');
      } else {
        this.downloadBlob(blob, 'retrospective-board.png');
        this.toastService.show('info', 'Screenshot downloaded');
      }
    } catch (error) {
      this.toastService.show('error', 'Failed to capture screenshot');
    }
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
