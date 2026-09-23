/**
 * Per-thread scroll adapters for the session timeline popover.
 * Session views register on mount; the popover calls scrollToThreadTurn.
 */

/**
 * Grok wraps user text in `<user_query>…</user_query>`. Strip for timeline
 * display (also covers rows stored before the Rust normalizer ran).
 */
export function cleanTimelinePrompt(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const full = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (full) return full[1].trim();
  return raw
    .replace(/^<user_query>\s*/i, "")
    .replace(/\s*<\/user_query>\s*$/i, "")
    .trim();
}

export type ThreadTimelineScrollOpts = {
  promptOccurrenceFromEnd?: number;
  /** Turn prompt text — used by zero-scrollback TUI jump (Grok). */
  promptText?: string | null;
  /** Turn seq (1-based) — Grok Shift+turn hop distance. */
  seq?: number | null;
  /** Max seq on the thread (live edge) for hop math. */
  maxSeq?: number | null;
};

export type ThreadTimelineScrollHandler = (
  turnId: string,
  opts?: ThreadTimelineScrollOpts,
) => boolean | Promise<boolean>;

const handlers = new Map<string, ThreadTimelineScrollHandler[]>();

/** Live PTY out-of-band map: turnId → approximate buffer line (xterm). */
const ptyLineMaps = new Map<string, Map<string, number>>();

export function registerThreadTimelineScroll(
  threadId: string,
  handler: ThreadTimelineScrollHandler,
): () => void {
  const registered = handlers.get(threadId) ?? [];
  registered.push(handler);
  handlers.set(threadId, registered);
  return () => {
    const remaining = (handlers.get(threadId) ?? []).filter((entry) => entry !== handler);
    if (remaining.length) handlers.set(threadId, remaining);
    else handlers.delete(threadId);
  };
}

export function registerPtyTurnLine(
  threadId: string,
  turnId: string,
  line: number,
): void {
  let map = ptyLineMaps.get(threadId);
  if (!map) {
    map = new Map();
    ptyLineMaps.set(threadId, map);
  }
  map.set(turnId, line);
}

export function getPtyTurnLine(threadId: string, turnId: string): number | undefined {
  return ptyLineMaps.get(threadId)?.get(turnId);
}

export function clearPtyTurnMap(threadId: string): void {
  ptyLineMaps.delete(threadId);
}

/**
 * Scroll the active session view to a turn. Returns true if the adapter
 * reported success; false if no adapter or soft-fail.
 */
export async function scrollToThreadTurn(
  threadId: string,
  turnId: string,
  opts?: ThreadTimelineScrollOpts,
): Promise<boolean> {
  const registered = handlers.get(threadId);
  const handler = registered?.[registered.length - 1];
  if (!handler) return false;
  try {
    return await handler(turnId, opts);
  } catch {
    return false;
  }
}

const HIGHLIGHT_MS = 1200;

/** Brief flash on a chat element marked with data-turn-id. */
export function flashTurnHighlight(el: HTMLElement): void {
  el.classList.add("thread-turn-flash");
  window.setTimeout(() => {
    el.classList.remove("thread-turn-flash");
  }, HIGHLIGHT_MS);
}

/**
 * Rebind data-turn-id on user message elements by seq order + prompt prefix.
 * `turns` should be oldest-first for sequential matching.
 */
export function rebindChatTurnIds(
  root: HTMLElement | null,
  turns: Array<{ id: string; promptText: string; seq: number }>,
): void {
  if (!root || turns.length === 0) return;
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-timeline-user-msg]"),
  );
  if (nodes.length === 0) return;

  const prompts = nodes.map((node) => node.getAttribute("data-user-prompt") ?? "");
  const mapping = mapTurnIdsToUserKeys(nodes.map((_, i) => String(i)), turns, prompts);
  for (let i = 0; i < nodes.length; i++) {
    const id = mapping[String(i)];
    if (id) nodes[i].setAttribute("data-turn-id", id);
    else nodes[i].removeAttribute("data-turn-id");
  }
}

export function findTurnElement(
  root: ParentNode | Document,
  turnId: string,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
}

/**
 * Map a turn id → ordinal among currently visible user prompts (0-based).
 * Aligns from the end when counts differ (history truncation), same as rebind.
 */
export function resolveUserOrdinalForTurn(
  turnId: string,
  turns: Array<{ id: string; seq: number; promptText?: string }>,
  userCount: number,
  userPrompts?: string[],
): number | null {
  if (userPrompts) {
    const map = mapTurnIdsToUserKeys(userPrompts.map((_, i) => String(i)), turns, userPrompts);
    const key = Object.keys(map).find((key) => map[key] === turnId);
    return key == null ? null : Number(key);
  }
  if (userCount <= 0 || turns.length === 0) return null;
  const sorted = [...turns].sort((a, b) => a.seq - b.seq);
  const n = Math.min(userCount, sorted.length);
  const turnOffset = Math.max(0, sorted.length - n);
  const userOffset = Math.max(0, userCount - n);
  for (let i = 0; i < n; i++) {
    if (sorted[turnOffset + i].id === turnId) {
      return userOffset + i;
    }
  }
  return null;
}

/**
 * Build turnId → user key map (uuid / item id) by end-aligned seq order.
 * Keys come from `userKeys` in oldest-first render order.
 */
export function mapTurnIdsToUserKeys(
  userKeys: string[],
  turns: Array<{ id: string; seq: number; promptText?: string }>,
  userPrompts?: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (userKeys.length === 0 || turns.length === 0) return out;
  const sorted = [...turns].sort((a, b) => a.seq - b.seq);
  if (userPrompts) {
    const normalize = (text: string) => cleanTimelinePrompt(text).replace(/\s+/g, " ").trim().slice(0, 160);
    const prompts = userPrompts.map(normalize);
    let before = prompts.length;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const prompt = normalize(sorted[i].promptText ?? "");
      if (!prompt) continue;
      for (let j = before - 1; j >= 0; j--) {
        if (prompts[j] !== prompt) continue;
        out[userKeys[j]] = sorted[i].id;
        before = j;
        break;
      }
    }
    return out;
  }

  const n = Math.min(userKeys.length, sorted.length);
  const keyOffset = Math.max(0, userKeys.length - n);
  const turnOffset = Math.max(0, sorted.length - n);
  for (let i = 0; i < n; i++) {
    out[userKeys[keyOffset + i]] = sorted[turnOffset + i].id;
  }
  return out;
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** After a Virtuoso/DOM scroll, wait for the turn node to mount then flash it. */
export async function flashTurnAfterScroll(
  root: ParentNode | Document,
  turnId: string,
  attempts = 10,
  delayMs = 40,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const el = findTurnElement(root, turnId);
    if (el) {
      // Prefer re-scroll once mounted so sticky headers / virtual padding settle.
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      flashTurnHighlight(el);
      return true;
    }
    await waitMs(delayMs);
  }
  return false;
}
