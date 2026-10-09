import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EstimateExportService } from './estimate-export.service';
import { AuthService } from './auth.service';
import { BasePathService } from './base-path.service';
import { ToastService } from './toast.service';

/**
 * Tests for EstimateExportService.
 *
 * Requirements: R1.4 (exactly one authenticated request per activation),
 * R1.17 (download filename, MIME type, unchanged body), R1.18 (non-200 and
 * 30 second timeout each produce exactly one error toast and no download).
 */
describe('EstimateExportService', () => {
  const EXPORT_TIMEOUT_MS = 30_000;
  const OBJECT_URL = 'blob:http://localhost/estimate-export';

  let service: EstimateExportService;
  let httpTesting: HttpTestingController;

  let mockAuthService: { getToken: ReturnType<typeof vi.fn> };
  let mockBasePathService: { getApiUrl: ReturnType<typeof vi.fn>; getBasePath: ReturnType<typeof vi.fn> };
  let mockToastService: { show: ReturnType<typeof vi.fn> };

  /** Stand-in for the temporary download anchor created by the service. */
  let mockAnchor: { href: string; download: string; click: ReturnType<typeof vi.fn> };
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let restoreDomSpies: Array<() => void>;

  /**
   * Intercept only the anchor the service creates, delegating every other DOM
   * call to the real implementation.
   */
  function installDownloadSpies(): void {
    mockAnchor = { href: '', download: '', click: vi.fn() };

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string, options?: ElementCreationOptions) =>
        tagName === 'a' ? mockAnchor : originalCreateElement(tagName, options)) as typeof document.createElement);

    const originalAppendChild = document.body.appendChild.bind(document.body);
    const appendChildSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation(((node: Node) =>
        (node as unknown) === mockAnchor ? node : originalAppendChild(node)) as typeof document.body.appendChild);

    const originalRemoveChild = document.body.removeChild.bind(document.body);
    const removeChildSpy = vi
      .spyOn(document.body, 'removeChild')
      .mockImplementation(((node: Node) =>
        (node as unknown) === mockAnchor ? node : originalRemoveChild(node)) as typeof document.body.removeChild);

    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(OBJECT_URL);
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    restoreDomSpies = [
      () => createElementSpy.mockRestore(),
      () => appendChildSpy.mockRestore(),
      () => removeChildSpy.mockRestore(),
      () => createObjectURLSpy.mockRestore(),
      () => revokeObjectURLSpy.mockRestore(),
    ];
  }

  /** The Blob handed to URL.createObjectURL by the download helper. */
  function downloadedBlob(): Blob {
    return createObjectURLSpy.mock.calls[0]?.[0] as Blob;
  }

  function expectNoDownload(): void {
    expect(mockAnchor.click).not.toHaveBeenCalled();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    mockAuthService = { getToken: vi.fn().mockReturnValue('test-token-123') };
    mockBasePathService = {
      getApiUrl: vi.fn((path: string) => path),
      getBasePath: vi.fn().mockReturnValue(''),
    };
    mockToastService = { show: vi.fn() };

    installDownloadSpies();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        EstimateExportService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: BasePathService, useValue: mockBasePathService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });

    service = TestBed.inject(EstimateExportService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    for (const restore of restoreDomSpies) {
      restore();
    }
    httpTesting.verify();
    vi.clearAllMocks();
  });

  describe('request shape (R1.4)', () => {
    it('sends exactly one authenticated GET request per activation', async () => {
      const exportPromise = service.exportEstimates('session-abc');

      const req = httpTesting.expectOne('/api/sessions/session-abc/export');
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-123');
      req.flush('Story\nA');

      await exportPromise;

      // No second request escapes a single activation.
      httpTesting.expectNone('/api/sessions/session-abc/export');
    });

    it('sends no additional request while a request is awaiting a response', async () => {
      const first = service.exportEstimates('session-abc');
      expect(service.inFlight()).toBe(true);

      const second = service.exportEstimates('session-abc');

      const requests = httpTesting.match('/api/sessions/session-abc/export');
      expect(requests.length).toBe(1);
      requests[0].flush('Story\nA');

      await Promise.all([first, second]);
      expect(service.inFlight()).toBe(false);
    });

    it('allows a new request once the previous one has settled', async () => {
      const first = service.exportEstimates('session-abc');
      httpTesting.expectOne('/api/sessions/session-abc/export').flush('Story\nA');
      await first;

      const second = service.exportEstimates('session-abc');
      httpTesting.expectOne('/api/sessions/session-abc/export').flush('Story\nB');
      await second;

      expect(mockAnchor.click).toHaveBeenCalledTimes(2);
      expect(mockToastService.show).not.toHaveBeenCalled();
    });
  });

  describe('successful download (R1.17)', () => {
    it('downloads the response body unchanged as scrum-poker-<sessionId>.csv with text/csv MIME type', async () => {
      const csvContent =
        'Story,Participants\r\n"Title, with comma",3\r\n"He said ""hi""",2\r\n"Multi\nline story",1\r\n';

      const exportPromise = service.exportEstimates('session-xyz');

      const req = httpTesting.expectOne('/api/sessions/session-xyz/export');
      req.flush(csvContent);

      await exportPromise;

      expect(mockAnchor.download).toBe('scrum-poker-session-xyz.csv');
      expect(mockAnchor.href).toBe(OBJECT_URL);
      expect(mockAnchor.click).toHaveBeenCalledTimes(1);

      const blob = downloadedBlob();
      expect(blob.type).toBe('text/csv');
      expect(await blob.text()).toBe(csvContent);

      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith(OBJECT_URL);
      expect(mockToastService.show).not.toHaveBeenCalled();
      expect(service.inFlight()).toBe(false);
    });
  });

  describe('failure paths (R1.18)', () => {
    it('shows exactly one error toast and triggers no download on an error status', async () => {
      const exportPromise = service.exportEstimates('session-403');

      httpTesting
        .expectOne('/api/sessions/session-403/export')
        .flush(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403, statusText: 'Forbidden' });

      await exportPromise;

      expect(mockToastService.show).toHaveBeenCalledTimes(1);
      expect(mockToastService.show.mock.calls[0][0]).toBe('error');
      expect(typeof mockToastService.show.mock.calls[0][1]).toBe('string');
      expectNoDownload();
      expect(service.inFlight()).toBe(false);
    });

    it('shows exactly one error toast and triggers no download on a non-200 success status', async () => {
      const exportPromise = service.exportEstimates('session-204');

      httpTesting
        .expectOne('/api/sessions/session-204/export')
        .flush('', { status: 204, statusText: 'No Content' });

      await exportPromise;

      expect(mockToastService.show).toHaveBeenCalledTimes(1);
      expect(mockToastService.show.mock.calls[0][0]).toBe('error');
      expectNoDownload();
      expect(service.inFlight()).toBe(false);
    });

    it('shows exactly one error toast and triggers no download when no response arrives within 30 seconds', async () => {
      vi.useFakeTimers();
      try {
        const exportPromise = service.exportEstimates('session-slow');
        const req = httpTesting.expectOne('/api/sessions/session-slow/export');

        await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS - 1);
        expect(mockToastService.show).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await exportPromise;

        expect(req.cancelled).toBe(true);
        expect(mockToastService.show).toHaveBeenCalledTimes(1);
        expect(mockToastService.show.mock.calls[0][0]).toBe('error');
        expectNoDownload();
        expect(service.inFlight()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
