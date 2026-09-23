/**
 * macOS-style Cmd+arrow navigation for HTML inputs / textareas.
 *
 * - Cmd+Left  → start of the current line
 * - Cmd+Right → end of the current line
 * - Cmd+Up    → start of the whole prompt/value
 * - Cmd+Down  → end of the whole prompt/value
 * - +Shift    → extend the selection (standard anchor/focus model)
 *
 * WKWebView / Tauri does not always apply these natively the way AppKit
 * text views do, so composers and terminal text boxes handle them explicitly.
 *
 * Note: App.tsx also binds Cmd+Up/Down for session list navigation. That
 * global handler must yield when focus is in an editable field / terminal
 * (`isEditableKeyboardTarget`) so these prompt-nav shortcuts can fire.
 */

export type TextFieldEl = HTMLInputElement | HTMLTextAreaElement;

/**
 * True when the event target is a place where Cmd+arrows should move the
 * caret (composers, Warp input, xterm helper textarea) instead of switching
 * sessions.
 *
 * Duck-typed so unit tests don't need a full DOM, and so it works for both
 * real HTMLElements and the synthetic targets some test harnesses pass.
 */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    classList?: { contains?: (c: string) => boolean };
    closest?: (s: string) => unknown;
  };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  // xterm focuses a hidden helper textarea; also treat the terminal host.
  if (el.classList?.contains?.("xterm-helper-textarea")) return true;
  if (typeof el.closest === "function" && el.closest(".xterm")) return true;
  return false;
}

export function lineBounds(
  value: string,
  caret: number,
): { start: number; end: number } {
  const clamped = Math.max(0, Math.min(caret, value.length));
  const start = value.lastIndexOf("\n", Math.max(0, clamped - 1)) + 1;
  const nl = value.indexOf("\n", clamped);
  const end = nl === -1 ? value.length : nl;
  return { start, end };
}

export function textFieldCmdArrowTarget(
  value: string,
  caret: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): number {
  switch (key) {
    case "ArrowLeft":
      return lineBounds(value, caret).start;
    case "ArrowRight":
      return lineBounds(value, caret).end;
    case "ArrowUp":
      return 0;
    case "ArrowDown":
      return value.length;
  }
}

function isCmdArrowKey(
  key: string,
): key is "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown"
  );
}

/**
 * Apply Cmd(+Shift)+Arrow navigation to a text field.
 * Returns true when the event was handled (caller should return early).
 */
export function handleTextFieldCmdArrowNav(
  e: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
  },
  el: TextFieldEl | null | undefined,
): boolean {
  if (!el) return false;
  // Command only — leave Ctrl+Arrow alone (word nav / platform defaults).
  if (!e.metaKey || e.ctrlKey || e.altKey) return false;
  if (!isCmdArrowKey(e.key)) return false;

  const value = el.value;
  const selStart = el.selectionStart ?? 0;
  const selEnd = el.selectionEnd ?? 0;
  const direction = el.selectionDirection ?? "none";

  // Move the focus edge (the caret that was last moved). When collapsed,
  // both ends are the caret.
  const focus = direction === "backward" ? selStart : selEnd;
  const from = selStart === selEnd ? selStart : focus;
  const target = textFieldCmdArrowTarget(value, from, e.key);

  e.preventDefault();

  if (!e.shiftKey) {
    el.setSelectionRange(target, target);
    return true;
  }

  // Extend from the existing anchor (or from the pre-move caret if collapsed).
  const anchor =
    selStart === selEnd
      ? from
      : direction === "backward"
        ? selEnd
        : selStart;

  if (target < anchor) {
    el.setSelectionRange(target, anchor, "backward");
  } else {
    el.setSelectionRange(anchor, target, "forward");
  }
  return true;
}
