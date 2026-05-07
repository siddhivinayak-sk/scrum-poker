import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';

@Injectable({ providedIn: 'root' })
export class RetroExportService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly basePath = inject(BasePathService);

  /**
   * Export the retrospective board as a CSV file download.
   * Calls GET /api/retro/sessions/:sessionId/export with auth header,
   * receives CSV text, and triggers a browser file download.
   *
   * Requirements: 13.1, 13.2
   */
  async exportCSV(sessionId: string): Promise<void> {
    const headers = this.getAuthHeaders();
    const url = this.basePath.getApiUrl(`/api/retro/sessions/${sessionId}/export`);

    const csvText = await firstValueFrom(
      this.http.get(url, { headers, responseType: 'text' })
    );

    this.triggerDownload(csvText, `retrospective-${sessionId}.csv`, 'text/csv');
  }

  /**
   * Import cards from a CSV file into the retrospective board.
   * Reads the file content as text, then calls POST /api/retro/sessions/:sessionId/import
   * with the CSV data in the request body.
   *
   * Requirements: 14.1, 14.2, 14.3
   *
   * @returns A promise that resolves on success or rejects with an error message.
   */
  async importCSV(sessionId: string, file: File): Promise<void> {
    const csvData = await this.readFileAsText(file);
    const headers = this.getAuthHeaders();
    const url = this.basePath.getApiUrl(`/api/retro/sessions/${sessionId}/import`);

    await firstValueFrom(
      this.http.post<{ success: boolean }>(url, { csvData }, { headers })
    );
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
}
