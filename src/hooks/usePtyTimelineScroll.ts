/**
 * Out-of-band PTY line map + Session Timeline scroll adapter.
 * Shared by ClaudeTerminalView and TerminalView (Grok/Kimi/OpenCode/Codex PTY).
 *
 * Grok uses scrollback:0 (full-bleed TUI) — jump uses prompt-text search +
 * internal scroll (SGR wheel / PageUp), not xterm scrollToLine.
 */
import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  listThreadTurns,
  sendPtyInput,
  setThreadTurnPtyOffset,
} from "../lib/commands";
import type { ThreadTurn } from "../lib/types";
import { jumpPtyToTurn, type PtyJumpTerm } from "../lib/ptyTimelineJump";
import {
  getPtyTurnLine,
  registerPtyTurnLine,
  registerThreadTimelineScroll,
} from "../lib/threadTimelineScroll";

type BundleLike = { term: PtyJumpTerm } | null;

function parsePtyOffset(factsJson: string | undefined): number | null {
  try {
    const facts = JSON.parse(factsJson || "{}") as {
      ptyOffset?: number;
      pty_offset?: number;
    };
    if (typeof facts.ptyOffset === "number") return facts.ptyOffset;
    if (typeof facts.pty_offset === "number") return facts.pty_offset;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param threadId agmux thread id
 * @param bundleRef xterm bundle ref (`bundleRef.current?.term`)
 * @param enabled when false, skip registration (e.g. Codex chat mode hides the PTY)
 * @param grokScrollbackNav when true, the jump may drive the TUI's own
 *   scrollback with keystrokes. Those keys (Tab, `G`, Shift+Left) are Grok's;
 *   sending them to another agent's PTY would type junk into its prompt.
 */
export function usePtyTimelineScroll(
  threadId: string,
  bundleRef: RefObject<BundleLike>,
  enabled = true,
  grokScrollbackNav = false,
  codexPrompt = false,
): void {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // Bounded load (single-flight in listThreadTurns). Only need facts for
    // pty offsets — keep limit modest so remounts stay cheap.
    void listThreadTurns(threadId, 200)
      .then((turns) => {
        if (cancelled) return;
        for (const t of turns) {
          const line = parsePtyOffset(t.factsJson);
          if (line != null) {
            registerPtyTurnLine(threadId, t.id, line);
          }
        }
      })
      .catch(() => {});

    void listen<{ type?: string; turn?: ThreadTurn }>(
      `thread-turn-${threadId}`,
      (ev) => {
        const turn = ev.payload?.turn;
        if (!turn?.id || turn.status !== "running") return;

        // Never overwrite: tool-fact emits re-fire while status is still
        // "running" and would stamp every turn with the live cursor (~viewport
        // bottom on flush TUIs like Grok).
        const existing = getPtyTurnLine(threadId, turn.id);
        if (existing != null) return;

        const fromFacts = parsePtyOffset(turn.factsJson);
        if (fromFacts != null) {
          registerPtyTurnLine(threadId, turn.id, fromFacts);
          return;
        }

        const term = bundleRef.current?.term;
        if (!term) return;
        const line = term.buffer.active.baseY + term.buffer.active.cursorY;
        registerPtyTurnLine(threadId, turn.id, line);
        void setThreadTurnPtyOffset(threadId, turn.id, line).catch(() => {});
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    const unreg = registerThreadTimelineScroll(threadId, async (turnId, opts) => {
      const term = bundleRef.current?.term;
      if (!term) return false;
      const line = getPtyTurnLine(threadId, turnId);
      return jumpPtyToTurn(term, {
        line,
        promptText: opts?.promptText,
        codexPrompt,
        promptOccurrenceFromEnd: opts?.promptOccurrenceFromEnd,
        seq: opts?.seq,
        maxSeq: opts?.maxSeq,
        sendInput: grokScrollbackNav
          ? (keys) => sendPtyInput(threadId, keys)
          : undefined,
      });
    });

    return () => {
      cancelled = true;
      unlisten?.();
      unreg();
      // Keep in-memory map across remount so jump still works when switching tabs.
    };
  }, [threadId, bundleRef, enabled, grokScrollbackNav, codexPrompt]);
}
