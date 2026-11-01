import { describe, expect, it, vi } from 'vitest';
import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import {
  PANEL_CHUNK_LOADER_DEPS,
  PanelChunkLoader,
  PanelChunkLoaderTimers,
} from '../../services/panel-chunk-loader';
import { CHAT_PANEL_LOAD_RETRY_DELAYS_MS } from '@shared/types';
import { CHAT_LOAD_ERROR_TEXT, ChatLoadErrorNoticeComponent } from './chat-load-error-notice.component';

/** Manual clock: timers fire only through `advance`. */
class ManualTimers implements PanelChunkLoaderTimers {
  time = 0;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.pending.delete(handle)) timer.callback();
    }
  }
}

/** Lets the importer's settled promises run their handlers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function setup() {
  const timers = new ManualTimers();
  const importer = vi.fn((): Promise<Type<unknown>> => Promise.reject(new Error('chunk failed')));
  const dismissed = vi.fn();
  const { fixture } = await render(ChatLoadErrorNoticeComponent, {
    providers: [
      {
        provide: PANEL_CHUNK_LOADER_DEPS,
        useValue: {
          importer,
          baseUrl: 'http://localhost/main.js',
          importUrl: importer,
          timers,
          requestIdle: null,
        },
      },
    ],
    on: { dismissed },
  });
  const loader = TestBed.inject(PanelChunkLoader);

  // Exhaust one Load_Sequence so the loader shows the notice (R20.14).
  loader.requestOpen();
  await flush();
  for (const delay of CHAT_PANEL_LOAD_RETRY_DELAYS_MS) {
    timers.advance(delay);
    await flush();
  }
  expect(loader.errorShown()).toBe(true);
  expect(importer).toHaveBeenCalledTimes(CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length + 1);
  importer.mockClear();
  return { fixture, loader, importer, dismissed };
}

describe('ChatLoadErrorNoticeComponent', () => {
  it('shows the error text in a role="alert" element and two native buttons', async () => {
    await setup();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(CHAT_LOAD_ERROR_TEXT);
    expect(CHAT_LOAD_ERROR_TEXT).toBe('Chat could not be loaded.');
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(tryAgain.tagName).toBe('BUTTON');
    expect(tryAgain.getAttribute('type')).toBe('button');
    expect(dismiss.tagName).toBe('BUTTON');
    expect(dismiss.getAttribute('type')).toBe('button');
  });

  it('"Try again" hides the notice and starts a new Load_Sequence without emitting dismissed', async () => {
    const { loader, importer, dismissed } = await setup();

    screen.getByRole('button', { name: 'Try again' }).click();

    expect(loader.errorShown()).toBe(false);
    expect(loader.busy()).toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(dismissed).not.toHaveBeenCalled();
  });

  it('"Dismiss" hides the notice, starts nothing and emits dismissed', async () => {
    const { loader, importer, dismissed } = await setup();

    screen.getByRole('button', { name: 'Dismiss' }).click();

    expect(loader.errorShown()).toBe(false);
    expect(loader.busy()).toBe(false);
    expect(importer).not.toHaveBeenCalled();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('exposes its host element for the narrow dock-top measurement', async () => {
    const { fixture } = await setup();
    const host: HTMLElement = fixture.nativeElement;

    expect(fixture.componentInstance.element).toBe(host);
    expect(host.contains(screen.getByRole('alert'))).toBe(true);
  });
});
