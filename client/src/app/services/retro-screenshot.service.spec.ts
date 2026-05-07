import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { RetroScreenshotService } from './retro-screenshot.service';
import { ToastService } from './toast.service';

// Mock html2canvas at module level
vi.mock('html2canvas', () => {
  return {
    default: vi.fn(),
  };
});

describe('RetroScreenshotService', () => {
  let service: RetroScreenshotService;
  let toastService: ToastService;
  let html2canvasMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [RetroScreenshotService, ToastService],
    });
    service = TestBed.inject(RetroScreenshotService);
    toastService = TestBed.inject(ToastService);

    // Get the mocked html2canvas
    const mod = await import('html2canvas');
    html2canvasMock = mod.default as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should show success toast when screenshot is copied to clipboard', async () => {
    const showSpy = vi.spyOn(toastService, 'show');

    // Create a mock canvas that returns a blob via toBlob
    const mockBlob = new Blob(['fake-png'], { type: 'image/png' });
    const mockCanvas = {
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    html2canvasMock.mockResolvedValue(mockCanvas);

    // Mock clipboard API
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: mockWrite },
      writable: true,
      configurable: true,
    });

    // Mock ClipboardItem
    vi.stubGlobal('ClipboardItem', class MockClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    });

    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollWidth', { value: 800 });
    Object.defineProperty(element, 'scrollHeight', { value: 600 });

    await service.captureBoard(element);

    expect(html2canvasMock).toHaveBeenCalledWith(element, expect.objectContaining({
      windowWidth: 800,
      windowHeight: 600,
      width: 800,
      height: 600,
    }));
    expect(mockWrite).toHaveBeenCalled();
    expect(showSpy).toHaveBeenCalledWith('info', 'Screenshot copied to clipboard');
  });

  it('should fallback to download when clipboard API is not available', async () => {
    const showSpy = vi.spyOn(toastService, 'show');

    // Create a mock canvas that returns a blob via toBlob
    const mockBlob = new Blob(['fake-png'], { type: 'image/png' });
    const mockCanvas = {
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    html2canvasMock.mockResolvedValue(mockCanvas);

    // Remove clipboard write support
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: undefined },
      writable: true,
      configurable: true,
    });

    // Mock URL methods and anchor click
    const mockUrl = 'blob:mock-url';
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue(mockUrl),
      revokeObjectURL: vi.fn(),
    });

    const clickSpy = vi.fn();
    const createElementOriginal = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createElementOriginal(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(clickSpy);
      }
      return el;
    });

    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollWidth', { value: 800 });
    Object.defineProperty(element, 'scrollHeight', { value: 600 });

    await service.captureBoard(element);

    expect(showSpy).toHaveBeenCalledWith('info', 'Screenshot downloaded');
  });

  it('should show error toast when screenshot capture fails', async () => {
    const showSpy = vi.spyOn(toastService, 'show');

    html2canvasMock.mockRejectedValue(new Error('Canvas render failed'));

    const element = document.createElement('div');

    await service.captureBoard(element);

    expect(showSpy).toHaveBeenCalledWith('error', 'Failed to capture screenshot');
  });

  it('should fallback to download when clipboard write throws', async () => {
    const showSpy = vi.spyOn(toastService, 'show');

    const mockBlob = new Blob(['fake-png'], { type: 'image/png' });
    const mockCanvas = {
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    html2canvasMock.mockResolvedValue(mockCanvas);

    // Mock clipboard API that throws
    const mockWrite = vi.fn().mockRejectedValue(new Error('Permission denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: mockWrite },
      writable: true,
      configurable: true,
    });

    vi.stubGlobal('ClipboardItem', class MockClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    });

    // Mock URL methods and anchor click
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });

    const clickSpy = vi.fn();
    const createElementOriginal = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createElementOriginal(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(clickSpy);
      }
      return el;
    });

    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollWidth', { value: 800 });
    Object.defineProperty(element, 'scrollHeight', { value: 600 });

    await service.captureBoard(element);

    expect(showSpy).toHaveBeenCalledWith('info', 'Screenshot downloaded');
  });
});
