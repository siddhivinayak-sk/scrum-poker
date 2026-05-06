import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { User } from '@shared/types';

/**
 * Pure function: compute the toggled role for a user.
 */
export function toggleRole(currentRole: 'moderator' | 'participant'): 'moderator' | 'participant' {
  return currentRole === 'moderator' ? 'participant' : 'moderator';
}

/**
 * Pure function: apply a role change to a user, returning a new user object.
 */
export function applyRoleChange(
  user: User,
  newRole: 'moderator' | 'participant'
): User {
  return { ...user, role: newRole };
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (currentUser(); as user) {
      <section class="profile" role="region" aria-label="User profile">
        <span class="profile__name" aria-label="Username">{{ user.displayName }}</span>
        <span class="profile__role" aria-label="Current role">{{ user.role }}</span>
        <button
          class="profile__toggle"
          (click)="switchRole()"
          [attr.aria-label]="'Switch to ' + nextRole() + ' role'"
        >
          Switch to {{ nextRole() }}
        </button>
      </section>
    }
  `,
  styles: [
    `
      .profile {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .profile__name {
        font-weight: 600;
        font-size: 0.9rem;
      }

      .profile__role {
        font-size: 0.8rem;
        color: #1a1a2e;
        text-transform: capitalize;
        padding: 0.2rem 0.5rem;
        background: #e3f2fd;
        border-radius: 4px;
      }

      .profile__toggle {
        padding: 0.4rem 0.75rem;
        border: 1px solid #1976d2;
        border-radius: 6px;
        background: #fff;
        color: #1976d2;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
        transition: background-color 0.2s;
      }

      .profile__toggle:hover {
        background: #e3f2fd;
      }

      .profile__toggle:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
      }
    `,
  ],
})
export class ProfileComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);

  readonly currentUser = this.sessionState.currentUser;

  readonly nextRole = computed(() => {
    const user = this.currentUser();
    if (!user) return 'moderator';
    return toggleRole(user.role);
  });

  switchRole(): void {
    const user = this.currentUser();
    if (!user) return;
    const newRole = toggleRole(user.role);
    this.wsService.send('role:change', { role: newRole });
  }
}
