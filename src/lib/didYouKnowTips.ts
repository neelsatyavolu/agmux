/**
 * "Did you know?" tips shown on the home screen.
 *
 * Each tip is a single sentence. Wrap inline keyboard shortcuts, paths,
 * or code references in backticks (`like-this`) — HomeScreen renders the
 * backticked spans with the <Code> primitive.
 *
 * Tips should be useful for non-technical users: what you can do, not how
 * the app is built. Avoid engineering jargon.
 *
 * Add freely. The home screen picks one at random on every mount.
 */
export const DID_YOU_KNOW_TIPS: readonly string[] = [
  // ── Command palette + navigation ────────────────────────────────────────
  "Press `⌘K` anywhere to jump to a project, start a chat, or run a command.",
  "Approvals show up as banners in the chat — no extra windows to hunt down.",
  "`⌘⇧F` searches across every chat, prompt, and journal note.",
  "`⌘N` starts a new chat in the project you have selected.",
  "`⌘T` opens a new session — pick from your recent projects.",
  "`⌘O` opens any folder on disk as a project right away.",
  "Use `⌘⇧.` to show or hide the editor beside your chat.",
  "`⌘⇧T` switches to Task mode for work on a separate branch.",
  "Jump to the sidebar with `⌘1` and back to the editor with `⌘2`.",

  // ── Composer / input bar ────────────────────────────────────────────────
  "Type `/` in the input bar for shortcuts like `/clear`, `/plan`, and `/branch`.",
  "Type `@` to attach a file from your project to the next message.",
  "Drag a screenshot onto the chat box to send it as an image.",
  "Paste an image from your clipboard with `⌘V`.",
  "The model chip remembers the last model you picked for each agent.",
  "The effort dial controls how carefully the agent thinks before acting.",
  "Press `Esc` while a reply is running to stop it.",
  "Use `⇧↵` for a new line, `↵` to send, and `⌘↵` to queue a follow-up.",
  "Switch permission modes from the composer — ask first, auto, or full access.",
  "The small ring next to the model name shows how full the chat context is.",
  "Plan mode lets the agent outline an approach before editing files — toggle it from the composer.",

  // ── Agents & providers ─────────────────────────────────────────────────
  "Run Claude, Codex, Grok, Kimi, Cursor, and OpenCode from the same window.",
  "Start a chat with a model on your Mac from the model list — nothing leaves your computer.",
  "Set the default agent for new chats in Settings → General.",
  "Each agent keeps its own sign-in — connect Anthropic, OpenAI, and others independently.",
  "Pick a faster model for quick tasks and a stronger one when you need deeper work.",

  // ── Sidebar features ───────────────────────────────────────────────────
  "Right-click any chat in the sidebar to rename, archive, fork, or pin it.",
  "A pulsing amber dot means a chat is waiting for your approval.",
  "A green dot means a chat finished while you were away — click to mark it read.",
  "Pinned chats stay at the top of their project, even when archived.",
  "Chats sort by recent activity so the freshest ones stay on top.",
  "Drag the sidebar edge to resize it; double-click the edge to snap back.",
  "Collapse a project with the chevron — hidden chats stay safe.",

  // ── Files & editor ─────────────────────────────────────────────────────
  "The built-in editor opens files beside your chat without leaving agmux.",
  "Right-click a file in the tree to rename, delete, or copy its path.",
  "`⌘P` in the editor opens quick-open across the whole project.",
  "Edited files show a dot on their tab until you save.",
  "Click a diff in chat to jump straight to that file in the editor.",
  "Hold Shift while selecting text in a terminal to copy it, even in full-screen mode.",

  // ── Hooks, notifications, automation ───────────────────────────────────
  "Approval prompts still reach you when the window is in the background.",
  "You will not get the same approval notification twice.",
  "Notification history keeps recent alerts so you can catch up later.",
  "Pair your phone under Remote Control to approve or answer from anywhere.",

  // ── Task mode ──────────────────────────────────────────────────────────
  "Task mode keeps main branch work separate so experiments stay isolated.",
  "Each task can track its own branch, pull request, and issue links.",
  "Stop a task to keep its files; archive it when you are fully done.",
  "The `+N −M` badge on a chat shows lines added and removed as the agent works.",
  "The commit dialog finds modified, new, and staged files for you.",

  // ── Settings & themes ──────────────────────────────────────────────────
  "agmux ships with a dozen themes — switch them in Settings → Appearance.",
  "Adjust glass blur and border strength under Settings → Appearance.",
  "Pick a UI font and a code font that suit you — defaults are Geist and Geist Mono.",
  "Set animations to smooth, quick, or off for accessibility.",
  "Light mode is fully supported — toggle it in Settings → Appearance.",
  "Open the project in Cursor, VS Code, Zed, or another editor from the chat top bar.",
  "Multi-view in Settings lets you put two chats side by side.",
  "Choose stable, beta, or off for automatic updates.",

  // ── Sessions, history, journal ─────────────────────────────────────────
  "Claude chats restore when you reopen the app — scrollback is kept.",
  "The journal panel records key decisions for a chat so you can find them later.",
  "Fork a chat from the menu to branch the conversation without losing the original.",
  "Archived chats still show up in search — nothing is truly gone.",
  "Usage shows estimated tokens and cost per agent, per day.",

  // ── Productivity ───────────────────────────────────────────────────────
  "Resume a background terminal from the sidebar anytime.",
  "Hold `⌥` while clicking a file mention to open it in the editor without leaving chat.",
  "Use the optimize control on the composer to polish your prompt before sending.",
  "The Skills tab holds reusable prompts you can run with `/`.",
  "Pin a chat, then jump back with `⌘1` from anywhere.",
  "In multi-view, drag a tab onto another pane to split your workspace.",

  // ── Local models & remote ──────────────────────────────────────────────
  "Browse and download local models in Settings → Local Models.",
  "Eject a loaded local model from the chat bar to free memory; the next message loads it again.",
  "With Remote Control, your phone can open the same chats as your Mac.",
  "Teams only shares hourly usage summaries — never your prompts or code.",

  // ── Misc ───────────────────────────────────────────────────────────────
  "`⌘⇧.` is a quick way into IDE mode — try it when you need the file tree.",
  "agmux remembers your last selected project across launches.",
  "Light mode keeps the same accent colors with lighter surfaces.",
  "After an update, What's New opens automatically — press `⌘?` anytime to reopen it.",
  "Quitting agmux cleanly stops every running agent session.",
  "The home screen greeting verb changes each time you return.",
];

export function pickDidYouKnowTip(): string {
  return DID_YOU_KNOW_TIPS[Math.floor(Math.random() * DID_YOU_KNOW_TIPS.length)];
}

/**
 * Render a tip string into segments — plain text and inline-code spans —
 * so the consumer can render `code-fenced` portions with their own primitive.
 */
export interface TipSegment {
  kind: "text" | "code";
  value: string;
}

export function parseTip(tip: string): TipSegment[] {
  const parts = tip.split("`");
  const segments: TipSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const value = parts[i];
    if (!value) continue;
    segments.push({ kind: i % 2 === 1 ? "code" : "text", value });
  }
  return segments;
}
