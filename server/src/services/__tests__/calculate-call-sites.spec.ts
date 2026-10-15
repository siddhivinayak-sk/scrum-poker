import * as fs from 'fs';
import * as path from 'path';

/**
 * Source-scan test (task 4.5): every production `calculate(` call under
 * `server/src/services/` must pass a voting system as its second argument.
 *
 * Validates: Requirements 15.10
 */

interface CallSite {
  /** 1-based line number of the `calculate(` occurrence. */
  line: number;
  /** Number of top-level, non-empty arguments in the call. */
  argCount: number;
}

/**
 * Blank out comments and string/template literal contents (keeping newlines
 * and overall length) so that `calculate(` inside them is never matched and
 * parentheses/commas inside literals never confuse argument counting.
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = (ch: string): string => (ch === '\n' || ch === '\r' ? ch : ' ');

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(blank(src[i]));
        i++;
      }
      if (i < src.length) {
        out.push(' ', ' ');
        i += 2;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out.push(' ', blank(src[i + 1]));
          i += 2;
          continue;
        }
        // Single/double-quoted strings cannot span lines; stop on a stray newline.
        if (quote !== '`' && src[i] === '\n') break;
        out.push(blank(src[i]));
        i++;
      }
      if (i < src.length && src[i] === quote) {
        out.push(quote);
        i++;
      }
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

/**
 * Find every free-function call `calculate(...)` in a TypeScript source and
 * count its top-level arguments. Skips `.calculate(` method calls,
 * `function calculate(` declarations, comments and string literals.
 */
function findCalculateCalls(source: string): CallSite[] {
  const code = stripCommentsAndStrings(source);
  const re = /calculate\s*\(/g;
  const sites: CallSite[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    const start = m.index;
    const before = code.slice(0, start);

    // Part of a longer identifier (e.g. `recalculate(`, `$calculate(`).
    if (/[\w$]$/.test(before)) continue;
    // Method call / property access (`.calculate(`, `?.calculate(`).
    if (/\.\s*$/.test(before)) continue;
    // Declaration (`function calculate(`).
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;

    // Walk to the matching close paren, counting top-level commas.
    const openIdx = start + m[0].length - 1;
    let depth = 0;
    let commas = 0;
    let lastCommaIdx = -1;
    let closeIdx = -1;
    for (let j = openIdx; j < code.length; j++) {
      const c = code[j];
      if (c === '(' || c === '[' || c === '{') {
        depth++;
      } else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          closeIdx = j;
          break;
        }
      } else if (c === ',' && depth === 1) {
        commas++;
        lastCommaIdx = j;
      }
    }
    if (closeIdx === -1) {
      throw new Error(`Unbalanced parentheses for calculate( at offset ${start}`);
    }

    const inner = code.slice(openIdx + 1, closeIdx);
    let argCount = 0;
    if (inner.trim().length > 0) {
      // A trailing comma does not introduce another argument.
      const afterLastComma = lastCommaIdx >= 0 ? code.slice(lastCommaIdx + 1, closeIdx) : '';
      argCount = commas + 1;
      if (commas > 0 && afterLastComma.trim().length === 0) argCount -= 1;
    }

    const line = code.slice(0, start).split('\n').length;
    sites.push({ line, argCount });
  }
  return sites;
}

const SERVICES_DIR = path.resolve(__dirname, '..');
const EXCLUDED_FILES = new Set(['metrics-engine.ts']);

function listProductionServiceFiles(): string[] {
  return fs
    .readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !EXCLUDED_FILES.has(e.name))
    .map((e) => e.name)
    .sort();
}

describe('calculate( call-site source scan (Requirement 15.10)', () => {
  describe('scanner self-check (cannot pass vacuously)', () => {
    const SAMPLE = [
      '// calculate(selections) in a line comment is ignored',
      '/* calculate(selections) in a block comment is ignored */',
      "const s = 'calculate(selections)';",
      'const t = `calculate(selections)`;',
      'function calculate(a: number, b: number) {}',
      'const x = obj.calculate(a);',
      'const y = recalculate(a);',
      'const one = calculate(a);',
      'const two = calculate(a, b);',
      'const nested = calculate(foo(a, b));',
      'const nestedTwo = calculate(foo(a, b), cfg.votingSystem);',
      'const multi = calculate(',
      '  makeMap([["a", 1], ["b", 2]]),',
      '  system,',
      ');',
      'const none = calculate();',
    ].join('\n');

    it('finds exactly the real free-function calls in a known sample', () => {
      const sites = findCalculateCalls(SAMPLE);
      expect(sites.map((s) => s.argCount)).toEqual([1, 2, 1, 2, 2, 0]);
      expect(sites.map((s) => s.line)).toEqual([8, 9, 10, 11, 12, 16]);
    });

    it('flags a single-argument call as lacking a voting system', () => {
      const sites = findCalculateCalls('const m = calculate(this.round.selections);');
      expect(sites).toHaveLength(1);
      expect(sites[0].argCount).toBeLessThan(2);
    });

    it('does not confuse a comma inside a nested call or literal with a second argument', () => {
      const sites = findCalculateCalls("calculate(pick(a, b), 'x');\ncalculate(pick(a, 'b,c'));");
      expect(sites.map((s) => s.argCount)).toEqual([2, 1]);
    });
  });

  describe('production sources under server/src/services/', () => {
    const files = listProductionServiceFiles();
    const sitesByFile = new Map<string, CallSite[]>();
    for (const file of files) {
      const source = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf8');
      sitesByFile.set(file, findCalculateCalls(source));
    }

    it('scans the expected production files (guard against an empty scan)', () => {
      expect(files).toEqual(expect.arrayContaining(['game-session.ts', 'session-manager.ts']));
      expect(files).not.toContain('metrics-engine.ts');
    });

    it('every calculate( call site passes a second (voting system) argument', () => {
      const offenders: string[] = [];
      for (const [file, sites] of sitesByFile) {
        for (const site of sites) {
          if (site.argCount < 2) offenders.push(`${file}:${site.line} (args: ${site.argCount})`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('finds exactly four call sites: two in game-session.ts and two in session-manager.ts', () => {
      const counts: Record<string, number> = {};
      for (const [file, sites] of sitesByFile) {
        if (sites.length > 0) counts[file] = sites.length;
      }
      expect(counts).toEqual({ 'game-session.ts': 2, 'session-manager.ts': 2 });

      const total = [...sitesByFile.values()].reduce((n, s) => n + s.length, 0);
      expect(total).toBe(4);
    });
  });
});
