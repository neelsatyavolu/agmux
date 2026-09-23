/**
 * Map Cmd+arrow keys in PTY terminals to control sequences most agent CLIs
 * and readline-style editors understand.
 *
 * - Cmd+Left  → Ctrl+A (start of line)
 * - Cmd+Right → Ctrl+E (end of line)
 * - Cmd+Up    → Ctrl+Home (start of multi-line prompt / buffer, when supported)
 * - Cmd+Down  → Ctrl+End  (end of multi-line prompt / buffer, when supported)
 *
 * Home/End use the H/F form xterm itself emits for Ctrl+Home/End
 * (`CSI 1;5 H` / `CSI 1;5 F`), not the `1~`/`4~` form — many TUIs only
 * recognize the former.
 *
 * Shift+Cmd+Arrow is left to terminalSelection (buffer text select).
 *
 * Returns the bytes to write to the PTY, or null if the event is not a
 * Cmd+arrow we handle. Caller should only act on keydown and swallow the
 * event so xterm does not also emit a conflicting sequence.
 */

export function ptyBytesForCmdArrow(e: {
  type?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}): string | null {
  if (e.type != null && e.type !== "keydown") return null;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;

  switch (e.key) {
    case "ArrowLeft":
      return "\x01"; // Ctrl+A
    case "ArrowRight":
      return "\x05"; // Ctrl+E
    case "ArrowUp":
      // Ctrl+Home — start of prompt / editing buffer in multi-line TUIs
      return "\x1b[1;5H";
    case "ArrowDown":
      // Ctrl+End — end of prompt / editing buffer
      return "\x1b[1;5F";
    default:
      return null;
  }
}
