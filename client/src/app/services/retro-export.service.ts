import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { RetroSessionState } from '@shared/types';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';
import { ToastService } from './toast.service';
import { RetroStateService } from './retro-state.service';

@Injectable({ providedIn: 'root' })
export class RetroExportService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly basePath = inject(BasePathService);
  private readonly toastService = inject(ToastService);
  private readonly retroState = inject(RetroStateService);

  /**
   * Export the retrospective board as a CSV file download.
   * Calls GET /api/retro/sessions/:sessionId/export with auth header,
   * receives CSV text, and triggers a browser file download.
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4
   */
  async exportCSV(sessionId: string): Promise<void> {
    const headers = this.getAuthHeaders();
    const url = this.basePath.getApiUrl(`/api/retro/sessions/${sessionId}/export`);

    try {
      const csvText = await firstValueFrom(
        this.http.get(url, { headers, responseType: 'text' })
      );

      this.triggerDownload(csvText, `retrospective-${sessionId}.csv`, 'text/csv');
    } catch (error: unknown) {
      const message = this.extractErrorMessage(error, 'Failed to export CSV');
      this.toastService.show('error', message);
      throw error;
    }
  }

  /**
   * Import cards from a CSV file into the retrospective board.
   * Reads the file content as text, then calls POST /api/retro/sessions/:sessionId/import
   * with the CSV data in the request body.
   *
   * Requirements: 2.1, 2.2, 2.3, 2.4
   *
   * @returns A promise that resolves on success or rejects with an error.
   */
  async importCSV(sessionId: string, file: File): Promise<void> {
    let csvData: string;
    try {
      csvData = await this.readFileAsText(file);
    } catch {
      this.toastService.show('error', 'Failed to read file');
      throw new Error('Failed to read file');
    }

    const headers = this.getAuthHeaders();
    const importUrl = this.basePath.getApiUrl(`/api/retro/sessions/${sessionId}/import`);

    try {
      await firstValueFrom(
        this.http.post<{ success: boolean }>(importUrl, { csvData }, { headers })
      );
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse && error.error?.code === 'INVALID_CSV') {
        this.toastService.show('error', error.error.message);
      } else if (error instanceof HttpErrorResponse && error.error?.error === 'INVALID_CSV') {
        this.toastService.show('error', error.error.message);
      } else {
        const message = this.extractErrorMessage(error, 'Failed to import CSV');
        this.toastService.show('error', message);
      }
      throw error;
    }

    // Refresh board state after successful import
    await this.refreshBoardState(sessionId, headers);
  }

  /**
   * Fetch the latest session state from the server and apply it to the state service.
   */
  private async refreshBoardState(sessionId: string, headers: HttpHeaders): Promise<void> {
    const stateUrl = this.basePath.getApiUrl(`/api/retro/sessions/${sessionId}`);
    try {
      const state = await firstValueFrom(
        this.http.get<RetroSessionState>(stateUrl, { headers })
      );
      this.retroState.applyState(state);
    } catch {
      // State refresh failure is non-critical; the board will sync on next WS event
    }
  }

  /**
   * Read a File object as text using FileReader.
   */
  private readFileAsText(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  /**
   * Trigger a file download in the browser by creating a temporary anchor element.
   */
  private triggerDownload(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  /**
   * Build HTTP headers with the current auth token.
   */
  private getAuthHeaders(): HttpHeaders {
    const token = this.authService.getToken();
    return new HttpHeaders({
      Authorization: `Bearer ${token}`,
    });
  }

  /**
   * Extract an error message from an HTTP error response.
   * Falls back to the provided default message if no server message is available.
   */
  private extractErrorMessage(error: unknown, defaultMessage: string): string {
    if (error instanceof HttpErrorResponse) {
      // Server may return JSON with a 'message' field or plain text
      if (error.error && typeof error.error === 'object' && error.error.message) {
        return error.error.message;
      }
      if (typeof error.error === 'string' && error.error.length > 0) {
        return error.error;
      }
    }
    return defaultMessage;
  }
}
