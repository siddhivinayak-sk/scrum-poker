import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MergePopupComponent } from './merge-popup.component';

describe('MergePopupComponent', () => {
  let fixture: ComponentFixture<MergePopupComponent>;
  let component: MergePopupComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MergePopupComponent],
    });
  });

  function createComponent(
    sourceText = 'Source card content',
    targetText = 'Target card content'
  ): ComponentFixture<MergePopupComponent> {
    const fix = TestBed.createComponent(MergePopupComponent);
    fix.componentRef.setInput('sourceCardText', sourceText);
    fix.componentRef.setInput('targetCardText', targetText);
    fix.detectChanges();
    return fix;
  }

  describe('rendering', () => {
    it('should render with source and target card text', () => {
      fixture = createComponent('My source text', 'My target text');
      component = fixture.componentInstance;

      const textElements = fixture.nativeElement.querySelectorAll('.merge-popup__text');
      const texts = Array.from(textElements).map((el: any) => el.textContent.trim());

      expect(texts).toContain('My target text');
      expect(texts).toContain('My source text');
    });

    it('should display the target card text before the source card text', () => {
      fixture = createComponent('Source here', 'Target here');

      const previews = fixture.nativeElement.querySelectorAll('.merge-popup__card-preview');
      expect(previews.length).toBe(2);

      const firstLabel = previews[0].querySelector('.merge-popup__label').textContent.trim();
      const secondLabel = previews[1].querySelector('.merge-popup__label').textContent.trim();

      expect(firstLabel).toBe('Target:');
      expect(secondLabel).toBe('Source:');
    });
  });

  describe('ARIA attributes', () => {
    it('should have role="alertdialog" on the dialog element', () => {
      fixture = createComponent();

      const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]');
      expect(dialog).toBeTruthy();
    });

    it('should have aria-label="Confirm card merge" on the dialog element', () => {
      fixture = createComponent();

      const dialog = fixture.nativeElement.querySelector('.merge-popup__dialog');
      expect(dialog.getAttribute('aria-label')).toBe('Confirm card merge');
    });
  });

  describe('button interactions', () => {
    it('should emit confirmed event when "Merge" button is clicked', () => {
      fixture = createComponent();
      component = fixture.componentInstance;

      const confirmedSpy = vi.fn();
      component.confirmed.subscribe(confirmedSpy);

      const mergeBtn = fixture.nativeElement.querySelector('.merge-popup__btn--merge');
      mergeBtn.click();

      expect(confirmedSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit cancelled event when "Cancel" button is clicked', () => {
      fixture = createComponent();
      component = fixture.componentInstance;

      const cancelledSpy = vi.fn();
      component.cancelled.subscribe(cancelledSpy);

      const cancelBtn = fixture.nativeElement.querySelector('.merge-popup__btn--cancel');
      cancelBtn.click();

      expect(cancelledSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('keyboard interactions', () => {
    it('should emit cancelled event when Escape key is pressed', () => {
      fixture = createComponent();
      component = fixture.componentInstance;

      const cancelledSpy = vi.fn();
      component.cancelled.subscribe(cancelledSpy);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(cancelledSpy).toHaveBeenCalledTimes(1);
    });
  });
});
