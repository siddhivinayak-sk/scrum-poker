// Card value types
export type NumericCardValue = 0 | 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 | 89;
export type SpecialCardValue = 'coffee' | 'no-clue' | 'break';
export type CardValue = NumericCardValue | SpecialCardValue;

// Card value constants
export const FIBONACCI_SEQUENCE: NumericCardValue[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
export const SPECIAL_CARDS: SpecialCardValue[] = ['coffee', 'no-clue', 'break'];
export const ALL_CARDS: CardValue[] = [...FIBONACCI_SEQUENCE, ...SPECIAL_CARDS];

// User
export interface User {
  id: string;           // UUID
  displayName: string;
  role: 'moderator' | 'participant';
  isAnonymous: boolean;
}

// Voting Round
export interface VotingRound {
  id: string;           // UUID
  storyDescription: string;
  status: 'voting' | 'revealed' | 'completed';
  selections: Map<string, ExtendedCardValue>;  // userId -> cardValue
  startedAt: string;    // ISO 8601
  revealedAt?: string;  // ISO 8601
  votingDurationMs?: number; // computed on reveal: revealedAt - startedAt
  /** Optional so every existing round literal and stored record stays valid. Plain array, never a Map. */
  calloutNotes?: CalloutNote[];
}

// Participant Vote
export interface ParticipantVote {
  userId: string;
  displayName: string;
  cardValue: ExtendedCardValue | null;  // null = no vote
}

// Voting Metrics
export interface VotingMetrics {
  average: number | null;
  mode: ExtendedCardValue | null;
  spread: number | null;
  distribution: Record<string, number>;  // cardValue -> count
  outliers: string[];                     // userIds
  numericVoteCount: number;
  insufficientData: boolean;
}

// History Entry
export interface HistoryEntry {
  roundId: string;
  storyDescription: string;
  participants: ParticipantVote[];
  metrics: VotingMetrics;
  completedAt: string;  // ISO 8601
  votingDurationMs?: number; // total voting time for this round
  /** Plain array, never a Map, so it survives JSON.stringify/parse unchanged. */
  calloutNotes?: CalloutNote[];
}

// --- Callout Notes ---

/** One short note a participant attached to a Voting_Round. */
export interface CalloutNote {
  id: string;            // UUID, server-assigned
  roundId: string;       // the round the note was WRITTEN FOR, not the current one
  authorId: string;
  authorName: string;    // denormalised so history renders without a participant lookup
  text: string;          // already trimmed; <= NOTE_MAX_LENGTH
  storedAt: string;      // ISO 8601, server clock; the ordering key
}

export const NOTE_MAX_LENGTH = 280;

/** Rejection codes; each maps to exactly one acceptance criterion. */
export type CalloutNoteRejection =
  | 'NOTE_SESSION_MISMATCH'   // R13.13
  | 'NOTE_INVALID'            // malformed payload shape
  | 'NOTE_EMPTY'              // R10.7
  | 'NOTE_TOO_LONG'           // R10.6
  | 'NOTE_ROUND_UNKNOWN'      // R10.8
  | 'NOTE_DUPLICATE';         // R10.17

export const CALLOUT_NOTE_SUBMIT = 'callout:note:submit';
export const CALLOUT_NOTE_ADDED = 'callout:note:added';
export const CALLOUT_NOTE_REJECTED = 'callout:note:rejected';

export interface CalloutNoteSubmitPayload { sessionId: string; roundId: string; text: string; }
export interface CalloutNoteAddedPayload { roundId: string; note: CalloutNote; }
export interface CalloutNoteRejectedPayload {
  roundId: string;
  code: CalloutNoteRejection;
  message: string;
}

/** True when the value has the shape of a CalloutNote (all six fields are strings). */
export function isCalloutNote(value: unknown): value is CalloutNote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['roundId'] === 'string' &&
    typeof v['authorId'] === 'string' &&
    typeof v['authorName'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['storedAt'] === 'string'
  );
}

/** Treats anything that is not a well-formed note array as empty (R13.12). */
export function normaliseCalloutNotes(value: unknown): CalloutNote[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCalloutNote);
}

// Session State (full state for sync on reconnect)
export interface SessionState {
  currentRound: VotingRound | null;
  participants: User[];
  history: HistoryEntry[];
  isRevealed: boolean;
}

// WebSocket Message
export interface WebSocketMessage {
  event: string;
  data: any;
  timestamp: string;  // ISO 8601
}

// --- Multi-Team Session Types ---

// Voting system types
export type VotingSystemType = 'fibonacci' | 'modified-fibonacci' | 't-shirt' | 'power-of-2';

// Extended CardValue to support all voting systems
export type ExtendedCardValue =
  | NumericCardValue
  | SpecialCardValue
  | '½'
  | 20 | 40 | 100
  | 4 | 16 | 32 | 64
  | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';

// Voting system card value mappings
export const VOTING_SYSTEMS: Record<VotingSystemType, ExtendedCardValue[]> = {
  'fibonacci': [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  'modified-fibonacci': [0, '½', 1, 2, 3, 5, 8, 13, 20, 40, 100],
  't-shirt': ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  'power-of-2': [0, 1, 2, 4, 8, 16, 32, 64],
};

/**
 * Card_Numeric_Value: the real number a card contributes to numeric statistics.
 * Absence from this map means "has no Card_Numeric_Value" (specials and t-shirt sizes).
 *
 * A Map (not a Record) so numeric and string keys keep their identity with no coercion.
 */
export const CARD_NUMERIC_VALUE: ReadonlyMap<ExtendedCardValue, number> = new Map<
  ExtendedCardValue,
  number
>([
  // fibonacci (also covers the shared 0, 1, 2, 8 of the other numeric decks)
  [0, 0], [1, 1], [2, 2], [3, 3], [5, 5], [8, 8],
  [13, 13], [21, 21], [34, 34], [55, 55], [89, 89],
  // power-of-2 extras
  [4, 4], [16, 16], [32, 32], [64, 64],
  // modified-fibonacci extras
  ['½', 0.5], [20, 20], [40, 40], [100, 100],
  // coffee, no-clue, break, XS, S, M, L, XL, XXL are intentionally absent
]);

/** The Card_Numeric_Value of a card, or undefined when it has none. */
export function cardNumericValue(value: ExtendedCardValue): number | undefined {
  return CARD_NUMERIC_VALUE.get(value);
}

/** True exactly when the card has a Card_Numeric_Value. */
export function isNumericCard(value: ExtendedCardValue): boolean {
  return CARD_NUMERIC_VALUE.has(value);
}

/**
 * Builds the Card_Ladder of every voting system: the system's cards that have a
 * Card_Numeric_Value, ascending by that value, equal mapped values collapsed.
 * Must run after CARD_NUMERIC_VALUE and VOTING_SYSTEMS are initialised.
 */
export function buildCardLadders(): Record<VotingSystemType, readonly ExtendedCardValue[]> {
  const ladders = {} as Record<VotingSystemType, readonly ExtendedCardValue[]>;
  for (const system of Object.keys(VOTING_SYSTEMS) as VotingSystemType[]) {
    const seen = new Set<number>();
    const ladder: ExtendedCardValue[] = [];
    const numericCards = VOTING_SYSTEMS[system]
      .filter((card) => CARD_NUMERIC_VALUE.has(card))
      .sort((a, b) => (CARD_NUMERIC_VALUE.get(a) as number) - (CARD_NUMERIC_VALUE.get(b) as number));
    for (const card of numericCards) {
      const mapped = CARD_NUMERIC_VALUE.get(card) as number;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      ladder.push(card);
    }
    ladders[system] = ladder;
  }
  return ladders;
}

/**
 * Card_Ladder per voting system, precomputed once at module load.
 *   fibonacci          -> [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
 *   modified-fibonacci -> [0, '½', 1, 2, 3, 5, 8, 13, 20, 40, 100]
 *   power-of-2         -> [0, 1, 2, 4, 8, 16, 32, 64]
 *   t-shirt            -> []
 */
export const CARD_LADDERS: Readonly<Record<VotingSystemType, readonly ExtendedCardValue[]>> =
  buildCardLadders();

/** Ladder of a possibly-unknown system identifier; empty for an unknown one. */
export function cardLadderFor(votingSystem: string): readonly ExtendedCardValue[] {
  return Object.prototype.hasOwnProperty.call(CARD_LADDERS, votingSystem)
    ? CARD_LADDERS[votingSystem as VotingSystemType]
    : [];
}

/** Zero-based index of a card on a ladder, or -1 when absent. */
export function ladderIndexOf(
  ladder: readonly ExtendedCardValue[],
  value: ExtendedCardValue
): number {
  return ladder.indexOf(value);
}

// Permission types
export type PermissionMode = 'moderator-only' | 'all-players' | 'select-specific';

export interface PermissionConfig {
  mode: PermissionMode;
  allowedUserIds: string[]; // only used when mode is 'select-specific'
}

// Session configuration
export interface SessionConfiguration {
  votingSystem: VotingSystemType;
  revealPermission: PermissionConfig;
  issuePermission: PermissionConfig;
  autoReveal: boolean;
  countdownAnimation: boolean;
  gameName?: string;
  /**
   * Controls whether the fun callouts appear in this session.
   * Optional so configuration records that omit it stay valid; an absent or
   * non-boolean value is treated as `true` (see `resolveFunCallouts`).
   */
  funCallouts?: boolean;  // default: true
}

// Default session configuration
export const DEFAULT_SESSION_CONFIG: SessionConfiguration = {
  votingSystem: 'fibonacci',
  revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
  issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
  autoReveal: false,
  countdownAnimation: true,
  funCallouts: true,
};

/**
 * Single coercion point for the `funCallouts` default.
 * Returns the value when it is a boolean, otherwise `true`.
 * Deliberately separate from `resolveFluidCardHeight`: the two fields are independent.
 */
export function resolveFunCallouts(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

// Issue item in the session's issue list
export interface IssueItem {
  id: string;           // UUID
  title: string;
  status: 'pending' | 'estimating' | 'estimated';
  historyEntryId?: string;  // Links to the HistoryEntry when estimated
  createdAt: string;    // ISO 8601
}

// Session summary for the "my sessions" list
export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  completedRounds: number;
  participantCount: number;
  config: SessionConfiguration;
}

// Consensus level type
export type ConsensusLevel = 'full' | 'partial' | 'high-divergence' | 'none';

// Game session state (extends existing SessionState)
export interface GameSessionState extends SessionState {
  sessionId: string;
  config: SessionConfiguration;
  ownerId: string;
  createdAt: string;
  issueList: IssueItem[];
}

// Session info (returned by REST API)
export interface SessionInfo {
  sessionId: string;
  config: SessionConfiguration;
  participantCount: number;
  createdAt: string;
  ownerId: string;
}

// --- Retrospective Board Types ---

// Column layout type
export type ColumnLayout = 'vertical' | 'horizontal';

// --- Retro Participant Feelings Types ---

// Feeling categories available for selection
export type FeelingCategory =
  | 'Satisfaction'
  | 'Frustration'
  | 'Confidence'
  | 'Confusion'
  | 'Boredom'
  | 'Happy'
  | 'No_Feeling'
  | 'Glad'
  | 'Sad'
  | 'Mad';

export const ALL_FEELING_CATEGORIES: FeelingCategory[] = [
  'Satisfaction', 'Frustration', 'Confidence', 'Confusion',
  'Boredom', 'Happy', 'No_Feeling', 'Glad', 'Sad', 'Mad',
];

// Emoji mapping for each feeling category
export const FEELING_EMOJI_MAP: Record<FeelingCategory, string> = {
  Satisfaction: '😌',
  Frustration: '😤',
  Confidence: '💪',
  Confusion: '😕',
  Boredom: '😴',
  Happy: '😊',
  No_Feeling: '😶',
  Glad: '😄',
  Sad: '😢',
  Mad: '😠',
};

export const DEFAULT_ALLOWED_FEELINGS: FeelingCategory[] = ['Happy', 'Sad', 'No_Feeling'];

// WebSocket event type constants for feelings
export const RETRO_FEELING_SELECT = 'retro:feeling:select';
export const RETRO_FEELING_UPDATED = 'retro:feeling:updated';

// Retrospective board configuration
export interface RetroConfiguration {
  boardName: string;
  maxVotesPerUser: number;                // default: 6, positive integer
  templateId: string;                     // references a template
  hideCardsInitially: boolean;            // default: false
  disableVotingInitially: boolean;        // default: false
  hideVoteCount: boolean;                 // default: false
  oneVotePerCard: boolean;                // default: false
  showCardAuthor: boolean;                // default: false
  password: string | null;                // null = no password
  enableGifEmoji: boolean;               // default: true
  columnLayout: ColumnLayout;             // default: 'vertical'
  allowedFeelings: FeelingCategory[];     // ordered list of allowed feelings, min 1, max 10
  /**
   * Sizes the card text area to its content.
   * Optional so configuration records that omit it stay valid; an absent or
   * non-boolean value is treated as `true` (see `resolveFluidCardHeight`).
   */
  fluidCardHeight?: boolean;              // default: true
}

// Retrospective template definition
export interface RetroTemplate {
  id: string;           // kebab-case identifier
  name: string;         // display name
  columns: string[];    // ordered column names
}

// Retrospective board state
export interface RetroBoard {
  columns: RetroColumn[];
  context: string;                        // sprint context description
  cardsRevealed: boolean;                 // moderator has revealed cards
  votingEnabled: boolean;                 // moderator has enabled voting
  isCompleted: boolean;                   // board is locked
}

// Retrospective column
export interface RetroColumn {
  id: string;           // UUID
  name: string;
  cards: RetroCard[];
  order: number;        // position index
}

// Retrospective card
export interface RetroCard {
  id: string;           // UUID
  text: string;
  authorId: string;     // userId of creator
  authorName: string;   // display name of creator
  votes: number;        // total vote count
  votedBy: string[];    // userIds who voted on this card
  comments: RetroComment[];
  columnId: string;     // parent column reference
  order: number;        // position within column
  createdAt: string;    // ISO 8601
}

// Retrospective comment
export interface RetroComment {
  id: string;           // UUID
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;    // ISO 8601
}

// Retrospective session state (full state for sync)
export interface RetroSessionState {
  sessionId: string;
  config: RetroConfiguration;
  board: RetroBoard;
  participants: User[];              // reuses existing User type
  ownerId: string;
  createdAt: string;
  votesRemaining: Record<string, number>; // userId -> remaining votes
  feelings: Record<string, FeelingCategory | null>; // userId -> selected feeling or null
}

// --- Helper Functions ---

/**
 * Returns the card values for a given voting system, including special cards.
 */
export function getCardsForVotingSystem(system: VotingSystemType): ExtendedCardValue[] {
  const systemCards = VOTING_SYSTEMS[system];
  return [...systemCards, ...SPECIAL_CARDS];
}

/**
 * Evaluates whether a user has permission based on their role and the permission configuration.
 */
export function hasPermission(
  userId: string,
  userRole: 'moderator' | 'participant',
  permissionConfig: PermissionConfig
): boolean {
  switch (permissionConfig.mode) {
    case 'moderator-only':
      return userRole === 'moderator';
    case 'all-players':
      return true;
    case 'select-specific':
      return userRole === 'moderator' || permissionConfig.allowedUserIds.includes(userId);
  }
}

/**
 * Formats a duration in milliseconds as MM:SS.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Compute consensus level from voting metrics.
 * - 'full': all numeric voters agree (spread === 0, numericVoteCount >= 2)
 * - 'high-divergence': spread > 5 for numeric systems, or position diff > 2 for t-shirt
 * - 'partial': between full and high-divergence
 * - 'none': insufficient data or no metrics
 */
export function computeConsensusLevel(
  metrics: VotingMetrics | null,
  votingSystem: VotingSystemType
): ConsensusLevel {
  if (!metrics || metrics.insufficientData) return 'none';
  if (metrics.spread === null) return 'none';
  if (metrics.numericVoteCount < 2) return 'none';
  if (metrics.spread === 0) return 'full';

  if (votingSystem === 't-shirt') {
    const T_SHIRT_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    const votedPositions = Object.keys(metrics.distribution)
      .filter(k => T_SHIRT_ORDER.includes(k))
      .map(k => T_SHIRT_ORDER.indexOf(k));
    if (votedPositions.length < 2) return 'none';
    const posSpread = Math.max(...votedPositions) - Math.min(...votedPositions);
    return posSpread > 2 ? 'high-divergence' : 'partial';
  }

  return metrics.spread > 5 ? 'high-divergence' : 'partial';
}

// --- Retrospective card height ---

/**
 * Single coercion point for the `fluidCardHeight` default.
 * Returns the value when it is a boolean, otherwise `true`.
 */
export function resolveFluidCardHeight(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

// --- Retrospective session listing ---

// Summary entry of GET /api/retro/sessions/mine
export interface RetroSessionSummary {
  sessionId: string;
  boardName: string;
  createdAt: string;        // ISO 8601
  lastActivityAt: string;   // ISO 8601
  participantCount: number; // non-negative integer
  cardCount: number;        // non-negative integer
  isCompleted: boolean;
}

// Response body of GET /api/retro/sessions/mine
export interface RetroSessionsResponse {
  sessions: RetroSessionSummary[];
}

// --- Retrospective session end ---

// WebSocket event type constant for a moderator ending a retro session
export const RETRO_SESSION_ENDED = 'retro:session:ended';

// Payload of retro:session:ended
export interface RetroSessionEndedPayload {
  sessionId: string;
}

// --- Connection lifecycle ---

// Shared connection lifecycle state for the poker and retro WebSocket services
export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

// Indicator labels, used as both the title attribute and the visible label
export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  reconnecting: 'Trying to restore connection',
  disconnected: 'Disconnected',
};
