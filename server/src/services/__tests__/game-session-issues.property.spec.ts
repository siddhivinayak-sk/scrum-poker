import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, IssueItem } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Arbitrary generator for an IssueItem (used to pre-populate the issue list).
 * Filters out whitespace-only strings since addIssue rejects them.
 */
function arbIssueItem(): fc.Arbitrary<{ title: string }> {
  return fc.record({
    title: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
  });
}

/**
 * Property 5: Issue list add appends correctly
 *
 * For any game session with an existing issue list of length N, adding a new issue
 * with a non-empty title SHALL result in an issue list of length N+1 where the last
 * item has the given title and status 'pending'.
 *
 * **Validates: Requirements 7.2**
 */
describe('Property 5: Issue list add appends correctly', () => {
  it('adding an issue to a list of length N results in length N+1 with correct last item', () => {
    fc.assert(
      fc.property(
        fc.record({
          existingIssues: fc.array(arbIssueItem()),
          newTitle: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        }),
        ({ existingIssues, newTitle }) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Pre-populate the issue list with existing issues
          for (const issue of existingIssues) {
            session.addIssue(issue.title);
          }

          const N = session.getIssueList().length;

          // Add the new issue
          session.addIssue(newTitle);

          const issueList = session.getIssueList();

          // 1. List length increased by 1
          expect(issueList.length).toBe(N + 1);

          const lastItem = issueList[issueList.length - 1];

          // 2. Last item has the given title (trimmed)
          expect(lastItem.title).toBe(newTitle.trim());

          // 3. Last item has status 'pending'
          expect(lastItem.status).toBe('pending');

          // 4. Last item has a valid UUID id
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          expect(lastItem.id).toMatch(uuidRegex);

          // 5. Last item has a valid ISO 8601 createdAt
          const isoDate = new Date(lastItem.createdAt);
          expect(isoDate.toISOString()).toBe(lastItem.createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 6: Bulk import parsing splits on newlines
 *
 * For any string containing newline characters, bulk importing SHALL produce one issue
 * for each non-empty, non-whitespace-only line. The number of resulting issues SHALL
 * equal the number of non-empty trimmed lines, and each issue's title SHALL equal the
 * corresponding trimmed line.
 *
 * **Validates: Requirements 7.3**
 */
describe('Property 6: Bulk import parsing splits on newlines', () => {
  it('bulk importing a multi-line string produces one issue per non-empty trimmed line', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.string({ minLength: 1 }), fc.constant('')),
          { minLength: 0, maxLength: 30 },
        ),
        (lines) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Simulate bulk import: join lines with newlines, then split and pass to addIssues
          const bulkText = lines.join('\n');
          const splitLines = bulkText.split('\n');
          const createdIssues = session.addIssues(splitLines);

          // Determine expected non-empty trimmed lines
          const expectedLines = splitLines
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          // 1. Number of created issues equals number of non-empty trimmed lines
          expect(createdIssues.length).toBe(expectedLines.length);

          // 2. Each issue's title matches the corresponding trimmed line
          for (let i = 0; i < createdIssues.length; i++) {
            expect(createdIssues[i].title).toBe(expectedLines[i]);
          }

          // 3. The session's issue list matches
          const issueList = session.getIssueList();
          expect(issueList.length).toBe(expectedLines.length);
          for (let i = 0; i < issueList.length; i++) {
            expect(issueList[i].title).toBe(expectedLines[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 7: Issue list reorder produces correct order
 *
 * For any issue list and for any valid permutation of issue IDs (containing exactly
 * the same IDs as the current list), reordering SHALL produce a list where the issues
 * appear in the order specified by the permutation, with all issue data preserved.
 *
 * **Validates: Requirements 7.4**
 */
describe('Property 7: Issue list reorder produces correct order', () => {
  it('reordering with a valid permutation produces the correct order with data preserved', () => {
    // Generator that produces non-whitespace-only titles
    const arbNonEmptyTitle = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
    const arbValidIssueItem = fc.record({ title: arbNonEmptyTitle });

    fc.assert(
      fc.property(
        fc.array(arbValidIssueItem, { minLength: 1, maxLength: 20 }),
        (issueTitles) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add issues to the session
          for (const item of issueTitles) {
            session.addIssue(item.title);
          }

          const originalList = session.getIssueList();
          const originalIds = originalList.map((issue) => issue.id);

          // Create a shuffled permutation of the IDs
          const shuffledIds = [...originalIds].sort(() => Math.random() - 0.5);

          // Build a map of original issue data by ID for comparison
          const originalDataById = new Map(
            originalList.map((issue) => [issue.id, { ...issue }]),
          );

          // Reorder
          session.reorderIssues(shuffledIds);

          const reorderedList = session.getIssueList();

          // 1. Length is preserved
          expect(reorderedList.length).toBe(originalList.length);

          // 2. Issues appear in the order specified by shuffledIds
          for (let i = 0; i < shuffledIds.length; i++) {
            expect(reorderedList[i].id).toBe(shuffledIds[i]);
          }

          // 3. All issue data is preserved (title, status, createdAt)
          for (const issue of reorderedList) {
            const original = originalDataById.get(issue.id)!;
            expect(issue.title).toBe(original.title);
            expect(issue.status).toBe(original.status);
            expect(issue.createdAt).toBe(original.createdAt);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 8: Issue selection starts round with correct description
 *
 * For any game session with an issue list containing at least one pending issue,
 * selecting that issue for estimation SHALL start a new voting round whose
 * storyDescription equals the selected issue's title, and the issue's status
 * SHALL change to 'estimating'.
 *
 * **Validates: Requirements 7.6**
 */
describe('Property 8: Issue selection starts round with correct description', () => {
  it('selecting an issue starts a round with matching storyDescription and marks issue as estimating', () => {
    const arbNonEmptyTitle = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
    const arbValidIssueItem = fc.record({ title: arbNonEmptyTitle });

    fc.assert(
      fc.property(
        fc.array(arbValidIssueItem, { minLength: 1, maxLength: 20 }),
        fc.nat(),
        (issueTitles, indexSeed) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add issues to the session
          for (const item of issueTitles) {
            session.addIssue(item.title);
          }

          const issueList = session.getIssueList();
          // Pick a random issue from the list
          const selectedIndex = indexSeed % issueList.length;
          const selectedIssue = issueList[selectedIndex];

          // Select the issue for estimation
          const round = session.selectIssueForEstimation(selectedIssue.id);

          // 1. The round's storyDescription equals the selected issue's title
          expect(round.storyDescription).toBe(selectedIssue.title);

          // 2. The round status is 'voting'
          expect(round.status).toBe('voting');

          // 3. The issue's status changed to 'estimating'
          const updatedIssueList = session.getIssueList();
          const updatedIssue = updatedIssueList.find((i) => i.id === selectedIssue.id);
          expect(updatedIssue!.status).toBe('estimating');

          // 4. The current round matches the returned round
          expect(session.getCurrentRound()).toBe(round);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 9: Issue list included in session state
 *
 * For any game session with an issue list, getSessionState() SHALL return a
 * GameSessionState object whose issueList field is equal to the session's
 * current issue list (same items, same order).
 *
 * **Validates: Requirements 7.7**
 */
describe('Property 9: Issue list included in session state', () => {
  it('getSessionState() returns issueList matching the current issue list', () => {
    const arbNonEmptyTitle = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
    const arbValidIssueItem = fc.record({ title: arbNonEmptyTitle });

    fc.assert(
      fc.property(
        fc.array(arbValidIssueItem, { minLength: 0, maxLength: 20 }),
        (issueTitles) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add issues to the session
          for (const item of issueTitles) {
            session.addIssue(item.title);
          }

          const issueList = session.getIssueList();
          const sessionState = session.getSessionState();

          // 1. issueList field exists in session state
          expect(sessionState.issueList).toBeDefined();

          // 2. Same length
          expect(sessionState.issueList.length).toBe(issueList.length);

          // 3. Same items in same order
          for (let i = 0; i < issueList.length; i++) {
            expect(sessionState.issueList[i].id).toBe(issueList[i].id);
            expect(sessionState.issueList[i].title).toBe(issueList[i].title);
            expect(sessionState.issueList[i].status).toBe(issueList[i].status);
            expect(sessionState.issueList[i].createdAt).toBe(issueList[i].createdAt);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
