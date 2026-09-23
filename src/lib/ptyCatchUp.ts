/**
 * Catch up an xterm buffer from the current Rust ring-buffer snapshot.
 * Used when a hidden terminal skipped live PTY events and is shown again.
 */
import { getPtySnapshot } from "./commands";
import { TUI_MOUSE_DECSET } from "./ptyMouse";
import { decodeSnapshot, type XtermBundle } from "./xterm-loader";

const ESC = 0x1b;

/**
 * Ring wrap can start mid-CSI (`…;2;125;207;255;48;2;20;20;20m`).
 * xterm prints that tail as text at (1,1) after reset — Grok's header
 * stays garbled until a full TUI repaint. Skip to the next ESC so the
 * parser begins on a real sequence. `end_offset` is unchanged: these
 * bytes are still "already written" for live-event dedup.
 */
export function trimLeadingIncompleteVt(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data[0] === ESC) return data;
  const esc = data.indexOf(ESC);
  if (esc <= 0) return data;
  return data.subarray(esc);
}

export async function replaceTerminalFromSnapshot(
  bundle: XtermBundle,
  threadId: string,
  opts?: { restoreMouse?: boolean; lastWrittenOffset?: number; onReplay?: (bytes: Uint8Array) => void },
): Promise<number> {
  const snap = await getPtySnapshot(threadId);
  const bytes = decodeSnapshot(snap.data);
  const startOffset = snap.end_offset - bytes.length;
  const lastOffset = opts?.lastWrittenOffset;
  if (!bundle.needsSnapshotReset && lastOffset !== undefined && lastOffset >= startOffset && lastOffset <= snap.end_offset) {
    // The prefix is already parsed or queued intact. Keep its scrollback,
    // mouse modes and partial UTF-8/VT state; only feed the missing suffix.
    // Flush queued pre-hide bytes first so the stream stays ordered.
    bundle.flushBatched();
    const missing = bytes.subarray(lastOffset - startOffset);
    if (missing.length > 0) {
      bundle.writeBatched(missing);
      bundle.flushBatched();
      opts?.onReplay?.(missing);
    }
    return snap.end_offset;
  }
  try {
    bundle.flushBatched();
    bundle.term.reset();
    bundle.needsSnapshotReset = false;
  } catch {
    /* ignore — terminal may be disposing */
  }
  if (snap.data) {
    const replay = trimLeadingIncompleteVt(bytes);
    if (replay.length > 0) {
      bundle.writeBatched(replay);
      bundle.flushBatched();
      opts?.onReplay?.(replay);
    }
  }
  // reset() clears mouse tracking. Grok's ?1000h/?1003h/?1006h is sent once
  // at startup and is usually gone from the 1MB ring, so clicks become
  // xterm selection instead of TUI hits. Re-assert into the parser only.
  if (opts?.restoreMouse) {
    bundle.writeBatched(TUI_MOUSE_DECSET);
    bundle.flushBatched();
  }
  return snap.end_offset;
}
