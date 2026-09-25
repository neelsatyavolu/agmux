/**
 * The disclosure copy, desktop side.
 *
 * This must stay word-identical to the web's `teams-service/web/disclosure.js`
 * — the join modal, the privacy page and the employee self-view all show the
 * same list, and the design treats that consistency as load-bearing.
 */

export const SHARED: string[] = [
  "Token totals from sessions started in agmux: in, out, cached — plus estimated cost",
  "Active agent time in hourly buckets",
  "Sessions started, session activity by hour, turn counts, and tool-call counts",
  "Tool calls grouped by kind: terminal, edits, reads, search, web, subagents, MCP",
  "How many tool calls failed, where the provider reports an outcome",
  "How many files changed and how many lines were added or removed — counts only, never the lines",
  "Peak simultaneous sessions over time",
  "Provider and model names",
  "Project basenames, or an opaque hash for private repos",
  "After-hours share, weekend share, idle days",
  "How long agents waited for you to approve or deny tools (counts + total wait time)",
  "Last upload time (“as of …”)",
  "Counts of pull requests (size tier by lines changed) from GitHub repositories your team owner selected, when Leaderboard is enabled",
  "Separately from analytics: Grok and Codex team account credentials explicitly added by an owner or manager are encrypted and shared with eligible team members",
  "Which account your running agmux sessions use, as an opaque ID with a session count, so members see how many people share an account — plus that Claude account’s email when your owner turns on shared Claude activity and 2 or more members use it",
];

export const NEVER: string[] = [
  "Prompt text, agent replies, chat history",
  "Diffs, file contents, code snippets",
  "Absolute paths, directory trees, filenames",
  "Terminal output, personal secrets, environment variables",
  "Personal provider credentials",
  "Keystrokes, screenshots, screen recording",
  "Live “watch someone code” views — the product has none",
  "Claude Code, Codex, or Grok sessions you started outside agmux",
];

/** Shorter phrasing for the constrained join modal; same meaning, same order. */
export const SHARED_SHORT: string[] = [
  "Token counts from agmux sessions + est. cost",
  "Active agent time by hour",
  "Sessions, turns, tool calls",
  "Tool calls by kind (terminal, edits, reads…)",
  "Failed tool-call counts",
  "Files changed, lines added/removed — counts only",
  "Peak simultaneous sessions",
  "Providers and models",
  "Project basenames or hash",
  "After-hours / weekend share",
  "Approval wait counts and total blocked time",
  "PR counts by size tier from selected GitHub repos when Leaderboard is on",
  "Explicitly added team account credentials — encrypted and shared with eligible members, separately from analytics",
  "Which account agmux sessions use (opaque ID); a shared Claude account’s email when your owner enables it",
];

export const NEVER_SHORT: string[] = [
  "Prompts and replies",
  "Diffs, code, file contents",
  "Absolute paths",
  "Terminal output, personal secrets",
  "Personal provider credentials",
  "Live session viewing",
  "Sessions started outside agmux",
];
