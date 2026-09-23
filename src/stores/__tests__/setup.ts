// Test setup: polyfill browser globals that stores expect.
// Vitest config uses environment: "node" for speed, but Zustand stores
// touch localStorage and crypto.randomUUID at module-init time.

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();

// Replace whatever Node provides (Node 25 ships an empty stub) with a real
// in-memory implementation. Use defineProperty since `localStorage` may be
// non-writable on the global.
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  writable: true,
  configurable: true,
});

// Provide a sessionStorage too — some downstream code may touch it.
Object.defineProperty(globalThis, "sessionStorage", {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
});

// crypto.randomUUID exists in Node 19+; nothing to polyfill there. But guard
// in case some import shadows it.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let n = 0;
  Object.defineProperty(globalThis, "crypto", {
    value: {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `00000000-0000-0000-0000-${(n++).toString(16).padStart(12, "0")}`,
    },
    writable: true,
    configurable: true,
  });
}

/** Helper for tests that want a clean storage between cases. */
export function clearLocalStorage(): void {
  storage.clear();
}
