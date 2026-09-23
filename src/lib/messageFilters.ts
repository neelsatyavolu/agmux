export interface TaskNotification {
  taskId: string;
  status: string;
  summary: string;
}

const BLOCK_TAGS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-caveat",
  "local-command-stdout",
  "context_guidance",
  "context_window_protection",
  "task-notification",
  "ide_opened_file",
  "persisted-output",
];

const BLOCK_TAG_PATTERN = new RegExp(
  `<(${BLOCK_TAGS.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>`,
  "g"
);

// Orphaned closing tags for block-level tags (opening tag was in a prior
// chunk or message, so the paired regex in BLOCK_TAG_PATTERN never matches)
const ORPHAN_CLOSE_TAG_PATTERN = new RegExp(
  `<\\/(${BLOCK_TAGS.join("|")})>`,
  "g"
);

const TASK_NOTIFICATION_PATTERN =
  /<task-notification[^>]*>([\s\S]*?)<\/task-notification>/g;
const LEGACY_SDK_TASK_NOTIFICATION_PATTERN =
  /^\s*>\s*\*\*Notification\*\*:[\s\S]*?(?=\n\s*\n|$)/gim;

function extractTagContent(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? match[1].trim() : "";
}

function parseTaskNotification(xml: string): TaskNotification | null {
  const taskId = extractTagContent(xml, "task-id");
  const status = extractTagContent(xml, "status");
  const summary = extractTagContent(xml, "summary");
  if (!taskId && !status && !summary) return null;
  return { taskId, status, summary };
}

function extractNotifications(text: string): TaskNotification[] {
  const notifications: TaskNotification[] = [];
  let match: RegExpExecArray | null;
  TASK_NOTIFICATION_PATTERN.lastIndex = 0;
  while ((match = TASK_NOTIFICATION_PATTERN.exec(text)) !== null) {
    const parsed = parseTaskNotification(match[0]);
    if (parsed) notifications.push(parsed);
  }
  return notifications;
}

export function stripSystemTags(text: string): string {
  return text
    .replace(BLOCK_TAG_PATTERN, "")
    .replace(ORPHAN_CLOSE_TAG_PATTERN, "")
    .trim();
}

function stripLegacySdkTaskNotifications(text: string): string {
  return text.replace(LEGACY_SDK_TASK_NOTIFICATION_PATTERN, "").trim();
}

// Comprehensive ANSI/terminal escape stripping:
// 1. CSI sequences: \x1b[ ... <letter>   (colors, cursor, etc.)
// 2. OSC sequences: \x1b] ... \x07|\x1b\\  (window titles, hyperlinks — the
//    source of "0q4mu☒]0;∗ Claude Code☒" garbled text on session restore)
// 3. DCS/APC/PM/SOS string sequences: \x1bP|\x1b_|\x1b^  ... \x1b\\
// 4. Simple two-char escapes: \x1b followed by a single char (e.g. \x1b= \x1b>)
// 5. Stray C0/C1 control chars that remain after stripping (BEL, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /[\x1b\x9b]\[[\x20-\x3f]*[\x40-\x7e]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_STRING_SEQ = /\x1b[P_^][\s\S]*?\x1b\\/g;
// eslint-disable-next-line no-control-regex
const ANSI_TWO_CHAR = /\x1b[\x20-\x7e]/g;
// eslint-disable-next-line no-control-regex
const STRAY_CONTROLS = /[\x00-\x08\x0e-\x1a\x7f]/g;

/** Strip CSI/OSC/control sequences (PTY dumps, truecolor SGR, cursor moves). */
export function stripAnsiCodes(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_STRING_SEQ, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_TWO_CHAR, "")
    .replace(STRAY_CONTROLS, "");
}

/** Clean a search-result snippet for display — strip ANSI and collapse space. */
export function cleanSearchSnippet(text: string): string {
  const cleaned = stripAnsiCodes(text)
    .replace(/\s+/g, " ")
    .trim();
  // Require a few real letters so pure escape-residue never shows.
  const letters = (cleaned.match(/[A-Za-z]/g) ?? []).length;
  return letters >= 4 ? cleaned : "";
}

function stripNoisyLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("Caveat:")) return false;
      if (trimmed.startsWith("[Request interrupted")) return false;
      if (trimmed.startsWith("Full transcript available at:")) return false;
      if (trimmed.startsWith("[ede_diagnostic]")) return false;
      // Compacting conversation notices are rendered as dedicated UI elements
      // (not filtered here — see SystemMessage handling in ClaudeSdkSessionView)
      return true;
    })
    .join("\n")
    .trim();
}

export function isSessionContinuationMessage(text: string): boolean {
  return /this session is being continued from a previous/i.test(text);
}

export function isCompactingMessage(text: string): boolean {
  return /compacting conversation/i.test(text);
}

export function cleanMessageContent(text: string): {
  text: string;
  notifications: TaskNotification[];
} {
  const notifications = extractNotifications(text);
  const stripped = stripAnsiCodes(
    stripLegacySdkTaskNotifications(stripSystemTags(text))
  );
  const cleaned = stripNoisyLines(stripped);
  return { text: cleaned, notifications };
}
