import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RetroExportService } from './retro-export.service';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';

describe('RetroExportService', () => {
  let service: RetroExportService;
  let httpTesting: HttpTestingController;

  const mockAuthService = {
    getToken: vi.fn().mockReturnValue('test-token-123'),
  };

  const mockBasePathService = {
    getApiUrl: vi.fn((path: string) => path),
    getBasePath: vi.fn().mockReturnValue(''),
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        RetroExportService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: BasePathService, useValue: mockBasePathService },
      ],
    });

    service = TestBed.inject(RetroExportService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  describe('exportCSV', () => {
    it('should call GET /api/retro/sessions/:sessionId/export with auth header', async () => {
      const sessionId = 'session-abc';
      const csvContent = 'Column,Card Text,Votes,Author,Comments\nWent Well,Great sprint,3,Alice,Nice work';

      // Mock DOM methods for download trigger
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
      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(revokeObjectURLSpy).toHaveBeenCalled();

      createElementSpy.mockRestore();
      appendChildSpy.mockRestore();
      removeChildSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });
  });

  describe('importCSV', () => {
    it('should read file and call POST /api/retro/sessions/:sessionId/import with csvData', async () => {
      const sessionId = 'session-xyz';
      const csvContent = 'Column,Card Text\nWent Well,Good job';
      const file = new File([csvContent], 'import.csv', { type: 'text/csv' });

      const importPromise = service.importCSV(sessionId, file);

      // Allow FileReader to complete (it fires asynchronously even in jsdom)
      await new Promise((resolve) => setTimeout(resolve, 50));

      const req = httpTesting.expectOne('/api/retro/sessions/session-xyz/import');
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-123');
      expect(req.request.body).toEqual({ csvData: csvContent });
      req.flush({ success: true });

      await importPromise;
    });

    it('should reject with error when server returns an error response', async () => {
      const sessionId = 'session-err';
      const csvContent = 'invalid csv data';
      const file = new File([csvContent], 'bad.csv', { type: 'text/csv' });

      const importPromise = service.importCSV(sessionId, file);

      // Allow FileReader to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const req = httpTesting.expectOne('/api/retro/sessions/session-err/import');
      req.flush(
        { error: 'INVALID_CSV', message: 'Missing required columns' },
        { status: 400, statusText: 'Bad Request' }
      );

      await expect(importPromise).rejects.toThrow();
    });
  });
});
