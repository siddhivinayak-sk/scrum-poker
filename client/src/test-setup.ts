/**
 * Test setup file for vitest + jsdom environment.
 * Provides polyfills for globals that jsdom may not expose correctly on CI.
 *
 * Note: This file runs AFTER Angular TestBed initialization.
 * For pre-initialization polyfills, Node version compatibility is the primary fix.
 */

// Ensure localStorage is available (jsdom may not provide it in headless CI)
if (typeof globalThis.localStorage === 'undefined') {
  const createMockStorage = (): Storage => {
    const store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { Object.keys(store).forEach(k => delete store[k]); },
      get length() { return Object.keys(store).length; },
      key: (index: number) => Object.keys(store)[index] ?? null,
    } as Storage;
  };
  (globalThis as any).localStorage = createMockStorage();
}

if (typeof globalThis.sessionStorage === 'undefined') {
  const createMockStorage = (): Storage => {
    const store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { Object.keys(store).forEach(k => delete store[k]); },
      get length() { return Object.keys(store).length; },
      key: (index: number) => Object.keys(store)[index] ?? null,
    } as Storage;
  };
  (globalThis as any).sessionStorage = createMockStorage();
}
