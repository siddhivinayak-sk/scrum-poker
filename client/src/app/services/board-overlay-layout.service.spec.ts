import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DestroyRef, EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BoardOverlayLayoutService } from './board-overlay-layout.service';

type ResizeObserverGlobal = { ResizeObserver?: typeof ResizeObserver };

/** Records observers so a test can deliver a size change without a layout engine. */
class StubResizeObserver {
  static readonly instances: StubResizeObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function elementWithRect(rect: Partial<DOMRect>): Element {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ ...new DOMRect(), ...rect }) as DOMRect;
  return el;
}

/** A child injector whose `DestroyRef` the test can fire with `destroy()`. */
function scope(): EnvironmentInjector {
  return createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
}

describe('BoardOverlayLayoutService', () => {
  const target = globalThis as ResizeObserverGlobal;
  const originalObserver = target.ResizeObserver;
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    setViewport(1280, 800);
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    StubResizeObserver.instances.length = 0;
    if (originalObserver) target.ResizeObserver = originalObserver;
    else delete target.ResizeObserver;
    setViewport(originalWidth, originalHeight);
  });

  it('keeps the defaults and throws nothing when ResizeObserver is undefined', () => {
    delete target.ResizeObserver;
    const service = TestBed.inject(BoardOverlayLayoutService);
    const injector = scope();
    const destroyRef = injector.get(DestroyRef);

    expect(() => {
      service.trackHeader(elementWithRect({ bottom: 120 }), destroyRef);
      service.trackCalloutLayer(elementWithRect({ height: 200 }), destroyRef);
      injector.destroy();
    }).not.toThrow();

    expect(service.headerBottomPx()).toBe(0);
    expect(service.calloutLayerHeightPx()).toBe(0);
    expect(service.chatDockTopPx()).toBeNull();
    expect(service.baseOffsetPx()).toBe(16);
    expect(service.balloonBottomPx()).toBe(16);
    expect(service.balloonMaxHeightPx()).toBe(400);
    expect(service.balloonHidden()).toBe(false);
  });

  it('updates the viewport on every resize event without a debounce', () => {
    const service = TestBed.inject(BoardOverlayLayoutService);
    expect(service.viewport()).toEqual({ width: 1280, height: 800 });

    setViewport(500, 300);
    window.dispatchEvent(new Event('resize'));
    expect(service.viewport()).toEqual({ width: 500, height: 300 });

    setViewport(520, 310);
    window.dispatchEvent(new Event('resize'));
    expect(service.viewport()).toEqual({ width: 520, height: 310 });
  });

  it('moves the base offset above the chat dock only on a narrow viewport', () => {
    const service = TestBed.inject(BoardOverlayLayoutService);

    service.setChatDockTop(700);
    expect(service.baseOffsetPx()).toBe(16);

    setViewport(400, 800);
    window.dispatchEvent(new Event('resize'));
    expect(service.baseOffsetPx()).toBe(800 - 700 + 8);
    expect(service.balloonBottomPx()).toBe(108);

    service.setChatDockTop(null);
    expect(service.baseOffsetPx()).toBe(16);
  });

  it('measures tracked elements and resets them when the tracking scope is destroyed', () => {
    target.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    const service = TestBed.inject(BoardOverlayLayoutService);
    const injector = scope();
    const destroyRef = injector.get(DestroyRef);

    service.trackHeader(elementWithRect({ bottom: 120 }), destroyRef);
    service.trackCalloutLayer(elementWithRect({ height: 200 }), destroyRef);
    StubResizeObserver.instances.forEach(observer => observer.fire());

    expect(service.headerBottomPx()).toBe(120);
    expect(service.calloutLayerHeightPx()).toBe(200);
    expect(service.balloonBottomPx()).toBe(16 + 200 + 8);
    expect(service.balloonMaxHeightPx()).toBe(Math.min(400, 800 - 224 - 128));

    injector.destroy();
    expect(StubResizeObserver.instances.every(observer => observer.disconnected)).toBe(true);
    expect(service.headerBottomPx()).toBe(0);
    expect(service.calloutLayerHeightPx()).toBe(0);
  });
});
