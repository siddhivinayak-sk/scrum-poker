import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RetroExportService } from './retro-export.service';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';
import { ToastService } from './toast.service';
import { RetroStateService } from './retro-state.service';

describe('RetroExportService', () => {
  let service: RetroExportService;
  let httpTesting: HttpTestingController;
  let mockToastService: { show: ReturnType<typeof vi.fn> };

  const mockAuthService = {
    getToken: vi.fn().mockReturnValue('test-token-123'),
  };

  const mockBasePathService = {
    getApiUrl: vi.fn((path: string) => path),
    getBasePath: vi.fn().mockReturnValue(''),
  };

  const mockRetroStateService = {
    applyState: vi.fn(),
  };

  beforeEach(() => {
    mockToastService = { show: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        RetroExportService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: BasePathService, useValue: mockBasePathService },
        { provide: ToastService, useValue: mockToastService },
        { provide: RetroStateService, useValue: mockRetroStateService },
      ],
    });

    service = TestBed.inject(RetroExportService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
    vi.clearAllMocks();
  });

  describe('exportCSV', () => {
    it('should trigger download with correct filename and MIME type on success', async () => {
      const sessionId = 'session-abc';
      const csvContent = 'Column,Card Text,Votes,Author,Comments\nWent Well,Great sprint,3,Alice,Nice work';

      const mockAnchor = {
        href: '',
        download: '',
        click: vi.fn(),
      };
      const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as any);
      const appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
      const removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/fake-url');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      const exportPromise = service.exportCSV(sessionId);

      const req = httpTesting.expectOne('/api/retro/sessions/session-abc/export');
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-123');
      req.flush(csvContent);

      await exportPromise;

      expect(createElementSpy).toHaveBeenCalledWith('a');
      expect(mockAnchor.download).toBe('retrospective-session-abc.csv');
      expect(mockAnchor.click).toHaveBeenCalled();

      // Verify the blob was created with text/csv MIME type
      const blobArg = (createObjectURLSpy.mock.calls[0] as any[])[0] as Blob;
      expect(blobArg.type).toBe('text/csv');

      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/fake-url');

      createElementSpy.mockRestore();
      appendChildSpy.mockRestore();
      removeChildSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('should show toast with server error message when export fails', async () => {
      const sessionId = 'session-fail';

      const exportPromise = service.exportCSV(sessionId);

      const req = httpTesting.expectOne('/api/retro/sessions/session-fail/export');
      // When responseType is 'text', Angular passes the error body as a string
      req.flush(
        'Session not found',
        { status: 404, statusText: 'Not Found' }
      );

      await expect(exportPromise).rejects.toThrow();

      expect(mockToastService.show).toHaveBeenCalledWith('error', 'Session not found');
    });

    it('should show generic error message when server provides no message', async () => {
      const sessionId = 'session-500';

      const exportPromise = service.exportCSV(sessionId);

      const req = httpTesting.expectOne('/api/retro/sessions/session-500/export');
      req.flush(null, { status: 500, statusText: 'Internal Server Error' });

      await expect(exportPromise).rejects.toThrow();

      expect(mockToastService.show).toHaveBeenCalledWith('error', 'Failed to export CSV');
    });
  });

  describe('importCSV', () => {
    it('should refresh board state after successful import', async () => {
      const sessionId = 'session-xyz';
      const csvContent = 'Column,Card Text\nWent Well,Good job';
      const file = new File([csvContent], 'import.csv', { type: 'text/csv' });

      const importPromise = service.importCSV(sessionId, file);

      // Allow FileReader to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const req = httpTesting.expectOne('/api/retro/sessions/session-xyz/import');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-123');
      expect(req.request.body).toEqual({ csvData: csvContent });
      req.flush({ success: true });

      // After successful import, the service fetches updated state
      await new Promise((resolve) => setTimeout(resolve, 0));
      const stateReq = httpTesting.expectOne('/api/retro/sessions/session-xyz');
      expect(stateReq.request.method).toBe('GET');
      const mockState = { sessionId: 'session-xyz', board: { columns: [{ id: 'col-1', name: 'Went Well', cards: [] }] } };
      stateReq.flush(mockState);

      await importPromise;

      expect(mockRetroStateService.applyState).toHaveBeenCalledWith(mockState);
    });

    it('should show toast with server message when error code is INVALID_CSV', async () => {
      const sessionId = 'session-err';
      const csvContent = 'invalid csv data';
      const file = new File([csvContent], 'bad.csv', { type: 'text/csv' });

      const importPromise = service.importCSV(sessionId, file);

      // Allow FileReader to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const req = httpTesting.expectOne('/api/retro/sessions/session-err/import');
      req.flush(
        { code: 'INVALID_CSV', message: 'Missing required Column header' },
        { status: 400, statusText: 'Bad Request' }
      );

      await expect(importPromise).rejects.toThrow();

      expect(mockToastService.show).toHaveBeenCalledWith('error', 'Missing required Column header');
    });

    it('should show toast with server message when error field is INVALID_CSV', async () => {
      const sessionId = 'session-err2';
      const csvContent = 'no headers here';
      const file = new File([csvContent], 'bad2.csv', { type: 'text/csv' });

      const importPromise = service.importCSV(sessionId, file);

      // Allow FileReader to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const req = httpTesting.expectOne('/api/retro/sessions/session-err2/import');
      req.flush(
        { error: 'INVALID_CSV', message: 'CSV must contain Card Text column' },
        { status: 400, statusText: 'Bad Request' }
      );

      await expect(importPromise).rejects.toThrow();

      expect(mockToastService.show).toHaveBeenCalledWith('error', 'CSV must contain Card Text column');
    });

    it('should show generic error toast when file read fails', async () => {
      const sessionId = 'session-read-fail';
      const file = new File([], 'empty.csv', { type: 'text/csv' });

      // Mock FileReader to simulate read failure
      const originalFileReader = globalThis.FileReader;

      class MockFileReader {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsText() {
          // Trigger onerror asynchronously to simulate FileReader behavior
          setTimeout(() => {
            if (this.onerror) {
              this.onerror();
            }
          }, 0);
        }
      }

      globalThis.FileReader = MockFileReader as any;

      // Track the rejection with a settled flag to avoid unhandled promise warning
      let caughtError: unknown = null;
      const importPromise = service.importCSV(sessionId, file).catch((err) => {
        caughtError = err;
      });

      // Wait for FileReader error to fire and promise to settle
      await importPromise;

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('Failed to read file');
      expect(mockToastService.show).toHaveBeenCalledWith('error', 'Failed to read file');

      // Restore original FileReader
      globalThis.FileReader = originalFileReader;
    });
  });
});
