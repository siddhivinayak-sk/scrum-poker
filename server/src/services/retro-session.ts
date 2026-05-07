import { v4 as uuidv4 } from 'uuid';
import {
  User,
  RetroConfiguration,
  RetroBoard,
  RetroColumn,
  RetroCard,
  RetroComment,
  RetroSessionState,
} from '../../../shared/types';
import { getTemplateById } from './retro-templates';

/**
 * Encapsulates the per-session state for a retrospective board.
 * Manages board columns, cards, votes, comments, participants,
 * and moderator controls for a single retro session.
 */
export class RetroSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly createdAt: string;
  config: RetroConfiguration;
  lastActivityAt: string;

  private board: RetroBoard;
  private participants: Map<string, User> = new Map();
  private votesUsed: Map<string, number> = new Map(); // userId -> votes used

  constructor(sessionId: string, ownerId: string, config: RetroConfiguration) {
    this.sessionId = sessionId;
    this.ownerId = ownerId;
    this.config = { ...config };
    const now = new Date().toISOString();
    this.createdAt = now;
    this.lastActivityAt = now;

    // Initialize board state from template
    const template = getTemplateById(config.templateId);
    const columns: RetroColumn[] = (template ? template.columns : []).map(
      (name, index) => ({
        id: uuidv4(),
        name,
        cards: [],
        order: index,
      })
    );

    this.board = {
      columns,
      context: '',
      cardsRevealed: false,
      votingEnabled: !config.disableVotingInitially,
      isCompleted: false,
    };
  }

  /**
   * Update the lastActivityAt timestamp to the current time.
   */
  private touch(): void {
    this.lastActivityAt = new Date().toISOString();
  }

  /**
   * Get the full session state for sync on connect/reconnect.
   */
  getSessionState(): RetroSessionState {
    return {
      sessionId: this.sessionId,
      config: this.config,
      board: this.board,
      participants: this.getParticipants(),
      ownerId: this.ownerId,
      createdAt: this.createdAt,
      votesRemaining: this.getVotesRemainingMap(),
    };
  }

  /**
   * Get the session state filtered by card visibility rules.
   * If hideCardsInitially is true and cards have not been revealed,
   * only the requesting user's own cards are visible. Card counts
   * per column are still reflected via the column structure.
   */
  getVisibleState(userId: string): RetroSessionState {
    if (this.config.hideCardsInitially && !this.board.cardsRevealed) {
      const filteredBoard: RetroBoard = {
        ...this.board,
        columns: this.board.columns.map((column) => ({
          ...column,
          cards: column.cards.filter((card) => card.authorId === userId),
        })),
      };

      return {
        sessionId: this.sessionId,
        config: this.config,
        board: filteredBoard,
        participants: this.getParticipants(),
        ownerId: this.ownerId,
        createdAt: this.createdAt,
        votesRemaining: this.getVotesRemainingMap(),
      };
    }

    return this.getSessionState();
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
   * Add a participant to the session.
   * Initializes their vote count to 0 used.
   */
  addParticipant(user: User): void {
    this.participants.set(user.id, user);
    if (!this.votesUsed.has(user.id)) {
      this.votesUsed.set(user.id, 0);
    }
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
   * Check if a display name is already taken (case-insensitive).
   */
  hasDisplayName(displayName: string): boolean {
    const lower = displayName.toLowerCase();
    for (const user of this.participants.values()) {
      if (user.displayName.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the remaining votes for a specific user.
   */
  getVotesRemaining(userId: string): number {
    const used = this.votesUsed.get(userId) ?? 0;
    return Math.max(0, this.config.maxVotesPerUser - used);
  }

  /**
   * Get a map of userId -> remaining votes for all participants.
   */
  private getVotesRemainingMap(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const userId of this.participants.keys()) {
      result[userId] = this.getVotesRemaining(userId);
    }
    return result;
  }

  // --- Column operations (implemented in task 2.3) ---

  addColumn(name: string): RetroColumn {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Column name cannot be empty');
    }
    const column: RetroColumn = {
      id: uuidv4(),
      name: trimmed,
      cards: [],
      order: this.board.columns.length,
    };
    this.board.columns.push(column);
    this.touch();
    return column;
  }

  removeColumn(columnId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const index = this.board.columns.findIndex((col) => col.id === columnId);
    if (index === -1) {
      throw new Error('Column not found');
    }
    this.board.columns.splice(index, 1);
    // Re-index remaining columns
    this.board.columns.forEach((col, i) => {
      col.order = i;
    });
    this.touch();
  }

  reorderColumns(orderedIds: string[]): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const reordered: RetroColumn[] = [];
    for (const id of orderedIds) {
      const col = this.board.columns.find((c) => c.id === id);
      if (col) {
        reordered.push(col);
      }
    }
    // Update order property based on new position
    reordered.forEach((col, i) => {
      col.order = i;
    });
    this.board.columns = reordered;
    this.touch();
  }

  renameColumn(columnId: string, name: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const column = this.board.columns.find((col) => col.id === columnId);
    if (!column) {
      throw new Error('Column not found');
    }
    column.name = name;
    this.touch();
  }

  // --- Card operations (implemented in task 2.4) ---

  /**
   * Find a card by ID across all columns.
   * Returns the card and its parent column, or throws if not found.
   */
  private findCard(cardId: string): { card: RetroCard; column: RetroColumn } {
    for (const column of this.board.columns) {
      const card = column.cards.find((c) => c.id === cardId);
      if (card) {
        return { card, column };
      }
    }
    throw new Error('Card not found');
  }

  addCard(columnId: string, text: string, authorId: string, authorName: string): RetroCard {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const column = this.board.columns.find((col) => col.id === columnId);
    if (!column) {
      throw new Error('Column not found');
    }
    const card: RetroCard = {
      id: uuidv4(),
      text,
      authorId,
      authorName,
      votes: 0,
      votedBy: [],
      comments: [],
      columnId,
      order: column.cards.length,
      createdAt: new Date().toISOString(),
    };
    column.cards.push(card);
    this.touch();
    return card;
  }

  editCard(cardId: string, text: string, userId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card } = this.findCard(cardId);
    if (card.authorId !== userId && userId !== this.ownerId) {
      throw new Error('Not authorized');
    }
    card.text = text;
    this.touch();
  }

  removeCard(cardId: string, userId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card, column } = this.findCard(cardId);
    if (card.authorId !== userId && userId !== this.ownerId) {
      throw new Error('Not authorized');
    }
    column.cards = column.cards.filter((c) => c.id !== cardId);
    // Re-index remaining cards' order
    column.cards.forEach((c, i) => {
      c.order = i;
    });
    this.touch();
  }

  moveCard(cardId: string, targetColumnId: string, targetIndex: number): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card, column: sourceColumn } = this.findCard(cardId);
    const targetColumn = this.board.columns.find((col) => col.id === targetColumnId);
    if (!targetColumn) {
      throw new Error('Column not found');
    }
    // Remove card from source column
    sourceColumn.cards = sourceColumn.cards.filter((c) => c.id !== cardId);
    // Update card's columnId
    card.columnId = targetColumnId;
    // Insert card at target index
    targetColumn.cards.splice(targetIndex, 0, card);
    // Re-index cards in source column
    sourceColumn.cards.forEach((c, i) => {
      c.order = i;
    });
    // Re-index cards in target column
    targetColumn.cards.forEach((c, i) => {
      c.order = i;
    });
    this.touch();
  }

  // --- Voting (implemented in task 2.5) ---

  voteCard(cardId: string, userId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    if (!this.board.votingEnabled) {
      throw new Error('Voting is not enabled');
    }
    const { card } = this.findCard(cardId);
    if (this.getVotesRemaining(userId) <= 0) {
      throw new Error('No votes remaining');
    }
    if (this.config.oneVotePerCard && card.votedBy.includes(userId)) {
      throw new Error('Already voted on this card');
    }
    card.votes++;
    card.votedBy.push(userId);
    this.votesUsed.set(userId, (this.votesUsed.get(userId) ?? 0) + 1);
    this.touch();
  }

  unvoteCard(cardId: string, userId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card } = this.findCard(cardId);
    const voteIndex = card.votedBy.indexOf(userId);
    if (voteIndex === -1) {
      throw new Error('User has not voted on this card');
    }
    card.votes--;
    card.votedBy.splice(voteIndex, 1);
    this.votesUsed.set(userId, (this.votesUsed.get(userId) ?? 0) - 1);
    this.touch();
  }

  // --- Comments (implemented in task 2.6) ---

  addComment(cardId: string, text: string, authorId: string, authorName: string): RetroComment {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card } = this.findCard(cardId);
    const comment: RetroComment = {
      id: uuidv4(),
      text,
      authorId,
      authorName,
      createdAt: new Date().toISOString(),
    };
    card.comments.push(comment);
    this.touch();
    return comment;
  }

  removeComment(cardId: string, commentId: string, userId: string): void {
    if (this.board.isCompleted) {
      throw new Error('Board is completed');
    }
    const { card } = this.findCard(cardId);
    const commentIndex = card.comments.findIndex((c) => c.id === commentId);
    if (commentIndex === -1) {
      throw new Error('Comment not found');
    }
    const comment = card.comments[commentIndex];
    if (comment.authorId !== userId && userId !== this.ownerId) {
      throw new Error('Not authorized');
    }
    card.comments.splice(commentIndex, 1);
    this.touch();
  }

  // --- Moderator controls (implemented in task 2.7) ---

  revealCards(): void {
    this.board.cardsRevealed = true;
    this.touch();
  }

  enableVoting(): void {
    this.board.votingEnabled = true;
    this.touch();
  }

  completeBoard(): void {
    this.board.isCompleted = true;
    this.touch();
  }

  updateContext(text: string): void {
    this.board.context = text;
    this.touch();
  }

  updateConfig(partial: Partial<RetroConfiguration>): RetroConfiguration {
    this.config = { ...this.config, ...partial };
    this.touch();
    return this.config;
  }

  // --- CSV export/import (implemented in task 2.8) ---

  /**
   * Escape a field value for CSV output.
   * Fields containing commas, double quotes, or newlines are enclosed in double quotes.
   * Double quotes within fields are escaped by doubling them.
   */
  private escapeCSVField(field: string): string {
    if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
  }

  /**
   * Parse a CSV string into rows of fields.
   * Handles quoted fields with embedded commas, newlines, and escaped quotes.
   */
  private parseCSV(csvData: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;

    while (i < csvData.length) {
      const char = csvData[i];

      if (inQuotes) {
        if (char === '"') {
          // Check for escaped quote (doubled)
          if (i + 1 < csvData.length && csvData[i + 1] === '"') {
            currentField += '"';
            i += 2;
          } else {
            // End of quoted field
            inQuotes = false;
            i++;
          }
        } else {
          currentField += char;
          i++;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
          i++;
        } else if (char === ',') {
          currentRow.push(currentField);
          currentField = '';
          i++;
        } else if (char === '\r') {
          // Handle \r\n or standalone \r as row delimiter
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          if (i + 1 < csvData.length && csvData[i + 1] === '\n') {
            i += 2;
          } else {
            i++;
          }
        } else if (char === '\n') {
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
        } else {
          currentField += char;
          i++;
        }
      }
    }

    // Push the last field and row if there's remaining content
    if (currentField !== '' || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    return rows;
  }

  /**
   * Export the board data as a CSV string.
   * Headers: "Column","Card Text","Votes","Author","Comments"
   * Comments are joined with " | " separator.
   */
  exportCSV(): string {
    const headers = ['Column', 'Card Text', 'Votes', 'Author', 'Comments'];
    const lines: string[] = [headers.map((h) => this.escapeCSVField(h)).join(',')];

    for (const column of this.board.columns) {
      for (const card of column.cards) {
        const commentsText = card.comments.map((c) => c.text).join(' | ');
        const row = [
          this.escapeCSVField(column.name),
          this.escapeCSVField(card.text),
          this.escapeCSVField(String(card.votes)),
          this.escapeCSVField(card.authorName),
          this.escapeCSVField(commentsText),
        ];
        lines.push(row.join(','));
      }
    }

    return lines.join('\n');
  }

  /**
   * Import cards from a CSV string.
   * Validates structure: requires "Column" and "Card Text" headers.
   * Creates cards in matching columns with a system import author.
   * Throws descriptive errors for malformed input.
   */
  importCSV(csvData: string): void {
    if (!csvData || csvData.trim() === '') {
      throw new Error('CSV data is empty');
    }

    const rows = this.parseCSV(csvData);
    if (rows.length === 0) {
      throw new Error('CSV data is empty');
    }

    // Validate header row
    const headers = rows[0].map((h) => h.trim());
    const columnIndex = headers.indexOf('Column');
    const cardTextIndex = headers.indexOf('Card Text');

    if (columnIndex === -1 || cardTextIndex === -1) {
      throw new Error(
        'CSV is missing required headers: "Column" and "Card Text" are required'
      );
    }

    // Process data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      // Skip completely empty rows
      if (row.length === 1 && row[0].trim() === '') {
        continue;
      }

      const columnName = row[columnIndex]?.trim() ?? '';
      const cardText = row[cardTextIndex]?.trim() ?? '';

      if (!columnName) {
        throw new Error(`Row ${i + 1}: missing column name`);
      }
      if (!cardText) {
        throw new Error(`Row ${i + 1}: missing card text`);
      }

      // Find matching column by name (case-sensitive)
      const column = this.board.columns.find((col) => col.name === columnName);
      if (!column) {
        throw new Error(
          `Row ${i + 1}: column "${columnName}" not found on the board`
        );
      }

      // Create card in the matching column
      const card: RetroCard = {
        id: uuidv4(),
        text: cardText,
        authorId: 'import',
        authorName: 'Imported',
        votes: 0,
        votedBy: [],
        comments: [],
        columnId: column.id,
        order: column.cards.length,
        createdAt: new Date().toISOString(),
      };
      column.cards.push(card);
    }

    this.touch();
  }
}
