import {
  Component,
  inject,
  computed,
  signal,
  ElementRef,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-retro-user-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (displayName()) {
      <div class="user-menu">
        <button
          class="user-menu__avatar"
          [attr.aria-label]="'User menu for ' + displayName()"
          [attr.aria-expanded]="menuOpen()"
          aria-haspopup="true"
          (click)="toggleMenu()"
        >
          {{ avatarLetter() }}
        </button>

        @if (menuOpen()) {
          <div class="user-menu__dropdown" role="menu" aria-label="User menu">
            <div class="user-menu__info" role="none">
              <span class="user-menu__name">{{ displayName() }}</span>
              <span class="user-menu__role">{{ isModerator() ? 'moderator' : 'participant' }}</span>
            </div>

            <button
              class="user-menu__item"
              role="menuitem"
              [attr.aria-label]="'Switch to ' + (isModerator() ? 'participant' : 'moderator')"
              (click)="switchRole()"
            >
              Switch to {{ isModerator() ? 'participant' : 'moderator' }}
            </button>

            <button
              class="user-menu__item user-menu__item--logout"
              role="menuitem"
              aria-label="Logout"
              (click)="logout()"
            >
              Logout
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .user-menu {
      position: relative;
      display: inline-block;
    }

    .user-menu__avatar {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.6);
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
      font-size: 0.85rem;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      transition: box-shadow 0.2s;
    }

    .user-menu__avatar:hover {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .user-menu__avatar:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    .user-menu__dropdown {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 180px;
      background: #ffffff;
      border-radius: 8px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      z-index: 1000;
      overflow: hidden;
    }

    .user-menu__info {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #e2e8f0;
    }

    .user-menu__name {
      font-weight: 600;
      font-size: 0.85rem;
      color: #1a1a2e;
    }

    .user-menu__role {
      font-size: 0.75rem;
      color: #4a5568;
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
      cursor: pointer;
      min-height: 44px;
      transition: background-color 0.15s;
    }

    .user-menu__item:hover {
      background: #f0f4ff;
    }

    .user-menu__item--logout {
      color: #e53e3e;
    }

    .user-menu__item--logout:hover {
      background: #fff5f5;
    }
  `],
})
export class RetroUserMenuComponent {
  private readonly retroState = inject(RetroStateService);
  private readonly ws = inject(RetroWebSocketService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly elementRef = inject(ElementRef);

  readonly menuOpen = signal(false);
  readonly isModerator = this.retroState.isModerator;

  readonly displayName = computed(() => {
    const userId = this.retroState.currentUserId();
    const participants = this.retroState.participants();
    const user = participants.find(p => p.id === userId);
    return user?.displayName ?? '';
  });

  readonly avatarLetter = computed(() => {
    const name = this.displayName();
    return name ? name.charAt(0).toUpperCase() : '?';
  });

  toggleMenu(): void {
    this.menuOpen.update(v => !v);
  }

  switchRole(): void {
    const newRole = this.isModerator() ? 'participant' : 'moderator';
    this.ws.send('role:change', { role: newRole });
    this.menuOpen.set(false);
  }

  logout(): void {
    this.authService.logout();
    this.menuOpen.set(false);
    this.router.navigate(['/login']);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.menuOpen() && !this.elementRef.nativeElement.contains(event.target)) {
      this.menuOpen.set(false);
    }
  }
}
