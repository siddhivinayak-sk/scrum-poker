import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { MetricsComponent, deriveMetricsDisplay } from './metrics.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { VotingMetrics } from '@shared/types';

describe('MetricsComponent', () => {
  let component: MetricsComponent;
  let isRevealedSignal: WritableSignal<boolean>;
  let metricsSignal: WritableSignal<VotingMetrics | null>;

  beforeEach(() => {
    isRevealedSignal = signal<boolean>(false);
    metricsSignal = signal<VotingMetrics | null>(null);

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: isRevealedSignal.asReadonly(),
      metrics: metricsSignal.asReadonly(),
      history: signal([]).asReadonly(),
      currentUser: signal(null).asReadonly(),
    };

    const mockWsService = {
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      connectionState: signal('disconnected' as const),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        { provide: WebSocketService, useValue: mockWsService },
      ],
    });

    const fixture = TestBed.createComponent(MetricsComponent);
    component = fixture.componentInstance;
  });

  describe('visibility', () => {
    it('should not be visible when cards are not revealed', () => {
      isRevealedSignal.set(false);
      metricsSignal.set(null);
      expect(component.visible()).toBe(false);
    });

    it('should not be visible when metrics is null even if revealed', () => {
      isRevealedSignal.set(true);
      metricsSignal.set(null);
      expect(component.visible()).toBe(false);
    });

    it('should be visible when revealed and metrics exist', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 5,
        mode: 5,
        spread: 4,
        distribution: { '3': 1, '5': 2, '8': 1 },
        outliers: [],
        numericVoteCount: 4,
        insufficientData: false,
      });
      expect(component.visible()).toBe(true);
    });
  });

  describe('metrics display', () => {
    it('should display formatted average, mode, and spread', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 5.25,
        mode: 5,
        spread: 10,
        distribution: { '3': 1, '5': 2, '8': 1 },
        outliers: [],
        numericVoteCount: 4,
        insufficientData: false,
      });

      const display = component.metricsDisplay();
      expect(display).not.toBeNull();
      expect(display!.average).toBe('5.3');
      expect(display!.mode).toBe('5');
      expect(display!.spread).toBe('10');
    });

    it('should show outlier count when outliers exist', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 10,
        mode: 5,
        spread: 50,
        distribution: { '5': 2, '55': 1 },
        outliers: ['u3'],
        numericVoteCount: 3,
        insufficientData: false,
      });

      const display = component.metricsDisplay();
      expect(display!.outlierCount).toBe(1);
    });

    it('should show distribution entries sorted by count descending', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 5,
        mode: 5,
        spread: 5,
        distribution: { '3': 1, '5': 3, '8': 2 },
        outliers: [],
        numericVoteCount: 6,
        insufficientData: false,
      });

      const display = component.metricsDisplay();
      expect(display!.distribution[0].label).toBe('5');
      expect(display!.distribution[0].count).toBe(3);
      expect(display!.distribution[1].label).toBe('8');
      expect(display!.distribution[1].count).toBe(2);
    });
  });

  describe('insufficient data', () => {
    it('should show insufficient data message when fewer than 2 numeric votes', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: null,
        mode: null,
        spread: null,
        distribution: { coffee: 2 },
        outliers: [],
        numericVoteCount: 0,
        insufficientData: true,
      });

      const display = component.metricsDisplay();
      expect(display!.insufficientData).toBe(true);
    });
  });

  describe('bar width calculation', () => {
    it('should return 100% for the highest count', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 5,
        mode: 5,
        spread: 5,
        distribution: { '5': 4, '3': 2 },
        outliers: [],
        numericVoteCount: 6,
        insufficientData: false,
      });

      expect(component.getBarWidth(4)).toBe(100);
    });

    it('should return 50% for half the highest count', () => {
      isRevealedSignal.set(true);
      metricsSignal.set({
        average: 5,
        mode: 5,
        spread: 5,
        distribution: { '5': 4, '3': 2 },
        outliers: [],
        numericVoteCount: 6,
        insufficientData: false,
      });

      expect(component.getBarWidth(2)).toBe(50);
    });
  });
});

describe('deriveMetricsDisplay (pure function)', () => {
  it('should return null for null metrics', () => {
    expect(deriveMetricsDisplay(null)).toBeNull();
  });

  it('should return insufficient data display when insufficientData is true', () => {
    const result = deriveMetricsDisplay({
      average: null,
      mode: null,
      spread: null,
      distribution: {},
      outliers: [],
      numericVoteCount: 1,
      insufficientData: true,
    });

    expect(result).not.toBeNull();
    expect(result!.insufficientData).toBe(true);
    expect(result!.average).toBe('—');
    expect(result!.mode).toBe('—');
    expect(result!.spread).toBe('—');
    expect(result!.distribution).toEqual([]);
  });

  it('should format average to one decimal place', () => {
    const result = deriveMetricsDisplay({
      average: 3.666,
      mode: 3,
      spread: 5,
      distribution: { '3': 2, '5': 1 },
      outliers: [],
      numericVoteCount: 3,
      insufficientData: false,
    });

    expect(result!.average).toBe('3.7');
  });

  it('should handle null average/mode/spread gracefully', () => {
    const result = deriveMetricsDisplay({
      average: null,
      mode: null,
      spread: null,
      distribution: {},
      outliers: [],
      numericVoteCount: 0,
      insufficientData: false,
    });

    expect(result!.average).toBe('—');
    expect(result!.mode).toBe('—');
    expect(result!.spread).toBe('—');
  });
});
