---
description: "Use when writing, modifying, or reviewing any code change. Enforces no-regression safety, TypeScript best practices, Angular/Node.js performance patterns, and OWASP security rules for this scrum-poker codebase."
applyTo: "**/*.ts"
---
# Code Quality & Safety Standards

## No Regression
- Before changing a function, method, or type, check all usages — verify every caller is still satisfied after the change.
- Do not alter the shape of types or exported symbols in `shared/types.ts` without updating all consumers on both client and server.
- After any logic change, run `cd server && npm test` and `cd client && npm test` to verify no tests break.
- Do not remove or rename exported symbols without updating all import sites across the workspace.

## TypeScript
- No `any` — use `unknown` with type guards, or narrow the type precisely. Never suppress errors with `@ts-ignore` or `@ts-expect-error` without a comment explaining why.
- Honour all enabled strict flags: `strict`, `noImplicitReturns`, `strictTemplates`, `noImplicitOverride`. Fix the root cause instead of suppressing the diagnostic.
- Prefer `readonly` properties and immutable patterns; mutate state only through the owning class or service.
- Use discriminated unions over boolean flags when the data shape changes with state.

## Angular (client)
- **Standalone components only** — declare `imports: []` in every component; never introduce NgModules.
- **Signals-first state** — use `signal()`, `computed()`, `effect()` for reactive state. Do not introduce new RxJS `BehaviorSubject` or `Subject` streams unless bridging from WebSocket events.
- All new routes must use `loadComponent()` (lazy loading) in `app.routes.ts`.
- Import shared types via the `@shared/types` path alias — never via relative paths like `../../shared/types`.
- Do not bypass Angular's built-in sanitization: avoid `innerHTML` binding and never call `DomSanitizer.bypassSecurityTrust*` without explicit justification.

## Node.js / Express (server)
- Validate and sanitize all user-supplied input at REST route and WebSocket entry points before passing to services.
- Use `GameSession` methods for all session-state mutation — do not access or modify its private fields from outside the class.
- Keep poker and retro concerns strictly isolated: separate registries (`session-registry.ts` vs `retro-session-registry.ts`), handlers, and routes.
- Never log JWT tokens, passwords, or secrets — redact sensitive fields before writing to console or logs.

## Performance
- Keep synchronous loops over large collections out of WebSocket message handlers; move heavy computation to a helper and keep the handler thin.
- On the client, prefer `computed()` over `effect()` for derived values; avoid causing unnecessary re-renders inside `effect()` callbacks.
- Avoid importing large libraries at the top-level of lazy-loaded route components — use dynamic `import()` for heavy one-off dependencies to keep chunk sizes small.

## Security (OWASP)
- JWT authorization must rely on `jsonwebtoken.verify()` on the server — never trust client-decoded or client-provided token payloads for access-control decisions.
- Do not expose internal error stack traces in HTTP or WebSocket error responses; return a generic message to the client and log details server-side.
- Avoid storing sensitive data beyond the established keys (`scrum-poker-token`, `scrum-poker-user`) in `localStorage`; never store passwords or raw secrets client-side.
- When constructing any dynamic query, path, or command from user input, validate and whitelist inputs to prevent injection attacks.
