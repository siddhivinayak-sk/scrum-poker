import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { ConsensusIndicatorComponent } from './consensus-indicator.component';
import { VotingMetrics } from '@shared/types';

describe('ConsensusIndicatorComponent', () => {
  let fixture: ComponentFixture<ConsensusIndicatorComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ConsensusIndicatorComponent],
    });
    fixture = TestBed.createComponent(ConsensusIndicatorComponent);
  });

  function createMetrics(overrides: Partial<VotingMetrics> = {}): VotingMetrics {
    return {
      average: 5,
      mode: 5,
      spread: 0,
      distribution: { '5': 3 },
      outliers: [],
      numericVoteCount: 3,
      insufficientData: false,
      ...overrides,
    };
  }

  describe('consensus level rendering', () => {
    it('should display Full Agreement when spread is 0 and numericVoteCount >= 2', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 0, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeTruthy();
      expect(el.classList.contains('consensus-indicator--full')).toBe(true);
      expect(el.textContent).toContain('Full Agreement');
      expect(el.textContent).toContain('✓');
    });

    it('should display Partial Agreement when spread is between 1 and 5 for numeric systems', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 3, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeTruthy();
      expect(el.classList.contains('consensus-indicator--partial')).toBe(true);
      expect(el.textContent).toContain('Partial Agreement');
      expect(el.textContent).toContain('~');
    });

    it('should display High Divergence when spread > 5 for numeric systems', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 8, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeTruthy();
      expect(el.classList.contains('consensus-indicator--high-divergence')).toBe(true);
      expect(el.textContent).toContain('High Divergence');
      expect(el.textContent).toContain('⚠');
    });

    it('should not render when metrics is null', () => {
      fixture.componentRef.setInput('metrics', null);
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeNull();
    });

    it('should not render when insufficientData is true', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ insufficientData: true }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeNull();
    });

    it('should not render when numericVoteCount < 2', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ numericVoteCount: 1, spread: 0 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeNull();
    });

    it('should handle t-shirt system with position spread > 2 as high divergence', () => {
      fixture.componentRef.setInput(
        'metrics',
        createMetrics({
          spread: 3,
          numericVoteCount: 3,
          distribution: { XS: 1, XL: 1, XXL: 1 },
        })
      );
      fixture.componentRef.setInput('votingSystem', 't-shirt');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeTruthy();
      expect(el.classList.contains('consensus-indicator--high-divergence')).toBe(true);
    });

    it('should handle t-shirt system with position spread <= 2 as partial', () => {
      fixture.componentRef.setInput(
        'metrics',
        createMetrics({
          spread: 1,
          numericVoteCount: 3,
          distribution: { S: 2, M: 1 },
        })
      );
      fixture.componentRef.setInput('votingSystem', 't-shirt');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el).toBeTruthy();
      expect(el.classList.contains('consensus-indicator--partial')).toBe(true);
    });
  });

  describe('accessibility', () => {
    it('should have role="status" on the indicator element', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 0, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('[role="status"]');
      expect(el).toBeTruthy();
    });

    it('should have an aria-label describing the consensus level', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 0, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('.consensus-indicator');
      expect(el.getAttribute('aria-label')).toBe('Consensus: Full Agreement');
    });

    it('should have aria-hidden on the icon', () => {
      fixture.componentRef.setInput('metrics', createMetrics({ spread: 0, numericVoteCount: 3 }));
      fixture.componentRef.setInput('votingSystem', 'fibonacci');
      fixture.detectChanges();

      const icon = fixture.nativeElement.querySelector('.consensus-indicator__icon');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
