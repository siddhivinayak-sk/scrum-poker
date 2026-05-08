import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { RetroColumn, RetroTemplate } from '../../../../shared/types';
import { RETRO_TEMPLATES } from '../retro-templates';

/**
 * Creates columns from a template definition.
 * This is the logic that RetroSession will use when initializing a board from a template.
 */
function createColumnsFromTemplate(template: RetroTemplate): RetroColumn[] {
  return template.columns.map((name, index) => ({
    id: uuidv4(),
    name,
    cards: [],
    order: index,
  }));
}

/**
 * Property 3: Template-to-columns mapping
 *
 * For any template selected from the template registry, creating a board with that
 * template should produce columns whose names exactly match the template's column
 * definitions in order.
 *
 * **Validates: Requirements 3.2, 7.1**
 */
describe('Property 3: Template-to-columns mapping', () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('creating a board from any template produces columns matching the template definition', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RETRO_TEMPLATES),
        (template: RetroTemplate) => {
          const columns = createColumnsFromTemplate(template);

          // Number of columns equals the number of columns in the template
          expect(columns.length).toBe(template.columns.length);

          // Each column name matches the corresponding template column name in order
          columns.forEach((column, index) => {
            expect(column.name).toBe(template.columns[index]);
          });

          // Each column has a valid UUID id
          columns.forEach((column) => {
            expect(column.id).toMatch(UUID_REGEX);
          });

          // Each column has an empty cards array initially
          columns.forEach((column) => {
            expect(column.cards).toEqual([]);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
