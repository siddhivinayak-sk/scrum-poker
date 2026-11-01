import { ChangeDetectionStrategy, Component, inject, linkedSignal } from '@angular/core';
import { BoardKind } from '@shared/types';
import { ChatStore } from '../../services/chat-store.service';
import { CHAT_TRANSPORT } from '../../services/chat-transport';
import { PresenceEntry, PresenceParticipant, presenceEntries } from './chat-format';

/** Id of the Presence_List element for one Board_Kind; the header toggle's `aria-controls` target. */
export function presenceListId(kind: BoardKind): string {
  return `chat-presence-${kind}`;
}

/**
 * Presence_List of the Chat_Panel (Deferred chat chunk).
 *
 * - One entry per distinct user ID of the Board_Page's participant list, sorted by display name
 *   (case-insensitive) and then user ID, as plain text (R10.3, R10.5).
 * - "(you)" and "Moderator" are visible text, never colour or icon alone (R10.6).
 * - Visibility is `store.presenceOpen`: hidden when the Board_Page is first rendered and kept
 *   across Panel_State changes because the page-scoped store owns it (R10.7). The element stays
 *   in the DOM while hidden so the toggle's `aria-controls` always resolves.
 * - While Connection_State is not `connected`, the list seen last while connected stays on screen
 *   whatever the participant signal does; once connected again it follows the participant list
 *   the Board_Page holds (R10.8).
 */
@Component({
  selector: 'app-chat-presence-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul
      class="chat-presence"
      aria-label="Participants"
      [id]="listId"
      [hidden]="!store.presenceOpen()"
    >
      @for (entry of entries(); track entry.userId) {
        <li class="chat-presence__entry">
          <span class="chat-presence__name">{{ entry.displayName }}</span>
          @if (entry.isYou) {
            <span class="chat-presence__you"> (you)</span>
          }
          @if (entry.isModerator) {
            <span class="chat-presence__role">Moderator</span>
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: none;
      }

      .chat-presence {
        margin: 0;
        padding: 4px 12px 8px;
        list-style: none;
        color: var(--text-primary);
        font-size: 0.875rem;
        line-height: 1.4;
      }

      .chat-presence[hidden] {
        display: none;
      }

      .chat-presence__entry {
        padding: 4px 0;
        overflow-wrap: anywhere;
      }

      .chat-presence__name {
        font-weight: 600;
      }

      .chat-presence__you {
        color: var(--text-secondary);
      }

      .chat-presence__role {
        display: inline-block;
        margin-left: 8px;
        padding: 0 6px;
        border: 1px solid currentColor;
        border-radius: 4px;
        color: var(--text-secondary);
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.5;
      }
    `,
  ],
})
export class ChatPresenceListComponent {
  protected readonly store = inject(ChatStore);
  private readonly transport = inject(CHAT_TRANSPORT);

  /** Stable per Board_Kind, so poker and retro never share an id (see `presenceListId`). */
  protected readonly listId = presenceListId(this.store.boardKind);

  /**
   * Entries shown. Recomputed from the participant list and the current user while connected;
   * while not connected the previous value is kept (R10.8). Before any value exists (first
   * render while offline) the current participant list is used.
   */
  protected readonly entries = linkedSignal<
    { connected: boolean; participants: readonly PresenceParticipant[]; me: string | null },
    readonly PresenceEntry[]
  >({
    source: () => ({
      connected: this.store.connectionState() === 'connected',
      participants: this.transport.participants(),
      me: this.transport.currentUserId(),
    }),
    computation: (source, previous) =>
      source.connected || previous === undefined
        ? presenceEntries(source.participants, source.me)
        : previous.value,
  });
}
