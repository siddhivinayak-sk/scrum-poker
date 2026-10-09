import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { EMPTY } from 'rxjs';
import fc from 'fast-check';
import { User } from '@shared/types';
import { UserMenuComponent } from '../user-menu/user-menu.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';

/**
 * Property 25: Lobby user control structure and avatar initial
 *
 * For any authenticated display name holding at least one non-whitespace
 * character, the lobby user control exposes the avatar accessible name
 * `User menu for <display name>`, `aria-haspopup="true"`, an `aria-expanded`
 * value tracking the open state, a dropdown with role `menu` named
 * `User menu`, a single action item named `Logout`, no role-switch item, and
 * an avatar initial equal to the uppercase form of the first non-whitespace
 * character; for any whitespace-only display name the avatar renders no
 * initial text while the dropdown and the logout action stay reachable.
 *
 * Unit exercised: `UserMenuComponent` with the lobby's input combination
 * (`user` supplied by the host, `showRoleSwitch` false). The lobby supplies
 * the user from stored credentials rather than from poker session state, so
 * `SessionStateService.currentUser` is held at `null` throughout.
 *
 * **Validates: Requirements 12.2, 12.3, 12.10**
 */

// --- Arbitraries ---

/** Whitespace characters that JavaScript's `\s` class matches. */
const WHITESPACE_CHARS = [' ', '\t', '\n', '\u00a0', '\u3000'];

/** Emoji, including a skin-tone modifier and a ZWJ sequence. */
const EMOJI = ['\u{1f600}', '\u{1f389}', '\u{1f984}', '\u{1f44d}\u{1f3fd}', '\u{1f9d1}\u200d\u{1f680}'];

/** Base letters carrying combining marks, plus a bare combining mark. */
const COMBINING = ['e\u0301', 'A\u030a', 'n\u0303', 'o\u0308', '\u0301'];

/** Non-ASCII letters, including ones whose uppercase form is multi-character. */
const UNICODE_LETTERS = ['\u00e9', '\u00fc', '\u00f1', '\u03c9', '\u00df', '\ufb01', '\u65e5', '\u8a9e', '\u0434', '\u05e9', '\u0627'];

/** A single whitespace character. */
const arbWhitespaceChar = fc.constantFrom(...WHITESPACE_CHARS);

/** One building block of a display name. */
const arbNameFragment = fc.oneof(
  { weight: 5, arbitrary: fc.string({ minLength: 1, maxLength: 6 }) },
  { weight: 3, arbitrary: fc.constantFrom(...UNICODE_LETTERS) },
  { weight: 3, arbitrary: fc.constantFrom(...EMOJI) },
  { weight: 3, arbitrary: fc.constantFrom(...COMBINING) },
  { weight: 2, arbitrary: arbWhitespaceChar },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 4 }) }
);

/** Run of leading or trailing whitespace padding. */
const arbWhitespaceRun = fc
  .array(arbWhitespaceChar, { minLength: 0, maxLength: 5, size: 'max' })
  .map((chars) => chars.join(''));

/**
 * Display names of 1 through 200 characters mixing ASCII, unicode letters,
 * emoji, combining marks and interior whitespace, padded with leading and
 * trailing whitespace, and holding at least one non-whitespace character.
 */
const arbDisplayName = fc
  .tuple(
    arbWhitespaceRun,
    fc.array(arbNameFragment, { minLength: 1, maxLength: 20, size: 'max' }).map((parts) => parts.join('')),
    arbWhitespaceRun
  )
  .map(([lead, body, trail]) => `${lead}${body}${trail}`)
  .filter((name) => name.length >= 1 && name.length <= 200 && /\S/u.test(name));

/** Display names of 1 through 200 characters holding only whitespace. */
const arbWhitespaceOnlyName = fc
  .array(arbWhitespaceChar, { minLength: 1, maxLength: 200, size: 'max' })
  .map((chars) => chars.join(''));

const arbRole: fc.Arbitrary<User['role']> = fc.constantFrom('participant', 'moderator');

// --- Oracle ---

/**
 * Independent restatement of the expected avatar initial: strip leading
 * whitespace, then uppercase the first remaining code point.
 */
function expectedInitial(displayName: string): string {
  const withoutLeadingWhitespace = displayName.replace(/^\s+/u, '');
  if (withoutLeadingWhitespace === '') return '';
  return [...withoutLeadingWhitespace][0].toUpperCase();
}

describe('Property 25: Lobby user control structure and avatar initial', () => {
  let mockAuthService: { logout: ReturnType<typeof vi.fn>; getToken: ReturnType<typeof vi.fn> };
  let mockRouter: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();

    const mockSessionState = {
      currentRound: signal(null).asReadonly(),
      participants: signal([]).asReadonly(),
      selections: signal(new Map()).asReadonly(),
      isRevealed: signal(false).asReadonly(),
      metrics: signal(null).asReadonly(),
      history: signal([]).asReadonly(),
      // The lobby has no poker session: the control must render from its input.
      currentUser: signal<User | null>(null).asReadonly(),
    };

    mockAuthService = {
      logout: vi.fn(),
      getToken: vi.fn().mockReturnValue('lobby-token'),
    };

    mockRouter = { navigate: vi.fn().mockResolvedValue(true) };

    TestBed.configureTestingModule({
      imports: [UserMenuComponent],
      providers: [
        { provide: SessionStateService, useValue: mockSessionState },
        {
          provide: WebSocketService,
          useValue: {
            send: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: vi.fn().mockReturnValue(EMPTY),
            connectionState: signal('disconnected' as const),
          },
        },
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Render the control the way the lobby header hosts it. */
  function renderLobbyUserMenu(user: User): ComponentFixture<UserMenuComponent> {
    const fixture = TestBed.createComponent(UserMenuComponent);
    fixture.componentRef.setInput('user', user);
    fixture.componentRef.setInput('showRoleSwitch', false);
    fixture.detectChanges();
    return fixture;
  }

  function avatarOf(fixture: ComponentFixture<UserMenuComponent>): HTMLButtonElement {
    const avatar = (fixture.nativeElement as HTMLElement).querySelector('.user-menu__avatar');
    expect(avatar).not.toBeNull();
    return avatar as HTMLButtonElement;
  }

  it('exposes the poker accessible names, a single Logout item and the uppercased first non-whitespace initial', () => {
    fc.assert(
      fc.property(arbDisplayName, arbRole, (displayName, role) => {
        const fixture = renderLobbyUserMenu({
          id: 'lobby-user',
          displayName,
          role,
          isAnonymous: false,
        });

        try {
          const host = fixture.nativeElement as HTMLElement;
          const avatar = avatarOf(fixture);

          // Avatar accessible name and popup semantics.
          expect(avatar.getAttribute('aria-label')).toBe(`User menu for ${displayName}`);
          expect(avatar.getAttribute('aria-haspopup')).toBe('true');

          // The initial is the uppercase first non-whitespace character.
          expect(avatar.textContent?.trim()).toBe(expectedInitial(displayName));

          // aria-expanded tracks the closed state.
          expect(avatar.getAttribute('aria-expanded')).toBe('false');
          expect(host.querySelector('[role="menu"]')).toBeNull();

          // Open: aria-expanded tracks the open state.
          avatar.click();
          fixture.detectChanges();
          vi.advanceTimersByTime(0);

          expect(avatar.getAttribute('aria-expanded')).toBe('true');

          const dropdown = host.querySelector('.user-menu__dropdown');
          expect(dropdown).not.toBeNull();
          expect(dropdown?.getAttribute('role')).toBe('menu');
          expect(dropdown?.getAttribute('aria-label')).toBe('User menu');

          // Exactly one action item, named Logout, and no role switch.
          const menuItems = Array.from(host.querySelectorAll('[role="menuitem"]'));
          expect(menuItems.length).toBe(1);
          expect(menuItems[0].getAttribute('aria-label')).toBe('Logout');
          expect(menuItems[0].textContent?.trim()).toBe('Logout');
          expect(dropdown?.textContent).not.toContain('Switch to');

          // Close: aria-expanded tracks the open state again.
          avatar.click();
          fixture.detectChanges();
          vi.advanceTimersByTime(0);

          expect(avatar.getAttribute('aria-expanded')).toBe('false');
          expect(host.querySelector('[role="menu"]')).toBeNull();
        } finally {
          fixture.destroy();
        }
      }),
      { numRuns: 100 }
    );
  });

  it('renders no initial for a whitespace-only name while the dropdown and logout stay reachable', () => {
    fc.assert(
      fc.property(arbWhitespaceOnlyName, arbRole, (displayName, role) => {
        mockAuthService.logout.mockClear();
        mockRouter.navigate.mockClear();

        const fixture = renderLobbyUserMenu({
          id: 'lobby-user',
          displayName,
          role,
          isAnonymous: false,
        });

        try {
          const host = fixture.nativeElement as HTMLElement;
          const avatar = avatarOf(fixture);

          // No initial text, yet the avatar stays an activatable button.
          expect(avatar.textContent?.trim()).toBe('');
          expect(avatar.tagName).toBe('BUTTON');
          expect(avatar.disabled).toBe(false);
          expect(avatar.getAttribute('aria-haspopup')).toBe('true');
          expect(avatar.getAttribute('aria-expanded')).toBe('false');

          // The dropdown opens by pointer activation.
          avatar.click();
          fixture.detectChanges();
          vi.advanceTimersByTime(0);

          expect(avatar.getAttribute('aria-expanded')).toBe('true');
          const dropdown = host.querySelector('.user-menu__dropdown');
          expect(dropdown).not.toBeNull();
          expect(dropdown?.getAttribute('role')).toBe('menu');
          expect(dropdown?.getAttribute('aria-label')).toBe('User menu');

          // The logout action is the only item, keyboard focusable and
          // reachable by pointer.
          const menuItems = Array.from(host.querySelectorAll('[role="menuitem"]'));
          expect(menuItems.length).toBe(1);
          const logout = menuItems[0] as HTMLButtonElement;
          expect(logout.getAttribute('aria-label')).toBe('Logout');
          expect(logout.disabled).toBe(false);
          expect(logout.getAttribute('tabindex')).toBe('0');

          logout.click();
          fixture.detectChanges();

          expect(mockAuthService.logout).toHaveBeenCalledTimes(1);
          expect(mockRouter.navigate).toHaveBeenCalledWith(['/login']);
        } finally {
          fixture.destroy();
        }
      }),
      { numRuns: 100 }
    );
  });
});
