import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ChatMessage, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import { ChatMessageListComponent } from './chat-message-list.component';
import { avatarInitials } from './chat-format';

// Feature: session-chat, Property 29: Message content renders as plain text

const NUM_RUNS = 100;
const ME = 'me';

/** Manual clock: timers fire only through `advance`. */
class ManualTimers implements ChatTimers {
  time = 1_000_000;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.pending.delete(handle)) timer.callback();
    }
  }
}

class FakeTransport implements ChatTransport {
  readonly boardKind = 'poker' as const;
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>(ME);
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  readonly sent: ChatMessageSendPayload[] = [];
  send(payload: ChatMessageSendPayload): boolean {
    this.sent.push(payload);
    return true;
  }
}

function id(seq: number): string {
  return `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`;
}

function message(seq: number, own: boolean, authorName: string, text: string): ChatMessage {
  return {
    id: id(seq),
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId: own ? ME : `other-${seq}`,
    authorName,
    text,
    sentAt: new Date(1_000_000 + seq).toISOString(),
  };
}

// --- Generators --------------------------------------------------------------------------

/** Markup, entity, Angular-template and Unicode fragments that a naive renderer would mangle. */
const FRAGMENTS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<b>bold</b>',
  '<i>',
  '</p>',
  '<p class="chat-msg__text">',
  '<a href="javascript:alert(1)">link</a>',
  'javascript:alert(1)',
  '<iframe src="https://example.com"></iframe>',
  '<svg onload=alert(1)><circle/></svg>',
  '<style>*{display:none}</style>',
  '<div onclick="alert(1)" style="color:red">x</div>',
  '" onmouseover="alert(1)',
  "' autofocus onfocus='alert(1)",
  '<!-- comment -->',
  '<![CDATA[x]]>',
  '&amp;',
  '&lt;',
  '&gt;',
  '&quot;',
  '&#60;script&#62;',
  '&nbsp;',
  '{{ 1 + 1 }}',
  '{{row.author}}',
  "{{ constructor.constructor('alert(1)')() }}",
  '@if (true) { yes }',
  '{',
  '}',
  '<',
  '>',
  '"',
  "'",
  '`',
  '\\',
  '\n',
  '\r\n',
  '\t',
  '  ',
  '\u00a0',
  '😀',
  '👨‍👩‍👧‍👦',
  '🇮🇳',
  'مرحبا بالعالم',
  'שלום',
  '\u202Eevil\u202C',
  '\u200B',
  '\u200C',
  '\u200D',
  '\uFEFF',
  'e\u0301',
] as const;

const loneSurrogate = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((code) => String.fromCharCode(code));

const piece = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...FRAGMENTS) },
  { weight: 2, arbitrary: fc.string({ maxLength: 12 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 6 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 6 }) },
  { weight: 1, arbitrary: fc.string({ unit: loneSurrogate, maxLength: 2 }) },
);

/** Any string, biased towards markup-like content; empty strings included. */
const content = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join(''));

interface GeneratedMessage {
  readonly own: boolean;
  readonly authorName: string;
  readonly text: string;
}

const generatedMessage: fc.Arbitrary<GeneratedMessage> = fc.record({
  own: fc.boolean(),
  authorName: content,
  text: content,
});

// --- DOM helpers -------------------------------------------------------------------------

/** Rendered rows by `data-key`, in DOM order. */
function rows(log: HTMLElement): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  for (const child of Array.from(log.children)) {
    if (child instanceof HTMLElement && child.dataset['key'] !== undefined) {
      result.set(child.dataset['key'], child);
    }
  }
  return result;
}

/**
 * Structure of a row: every element (the row and its descendants, in document order) as tag
 * name, class list and sorted attribute names. Attribute values are left out because `data-key`,
 * `datetime` and the avatar colour legitimately differ between rows.
 */
function structure(row: HTMLElement): string[] {
  return [row, ...Array.from(row.querySelectorAll('*'))].map((el) => {
    const attributes = Array.from(el.attributes)
      .map((a) => a.name)
      .sort()
      .join(',');
    return `${el.tagName}.${Array.from(el.classList).sort().join('.')}[${attributes}]`;
  });
}

const FORBIDDEN = 'script, img, a, b, i, iframe, svg, style, object, embed, link, meta, form, input';

function onAttributes(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      if (a.name.toLowerCase().startsWith('on')) found.push(`${el.tagName}[${a.name}]`);
    }
  }
  return found;
}

// --- Property ----------------------------------------------------------------------------

describe('ChatMessageListComponent: Property 29 (R5.8)', () => {
  it('renders text and authorName literally and creates no element from either', async () => {
    const transport = new FakeTransport();
    const timers = new ManualTimers();
    const storage = new Map<string, string>();
    const { fixture, container } = await render(ChatMessageListComponent, {
      providers: [
        ChatStore,
        { provide: CHAT_TRANSPORT, useValue: transport },
        { provide: CHAT_TIMERS, useValue: timers },
        {
          provide: CHAT_READ_MARKER_STORE,
          useValue: new ReadMarkerStore(() => ({
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => void storage.set(k, v),
          })),
        },
      ],
    });
    const store = TestBed.inject(ChatStore);
    const log = container.querySelector<HTMLElement>('[role="log"]');
    if (log === null) throw new Error('Message_List log element not rendered');

    let run = 0;
    fc.assert(
      fc.property(fc.array(generatedMessage, { minLength: 1, maxLength: 4 }), (generated) => {
        // A fresh Board_Session per run reuses the one rendered component.
        store.reset(`s${++run}`);
        fixture.detectChanges();

        // Baseline rows from plain text: seq 1 is another participant's, seq 2 is own.
        const baselineOther = message(1, false, 'Plain Name', 'plain text');
        const baselineOwn = message(2, true, 'Plain Me', 'plain text');
        const messages = [
          baselineOther,
          baselineOwn,
          ...generated.map((g, i) => message(i + 3, g.own, g.authorName, g.text)),
        ];
        transport.history$.next({ messages });
        fixture.detectChanges();

        const rendered = rows(log);
        expect([...rendered.keys()]).toEqual(messages.map((m) => m.id));
        const otherShape = structure(rendered.get(baselineOther.id)!);
        const ownShape = structure(rendered.get(baselineOwn.id)!);

        generated.forEach((g, i) => {
          const row = rendered.get(id(i + 3))!;
          // Exactly the component's static structure; nothing created from text or authorName.
          expect(structure(row)).toEqual(g.own ? ownShape : otherShape);

          const text = row.querySelector('.chat-msg__text');
          const author = row.querySelector('.chat-msg__author');
          expect(text?.textContent).toBe(g.text);
          expect(author?.textContent).toBe(g.own ? 'You' : g.authorName);
          // Text and author hold text nodes only ({{ }} and markup are never evaluated).
          for (const node of [text, author]) {
            for (const child of Array.from(node?.childNodes ?? [])) {
              expect(child.nodeType).toBe(Node.TEXT_NODE);
            }
          }
          const avatar = row.querySelector('.chat-msg__avatar');
          if (g.own) expect(avatar).toBeNull();
          else expect(avatar?.textContent).toBe(avatarInitials(g.authorName));
        });

        expect(log.querySelector(FORBIDDEN)).toBeNull();
        expect(onAttributes(log)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
