import {
  Component,
  inject,
  computed,
  signal,
  ElementRef,
  HostListener,
  ViewChild,
  AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { toggleRole } from '../profile/profile.component';

/**
 * Pure function: extract the first letter of a display name, uppercased.
 */
export function getAvatarLetter(displayName: string): string {
  return displayName.charAt(0).toUpperCase();
}

@Component({
  selector: 'app-user-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (currentUser(); as user) {
      <div class="user-menu">
        <button
          #avatarButton
          class="user-menu__avatar"
          [attr.aria-label]="'User menu for ' + user.displayName"
          [attr.aria-expanded]="menuOpen()"
          aria-haspopup="true"
          (click)="toggleMenu()"
          (keydown)="onAvatarKeydown($event)"
        >
          {{ avatarLetter() }}
        </button>

        @if (menuOpen()) {
          <div
            class="user-menu__dropdown"
            role="menu"
            aria-label="User menu"
            #dropdownMenu
          >
            <div class="user-menu__info" role="none">
              <span class="user-menu__name">{{ user.displayName }}</span>
              <span class="user-menu__role">{{ user.role }}</span>
            </div>

            <button
              class="user-menu__item"
              role="menuitem"
              [attr.aria-label]="'Switch to ' + nextRole() + ' role'"
              [attr.tabindex]="focusedIndex() === 0 ? 0 : -1"
              (click)="switchRole()"
              (keydown)="onMenuItemKeydown($event, 0)"
              #menuItem
            >
              Switch to {{ nextRole() }}
            </button>

            <button
              class="user-menu__item user-menu__item--logout"
              role="menuitem"
              aria-label="Logout"
              [attr.tabindex]="focusedIndex() === 1 ? 0 : -1"
              (click)="logout()"
              (keydown)="onMenuItemKeydown($event, 1)"
              #menuItem
            >
              Logout
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .user-menu {
        position: relative;
        display: inline-block;
      }

      .user-menu__avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        min-width: 44px;
        min-height: 44px;
        border-radius: 50%;
        border: 2px solid var(--color-primary, #667eea);
        background: var(--gradient-primary, linear-gradient(135deg, #667eea 0%, #764ba2 100%));
        color: var(--text-on-primary, #ffffff);
        font-size: 1.1rem;
        font-weight: 700;
        cursor: pointer;
        transition: box-shadow 0.2s, border-color 0.2s;
        padding: 0;
        line-height: 1;
      }

      .user-menu__avatar:hover {
        box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
      }

      .user-menu__avatar:focus-visible {
        outline: 2px solid var(--color-primary, #667eea);
        outline-offset: 2px;
      }

      .user-menu__dropdown {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        min-width: 200px;
        background: #ffffff;
        border-radius: 8px;
        box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.2));
        z-index: 1000;
        overflow: hidden;
      }

      .user-menu__info {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid #e2e8f0;
      }

      .user-menu__name {
        font-weight: 600;
        font-size: 0.9rem;
        color: var(--text-primary, #1a1a2e);
      }

      .user-menu__role {
        font-size: 0.8rem;
        color: var(--text-secondary, #4a5568);
        text-transform: capitalize;
      }

      .user-menu__item {
        display: block;
        width: 100%;
        padding: 0.6rem 1rem;
        border: none;
        background: transparent;
        text-align: left;
        font-size: 0.85rem;
        color: var(--text-primary, #1a1a2e);
        cursor: pointer;
        min-height: 44px;
        transition: background-color 0.15s;
      }

      .user-menu__item:hover,
      .user-menu__item:focus-visible {
        background: #f0f4ff;
      }

      .user-menu__item:focus-visible {
        outline: 2px solid var(--color-primary, #667eea);
        outline-offset: -2px;
      }

      .user-menu__item--logout {
        color: #e53e3e;
        border-top: 1px solid #e2e8f0;
      }

      .user-menu__item--logout:hover,
      .user-menu__item--logout:focus-visible {
        background: #fff5f5;
      }
    `,
  ],
})
export class UserMenuComponent implements AfterViewInit {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly elementRef = inject(ElementRef);

  @ViewChild('avatarButton') avatarButtonRef!: ElementRef<HTMLButtonElement>;

  readonly currentUser = this.sessionState.currentUser;
  readonly menuOpen = signal(false);
  readonly focusedIndex = signal(0);

  private readonly MENU_ITEM_COUNT = 2;

  readonly avatarLetter = computed(() => {
    const user = this.currentUser();
    if (!user) return '';
    return getAvatarLetter(user.displayName);
  });

  readonly nextRole = computed(() => {
    const user = this.currentUser();
    if (!user) return 'moderator';
    return toggleRole(user.role);
  });

  private menuItems: HTMLButtonElement[] = [];

  ngAfterViewInit(): void {
    // Menu items are queried dynamically when menu opens
  }

  toggleMenu(): void {
    const isOpen = this.menuOpen();
    this.menuOpen.set(!isOpen);
    if (!isOpen) {
      this.focusedIndex.set(0);
      // Focus first menu item after DOM updates
      setTimeout(() => this.focusMenuItem(0), 0);
    }
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  switchRole(): void {
    const user = this.currentUser();
    if (!user) return;
    const newRole = toggleRole(user.role);
    this.wsService.send('role:change', { role: newRole });
    this.closeMenu();
  }

  logout(): void {
    this.authService.logout();
    this.closeMenu();
    this.router.navigate(['/login']);
  }

  onAvatarKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!this.menuOpen()) {
        this.menuOpen.set(true);
        this.focusedIndex.set(0);
        setTimeout(() => this.focusMenuItem(0), 0);
      }
    }
  }

  onMenuItemKeydown(event: KeyboardEvent, index: number): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveFocus(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveFocus(index - 1);
        break;
      case 'Escape':
        event.preventDefault();
        this.closeMenu();
        this.avatarButtonRef?.nativeElement?.focus();
        break;
      case 'Tab':
        this.closeMenu();
        break;
      case 'Home':
        event.preventDefault();
        this.moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        this.moveFocus(this.MENU_ITEM_COUNT - 1);
        break;
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.menuOpen() && !this.elementRef.nativeElement.contains(event.target)) {
      this.closeMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.menuOpen()) {
      this.closeMenu();
      this.avatarButtonRef?.nativeElement?.focus();
    }
  }

  private moveFocus(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.MENU_ITEM_COUNT - 1));
    this.focusedIndex.set(clamped);
    this.focusMenuItem(clamped);
  }

  private focusMenuItem(index: number): void {
    const items = this.elementRef.nativeElement.querySelectorAll('[role="menuitem"]');
    if (items[index]) {
      (items[index] as HTMLElement).focus();
    }
  }
}
