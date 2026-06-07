import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { ToastService } from '../../services/toast.service';
import { FeelingsService } from '../../services/feelings.service';
import {
  ALL_FEELING_CATEGORIES,
  FEELING_EMOJI_MAP,
  FeelingCategory,
  RetroConfiguration,
} from '@shared/types';

describe('RetroToolbarComponent - Feelings Settings Section', () => {
  let fixture: ComponentFixture<RetroToolbarComponent>;
  let component: RetroToolbarComponent;

  let configSignal: WritableSignal<RetroConfiguration | null>;
  let sendConfigUpdateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSignal = signal<RetroConfiguration | null>({
      allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
      hideCardsInitially: false,
      disableVotingInitially: false,
      hideVoteCount: false,
      oneVotePerCard: false,
      showCardAuthor: false,
      enableGifEmoji: false,
      columnLayout: 'vertical',
    } as RetroConfiguration);

    sendConfigUpdateMock = vi.fn();

    const mockRetroState = {
      config: configSignal.asReadonly(),
      isModerator: signal(true).asReadonly(),
      isCompleted: signal(false).asReadonly(),
      cardsRevealed: signal(false).asReadonly(),
      votingEnabled: signal(false).asReadonly(),
      state: signal(null).asReadonly(),
      currentUserId: signal('user-1').asReadonly(),
    };

    const mockWsService = {
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      sendConfigUpdate: sendConfigUpdateMock,
      sendCardsReveal: vi.fn(),
      sendVotingEnable: vi.fn(),
      sendBoardComplete: vi.fn(),
      sendColumnAdd: vi.fn(),
      connectionState: signal('connected').asReadonly(),
    };

    const mockExportService = {
      exportCSV: vi.fn().mockResolvedValue(undefined),
      importCSV: vi.fn().mockResolvedValue(undefined),
    };

    const mockScreenshotService = {
      captureBoard: vi.fn(),
    };

    const mockToastService = {
      show: vi.fn(),
    };

    const mockFeelingsService = {
      myFeeling: signal<FeelingCategory | null>(null).asReadonly(),
      feelings: signal<Record<string, FeelingCategory | null>>({}).asReadonly(),
      selectFeeling: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [RetroToolbarComponent],
      providers: [
        { provide: RetroStateService, useValue: mockRetroState },
        { provide: RetroWebSocketService, useValue: mockWsService },
        { provide: RetroExportService, useValue: mockExportService },
        { provide: RetroScreenshotService, useValue: mockScreenshotService },
        { provide: ToastService, useValue: mockToastService },
        { provide: FeelingsService, useValue: mockFeelingsService },
      ],
    });

    fixture = TestBed.createComponent(RetroToolbarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('isModerator', true);
    fixture.componentRef.setInput('isCompleted', false);
    fixture.detectChanges();

    // Open the settings dialog
    component.showSettingsDialog.set(true);
    fixture.detectChanges();
  });

  describe('renders all 10 category checkboxes', () => {
    it('should display all 10 feeling category checkboxes in the settings dialog', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      expect(feelingsSection).toBeTruthy();

      const checkboxes = feelingsSection.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBe(10);
    });

    it('should display emoji and category name for each checkbox', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const labels = feelingsSection.querySelectorAll('.retro-settings__toggle');

      ALL_FEELING_CATEGORIES.forEach((category, index) => {
        const labelText = labels[index].textContent.trim();
        expect(labelText).toContain(FEELING_EMOJI_MAP[category]);
        expect(labelText).toContain(category);
      });
    });

    it('should set aria-label on each checkbox with emoji and category name', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll('input[type="checkbox"]');

      ALL_FEELING_CATEGORIES.forEach((category, index) => {
        const ariaLabel = checkboxes[index].getAttribute('aria-label');
        expect(ariaLabel).toBe(`${FEELING_EMOJI_MAP[category]} ${category}`);
      });
    });
  });

  describe('checked state matches current allowedFeelings', () => {
    it('should check boxes for categories in allowedFeelings', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      ALL_FEELING_CATEGORIES.forEach((category, index) => {
        const isAllowed = ['Happy', 'Sad', 'No_Feeling'].includes(category);
        expect(checkboxes[index].checked).toBe(isAllowed);
      });
    });

    it('should update checked state when config changes', () => {
      configSignal.set({
        allowedFeelings: ['Satisfaction', 'Frustration', 'Confidence', 'Confusion', 'Boredom'],
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        enableGifEmoji: false,
        columnLayout: 'vertical',
      } as RetroConfiguration);
      fixture.detectChanges();

      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      const expectedAllowed: FeelingCategory[] = [
        'Satisfaction',
        'Frustration',
        'Confidence',
        'Confusion',
        'Boredom',
      ];

      ALL_FEELING_CATEGORIES.forEach((category, index) => {
        expect(checkboxes[index].checked).toBe(expectedAllowed.includes(category));
      });
    });

    it('should reflect all categories checked when all 10 are allowed', () => {
      configSignal.set({
        allowedFeelings: [...ALL_FEELING_CATEGORIES],
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        enableGifEmoji: false,
        columnLayout: 'vertical',
      } as RetroConfiguration);
      fixture.detectChanges();

      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      for (const checkbox of Array.from(checkboxes)) {
        expect(checkbox.checked).toBe(true);
      }
    });
  });

  describe('toggling sends config update', () => {
    it('should send config update with added category when unchecked box is checked', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      // Find Satisfaction checkbox (index 0), which is unchecked
      const satisfactionIndex = ALL_FEELING_CATEGORIES.indexOf('Satisfaction');
      const checkbox = checkboxes[satisfactionIndex];
      expect(checkbox.checked).toBe(false);

      // Simulate checking it
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(sendConfigUpdateMock).toHaveBeenCalledTimes(1);
      const updatedFeelings = sendConfigUpdateMock.mock.calls[0][0].allowedFeelings;
      expect(updatedFeelings).toContain('Satisfaction');
      expect(updatedFeelings).toContain('Happy');
      expect(updatedFeelings).toContain('Sad');
      expect(updatedFeelings).toContain('No_Feeling');
    });

    it('should send config update with removed category when checked box is unchecked', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      // Find Happy checkbox (should be checked since it's in allowedFeelings)
      const happyIndex = ALL_FEELING_CATEGORIES.indexOf('Happy');
      const checkbox = checkboxes[happyIndex];
      expect(checkbox.checked).toBe(true);

      // Simulate unchecking it
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(sendConfigUpdateMock).toHaveBeenCalledTimes(1);
      const updatedFeelings = sendConfigUpdateMock.mock.calls[0][0].allowedFeelings;
      expect(updatedFeelings).not.toContain('Happy');
      expect(updatedFeelings).toContain('Sad');
      expect(updatedFeelings).toContain('No_Feeling');
    });

    it('should maintain order from ALL_FEELING_CATEGORIES when adding a category', () => {
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      // Add 'Satisfaction' (first in ALL_FEELING_CATEGORIES)
      const satisfactionIndex = ALL_FEELING_CATEGORIES.indexOf('Satisfaction');
      const checkbox = checkboxes[satisfactionIndex];
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      const updatedFeelings: FeelingCategory[] =
        sendConfigUpdateMock.mock.calls[0][0].allowedFeelings;
      // Satisfaction should come before Happy because it's earlier in ALL_FEELING_CATEGORIES
      const satIdx = updatedFeelings.indexOf('Satisfaction');
      const happyIdx = updatedFeelings.indexOf('Happy');
      expect(satIdx).toBeLessThan(happyIdx);
    });
  });

  describe('last checkbox cannot be unchecked (minimum-one enforcement)', () => {
    it('should disable the last remaining checked checkbox', () => {
      // Set only one category in allowedFeelings
      configSignal.set({
        allowedFeelings: ['Happy'],
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        enableGifEmoji: false,
        columnLayout: 'vertical',
      } as RetroConfiguration);
      fixture.detectChanges();

      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      const happyIndex = ALL_FEELING_CATEGORIES.indexOf('Happy');
      expect(checkboxes[happyIndex].disabled).toBe(true);
    });

    it('should not disable checkboxes when more than one category is allowed', () => {
      // Default config has 3 categories: Happy, Sad, No_Feeling
      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      const happyIndex = ALL_FEELING_CATEGORIES.indexOf('Happy');
      const sadIndex = ALL_FEELING_CATEGORIES.indexOf('Sad');
      const noFeelingIndex = ALL_FEELING_CATEGORIES.indexOf('No_Feeling');

      expect(checkboxes[happyIndex].disabled).toBe(false);
      expect(checkboxes[sadIndex].disabled).toBe(false);
      expect(checkboxes[noFeelingIndex].disabled).toBe(false);
    });

    it('should not send config update if trying to uncheck when only one remains (safety guard)', () => {
      configSignal.set({
        allowedFeelings: ['Sad'],
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        enableGifEmoji: false,
        columnLayout: 'vertical',
      } as RetroConfiguration);
      fixture.detectChanges();

      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      const sadIndex = ALL_FEELING_CATEGORIES.indexOf('Sad');
      // Force-try to uncheck the disabled checkbox by dispatching an event
      checkboxes[sadIndex].checked = false;
      checkboxes[sadIndex].dispatchEvent(new Event('change'));
      fixture.detectChanges();

      // The safety guard in onFeelingToggle should prevent sending
      expect(sendConfigUpdateMock).not.toHaveBeenCalled();
    });

    it('should only disable the checkbox that is the sole allowed category', () => {
      configSignal.set({
        allowedFeelings: ['Mad'],
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        enableGifEmoji: false,
        columnLayout: 'vertical',
      } as RetroConfiguration);
      fixture.detectChanges();

      const feelingsSection = fixture.nativeElement.querySelector('.retro-settings__feelings');
      const checkboxes = feelingsSection.querySelectorAll(
        'input[type="checkbox"]'
      ) as NodeListOf<HTMLInputElement>;

      // Only the Mad checkbox should be disabled
      ALL_FEELING_CATEGORIES.forEach((category, index) => {
        if (category === 'Mad') {
          expect(checkboxes[index].disabled).toBe(true);
        } else {
          expect(checkboxes[index].disabled).toBe(false);
        }
      });
    });
  });
});
