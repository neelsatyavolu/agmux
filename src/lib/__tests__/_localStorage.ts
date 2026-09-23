/**
 * Minimal in-memory localStorage polyfill for node-environment Vitest tests.
 * Tests that touch localStorage should call installLocalStorage() in beforeEach
 * and clearLocalStorage() in afterEach (or beforeEach) to avoid cross-test
 * leakage. Idempotent — safe to call repeatedly.
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

export function installLocalStorage(): MemoryStorage {
  const fresh = new MemoryStorage();
  // Reassign on globalThis so module-level references pick up the new instance
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: fresh,
  });
  return fresh;
}

export function clearLocalStorage(): void {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls && typeof ls.clear === "function") {
    ls.clear();
  }
}
