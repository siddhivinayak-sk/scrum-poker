import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalloutNoteAddedPayload, CalloutNoteRejectedPayload } from '@shared/types';
import { VoteCalloutLayerComponent } from './vote-callout-layer.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * The Vote_Callout_Layer on a browser that has no Visual Viewport API (R8.6, R8.7).
 *
 * `window.visualViewport` is `undefined` there (and in the test DOM), not `null`. The layer must
 * read the viewport, mount and unmount without throwing, and report no keyboard inset.
 */
describe('VoteCalloutLayerComponent without window.visualViewport', () => {
  let originalVisualViewport: PropertyDescriptor | undefined;

  const windows = (): Window[] => {
    const view = document.defaultView;
    return view !== null && view !== window ? [window, view] : [window];
  };

  const setVisualViewport = (value: undefined | null): void => {
    for (const win of windows()) {
      Object.defineProperty(win, 'visualViewport', { configurable: true, writable: true, value });
    }
  };

  beforeEach(() => {
    sessionStorage.clear();
    originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

    TestBed.configureTestingModule({
      imports: [VoteCalloutLayerComponent],
      providers: [
        {
          provide: SessionStateService,
          useValue: {
            stateSessionId: signal<string | null>('session-1'),
            sessionConfig: signal(null),
            currentRound: signal(null),
            participants: signal([]),
            metrics: signal(null),
            selections: signal(new Map()),
            isRevealed: signal(false),
            countdownActive: signal(false),
            currentUser: signal(null),
            hasRevealPermission: signal(false),
            calloutNoteAdded$: new Subject<CalloutNoteAddedPayload>().asObservable(),
            calloutNoteRejected$: new Subject<CalloutNoteRejectedPayload>().asObservable(),
          },
        },
        {
          provide: WebSocketService,
          useValue: {
            send: vi.fn(),
            on: <T>(): Observable<T> => new Subject<T>().asObservable(),
            connectionState: signal('connected'),
          },
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    for (const win of windows()) {
      if (originalVisualViewport) Object.defineProperty(win, 'visualViewport', originalVisualViewport);
      else Reflect.deleteProperty(win, 'visualViewport');
    }
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ] as const)('mounts and unmounts cleanly when visualViewport is %s', (_label, value) => {
    setVisualViewport(value);
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const fixture = TestBed.createComponent(VoteCalloutLayerComponent);
    fixture.componentRef.setInput('sessionId', 'session-1');
    expect(() => fixture.detectChanges()).not.toThrow();

    const layer = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.vote-callout-layer'
    );
    expect(layer).not.toBeNull();
    // No keyboard is inferred without a Visual Viewport: no lifted bottom edge, no reduced height.
    expect(layer?.style.bottom).toBe('');
    expect(layer?.style.maxHeight).toBe('');

    expect(() => fixture.destroy()).not.toThrow();
    expect(removeSpy.mock.calls.some(([type]) => type === 'resize')).toBe(true);
  });
});
