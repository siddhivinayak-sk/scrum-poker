import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as sharedTypes from '../../../shared/types';

/**
 * Static source scan for the session chat (task 16.4).
 *
 * - R13.11: every chat type, constant, event name and the `isChatMessage` guard
 *   is defined once, in `shared/types.ts` or `shared/chat-text.ts`. No file under
 *   `client/src/` or `server/src/` (tests included) declares one of those names
 *   again, and no production file there spells out a chat event name as a string
 *   literal instead of importing the constant.
 * - R19.4: chat files render content without `innerHTML`, `outerHTML`,
 *   `insertAdjacentHTML`, `document.write`, `[innerHTML]`, `[outerHTML]` or
 *   `bypassSecurityTrust*`.
 * - R19.5: chat files use neither `HttpClient` nor `new WebSocket`; chat events go
 *   over the existing Board_Connection only.
 * - R20.5: chat files add no `BehaviorSubject`.
 *
 * The shared names are read from the shared sources, so a new `CHAT_*`,
 * `RETRO_CHAT_*`, `Chat*` or `WS_*` export is covered without editing this file.
 *
 * Chat files (design.md, "Client: chat" file table, plus the two server modules
 * and the shared text module):
 * - `client/src/app/components/chat/**` (`.ts` and `.html`)
 * - `client/src/app/services/chat-*.ts`, `panel-chunk-loader.ts`, `chunk-url.ts`,
 *   `frame-guard.ts`, `board-overlay-layout.ts`, `board-overlay-layout.service.ts`
 * - `server/src/services/chat-room.ts`, `server/src/websocket/chat-send.ts`
 * - `shared/chat-text.ts`
 *
 * Spec and test files are left out of the forbidden-API scans: they build DOM
 * fixtures and assert on escaped markup through `innerHTML`, which renders no chat
 * content. Comments are stripped before scanning, so a comment that names a
 * forbidden API is not a hit; inline Angular templates are string literals and are
 * scanned.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SHARED_TYPES = path.join(REPO_ROOT, 'shared', 'types.ts');
const SHARED_CHAT_TEXT = path.join(REPO_ROOT, 'shared', 'chat-text.ts');
const SCAN_ROOTS = [path.join(REPO_ROOT, 'client', 'src'), path.join(REPO_ROOT, 'server', 'src')];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.angular']);

/** Names in `shared/types.ts` that belong to the chat contract (R13.2–R13.7, R20.12, R23.4). */
const CHAT_NAME_RE = /^(?:(?:RETRO_)?CHAT_\w+|Chat[A-Z]\w*|WS_\w+|isChatMessage|isCanonicalUuid|BoardKind)$/;

// --- Helpers ---------------------------------------------------------------------------------

interface Hit {
  file: string;
  line: number;
  name: string;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Names of the top-level exported declarations of a module. */
export function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!hasExportModifier(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/** Name of a node that declares a variable, function, class, interface, type, enum or namespace. */
function declaredName(node: ts.Node): ts.Identifier | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return node.name;
  }
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  return undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Every declaration, at any nesting depth, whose name is in `names`. */
export function findDeclarations(file: string, text: string, names: ReadonlySet<string>): Hit[] {
  const source = parse(file, text);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    const id = declaredName(node);
    if (id && names.has(id.text)) hits.push({ file, line: lineOf(source, id), name: id.text });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** Every string literal whose value is in `values` (comments are not literals). */
export function findStringLiterals(file: string, text: string, values: ReadonlySet<string>): Hit[] {
  const source = parse(file, text);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && values.has(node.text)) {
      hits.push({ file, line: lineOf(source, node), name: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** Source text with every comment removed; string and template literals are kept verbatim. */
export function withoutComments(file: string, text: string): string {
  if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, '');
  return ts.createPrinter({ removeComments: true }).printFile(parse(file, text));
}

interface ForbiddenPattern {
  label: string;
  pattern: RegExp;
}

const RENDERING_APIS: readonly ForbiddenPattern[] = [
  { label: 'innerHTML', pattern: /\binnerHTML\b/ },
  { label: 'outerHTML', pattern: /\bouterHTML\b/ },
  { label: 'insertAdjacentHTML', pattern: /\binsertAdjacentHTML\b/ },
  { label: 'document.write', pattern: /\bdocument\s*\.\s*write/ },
  { label: '[innerHTML]', pattern: /\[\s*innerHTML\s*\]/ },
  { label: '[outerHTML]', pattern: /\[\s*outerHTML\s*\]/ },
  { label: 'bypassSecurityTrust', pattern: /bypassSecurityTrust/ },
];

const NETWORK_APIS: readonly ForbiddenPattern[] = [
  { label: 'HttpClient', pattern: /HttpClient/ },
  { label: 'new WebSocket', pattern: /\bnew\s+WebSocket\b/ },
];

const STREAM_APIS: readonly ForbiddenPattern[] = [{ label: 'BehaviorSubject', pattern: /\bBehaviorSubject\b/ }];

/** Labels of the patterns found in the comment-free text of a file. */
export function forbiddenIn(file: string, text: string, patterns: readonly ForbiddenPattern[]): string[] {
  const code = withoutComments(file, text);
  return patterns.filter(({ pattern }) => pattern.test(code)).map(({ label }) => label);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function isTestFile(relative: string): boolean {
  return /\.(spec|test)\.ts$/.test(relative) || relative.split('/').includes('__tests__');
}

function isTsSource(relative: string): boolean {
  return relative.endsWith('.ts') && !relative.endsWith('.d.ts');
}

const CHAT_FILE_PATTERNS: readonly RegExp[] = [
  /^client\/src\/app\/components\/chat\/.+\.(ts|html)$/,
  /^client\/src\/app\/services\/chat-[^/]+\.ts$/,
  /^client\/src\/app\/services\/(panel-chunk-loader|chunk-url|frame-guard|board-overlay-layout|board-overlay-layout\.service)\.ts$/,
  /^server\/src\/services\/chat-room\.ts$/,
  /^server\/src\/websocket\/chat-send\.ts$/,
  /^shared\/chat-text\.ts$/,
];

function isChatFile(relative: string): boolean {
  return !isTestFile(relative) && CHAT_FILE_PATTERNS.some((re) => re.test(relative));
}

function format(hits: readonly Hit[]): string[] {
  return hits.map((h) => `${rel(h.file)}:${h.line} ${h.name}`);
}

// --- Inputs ----------------------------------------------------------------------------------

const sharedTypeExports = exportedNames(parse(SHARED_TYPES, fs.readFileSync(SHARED_TYPES, 'utf-8')));
const chatTextExports = exportedNames(parse(SHARED_CHAT_TEXT, fs.readFileSync(SHARED_CHAT_TEXT, 'utf-8')));
const CHAT_NAMES: ReadonlySet<string> = new Set([
  ...sharedTypeExports.filter((name) => CHAT_NAME_RE.test(name)),
  ...chatTextExports,
]);

const sharedValues = sharedTypes as unknown as Readonly<Record<string, unknown>>;
/** Runtime string values of the shared chat constants: the eight event names. */
const CHAT_EVENT_VALUES: ReadonlySet<string> = new Set(
  [...CHAT_NAMES]
    .map((name) => sharedValues[name])
    .filter((value): value is string => typeof value === 'string')
);

const SCANNED_FILES = SCAN_ROOTS.flatMap((root) => walk(root));
const SCANNED_TS = SCANNED_FILES.filter((file) => isTsSource(rel(file)));
const CHAT_FILES = [...SCANNED_FILES, SHARED_CHAT_TEXT].filter((file) => isChatFile(rel(file)));

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

// --- Scanner self-checks ---------------------------------------------------------------------

describe('chat static scan helpers', () => {
  const names = new Set(['CHAT_HISTORY', 'isChatMessage', 'BoardKind']);

  it('finds declarations at any depth and ignores imports, uses and comments', () => {
    const text = [
      "import { CHAT_HISTORY, isChatMessage as guard } from '@shared/types';",
      '// const CHAT_HISTORY = 1;',
      'const used = CHAT_HISTORY;',
      "export const CHAT_HISTORY_TEXT = 'x';",
      'describe("x", () => { type BoardKind = string; });',
      'function isChatMessage(v: unknown): boolean { return guard(v); }',
    ].join('\n');
    expect(findDeclarations('x.ts', text, names).map((h) => `${h.line} ${h.name}`)).toEqual([
      '5 BoardKind',
      '6 isChatMessage',
    ]);
  });

  it('finds string literals but not comments that hold an event name', () => {
    const text = [
      "/** Handle `chat:history`. */",
      "send('chat:history');",
      'send(`chat:history`);',
      "send('chat:history:x');",
    ].join('\n');
    expect(findStringLiterals('x.ts', text, new Set(['chat:history'])).map((h) => h.line)).toEqual([2, 3]);
  });

  it('finds forbidden APIs in code and inline templates but not in comments', () => {
    const code = [
      '// never use innerHTML or new WebSocket here',
      "@Component({ template: `<p [innerHTML]=\"t\"></p>` }) class A {}",
      'el.insertAdjacentHTML("beforeend", s);',
      'const s = new BehaviorSubject(0);',
    ].join('\n');
    expect(forbiddenIn('x.ts', code, RENDERING_APIS)).toEqual(['innerHTML', 'insertAdjacentHTML', '[innerHTML]']);
    expect(forbiddenIn('x.ts', code, NETWORK_APIS)).toEqual([]);
    expect(forbiddenIn('x.ts', code, STREAM_APIS)).toEqual(['BehaviorSubject']);
    expect(forbiddenIn('x.html', '<!-- [outerHTML] --><p>{{ t }}</p>', RENDERING_APIS)).toEqual([]);
  });
});

// --- R13.11 ----------------------------------------------------------------------------------

describe('R13.11: chat names are defined only in shared/', () => {
  it('derives the chat names from the shared sources', () => {
    for (const name of [
      'ChatMessage',
      'ChatRejection',
      'ChatMessageSendPayload',
      'ChatMessageAddedPayload',
      'ChatHistoryPayload',
      'ChatMessageRejectedPayload',
      'BoardKind',
      'CHAT_EVENTS',
      'CHAT_MESSAGE_MAX_LENGTH',
      'CHAT_RAW_TEXT_MAX_LENGTH',
      'CHAT_HISTORY_LIMIT',
      'CHAT_RATE_LIMIT_COUNT',
      'CHAT_RATE_LIMIT_WINDOW_MS',
      'CHAT_ACK_TIMEOUT_MS',
      'CHAT_DEDUP_PER_AUTHOR',
      'CHAT_MESSAGE_SEND',
      'CHAT_MESSAGE_ADDED',
      'CHAT_MESSAGE_REJECTED',
      'CHAT_HISTORY',
      'RETRO_CHAT_MESSAGE_SEND',
      'RETRO_CHAT_MESSAGE_ADDED',
      'RETRO_CHAT_MESSAGE_REJECTED',
      'RETRO_CHAT_HISTORY',
      'WS_MAX_PAYLOAD_BYTES',
      'WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT',
      'CHAT_PANEL_LOAD_RETRY_DELAYS_MS',
      'CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS',
      'isChatMessage',
      'isCanonicalUuid',
      'normaliseChatText',
      'validateChatText',
    ]) {
      expect(CHAT_NAMES).toContain(name);
    }
    expect([...CHAT_EVENT_VALUES].sort()).toEqual([
      'chat:history',
      'chat:message:added',
      'chat:message:rejected',
      'chat:message:send',
      'retro:chat:history',
      'retro:chat:message:added',
      'retro:chat:message:rejected',
      'retro:chat:message:send',
    ]);
  });

  it('scans both client/src and server/src', () => {
    const scanned = SCANNED_TS.map(rel);
    expect(scanned).toContain('client/src/app/services/chat-store.ts');
    expect(scanned).toContain('server/src/websocket/chat-send.ts');
  });

  it('declares no shared chat name a second time under client/src or server/src', () => {
    const hits = SCANNED_TS.flatMap((file) => findDeclarations(file, read(file), CHAT_NAMES));
    expect(format(hits)).toEqual([]);
  });

  it('spells out no chat event name as a string literal in production code', () => {
    const hits = SCANNED_TS.filter((file) => !isTestFile(rel(file))).flatMap((file) =>
      findStringLiterals(file, read(file), CHAT_EVENT_VALUES)
    );
    expect(format(hits)).toEqual([]);
  });
});

// --- R19.4, R19.5, R20.5 ---------------------------------------------------------------------

describe('chat files avoid unsafe rendering, extra transports and BehaviorSubject', () => {
  it('finds the chat files listed in the design', () => {
    const chatFiles = CHAT_FILES.map(rel);
    for (const expected of [
      'client/src/app/components/chat/chat-host.component.ts',
      'client/src/app/components/chat/chat-message-list.component.ts',
      'client/src/app/components/chat/chat-panel.component.ts',
      'client/src/app/services/chat-store.service.ts',
      'client/src/app/services/chat-transport.ts',
      'client/src/app/services/panel-chunk-loader.ts',
      'client/src/app/services/chunk-url.ts',
      'server/src/services/chat-room.ts',
      'server/src/websocket/chat-send.ts',
      'shared/chat-text.ts',
    ]) {
      expect(chatFiles).toContain(expected);
    }
    expect(chatFiles.filter(isTestFile)).toEqual([]);
  });

  const scan = (patterns: readonly ForbiddenPattern[]): string[] =>
    CHAT_FILES.flatMap((file) => forbiddenIn(file, read(file), patterns).map((label) => `${rel(file)} ${label}`));

  it('R19.4: renders chat content without HTML injection APIs', () => {
    expect(scan(RENDERING_APIS)).toEqual([]);
  });

  it('R19.5: uses no HttpClient and opens no WebSocket of its own', () => {
    expect(scan(NETWORK_APIS)).toEqual([]);
  });

  it('R20.5: adds no BehaviorSubject', () => {
    expect(scan(STREAM_APIS)).toEqual([]);
  });
});
