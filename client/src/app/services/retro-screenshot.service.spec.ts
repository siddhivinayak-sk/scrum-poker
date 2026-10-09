import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  RetroScreenshotService,
  CAPTURE_TIMEOUT_MS,
  SCREENSHOT_FILENAME,
  COPIED_MESSAGE,
  DOWNLOADED_MESSAGE,
  FAILED_MESSAGE,
} from './retro-screenshot.service';
import { CAPTURE_CLONE_CLASS, CAPTURE_ROOT_ATTRIBUTE } from './retro-capture-mode';
import { ToastService } from './toast.service';

// html2canvas is pulled in through a dynamic import inside the service, so the
// module has to be mocked rather than the symbol stubbed.
vi.mock('html2canvas', () => ({ default: vi.fn() }));

/**
 * Tests for RetroScreenshotService.
 *
 * Requirements: R4.1 (one capture per activation), R4.4 (failed capture emits
 * exactly one error notification, writes nothing to the clipboard and triggers
 * no download), R4.5 (clipboard success emits exactly one notification and no
 * download), R4.6 (unavailable or failing clipboard falls back to exactly one
 * PNG download), R4.8 (a capture that has not produced an image within 10
 * seconds ends and counts as a failure), R4.9 (a download emits exactly one
 * notification), R4.10 (no additional capture starts while one is in progress).
 *
 * R4.3 is covered here only for the service's own `finally` restore — the exact
 * structural round trip of capture mode lives in
 * `retro-capture-mode.property.spec.ts`.
 */
describe('RetroScreenshotService', () => {
  const OBJECT_URL = 'blob:http://localhost/retro-screenshot';
  const CARD_TEXT = 'A card text long enough to wrap across several rendered lines.';

  let service: RetroScreenshotService;
  let html2canvasMock: ReturnType<typeof vi.fn>;

  let mockToastService: { show: ReturnType<typeof vi.fn> };

  /** Stand-in for the temporary download anchor created by the service. */
  let mockAnchor: { href: string; download: string; click: ReturnType<typeof vi.fn> };
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let restoreDomSpies: Array<() => void>;

  /** Payloads handed to `navigator.clipboard.write`, newest last. */
  let clipboardWrites: unknown[][];
  let clipboardWrite: ReturnType<typeof vi.fn> | undefined;
  let originalClipboard: PropertyDescriptor | undefined;

  /** The board element under capture, attached so it has a layout. */
  let board: HTMLElement;

  interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /**
   * A board holding one column with one card, so capture mode has a text area to
   * substitute and a scroll container to unclip.
   */
  function createBoard(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'retro-board__columns';

    const cards = document.createElement('div');
    cards.className = 'retro-column__cards';

    const textArea = document.createElement('textarea');
    textArea.className = 'retro-card__text';
    textArea.value = CARD_TEXT;

    cards.appendChild(textArea);
    root.appendChild(cards);
    document.body.appendChild(root);

    Object.defineProperty(root, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(root, 'scrollHeight', { value: 600, configurable: true });

    return root;
  }

  /** Canvas stub whose `toBlob` hands back `blob` on the next tick of the callback. */
  function canvasYielding(blob: Blob | null): HTMLCanvasElement {
    return {
      toBlob: vi.fn((callback: (value: Blob | null) => void) => callback(blob)),
    } as unknown as HTMLCanvasElement;
  }

  function pngBlob(): Blob {
    return new Blob(['fake-png-bytes'], { type: 'image/png' });
  }

  /**
   * Install `write` as the clipboard implementation, or remove clipboard support
   * entirely when it is `undefined`.
   */
  function setClipboard(write: ((items: unknown[]) => Promise<void>) | undefined): void {
    if (write === undefined) {
      clipboardWrite = undefined;
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      return;
    }

    clipboardWrite = vi.fn((items: unknown[]) => {
      clipboardWrites.push(items);
      return write(items);
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: clipboardWrite },
      writable: true,
      configurable: true,
    });
  }

  /**
   * Intercept only the anchor the download fallback creates, delegating every
   * other DOM call — including the clones capture mode inserts — to the real
   * implementation.
   */
  function installDownloadSpies(): void {
    mockAnchor = { href: '', download: '', click: vi.fn() };

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string, options?: ElementCreationOptions) =>
        tagName === 'a'
          ? mockAnchor
          : originalCreateElement(tagName, options)) as typeof document.createElement);

    const originalAppendChild = document.body.appendChild.bind(document.body);
    const appendChildSpy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation(((node: Node) =>
        (node as unknown) === mockAnchor
          ? node
          : originalAppendChild(node)) as typeof document.body.appendChild);

    const originalRemoveChild = document.body.removeChild.bind(document.body);
    const removeChildSpy = vi
      .spyOn(document.body, 'removeChild')
      .mockImplementation(((node: Node) =>
        (node as unknown) === mockAnchor
          ? node
          : originalRemoveChild(node)) as typeof document.body.removeChild);

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

  /** The Blob handed to `URL.createObjectURL` by the download helper. */
  function downloadedBlob(): Blob {
    return createObjectURLSpy.mock.calls[0]?.[0] as Blob;
  }

  function expectNoDownload(): void {
    expect(mockAnchor.click).not.toHaveBeenCalled();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  }

  function expectNothingCopied(): void {
    expect(clipboardWrites).toHaveLength(0);
  }

  /** One notification of the given type and message, and nothing else. */
  function expectSingleNotification(type: 'info' | 'error', message: string): void {
    expect(mockToastService.show).toHaveBeenCalledTimes(1);
    expect(mockToastService.show).toHaveBeenCalledWith(type, message);
  }

  /** Nothing of capture mode is left behind on the board. */
  function expectCaptureModeRestored(): void {
    expect(board.hasAttribute(CAPTURE_ROOT_ATTRIBUTE)).toBe(false);
    expect(board.querySelectorAll(`.${CAPTURE_CLONE_CLASS}`)).toHaveLength(0);

    const textArea = board.querySelector<HTMLTextAreaElement>('textarea.retro-card__text');
    expect(textArea).not.toBeNull();
    expect(textArea!.style.display).toBe('');
    expect(textArea!.value).toBe(CARD_TEXT);
  }

  beforeEach(async () => {
    mockToastService = { show: vi.fn() };
    clipboardWrites = [];
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

    vi.stubGlobal(
      'ClipboardItem',
      class MockClipboardItem {
        constructor(public readonly items: Record<string, Blob>) {}
      },
    );

    board = createBoard();
    installDownloadSpies();

    TestBed.configureTestingModule({
      providers: [
        RetroScreenshotService,
        { provide: ToastService, useValue: mockToastService },
      ],
    });
    service = TestBed.inject(RetroScreenshotService);

    const mod = await import('html2canvas');
    html2canvasMock = mod.default as unknown as ReturnType<typeof vi.fn>;
    html2canvasMock.mockReset();
  });

  afterEach(() => {
    for (const restore of restoreDomSpies) {
      restore();
    }
    board.remove();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is created and reports no capture in progress', () => {
    expect(service).toBeTruthy();
    expect(service.capturing()).toBe(false);
  });

  describe('clipboard success (R4.5)', () => {
    beforeEach(() => {
      setClipboard(() => Promise.resolve());
      html2canvasMock.mockResolvedValue(canvasYielding(pngBlob()));
    });

    it('renders the board at its full scroll size', async () => {
      await service.captureBoard(board);

      expect(html2canvasMock).toHaveBeenCalledTimes(1);
      expect(html2canvasMock).toHaveBeenCalledWith(
        board,
        expect.objectContaining({
          windowWidth: 800,
          windowHeight: 600,
          width: 800,
          height: 600,
        }),
      );
    });

    it('copies the PNG and emits exactly one notification without downloading', async () => {
      await service.captureBoard(board);

      expect(clipboardWrites).toHaveLength(1);
      const [item] = clipboardWrites[0] as Array<{ items: Record<string, Blob> }>;
      expect(item.items['image/png'].type).toBe('image/png');

      expectSingleNotification('info', COPIED_MESSAGE);
      expectNoDownload();
    });

    it('restores capture mode and clears the capturing flag', async () => {
      await service.captureBoard(board);

      expectCaptureModeRestored();
      expect(service.capturing()).toBe(false);
    });

    it('renders while the board is in capture mode', async () => {
      let cloneTextDuringRender: string | null = null;
      let textAreaDisplayDuringRender: string | null = null;
      let markedDuringRender = false;

      html2canvasMock.mockImplementation((element: HTMLElement) => {
        markedDuringRender = element.getAttribute(CAPTURE_ROOT_ATTRIBUTE) === 'true';
        cloneTextDuringRender =
          element.querySelector(`.${CAPTURE_CLONE_CLASS}`)?.textContent ?? null;
        textAreaDisplayDuringRender =
          element.querySelector<HTMLTextAreaElement>('textarea.retro-card__text')?.style.display ??
          null;
        return Promise.resolve(canvasYielding(pngBlob()));
      });

      await service.captureBoard(board);

      expect(markedDuringRender).toBe(true);
      expect(cloneTextDuringRender).toBe(CARD_TEXT);
      expect(textAreaDisplayDuringRender).toBe('none');
      expectCaptureModeRestored();
    });
  });

  describe('download fallback (R4.6, R4.9)', () => {
    beforeEach(() => {
      html2canvasMock.mockResolvedValue(canvasYielding(pngBlob()));
    });

    it('downloads one PNG and emits exactly one notification when the clipboard is unavailable', async () => {
      setClipboard(undefined);

      await service.captureBoard(board);

      expect(mockAnchor.click).toHaveBeenCalledTimes(1);
      expect(mockAnchor.download).toBe(SCREENSHOT_FILENAME);
      expect(mockAnchor.href).toBe(OBJECT_URL);
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(downloadedBlob().type).toBe('image/png');
      expect(revokeObjectURLSpy).toHaveBeenCalledWith(OBJECT_URL);

      expectSingleNotification('info', DOWNLOADED_MESSAGE);
      expectCaptureModeRestored();
    });

    it('downloads one PNG and emits exactly one notification when the clipboard write rejects', async () => {
      setClipboard(() => Promise.reject(new Error('Permission denied')));

      await service.captureBoard(board);

      expect(clipboardWrite).toHaveBeenCalledTimes(1);
      expect(mockAnchor.click).toHaveBeenCalledTimes(1);
      expect(mockAnchor.download).toBe(SCREENSHOT_FILENAME);

      expectSingleNotification('info', DOWNLOADED_MESSAGE);
      expectCaptureModeRestored();
    });
  });

  describe('render failure (R4.4)', () => {
    beforeEach(() => {
      setClipboard(() => Promise.resolve());
    });

    it('emits exactly one error notification, copies nothing and downloads nothing', async () => {
      html2canvasMock.mockRejectedValue(new Error('Canvas render failed'));

      await service.captureBoard(board);

      expectSingleNotification('error', FAILED_MESSAGE);
      expectNothingCopied();
      expectNoDownload();
      expectCaptureModeRestored();
      expect(service.capturing()).toBe(false);
    });

    it('treats a canvas that yields no blob as a failed capture', async () => {
      html2canvasMock.mockResolvedValue(canvasYielding(null));

      await service.captureBoard(board);

      expectSingleNotification('error', FAILED_MESSAGE);
      expectNothingCopied();
      expectNoDownload();
      expectCaptureModeRestored();
    });
  });

  describe('capture budget (R4.8)', () => {
    it('ends a capture that has not produced an image within 10 seconds', async () => {
      vi.useFakeTimers();
      setClipboard(() => Promise.resolve());

      const pending = deferred<HTMLCanvasElement>();
      html2canvasMock.mockReturnValue(pending.promise);

      const capture = service.captureBoard(board);

      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
      expect(mockToastService.show).not.toHaveBeenCalled();
      expect(service.capturing()).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await capture;

      expectSingleNotification('error', FAILED_MESSAGE);
      expectNothingCopied();
      expectNoDownload();
      expectCaptureModeRestored();
      expect(service.capturing()).toBe(false);

      // A render that lands after the budget expired must not revive the capture.
      pending.resolve(canvasYielding(pngBlob()));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockToastService.show).toHaveBeenCalledTimes(1);
      expectNothingCopied();
      expectNoDownload();
    });
  });

  describe('re-entry guard (R4.1, R4.10)', () => {
    it('holds capturing true for the whole run', async () => {
      setClipboard(() => Promise.resolve());

      const pending = deferred<HTMLCanvasElement>();
      html2canvasMock.mockReturnValue(pending.promise);

      expect(service.capturing()).toBe(false);
      const capture = service.captureBoard(board);
      expect(service.capturing()).toBe(true);

      pending.resolve(canvasYielding(pngBlob()));
      await capture;

      expect(service.capturing()).toBe(false);
    });

    it('starts no second capture while one is in progress', async () => {
      setClipboard(() => Promise.resolve());

      // html2canvas arrives through a dynamic import, so the second activation
      // has to wait for the first render to actually start before it proves
      // anything about re-entry.
      const renderStarted = deferred<void>();
      const pending = deferred<HTMLCanvasElement>();
      html2canvasMock.mockImplementation(() => {
        renderStarted.resolve();
        return pending.promise;
      });

      const first = service.captureBoard(board);
      await renderStarted.promise;
      await service.captureBoard(board);

      expect(html2canvasMock).toHaveBeenCalledTimes(1);
      expect(mockToastService.show).not.toHaveBeenCalled();
      // The in-flight capture still owns the board.
      expect(board.getAttribute(CAPTURE_ROOT_ATTRIBUTE)).toBe('true');
      expect(board.querySelectorAll(`.${CAPTURE_CLONE_CLASS}`)).toHaveLength(1);

      pending.resolve(canvasYielding(pngBlob()));
      await first;

      expectSingleNotification('info', COPIED_MESSAGE);
      expectCaptureModeRestored();
    });

    it('allows a new capture once the previous one has finished', async () => {
      setClipboard(() => Promise.resolve());
      html2canvasMock.mockResolvedValue(canvasYielding(pngBlob()));

      await service.captureBoard(board);
      await service.captureBoard(board);

      expect(html2canvasMock).toHaveBeenCalledTimes(2);
      expect(mockToastService.show).toHaveBeenCalledTimes(2);
      expect(clipboardWrites).toHaveLength(2);
      expectCaptureModeRestored();
    });
  });
});
