import { v4 as uuidv4 } from 'uuid';
import {
  User,
  VotingRound,
  CardValue,
  VotingMetrics,
  HistoryEntry,
  ParticipantVote,
  SessionConfiguration,
  GameSessionState,
  IssueItem,
  hasPermission as sharedHasPermission,
} from '../../../shared/types';
import { calculate } from './metrics-engine';

/**
 * Result returned when cards are revealed.
 * Contains the selections map and the computed voting metrics.
 */
export interface RevealResult {
  selections: Map<string, CardValue>;
  metrics: VotingMetrics;
}

/**
 * Encapsulates the per-session state. This is a refactoring of the
 * session-manager.ts module-level functions into a class instance,
 * so that multiple isolated game sessions can coexist.
 */
export class GameSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly createdAt: string;
  config: SessionConfiguration;
  lastActivityAt: string;

  private participants: Map<string, User> = new Map();
  private currentRound: VotingRound | null = null;
  private history: HistoryEntry[] = [];
  private votingDurationMs: number | undefined = undefined;
  private issueList: IssueItem[] = [];

  constructor(sessionId: string, ownerId: string, config: SessionConfiguration) {
    this.sessionId = sessionId;
    this.ownerId = ownerId;
    this.config = { ...config };
    const now = new Date().toISOString();
    this.createdAt = now;
    this.lastActivityAt = now;
  }

  /**
   * Update the lastActivityAt timestamp to the current time.
   */
  private touch(): void {
    this.lastActivityAt = new Date().toISOString();
  }

  /**
   * Add a participant to the session.
   * If a participant with the same id already exists, they are replaced (reconnect scenario).
   */
  addParticipant(user: User): void {
    this.participants.set(user.id, user);
    this.touch();
  }

  /**
   * Remove a participant from the session by userId.
   */
  removeParticipant(userId: string): void {
    this.participants.delete(userId);
    this.touch();
  }

  /**
   * Remove a participant by moderator action.
   * Discards any active card selection and removes from participants.
   */
  removeParticipantByModerator(userId: string): void {
    // Discard any active selection
    if (this.currentRound && this.currentRound.selections.has(userId)) {
      this.currentRound.selections.delete(userId);
    }
    // Remove from participants
    this.participants.delete(userId);
    this.touch();
  }

  /**
   * Get the list of all current participants.
   */
  getParticipants(): User[] {
    return Array.from(this.participants.values());
  }

  /**
   * Get the number of current participants.
   */
  getParticipantCount(): number {
    return this.participants.size;
  }

  /**
   * Check if a display name is already in use in this session.
   * Uses case-insensitive comparison with trimming.
   */
  hasDisplayName(displayName: string): boolean {
    const normalized = displayName.trim().toLowerCase();
    for (const participant of this.participants.values()) {
      if (participant.displayName.trim().toLowerCase() === normalized) {
        return true;
      }
    }
    return false;
  }

  /**
   * Start a new voting round with the given story description.
   * Throws if the story description is empty or whitespace-only.
   */
  startRound(storyDescription: string): VotingRound {
    const trimmed = storyDescription.trim();
    if (trimmed.length === 0) {
      throw new Error('Story description must not be empty');
    }

    this.currentRound = {
      id: uuidv4(),
      storyDescription: trimmed,
      status: 'voting',
      selections: new Map(),
      startedAt: new Date().toISOString(),
    };

    this.votingDurationMs = undefined;
    this.touch();

    return this.currentRound;
  }

  /**
   * Get the current voting round, or null if none is active.
   */
  getCurrentRound(): VotingRound | null {
    return this.currentRound;
  }

  /**
   * Record a card selection for a user.
   * Ignored if there is no active round or the round is already revealed.
   * Last-write-wins: selecting again replaces the previous selection.
   */
  selectCard(userId: string, cardValue: CardValue): void {
    if (!this.currentRound || this.currentRound.status !== 'voting') {
      return;
    }
    this.currentRound.selections.set(userId, cardValue);
    this.touch();
  }

  /**
   * Get the current selections map.
   * Returns an empty map if no round is active.
   */
  getSelections(): Map<string, CardValue> {
    if (!this.currentRound) {
      return new Map();
    }
    return this.currentRound.selections;
  }

  /**
   * Check if auto-reveal should be triggered.
   * Returns true if config.autoReveal is true AND every participant
   * has a selection in the current round.
   */
  checkAutoReveal(): boolean {
    if (!this.config.autoReveal) {
      return false;
    }
    if (!this.currentRound || this.currentRound.status !== 'voting') {
      return false;
    }
    if (this.participants.size === 0) {
      return false;
    }
    for (const [userId] of this.participants) {
      if (!this.currentRound.selections.has(userId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Reveal all cards for the current round.
   * Changes round status to 'revealed' and computes metrics via MetricsEngine.
   * Also computes votingDurationMs (revealedAt - startedAt).
   * Throws if there is no active round or the round is already revealed.
   */
  revealCards(): RevealResult {
    if (!this.currentRound) {
      throw new Error('No active voting round');
    }
    if (this.currentRound.status === 'revealed') {
      throw new Error('Cards have already been revealed');
    }

    this.currentRound.status = 'revealed';
    this.currentRound.revealedAt = new Date().toISOString();

    // Compute voting duration
    const startedAt = new Date(this.currentRound.startedAt).getTime();
    const revealedAt = new Date(this.currentRound.revealedAt).getTime();
    this.votingDurationMs = revealedAt - startedAt;
    this.currentRound.votingDurationMs = this.votingDurationMs;

    const metrics = calculate(this.currentRound.selections);

    this.touch();

    return {
      selections: this.currentRound.selections,
      metrics,
    };
  }

  /**
   * Clear the board: save the current round to history (newest-first)
   * and reset the current round to null.
   * Includes votingDurationMs in the history entry if available.
   * Throws if there is no current round.
   */
  clearBoard(): HistoryEntry {
    if (!this.currentRound) {
      throw new Error('No active voting round to clear');
    }

    // Build participant votes from current participants and selections
    const participantVotes: ParticipantVote[] = this.getParticipants().map((user) => ({
      userId: user.id,
      displayName: user.displayName,
      cardValue: this.currentRound!.selections.get(user.id) ?? null,
    }));

    const metrics = calculate(this.currentRound.selections);

    const entry: HistoryEntry = {
      roundId: this.currentRound.id,
      storyDescription: this.currentRound.storyDescription,
      participants: participantVotes,
      metrics,
      completedAt: new Date().toISOString(),
      votingDurationMs: this.votingDurationMs,
    };

    // Prepend to history (newest-first)
    this.history.unshift(entry);

    // Reset current round and voting duration
    this.currentRound = null;
    this.votingDurationMs = undefined;

    this.touch();

    return entry;
  }

  /**
   * Re-vote on the current story: discard the current revealed round
   * without saving to history, and start a fresh round with the same story.
   * Throws if no round is active or the round is not yet revealed.
   */
  revote(): VotingRound {
    if (!this.currentRound) {
      throw new Error('No active round to re-vote');
    }
    if (this.currentRound.status !== 'revealed') {
      throw new Error('Can only re-vote after cards are revealed');
    }

    // Discard current round without saving to history
    const storyDescription = this.currentRound.storyDescription;
    this.currentRound = null;
    this.votingDurationMs = undefined;

    // Start a fresh round with the same story
    return this.startRound(storyDescription);
  }

  /**
   * Get the session history (newest-first ordering).
   */
  getHistory(): HistoryEntry[] {
    return this.history;
  }

  /**
   * Clear all session history entries.
   */
  clearHistory(): void {
    this.history = [];
    this.touch();
  }

  /**
   * Check if a user has a specific permission based on the session configuration
   * and the user's role within this session.
   */
  hasPermission(userId: string, permission: 'reveal' | 'issue'): boolean {
    const user = this.participants.get(userId);
    if (!user) {
      return false;
    }

    const permissionConfig = permission === 'reveal'
      ? this.config.revealPermission
      : this.config.issuePermission;

    return sharedHasPermission(userId, user.role, permissionConfig);
  }

  /**
   * Update the session configuration by merging partial updates.
   * Returns the updated configuration.
   */
  updateConfig(partial: Partial<SessionConfiguration>): SessionConfiguration {
    this.config = { ...this.config, ...partial };
    this.touch();
    return this.config;
  }

  /**
   * Get the full session state for reconnect sync.
   * Returns GameSessionState which extends SessionState with session-specific fields.
   */
  getSessionState(): GameSessionState {
    return {
      currentRound: this.currentRound,
      participants: this.getParticipants(),
      history: this.history,
      isRevealed: this.currentRound?.status === 'revealed',
      sessionId: this.sessionId,
      config: this.config,
      ownerId: this.ownerId,
      createdAt: this.createdAt,
      issueList: this.issueList,
    };
  }

  /**
   * Add a single issue to the issue list.
   * Throws if the title is empty or whitespace-only.
   */
  addIssue(title: string): IssueItem {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new Error('Issue title must not be empty');
    }

    const issue: IssueItem = {
      id: uuidv4(),
      title: trimmed,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.issueList.push(issue);
    this.touch();

    return issue;
  }

  /**
   * Add multiple issues to the issue list.
   * Filters out empty/whitespace-only titles and adds the rest.
   */
  addIssues(titles: string[]): IssueItem[] {
    const validTitles = titles.filter(t => t.trim().length > 0);
    return validTitles.map(t => this.addIssue(t));
  }

  /**
   * Remove an issue from the issue list by ID.
   * Throws if the issue is not found.
   */
  removeIssue(issueId: string): void {
    const index = this.issueList.findIndex(issue => issue.id === issueId);
    if (index === -1) {
      throw new Error('Issue not found in list');
    }
    this.issueList.splice(index, 1);
    this.touch();
  }

  /**
   * Reorder the issue list to match the given ordered IDs.
   * Throws if the provided IDs don't match the current issue list exactly.
   */
  reorderIssues(orderedIds: string[]): void {
    if (orderedIds.length !== this.issueList.length) {
      throw new Error('Reorder IDs must match current issue list');
    }

    const currentIds = new Set(this.issueList.map(issue => issue.id));
    const providedIds = new Set(orderedIds);

    if (currentIds.size !== providedIds.size) {
      throw new Error('Reorder IDs must match current issue list');
    }

    for (const id of orderedIds) {
      if (!currentIds.has(id)) {
        throw new Error('Reorder IDs must match current issue list');
      }
    }

    const issueMap = new Map(this.issueList.map(issue => [issue.id, issue]));
    this.issueList = orderedIds.map(id => issueMap.get(id)!);
    this.touch();
  }

  /**
   * Get the current issue list.
   */
  getIssueList(): IssueItem[] {
    return this.issueList;
  }

  /**
   * Mark an issue as estimated and link it to a history entry.
   * Throws if the issue is not found.
   */
  markIssueEstimated(issueId: string, historyEntryId: string): void {
    const issue = this.issueList.find(i => i.id === issueId);
    if (!issue) {
      throw new Error('Issue not found in list');
    }
    issue.status = 'estimated';
    issue.historyEntryId = historyEntryId;
    this.touch();
  }

  /**
   * Select an issue for estimation: marks it as 'estimating' and starts a new round.
   * Throws if the issue is not found.
   */
  selectIssueForEstimation(issueId: string): VotingRound {
    const issue = this.issueList.find(i => i.id === issueId);
    if (!issue) {
      throw new Error('Issue not found in list');
    }
    issue.status = 'estimating';
    const round = this.startRound(issue.title);
    this.touch();
    return round;
  }
}
