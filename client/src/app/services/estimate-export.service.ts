import { Injectable, Signal, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { TimeoutError, firstValueFrom, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';
import { ToastService } from './toast.service';

/** Maximum time to wait for the export response before failing (R1.18). */
const EXPORT_TIMEOUT_MS = 30_000;

const CSV_MIME_TYPE = 'text/csv';

/**
 * Requests the completed-estimate export document for a poker session and
 * triggers the browser file download.
 *
 * Requirements: R1.4, R1.17, R1.18
 */
@Injectable({ providedIn: 'root' })
export class EstimateExportService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly basePath = inject(BasePathService);
  private readonly toastService = inject(ToastService);

  private readonly _inFlight = signal(false);

  /** True while an export request is awaiting a response. */
  readonly inFlight: Signal<boolean> = this._inFlight.asReadonly();

  /**
   * Export the completed estimates of a poker session as a CSV file download.
   *
   * Sends exactly one `GET /api/sessions/:sessionId/export` carrying the stored
   * authentication token, and refuses to start while a previous request is still
   * pending (R1.4). On status 200 the response body is downloaded unchanged as
   * `scrum-poker-<sessionId>.csv` with MIME type `text/csv` (R1.17). Any other
   * status, or no response within 30 seconds, produces exactly one `error` toast
   * and no download (R1.18).
   */
  async exportEstimates(sessionId: string): Promise<void> {
    if (this._inFlight()) {
      return;
    }

    this._inFlight.set(true);
    try {
      const response = await firstValueFrom(
        this.http
          .get(this.basePath.getApiUrl(`/api/sessions/${sessionId}/export`), {
            headers: this.getAuthHeaders(),
            responseType: 'text',
            observe: 'response',
          })
          .pipe(timeout(EXPORT_TIMEOUT_MS))
      );

      if (response.status !== 200) {
        this.toastService.show('error', this.describeFailure(response));
        return;
      }

      this.triggerDownload(response.body ?? '', `scrum-poker-${sessionId}.csv`);
    } catch (error: unknown) {
      this.toastService.show('error', this.describeFailure(error));
    } finally {
      this._inFlight.set(false);
    }
  }

  /**
   * Build HTTP headers carrying the stored authentication token.
   */
  private getAuthHeaders(): HttpHeaders {
    const token = this.authService.getToken();
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  /**
   * Trigger a single browser file download of CSV text.
   */
  private triggerDownload(content: string, filename: string): void {
    const blob = new Blob([content], { type: CSV_MIME_TYPE });
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
   * Describe an export failure for the error notification.
   */
  private describeFailure(failure: unknown): string {
    if (failure instanceof TimeoutError) {
      return 'Export timed out. Please try again.';
    }

    if (failure instanceof HttpErrorResponse) {
      const serverMessage = this.extractServerMessage(failure.error);
      if (serverMessage !== null) {
        return serverMessage;
      }
      return `Failed to export estimates (status ${failure.status}).`;
    }

    if (failure instanceof HttpResponse) {
      return `Failed to export estimates (status ${failure.status}).`;
    }

    return 'Failed to export estimates.';
  }

  /**
   * Pull a human-readable message out of an error response body, which the
   * server may send as JSON or as plain text.
   */
  private extractServerMessage(body: unknown): string | null {
    if (typeof body === 'string' && body.length > 0) {
      try {
        return this.extractServerMessage(JSON.parse(body) as unknown);
      } catch {
        return body;
      }
    }

    if (body !== null && typeof body === 'object') {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    }

    return null;
  }
}
