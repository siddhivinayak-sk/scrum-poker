import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { FeelingsSummaryPopupComponent } from './feelings-summary-popup.component';
import { FeelingsService } from '../../services/feelings.service';
import { RetroStateService } from '../../services/retro-state.service';
import { ToastService } from '../../services/toast.service';
import { FeelingCategory, User } from '@shared/types';

// Mock html2canvas module
vi.mock('html2canvas', () => ({
  default: vi.fn(),
}));

describe('FeelingsSummaryPopupComponent', () => {
  let fixture: ComponentFixture<FeelingsSummaryPopupComponent>;
  let component: FeelingsSummaryPopupComponent;
  let feelingsSignal: WritableSignal<Record<string, FeelingCategory | null>>;
  let participantsSignal: WritableSignal<User[]>;
  let mockToastShow: ReturnType<typeof vi.fn>;

  function createParticipants(...names: { id: string; displayName: string }[]): User[] {
    return names.map((n) => ({
      id: n.id,
      displayName: n.displayName,
      role: 'participant' as const,
      isAnonymous: false,
    }));
  }

  beforeEach(() => {
    feelingsSignal = signal<Record<string, FeelingCategory | null>>({});
    participantsSignal = signal<User[]>([]);
    mockToastShow = vi.fn();

    const mockFeelingsService = {
      feelings: feelingsSignal.asReadonly(),
    };

    const mockRetroStateService = {
      participants: participantsSignal.asReadonly(),
    };

    const mockToastService = {
      show: mockToastShow,
    };

    TestBed.configureTestingModule({
      imports: [FeelingsSummaryPopupComponent],
      providers: [
        { provide: FeelingsService, useValue: mockFeelingsService },
        { provide: RetroStateService, useValue: mockRetroStateService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });

    fixture = TestBed.createComponent(FeelingsSummaryPopupComponent);
    component = fixture.componentInstance;
  });

  describe('rendering participant list with feeling emojis', () => {
    it('should render participant names with their feeling emojis when open', () => {
      participantsSignal.set(createParticipants(
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Bob' },
      ));
      feelingsSignal.set({ u1: 'Happy', u2: 'Sad' });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.feelings-summary__item');
      expect(items.length).toBe(2);

      // Alice with Happy emoji (sorted first alphabetically)
      const aliceItem = items[0];
      expect(aliceItem.querySelector('.feelings-summary__name').textContent).toContain('Alice');
      expect(aliceItem.querySelector('.feelings-summary__emoji').textContent).toContain('😊');
      expect(aliceItem.querySelector('.feelings-summary__category').textContent).toContain('Happy');

      // Bob with Sad emoji
      const bobItem = items[1];
      expect(bobItem.querySelector('.feelings-summary__name').textContent).toContain('Bob');
      expect(bobItem.querySelector('.feelings-summary__emoji').textContent).toContain('😢');
      expect(bobItem.querySelector('.feelings-summary__category').textContent).toContain('Sad');
    });

    it('should not render dialog when open is false', () => {
      participantsSignal.set(createParticipants({ id: 'u1', displayName: 'Alice' }));
      fixture.componentRef.setInput('open', false);
      fixture.detectChanges();

      const dialog = fixture.nativeElement.querySelector('.feelings-summary__dialog');
      expect(dialog).toBeNull();
    });
  });

  describe('displaying "No feeling" for null selections', () => {
    it('should display "No feeling" when participant has null feeling', () => {
      participantsSignal.set(createParticipants(
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Bob' },
      ));
      feelingsSignal.set({ u1: 'Happy' }); // u2 has no entry → null
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.feelings-summary__item');
      const bobItem = items[1];
      expect(bobItem.querySelector('.feelings-summary__no-feeling').textContent).toContain('No feeling');
      expect(bobItem.querySelector('.feelings-summary__emoji')).toBeNull();
    });

    it('should display "No feeling" for explicitly null feeling value', () => {
      participantsSignal.set(createParticipants({ id: 'u1', displayName: 'Alice' }));
      feelingsSignal.set({ u1: null });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const item = fixture.nativeElement.querySelector('.feelings-summary__item');
      expect(item.querySelector('.feelings-summary__no-feeling').textContent).toContain('No feeling');
    });
  });

  describe('participants sorted alphabetically case-insensitive', () => {
    it('should sort participants alphabetically ignoring case', () => {
      participantsSignal.set(createParticipants(
        { id: 'u1', displayName: 'charlie' },
        { id: 'u2', displayName: 'Alice' },
        { id: 'u3', displayName: 'bob' },
      ));
      feelingsSignal.set({});
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const names = fixture.nativeElement.querySelectorAll('.feelings-summary__name');
      expect(names[0].textContent).toContain('Alice');
      expect(names[1].textContent).toContain('bob');
      expect(names[2].textContent).toContain('charlie');
    });

    it('should handle participants with same names differing only by case', () => {
      participantsSignal.set(createParticipants(
        { id: 'u1', displayName: 'Zara' },
        { id: 'u2', displayName: 'adam' },
        { id: 'u3', displayName: 'Adam' },
      ));
      feelingsSignal.set({});
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const names = fixture.nativeElement.querySelectorAll('.feelings-summary__name');
      // Both Adam/adam come before Zara
      const nameTexts = Array.from(names).map((n: any) => n.textContent.trim());
      expect(nameTexts[2]).toBe('Zara');
      // adam and Adam are both before Zara (exact order between them depends on locale)
      expect(nameTexts[0].toLowerCase()).toBe('adam');
      expect(nameTexts[1].toLowerCase()).toBe('adam');
    });
  });

  describe('screenshot button triggers capture', () => {
    it('should call html2canvas when screenshot button is clicked', async () => {
      const html2canvasMock = (await import('html2canvas')).default as ReturnType<typeof vi.fn>;
      const mockCanvas = document.createElement('canvas');
      mockCanvas.toBlob = vi.fn((cb) => cb(new Blob(['image-data'], { type: 'image/png' })));
      html2canvasMock.mockResolvedValue(mockCanvas);

      // Mock URL.createObjectURL and revokeObjectURL
      const createObjectURLMock = vi.fn().mockReturnValue('blob:mock-url');
      const revokeObjectURLMock = vi.fn();
      globalThis.URL.createObjectURL = createObjectURLMock;
      globalThis.URL.revokeObjectURL = revokeObjectURLMock;

      participantsSignal.set(createParticipants({ id: 'u1', displayName: 'Alice' }));
      feelingsSignal.set({ u1: 'Happy' });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const screenshotBtn = fixture.nativeElement.querySelector('.feelings-summary__screenshot-btn');
      expect(screenshotBtn).toBeTruthy();

      screenshotBtn.click();
      await fixture.whenStable();

      expect(html2canvasMock).toHaveBeenCalled();
    });
  });

  describe('loading state during capture', () => {
    it('should show spinner and disable button during capture', async () => {
      const html2canvasMock = (await import('html2canvas')).default as ReturnType<typeof vi.fn>;
      let resolveCapture: (value: HTMLCanvasElement) => void;
      const capturePromise = new Promise<HTMLCanvasElement>((resolve) => {
        resolveCapture = resolve;
      });
      html2canvasMock.mockReturnValue(capturePromise);

      participantsSignal.set(createParticipants({ id: 'u1', displayName: 'Alice' }));
      feelingsSignal.set({ u1: 'Happy' });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const screenshotBtn = fixture.nativeElement.querySelector('.feelings-summary__screenshot-btn');
      screenshotBtn.click();
      fixture.detectChanges();

      // During capture: button should be disabled and show spinner
      expect(component.capturing()).toBe(true);
      const disabledBtn = fixture.nativeElement.querySelector('.feelings-summary__screenshot-btn');
      expect(disabledBtn.disabled).toBe(true);
      expect(disabledBtn.querySelector('.feelings-summary__spinner')).toBeTruthy();
      expect(disabledBtn.textContent).toContain('Capturing');

      // Resolve the capture with a canvas that has synchronous toBlob
      const mockCanvas = document.createElement('canvas');
      mockCanvas.toBlob = vi.fn((cb) => cb(new Blob(['data'], { type: 'image/png' })));
      globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:url');
      globalThis.URL.revokeObjectURL = vi.fn();
      resolveCapture!(mockCanvas);

      // Wait for all microtasks (captureScreenshot is async with multiple awaits)
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();

      // After capture: button should be re-enabled
      expect(component.capturing()).toBe(false);
      const enabledBtn = fixture.nativeElement.querySelector('.feelings-summary__screenshot-btn');
      expect(enabledBtn.disabled).toBe(false);
    });
  });

  describe('error handling on screenshot failure', () => {
    it('should show error toast and re-enable button when screenshot fails', async () => {
      const html2canvasMock = (await import('html2canvas')).default as ReturnType<typeof vi.fn>;
      html2canvasMock.mockRejectedValue(new Error('Capture failed'));

      participantsSignal.set(createParticipants({ id: 'u1', displayName: 'Alice' }));
      feelingsSignal.set({ u1: 'Happy' });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const screenshotBtn = fixture.nativeElement.querySelector('.feelings-summary__screenshot-btn');
      screenshotBtn.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(mockToastShow).toHaveBeenCalledWith('error', 'Failed to capture screenshot');
      expect(component.capturing()).toBe(false);
      expect(screenshotBtn.disabled).toBe(false);
    });
  });

  describe('close on backdrop click and close button', () => {
    it('should emit closed when backdrop is clicked', () => {
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const closedSpy = vi.fn();
      component.closed.subscribe(closedSpy);

      const backdrop = fixture.nativeElement.querySelector('.feelings-summary__backdrop');
      backdrop.click();

      expect(closedSpy).toHaveBeenCalled();
    });

    it('should emit closed when close button is clicked', () => {
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const closedSpy = vi.fn();
      component.closed.subscribe(closedSpy);

      const closeBtn = fixture.nativeElement.querySelector('.feelings-summary__close-btn');
      closeBtn.click();

      expect(closedSpy).toHaveBeenCalled();
    });

    it('should not emit closed when dialog content is clicked', () => {
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();

      const closedSpy = vi.fn();
      component.closed.subscribe(closedSpy);

      const dialog = fixture.nativeElement.querySelector('.feelings-summary__dialog');
      dialog.click();

      expect(closedSpy).not.toHaveBeenCalled();
    });
  });
});
