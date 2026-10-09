import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import {
  DEFAULT_SESSION_CONFIG,
  RetroSessionSummary,
  SessionSummary,
  User,
} from '@shared/types';
import { LobbyComponent } from './lobby.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * Example-based tests for the lobby user control.
 *
 * These complement `lobby-user-menu.property.spec.ts`, which exercises
 * `UserMenuComponent` in isolation over generated display names. Here the
 * control is reached through the real `LobbyComponent` host and the real
 * `AuthService`, so the subjects are the lobby-level facts: where the control
 * sits in the header, what the dropdown holds when the role switch is hidden,
 * the open/close and Escape interactions, logout clearing storage before
 * navigating, the two cases in which no control renders, and the lobby
 * actions and both session lists surviving all of it.
 *
 * Requirements: R8.22, R12.1, R12.4, R12.5, R12.6, R12.7, R12.8, R12.9
 */

const TOKEN_KEY = 'scrum-poker-token';
const USER_KEY = 'scrum-poker-user';

const STORED_USER: User = {
  id: 'user-1',
  displayName: 'Dana Facilitator',
  role: 'moderator',
  isAnonymous: false,
};

const POKER_SESSION: SessionSummary = {
  sessionId: 'poker-session-1',
  createdAt: '2026-05-01T10:00:00.000Z',
  lastActivityAt: '2026-05-01T11:00:00.000Z',
  completedRounds: 3,
  participantCount: 5,
  config: DEFAULT_SESSION_CONFIG,
};

const RETRO_SESSION: RetroSessionSummary = {
  sessionId: 'retro-session-1',
  boardName: 'Sprint 42 Retrospective',
  createdAt: '2026-05-01T09:00:00.000Z',
  lastActivityAt: '2026-05-01T12:00:00.000Z',
  participantCount: 4,
  cardCount: 7,
  isCompleted: false,
};

/**
 * An in-memory `Storage`. The test environment exposes a `localStorage`
 * global that lacks the mutating half of the Web Storage interface, so the
 * tests install a working one for the real `AuthService` to read and clear.
 */
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear: (): void => {
      store.clear();
    },
    getItem: (key: string): string | null => store.get(key) ?? null,
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string): void => {
      store.delete(key);
    },
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
  } as Storage;
}

interface Navigation {
  readonly commands: unknown[];
  /** Stored token at the moment navigation was requested. */
  readonly tokenAtNavigation: string | null;
  /** Stored user record at the moment navigation was requested. */
  readonly userAtNavigation: string | null;
}

interface RenderOptions {
  /** Stored token, or `null` to store none. */
  readonly token?: string | null;
  /** Stored user record, or `null` to store none. */
  readonly storedUser?: User | null;
  readonly pokerSessions?: SessionSummary[];
  readonly retroSessions?: RetroSessionSummary[];
  /** Status to answer the retro list request with. Defaults to 200. */
  readonly retroStatus?: number;
}

describe('Lobby user control', () => {
  let fixture: ComponentFixture<LobbyComponent>;
  let httpTesting: HttpTestingController;
  let navigations: Navigation[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', createMemoryStorage());
    navigations = [];
  });

  afterEach(() => {
    fixture?.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Render the lobby with the given stored credentials, using the real
   * `AuthService` so that the stored-token and stored-user-record conditions
   * of R12.1 and R12.6 are decided by production code rather than a stub.
   */
  function renderLobby(options: RenderOptions = {}): HTMLElement {
    const { token = 'lobby-token', storedUser = STORED_USER } = options;

    if (token !== null) localStorage.setItem(TOKEN_KEY, token);
    if (storedUser !== null) localStorage.setItem(USER_KEY, JSON.stringify(storedUser));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LobbyComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: Router,
          useValue: {
            navigate: (commands: unknown[]) => {
              navigations.push({
                commands,
                tokenAtNavigation: localStorage.getItem(TOKEN_KEY),
                userAtNavigation: localStorage.getItem(USER_KEY),
              });
              return Promise.resolve(true);
            },
          },
        },
        // The lobby hosts no poker session, and AuthService.logout() resets
        // session state through the injector.
        {
          provide: SessionStateService,
          useValue: {
            currentUser: signal<User | null>(null).asReadonly(),
            reset: vi.fn(),
          },
        },
        {
          provide: WebSocketService,
          useValue: { send: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
        },
      ],
    });

    httpTesting = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LobbyComponent);
    fixture.detectChanges();

    answerOpenRequests(options);
    fixture.detectChanges();

    return fixture.nativeElement as HTMLElement;
  }

  /**
   * Answer every request the lobby and its two list children opened, plus the
   * background token validation the real `AuthService` performs on init.
   */
  function answerOpenRequests(options: RenderOptions): void {
    const { storedUser = STORED_USER, retroStatus = 200 } = options;

    for (const request of httpTesting.match(() => true)) {
      const url = request.request.url;
      if (url.endsWith('/api/auth/validate')) {
        request.flush({ user: storedUser });
      } else if (url.endsWith('/api/retro/sessions/mine')) {
        if (retroStatus === 200) {
          request.flush({ sessions: options.retroSessions ?? [] });
        } else {
          request.flush(
            { error: 'UNAUTHORIZED' },
            { status: retroStatus, statusText: 'Unauthorized' }
          );
        }
      } else if (url.endsWith('/api/sessions/mine')) {
        request.flush({ sessions: options.pokerSessions ?? [] });
      } else {
        request.flush({});
      }
    }
  }

  function requireElement<T extends HTMLElement>(host: HTMLElement, selector: string): T {
    const element = host.querySelector<T>(selector);
    expect(element, `expected ${selector} in the lobby`).not.toBeNull();
    return element as T;
  }

  function avatarOf(host: HTMLElement): HTMLButtonElement {
    return requireElement<HTMLButtonElement>(host, '.user-menu__avatar');
  }

  /** Open the dropdown by pointer activation of the avatar button. */
  function openMenu(host: HTMLElement): HTMLButtonElement {
    const avatar = avatarOf(host);
    avatar.click();
    fixture.detectChanges();
    vi.advanceTimersByTime(0);
    return avatar;
  }

  describe('placement in the header (R12.1)', () => {
    it('renders the control as the last element of the header row inside the content area', () => {
      const host = renderLobby();

      const content = requireElement(host, '.lobby-content');
      const header = requireElement(host, '.lobby-header');

      // The header belongs to the content area, so the header content area is
      // the content area's inline box.
      expect(content.contains(header)).toBe(true);

      // The control is the last element of the header row.
      expect(header.lastElementChild?.tagName).toBe('APP-USER-MENU');
      expect(header.lastElementChild?.querySelector('.user-menu__avatar')).not.toBeNull();

      // The header precedes the rest of the page.
      const title = requireElement(host, '.lobby-title');
      expect(header.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('declares the header row so the control sits flush against the right edge', () => {
      const host = renderLobby();

      const header = requireElement(host, '.lobby-header');
      const headerStyle = getComputedStyle(header);
      expect(headerStyle.display).toBe('flex');
      expect(headerStyle.justifyContent).toBe('flex-end');
      expect(headerStyle.width).toBe('100%');

      // The dropdown is anchored to the control's right edge, so an open
      // dropdown does not extend past it either.
      openMenu(host);
      const dropdownStyle = getComputedStyle(requireElement(host, '.user-menu__dropdown'));
      expect(dropdownStyle.position).toBe('absolute');
      expect(dropdownStyle.right).toBe('0px');
    });
  });

  describe('dropdown content (R12.4)', () => {
    it('presents the display name and role with logout as the only action and no role switch', () => {
      const host = renderLobby();
      openMenu(host);

      const dropdown = requireElement(host, '.user-menu__dropdown');
      expect(requireElement(dropdown, '.user-menu__name').textContent?.trim()).toBe(
        STORED_USER.displayName
      );
      expect(requireElement(dropdown, '.user-menu__role').textContent?.trim()).toBe(
        STORED_USER.role
      );

      const items = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));
      expect(items.length).toBe(1);
      expect(items[0].getAttribute('aria-label')).toBe('Logout');
      expect(items[0].classList.contains('user-menu__item--logout')).toBe(true);
      expect(dropdown.textContent).not.toContain('Switch to');
      expect(dropdown.querySelector('[aria-label^="Switch to"]')).toBeNull();
    });

    it('keeps the display name inside the dropdown box by appending an ellipsis', () => {
      const host = renderLobby({
        storedUser: { ...STORED_USER, displayName: 'D'.repeat(300) },
      });
      openMenu(host);

      const nameStyle = getComputedStyle(requireElement(host, '.user-menu__name'));
      expect(nameStyle.overflow).toBe('hidden');
      expect(nameStyle.textOverflow).toBe('ellipsis');
      expect(nameStyle.whiteSpace).toBe('nowrap');

      const dropdownStyle = getComputedStyle(requireElement(host, '.user-menu__dropdown'));
      expect(dropdownStyle.overflow).toBe('hidden');
      expect(dropdownStyle.maxWidth).toBe('280px');
    });
  });

  describe('open and close (R12.7, R12.8, R12.9)', () => {
    it('opens on avatar activation and moves focus to the logout action', () => {
      const host = renderLobby();
      const avatar = avatarOf(host);

      expect(avatar.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[role="menu"]')).toBeNull();

      openMenu(host);

      expect(avatar.getAttribute('aria-expanded')).toBe('true');
      const logout = requireElement<HTMLButtonElement>(host, '[role="menuitem"]');
      expect(document.activeElement).toBe(logout);
    });

    it('closes on a second avatar activation, leaving the stored credentials unchanged', () => {
      const host = renderLobby();
      const avatar = openMenu(host);

      avatar.click();
      fixture.detectChanges();

      expect(avatar.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(localStorage.getItem(TOKEN_KEY)).toBe('lobby-token');
      expect(localStorage.getItem(USER_KEY)).not.toBeNull();
      expect(navigations).toEqual([]);
    });

    it('closes on an outside pointer activation, leaving the stored credentials unchanged', () => {
      const host = renderLobby();
      const avatar = openMenu(host);

      requireElement(host, '.lobby-title').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      fixture.detectChanges();

      expect(avatar.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(localStorage.getItem(TOKEN_KEY)).toBe('lobby-token');
      expect(localStorage.getItem(USER_KEY)).not.toBeNull();
      expect(navigations).toEqual([]);
    });

    it('closes on Escape and returns focus to the avatar button', () => {
      const host = renderLobby();
      const avatar = openMenu(host);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();

      expect(avatar.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(avatar);
      expect(localStorage.getItem(TOKEN_KEY)).toBe('lobby-token');
    });
  });

  describe('logout (R12.5)', () => {
    it('clears the stored token and user record before navigating to the login page', () => {
      const host = renderLobby();
      openMenu(host);

      requireElement<HTMLButtonElement>(host, '[role="menuitem"]').click();
      fixture.detectChanges();

      expect(navigations.length).toBe(1);
      const [navigation] = navigations;
      expect(navigation.commands).toEqual(['/login']);

      // Storage was already empty when navigation was requested, so a
      // subsequent load of the lobby route resolves to the login page.
      expect(navigation.tokenAtNavigation).toBeNull();
      expect(navigation.userAtNavigation).toBeNull();
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(USER_KEY)).toBeNull();
    });
  });

  describe('missing credentials (R12.6)', () => {
    it('renders no user control and keeps the rest of the lobby when the token is missing', () => {
      const host = renderLobby({ token: null, retroSessions: [RETRO_SESSION] });

      expect(host.querySelector('app-user-menu')).toBeNull();
      expect(host.querySelector('.user-menu__avatar')).toBeNull();

      // The header row itself stays, holding nothing but its spacer.
      expect(host.querySelector('.lobby-header')).not.toBeNull();
      expectLobbyIntact(host);

      // The list children are still mounted and still render their data.
      expect(host.querySelector('app-session-resume-list')).not.toBeNull();
      expect(host.querySelector('app-retro-resume-list')).not.toBeNull();
      expect(host.querySelector('.retro-resume-list__item')).not.toBeNull();
    });

    it('renders no user control and keeps the rest of the lobby when the user record is missing', () => {
      const host = renderLobby({
        storedUser: null,
        pokerSessions: [POKER_SESSION],
        retroSessions: [RETRO_SESSION],
      });

      expect(localStorage.getItem(TOKEN_KEY)).toBe('lobby-token');
      expect(host.querySelector('app-user-menu')).toBeNull();
      expect(host.querySelector('.user-menu__avatar')).toBeNull();

      expectLobbyIntact(host);
      expect(host.querySelectorAll('.session-resume-list__item').length).toBe(1);
      expect(host.querySelectorAll('.retro-resume-list__item').length).toBe(1);
    });
  });

  describe('preserved lobby actions and session lists (R8.22)', () => {
    it('keeps the three actions with their accessible names and behaviour while the control is present', () => {
      const host = renderLobby();
      expect(host.querySelector('app-user-menu')).not.toBeNull();

      expectLobbyIntact(host);

      requireElement<HTMLButtonElement>(host, '[aria-label="Start a new game"]').click();
      requireElement<HTMLButtonElement>(host, '[aria-label="Create a retrospective board"]').click();

      const input = requireElement<HTMLInputElement>(host, '[aria-label="Session ID or URL"]');
      input.value = 'poker-session-1';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      requireElement<HTMLButtonElement>(host, '[aria-label="Join session"]').click();
      httpTesting.expectOne('/api/sessions/poker-session-1/exists').flush({ exists: true });
      fixture.detectChanges();

      expect(navigations.map((navigation) => navigation.commands)).toEqual([
        ['/create-session'],
        ['/retro/create'],
        ['/session', 'poker-session-1'],
      ]);
    });

    it('keeps both session lists with distinct headings and accessible names while the control is present', () => {
      const host = renderLobby({
        pokerSessions: [POKER_SESSION],
        retroSessions: [RETRO_SESSION],
      });

      expect(host.querySelector('app-user-menu')).not.toBeNull();

      const pokerList = requireElement(host, '.session-resume-list');
      expect(pokerList.getAttribute('aria-label')).toBe('Your previous sessions');
      expect(requireElement(pokerList, '.session-resume-list__title').textContent?.trim()).toBe(
        'Your Previous Sessions'
      );
      expect(pokerList.querySelectorAll('.session-resume-list__item').length).toBe(1);
      expect(
        requireElement(pokerList, '.session-resume-list__btn').getAttribute('aria-label')
      ).toBe(`Resume session ${POKER_SESSION.sessionId}`);

      const retroList = requireElement(host, '.retro-resume-list');
      expect(retroList.getAttribute('aria-labelledby')).toBe('retro-resume-list-heading');
      expect(requireElement(retroList, '#retro-resume-list-heading').textContent?.trim()).toBe(
        'Your Retrospective Boards'
      );
      expect(retroList.querySelectorAll('.retro-resume-list__item').length).toBe(1);

      // Entry activation still navigates, from both lists.
      requireElement<HTMLButtonElement>(pokerList, '.session-resume-list__btn').click();
      requireElement<HTMLButtonElement>(retroList, '.retro-resume-list__btn').click();
      expect(navigations.map((navigation) => navigation.commands)).toEqual([
        ['/session', POKER_SESSION.sessionId],
        ['/retro', RETRO_SESSION.sessionId],
      ]);
    });

    it('keeps the actions enabled while the retro list reports a load failure', () => {
      const host = renderLobby({ retroStatus: 500, pokerSessions: [POKER_SESSION] });

      expect(requireElement(host, '.retro-resume-list__error').getAttribute('role')).toBe('alert');
      expect(host.querySelector('app-user-menu')).not.toBeNull();
      expectLobbyIntact(host);
      expect(host.querySelectorAll('.session-resume-list__item').length).toBe(1);
    });
  });

  /** The lobby actions that must survive every user-control state (R8.22). */
  function expectLobbyIntact(host: HTMLElement): void {
    expect(requireElement(host, '.lobby-title').textContent?.trim()).toBe(
      'Agile Application Catalog'
    );

    const startNewGame = requireElement<HTMLButtonElement>(
      host,
      '[aria-label="Start a new game"]'
    );
    expect(startNewGame.textContent?.trim()).toBe('Start New Game');
    expect(startNewGame.disabled).toBe(false);

    const createRetro = requireElement<HTMLButtonElement>(
      host,
      '[aria-label="Create a retrospective board"]'
    );
    expect(createRetro.textContent?.trim()).toBe('Create Retrospective Board');
    expect(createRetro.disabled).toBe(false);

    const join = requireElement<HTMLButtonElement>(host, '[aria-label="Join session"]');
    expect(join.textContent?.trim()).toBe('Join');
    expect(join.disabled).toBe(false);

    const input = requireElement<HTMLInputElement>(host, '[aria-label="Session ID or URL"]');
    expect(input.placeholder).toBe('Session ID or URL');
    expect(input.disabled).toBe(false);
  }
});
