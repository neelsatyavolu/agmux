/**
 * One-time localStorage key rename: `xanom-*` → `agmux-*`.
 *
 * Existing installs keep settings, session maps, split layout, etc. when they
 * update. Runs once per origin (flag key); safe to call on every boot.
 */
const MIGRATED_FLAG = "agmux-storage-migrated-v1";

export function migrateLegacyStorageKeys(): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (localStorage.getItem(MIGRATED_FLAG) === "1") return;

    // Collect first — mutating during iteration is unsafe; also prefer
    // localStorage.key(i) over Object.keys (jsdom / WebKit differ).
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (!key.startsWith("xanom-")) continue;
      const next = `agmux-${key.slice("xanom-".length)}`;
      if (localStorage.getItem(next) == null) {
        const value = localStorage.getItem(key);
        if (value != null) localStorage.setItem(next, value);
      }
      localStorage.removeItem(key);
    }

    localStorage.setItem(MIGRATED_FLAG, "1");
  } catch {
    // private mode / quota — ignore; app still works with defaults
  }
}
