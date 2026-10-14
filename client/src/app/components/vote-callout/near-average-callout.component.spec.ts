import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_REMOVAL_DEADLINE_MS } from './callout-animation';
import type { NearCalloutModel, NearCalloutName } from './callout-visibility';
import { NearAverageCalloutComponent } from './near-average-callout.component';

/**
 * Near_Average_Callout presentation (R2.3, R2.5, R2.6, R2.10, R2.12, R8.3, R8.4, R9.5, R9.7, R4.10).
 *
 * The component is exercised on its own with real inputs; the visibility resolver that builds the
 * model is covered by its own spec, so models here are built by hand in the shape it returns.
 */

const PHRASE_WITH_GLYPH = 'Great minds voted alike \u{1F389}';
const PHRASE_TEXT = 'Great minds voted alike';
const GLYPH = '\u{1F389}';

function name(full: string): NearCalloutName {
  const chars = Array.from(full);
  return { full, shown: chars.length > 18 ? chars.slice(0, 18).join('') + '\u2026' : full };
}

function model(overrides: Partial<NearCalloutModel> = {}): NearCalloutModel {
  return {
    roundId: 'round-1',
    variant: 'nearAverage',
    names: [name('Alex'), name('Blake'), name('Casey')],
    hiddenNameCount: 0,
    replayEntrance: true,
    ...overrides,
  };
}

describe('NearAverageCalloutComponent', () => {
  let fixture: ComponentFixture<NearAverageCalloutComponent>;
  let dismissed: ReturnType<typeof vi.fn<() => void>>;
  let removed: ReturnType<typeof vi.fn<() => void>>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const panel = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout');
  const chips = (): HTMLElement[] => Array.from(el().querySelectorAll<HTMLElement>('.callout__name'));
  const dismissBtn = (): HTMLButtonElement =>
    el().querySelector<HTMLButtonElement>('.callout__dismiss') as HTMLButtonElement;

  function mount(
    m: NearCalloutModel = model(),
    phrase: string = PHRASE_WITH_GLYPH,
    extra: { reducedMotion?: boolean } = {}
  ): void {
    fixture = TestBed.createComponent(NearAverageCalloutComponent);
    fixture.componentRef.setInput('model', m);
    fixture.componentRef.setInput('phrase', phrase);
    if (extra.reducedMotion !== undefined) {
      fixture.componentRef.setInput('reducedMotion', extra.reducedMotion);
    }
    dismissed = vi.fn<() => void>();
    removed = vi.fn<() => void>();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    fixture.componentInstance.removed.subscribe(removed);
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [NearAverageCalloutComponent] });
  });

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  describe('names (R2.3, R8.3, R8.4)', () => {
    it('renders one chip per name, in the order supplied', () => {
      mount(model({ names: [name('Zed'), name('Alex'), name('Morgan'), name('Blake')] }));

      expect(chips().map((c) => c.textContent?.trim())).toEqual(['Zed', 'Alex', 'Morgan', 'Blake']);
    });

    it('renders every supplied name on first paint, none lazily', () => {
      const eight = Array.from({ length: 8 }, (_, i) => name(`Person${String.fromCharCode(65 + i)}`));
      mount(model({ names: eight }));

      expect(chips()).toHaveLength(8);
    });

    it('shows the truncated text but keeps the full name in title and aria-label', () => {
      const long = 'Bartholomew Featherstonehaugh';
      mount(model({ names: [name(long), name('Alex')] }));

      const [first, second] = chips();
      expect(first.textContent?.trim()).toBe('Bartholomew Feathe\u2026');
      expect(first.textContent).not.toContain('Featherstonehaugh');
      expect(first.getAttribute('title')).toBe(long);
      expect(first.getAttribute('aria-label')).toBe(long);
      // A short name is shown unchanged and carries the same attributes.
      expect(second.textContent?.trim()).toBe('Alex');
      expect(second.getAttribute('title')).toBe('Alex');
      expect(second.getAttribute('aria-label')).toBe('Alex');
    });

    it('does not truncate a name of exactly 18 characters', () => {
      const exact = 'A'.repeat(18);
      mount(model({ names: [name(exact)] }));

      expect(chips()[0].textContent?.trim()).toBe(exact);
    });

    it('stamps each chip with its index for the stagger delay', () => {
      mount();

      expect(chips().map((c) => c.style.getPropertyValue('--name-index'))).toEqual(['0', '1', '2']);
    });

    it('renders markup in a display name literally', () => {
      mount(model({ names: [name('<b>Bold</b>')] }));

      expect(chips()[0].textContent?.trim()).toBe('<b>Bold</b>');
      expect(el().querySelector('b')).toBeNull();
    });
  });

  describe('summary (R8.3)', () => {
    it('shows "and N more" when names were hidden', () => {
      mount(model({ hiddenNameCount: 5 }));

      expect(el().querySelector('.callout__summary')?.textContent?.trim()).toBe('and 5 more');
    });

    it('renders no summary element when nothing was hidden', () => {
      mount(model({ hiddenNameCount: 0 }));

      expect(el().querySelector('.callout__summary')).toBeNull();
    });

    it('keeps the count out of the name chips', () => {
      mount(model({ hiddenNameCount: 12 }));

      for (const chip of chips()) expect(chip.textContent).not.toMatch(/\d/);
    });
  });

  describe('no rank, distance or far participants (R2.5, R2.6)', () => {
    it('renders no digit, ordinal or rank marker in any name chip', () => {
      mount(model({ names: [name('Alex'), name('Blake'), name('Casey'), name('Dana')] }));

      for (const chip of chips()) {
        expect(chip.textContent).not.toMatch(/\d/);
        expect(chip.textContent).not.toMatch(/\b(1st|2nd|3rd|first|second|third|rank|#)\b/i);
        expect(chip.getAttribute('title')).not.toMatch(/\d/);
        expect(chip.getAttribute('aria-label')).not.toMatch(/\d/);
      }
    });

    it('carries no distance or index data attribute on the panel or chips', () => {
      mount();

      const nodes = [el(), ...Array.from(el().querySelectorAll('*'))];
      for (const node of nodes) {
        const dataAttrs = node.getAttributeNames().filter((a) => a.startsWith('data-'));
        expect(dataAttrs).toEqual([]);
      }
    });

    it('shows only the names it was given and never a far participant', () => {
      // The far participant exists in the session but the resolver never forwards them.
      mount(model({ names: [name('Alex'), name('Blake')] }));

      const text = el().textContent ?? '';
      expect(text).toContain('Alex');
      expect(text).toContain('Blake');
      expect(text).not.toContain('Farley');
      expect(el().innerHTML).not.toContain('Farley');
    });

    it('lists no names at all for the wide-spread variant', () => {
      mount(model({ variant: 'wideSpread', names: [], hiddenNameCount: 0 }));

      expect(el().querySelector('.callout__names')).toBeNull();
      expect(chips()).toHaveLength(0);
      expect(el().querySelector('.callout__phrase')?.textContent).toContain(PHRASE_TEXT);
    });
  });

  describe('decorative glyph (R4.10)', () => {
    it('renders the glyph in an aria-hidden span, outside the phrase text', () => {
      mount();

      const glyph = el().querySelector('.callout__glyph');
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
      expect(glyph?.textContent).toBe(GLYPH);

      const phrase = el().querySelector('.callout__phrase') as HTMLElement;
      const withoutGlyph = Array.from(phrase.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('');
      expect(withoutGlyph.trim()).toBe(PHRASE_TEXT);
      expect(withoutGlyph).not.toContain(GLYPH);
    });

    it('renders no glyph element for a phrase without a glyph', () => {
      mount(model(), PHRASE_TEXT);

      expect(el().querySelector('.callout__glyph')).toBeNull();
      expect(el().querySelector('.callout__phrase')?.textContent?.trim()).toBe(PHRASE_TEXT);
    });

    it('keeps the glyph out of every accessible name', () => {
      mount();

      const named = [el(), ...Array.from(el().querySelectorAll('[aria-label]'))];
      for (const node of named) {
        expect(node.getAttribute('aria-label') ?? '').not.toContain(GLYPH);
      }
    });
  });

  describe('dismiss control (R2.10, R9.5, R9.7)', () => {
    it('renders a native button with the agreed accessible name and a visible label', () => {
      mount();

      const btn = dismissBtn();
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.getAttribute('aria-label')).toBe('Dismiss the vote agreement callout');
      expect(btn.textContent?.trim()).toBe('Got it');
    });

    it('does not move focus when it appears (R9.1)', () => {
      const before = document.activeElement;
      mount();

      expect(document.activeElement).toBe(before);
      expect(el().contains(document.activeElement)).toBe(false);
    });

    it('emits dismissed exactly once on activation, then plays the exit and is removed', () => {
      mount();

      dismissBtn().click();
      fixture.detectChanges();

      expect(dismissed).toHaveBeenCalledTimes(1);
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);
      expect(removed).not.toHaveBeenCalled();

      // The exit-completion deadline removes the panel even if no animationend arrives.
      vi.advanceTimersByTime(EXIT_REMOVAL_DEADLINE_MS);
      fixture.detectChanges();

      expect(removed).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();
    });

    it('emits dismissed and removed only once for repeated activations', () => {
      mount();

      dismissBtn().click();
      dismissBtn()?.click();
      fixture.detectChanges();
      vi.advanceTimersByTime(EXIT_REMOVAL_DEADLINE_MS * 3);
      fixture.detectChanges();

      expect(dismissed).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledTimes(1);
    });
  });

  describe('Escape handling (R9.7)', () => {
    function pressEscape(target: HTMLElement): { event: KeyboardEvent; reachedParent: boolean } {
      let reachedParent = false;
      const parent = el();
      const spy = (): void => {
        reachedParent = true;
      };
      parent.addEventListener('keydown', spy);
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      parent.removeEventListener('keydown', spy);
      return { event, reachedParent };
    }

    it('dismisses from the panel and stops the event reaching ancestors', () => {
      mount();

      const { reachedParent } = pressEscape(panel() as HTMLElement);
      fixture.detectChanges();

      expect(reachedParent).toBe(false);
      expect(dismissed).toHaveBeenCalledTimes(1);
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);
    });

    it('dismisses when Escape is pressed on the dismiss button', () => {
      mount();

      pressEscape(dismissBtn());

      expect(dismissed).toHaveBeenCalledTimes(1);
    });

    it('ignores keys other than Escape', () => {
      mount();

      (panel() as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      (panel() as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true })
      );

      expect(dismissed).not.toHaveBeenCalled();
      expect(panel()?.classList.contains('callout--exiting')).toBe(false);
    });

    it('emits dismissed once when Escape follows a button activation', () => {
      mount();

      dismissBtn().click();
      pressEscape(panel() as HTMLElement);

      expect(dismissed).toHaveBeenCalledTimes(1);
    });
  });

  describe('no automatic timeout (R2.12)', () => {
    it('is still present, with no dismissal or removal, long after any plausible auto-dismiss', () => {
      mount();

      // Ten minutes of simulated time, in steps so every scheduled timer gets its chance to run.
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(10_000);
        fixture.detectChanges();
      }

      expect(panel()).not.toBeNull();
      expect(panel()?.classList.contains('callout--exiting')).toBe(false);
      expect(chips()).toHaveLength(3);
      expect(dismissed).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
    });

    it('also stays present under reduced motion', () => {
      mount(model(), PHRASE_WITH_GLYPH, { reducedMotion: true });

      vi.advanceTimersByTime(10 * 60 * 1000);
      fixture.detectChanges();

      expect(panel()).not.toBeNull();
      expect(removed).not.toHaveBeenCalled();
    });

    it('stays present when mounted at rest', () => {
      mount(model({ replayEntrance: false }));

      vi.advanceTimersByTime(10 * 60 * 1000);
      fixture.detectChanges();

      expect(panel()).not.toBeNull();
      expect(removed).not.toHaveBeenCalled();
    });
  });

  describe('timer hygiene', () => {
    it('leaves no pending timers after destroy', () => {
      // The component's own timers live in a private set; read it through a narrow typed view.
      const ownTimers = (): number =>
        (fixture.componentInstance as unknown as { timers: Set<unknown> }).timers.size;

      mount();
      expect(ownTimers()).toBe(1); // entrance fallback
      dismissBtn().click();
      expect(ownTimers()).toBe(2); // plus the exit deadline

      fixture.destroy();

      expect(ownTimers()).toBe(0);
      // Nothing the component scheduled fires afterwards.
      vi.advanceTimersByTime(EXIT_REMOVAL_DEADLINE_MS * 3);
      expect(removed).not.toHaveBeenCalled();
    });
  });
});
