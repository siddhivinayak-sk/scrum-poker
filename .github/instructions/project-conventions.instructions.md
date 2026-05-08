---
description: "Use when adding components, services, WebSocket events, REST routes, shared types, or any new feature. Covers naming conventions, Angular template style, component anatomy, server event/route shapes, CSS theming, and the correct order for end-to-end feature implementation."
applyTo: "**/*.ts"
---
# Project Conventions

> For no-regression, security, and TypeScript quality rules see [code-quality.instructions.md](code-quality.instructions.md).  
> For project layout, build commands, and common pitfalls see [AGENTS.md](../../AGENTS.md).

## Naming Conventions

| Artefact | Pattern | Examples |
|----------|---------|---------|
| Component class | `PascalCase` + `Component` suffix | `CardDeckComponent`, `RetroColumnComponent` |
| Component file | `kebab-case.component.ts` | `card-deck.component.ts` |
| Service class | `PascalCase` + `Service` suffix | `SessionStateService` |
| Service file | `kebab-case.service.ts` | `session-state.service.ts` |
| Guard | camelCase functional guard | `authGuard`, `sessionAuthGuard` |
| Poker WS events | `domain:action` string | `card:select`, `cards:reveal`, `issue:add` |
| Retro WS events | `retro:domain:action` string | `retro:card:add`, `retro:column:rename` |
| REST error body | `{ error: 'SCREAMING_SNAKE_CODE' }` | `{ error: 'UNAUTHORIZED' }` |
| REST success status | `201` for create, `200` for other | `res.status(201).json({ sessionId })` |

## New Feature — Implementation Order

When adding a new feature end-to-end, always work in this sequence to avoid type errors cascading:

1. **`shared/types.ts`** — define or extend interfaces, enums, event strings
2. **`server/src/services/game-session.ts`** — add logic to `GameSession` class
3. **`server/src/websocket/handler.ts`** (or `retro-handler.ts`) — add `case` to the switch
4. **`client/src/app/services/`** — expose via `WebSocketService` or `SessionStateService`
5. **`client/src/app/components/`** — create component folder; update parent/route if needed
6. **Tests** — `*.spec.ts` (server: Jest; client: Vitest); property-based tests in `*.property.spec.ts` via `fast-check`

## Angular Component Anatomy

Follow this order within every component class:

```ts
@Component({
  selector: 'app-<kebab-name>',
  standalone: true,
  imports: [/* only what this component uses */],
  template: `...`,       // always inline — no separate .html files
  styles: [`...`]        // or styleUrl for larger SCSS
})
export class MyComponent {
  // 1. inject() dependencies
  private readonly stateService = inject(SessionStateService);

  // 2. signal() state
  private readonly _open = signal(false);

  // 3. computed() derived state (public)
  readonly open = this._open.asReadonly();

  // 4. Lifecycle hooks (ngOnInit, ngOnDestroy)

  // 5. Public methods (event handlers, actions)

  // 6. Private helper methods
}
```

- Use **inline templates** (`template: \`...\``) not separate `.html` files.
- Use modern Angular control flow directives: `@if`, `@for`, `@switch` — not `*ngIf`, `*ngFor`, `*ngSwitch`.
- Use `@for (item of items; track item.id)` — always provide a `track` expression.
- Use `inject()` for dependencies — avoid constructor injection for new code.

## CSS & Theming

- Reference colours and surfaces via CSS custom properties defined in `styles.scss`: `var(--color-primary)`, `var(--card-color-0)`, etc. — never hard-code colours.
- Class names follow BEM-lite: `block`, `block__element`, `block--modifier` (e.g., `poker-page__header`, `card--selected`).
- Respect `prefers-reduced-motion` for any animation added to a component.

## WebSocket Messages

- Always construct outgoing messages via the existing `createMessage(event, data)` helper in the handler — never build raw JSON strings inline.
- New events must be added to both the server `switch` **and** documented in `shared/types.ts` (as a string literal type or comment) so all consumers stay in sync.
- Retro events **must** live in `retro-handler.ts` and use the `retro:` prefix; poker events stay in `handler.ts`.

## REST Routes

- All routes must call `authenticateRequest(req)` first and return `401` before any business logic.
- Return `res.status(201).json(...)` for resource creation, `200` for updates/reads.
- Error responses always use `{ error: 'SCREAMING_SNAKE_CODE' }` — never expose raw exception messages.

## Deployment Awareness

- `BASE_PATH` is injected into `window.__BASE_PATH__` by the server at runtime — use `BasePathService.getApiUrl()` / `getWsUrl()` on the client; never hardcode `/api` or `ws://localhost`.
- Health check endpoint `/api/health` must remain accessible regardless of `BASE_PATH` — do not gate it behind auth or prefix middleware.
