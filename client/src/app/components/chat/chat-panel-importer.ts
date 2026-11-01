import type { Type } from '@angular/core';

/**
 * The only module that names the Chat_Panel (design "The importer and the
 * Chunk_URL", R20.4, R20.13).
 *
 * `chat-panel.component.ts` and its children are reached only through the
 * dynamic `import()` below, so the application builder emits them as the
 * Deferred chat chunk and rewrites the specifier to that file, relative to the
 * chunk holding this module, for example `import("./chunk-EVDY74SK.js")`.
 *
 * Keep both exports in this one module and keep `importChatPanel` a plain
 * arrow whose body starts with a literal relative `import()`:
 * - `resolveChunkUrl` (`services/chunk-url.ts`) reads the rewritten specifier
 *   from `importChatPanel`'s source text and resolves it against
 *   `CHAT_PANEL_IMPORTER_BASE_URL`. esbuild never splits a module across
 *   chunks, so `import.meta.url` is the URL of the chunk that holds the
 *   specifier, including any `BASE_PATH` prefix.
 * - `client/scripts/check-chat-chunk.mjs` (R22.19) finds the importer chunk by
 *   this file name and checks the same specifier.
 *
 * Do not import `./chat-panel.component` statically anywhere in the
 * application; that would pull the panel into the board page chunks.
 */
export const importChatPanel = (): Promise<Type<unknown>> =>
  import('./chat-panel.component').then((m) => m.ChatPanelComponent);

/** `import.meta.url` of the chunk holding `importChatPanel` (R20.13). */
export const CHAT_PANEL_IMPORTER_BASE_URL: string = import.meta.url;
