import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal, computed } from '@angular/core';
import { FeelingsStripComponent } from './feelings-strip.component';
import { RetroStateService } from '../../services/retro-state.service';
import { FeelingsService } from '../../services/feelings.service';
import { FeelingCategory, FEELING_EMOJI_MAP, RetroConfiguration } from '@shared/types';

describe('FeelingsStripComponent', () => {
  let fixture: ComponentFixture<FeelingsStripComponent>;
  let component: FeelingsStripComponent;

  let configSignal: WritableSignal<RetroConfiguration | null>;
  let isModeratorSignal: WritableSignal<boolean>;
  let isCompletedSignal: WritableSignal<boolean>;
  let myFeelingSignal: WritableSignal<FeelingCategory | null>;
  let selectFeelingMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSignal = signal<RetroConfiguration | null>({
      allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
    } as RetroConfiguration);
    isModeratorSignal = signal(false);
    isCompletedSignal = signal(false);
    myFeelingSignal = signal<FeelingCategory | null>(null);
    selectFeelingMock = vi.fn();

    const mockRetroState = {
      config: configSignal.asReadonly(),
      isModerator: isModeratorSignal.asReadonly(),
      isCompleted: isCompletedSignal.asReadonly(),
    };

    const mockFeelingsService = {
      myFeeling: myFeelingSignal.asReadonly(),
      selectFeeling: selectFeelingMock,
    };

    TestBed.configureTestingModule({
      imports: [FeelingsStripComponent],
      providers: [
        { provide: RetroStateService, useValue: mockRetroState },
        { provide: FeelingsService, useValue: mockFeelingsService },
      ],
    });

    fixture = TestBed.createComponent(FeelingsStripComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('rendering', () => {
    it('should render "Your feeling" label and golden border container', () => {
      const container = fixture.nativeElement.querySelector('.feelings-strip');
      expect(container).toBeTruthy();

      const label = fixture.nativeElement.querySelector('.feelings-strip__label');
      expect(label).toBeTruthy();
      expect(label.textContent.trim()).toBe('Your feeling');
    });

    it('should display correct emojis for allowedFeelings', () => {
      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons.length).toBe(3);

      expect(buttons[0].textContent.trim()).toBe(FEELING_EMOJI_MAP['Happy']);
      expect(buttons[1].textContent.trim()).toBe(FEELING_EMOJI_MAP['Sad']);
      expect(buttons[2].textContent.trim()).toBe(FEELING_EMOJI_MAP['No_Feeling']);
    });

    it('should update emojis when allowedFeelings changes', () => {
      configSignal.set({
        allowedFeelings: ['Frustration', 'Confidence', 'Boredom', 'Glad', 'Mad'],
      } as RetroConfiguration);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons.length).toBe(5);

      expect(buttons[0].textContent.trim()).toBe(FEELING_EMOJI_MAP['Frustration']);
      expect(buttons[1].textContent.trim()).toBe(FEELING_EMOJI_MAP['Confidence']);
      expect(buttons[2].textContent.trim()).toBe(FEELING_EMOJI_MAP['Boredom']);
      expect(buttons[3].textContent.trim()).toBe(FEELING_EMOJI_MAP['Glad']);
      expect(buttons[4].textContent.trim()).toBe(FEELING_EMOJI_MAP['Mad']);
    });
  });

  describe('selection highlighting', () => {
    it('should highlight selected emoji with --selected class', () => {
      myFeelingSignal.set('Happy');
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons[0].classList.contains('feelings-strip__emoji-btn--selected')).toBe(true);
      expect(buttons[1].classList.contains('feelings-strip__emoji-btn--selected')).toBe(false);
      expect(buttons[2].classList.contains('feelings-strip__emoji-btn--selected')).toBe(false);
    });

    it('should not highlight any emoji when no feeling selected', () => {
      myFeelingSignal.set(null);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      for (const btn of Array.from(buttons) as HTMLElement[]) {
        expect(btn.classList.contains('feelings-strip__emoji-btn--selected')).toBe(false);
      }
    });

    it('should move highlight when feeling changes', () => {
      myFeelingSignal.set('Happy');
      fixture.detectChanges();

      let buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons[0].classList.contains('feelings-strip__emoji-btn--selected')).toBe(true);

      myFeelingSignal.set('Sad');
      fixture.detectChanges();

      buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons[0].classList.contains('feelings-strip__emoji-btn--selected')).toBe(false);
      expect(buttons[1].classList.contains('feelings-strip__emoji-btn--selected')).toBe(true);
    });
  });

  describe('disabled state', () => {
    it('should disable emoji buttons when board is completed', () => {
      isCompletedSignal.set(true);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      for (const btn of Array.from(buttons) as HTMLButtonElement[]) {
        expect(btn.disabled).toBe(true);
      }
    });

    it('should enable emoji buttons when board is not completed', () => {
      isCompletedSignal.set(false);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      for (const btn of Array.from(buttons) as HTMLButtonElement[]) {
        expect(btn.disabled).toBe(false);
      }
    });
  });

  describe('summary icon visibility', () => {
    it('should show summary icon when user is moderator', () => {
      isModeratorSignal.set(true);
      fixture.detectChanges();

      const summaryBtn = fixture.nativeElement.querySelector('.feelings-strip__summary-btn');
      expect(summaryBtn).toBeTruthy();
      expect(summaryBtn.textContent.trim()).toBe('📊');
    });

    it('should not show summary icon when user is not moderator', () => {
      isModeratorSignal.set(false);
      fixture.detectChanges();

      const summaryBtn = fixture.nativeElement.querySelector('.feelings-strip__summary-btn');
      expect(summaryBtn).toBeNull();
    });
  });

  describe('click interactions', () => {
    it('should call selectFeeling with correct category on click', () => {
      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');

      buttons[0].click();
      expect(selectFeelingMock).toHaveBeenCalledWith('Happy');

      buttons[1].click();
      expect(selectFeelingMock).toHaveBeenCalledWith('Sad');

      buttons[2].click();
      expect(selectFeelingMock).toHaveBeenCalledWith('No_Feeling');
    });

    it('should call selectFeeling with null when clicking already selected feeling (toggle)', () => {
      myFeelingSignal.set('Happy');
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      buttons[0].click();

      expect(selectFeelingMock).toHaveBeenCalledWith(null);
    });

    it('should call selectFeeling with new category when clicking different emoji', () => {
      myFeelingSignal.set('Happy');
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      buttons[1].click();

      expect(selectFeelingMock).toHaveBeenCalledWith('Sad');
    });
  });

  describe('tooltip', () => {
    it('should display category name as title attribute on each emoji button', () => {
      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');

      expect(buttons[0].getAttribute('title')).toBe('Happy');
      expect(buttons[1].getAttribute('title')).toBe('Sad');
      expect(buttons[2].getAttribute('title')).toBe('No Feeling');
    });

    it('should update tooltips when allowedFeelings changes', () => {
      configSignal.set({
        allowedFeelings: ['Confidence', 'Frustration'],
      } as RetroConfiguration);
      fixture.detectChanges();

      const buttons = fixture.nativeElement.querySelectorAll('.feelings-strip__emoji-btn');
      expect(buttons[0].getAttribute('title')).toBe('Confidence');
      expect(buttons[1].getAttribute('title')).toBe('Frustration');
    });
  });
});
