/* The single source of disclosure copy.
   The design spec requires the join modal, the privacy page, and the employee
   self-view to be word-identical — so they all render from here. If you change
   wording, it changes in all three at once, which is the point.
   The desktop app mirrors this list in src/components/teams/disclosureCopy.ts. */

import { html, raw } from "./dom.js";

export const SHARED = [
  "Token totals from sessions started in agmux: in, out, cached — plus estimated cost",
  "Active agent time in hourly buckets",
  "Session activity by hour, turn counts, and tool-call counts",
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
];

export const NEVER = [
  "Prompt text, agent replies, chat history",
  "Diffs, file contents, code snippets",
  "Absolute paths, directory trees, filenames",
  "Terminal output, personal secrets, environment variables",
  "Personal provider credentials",
  "Keystrokes, screenshots, screen recording",
  "Live “watch someone code” views — the product has none",
  "Claude Code, Codex, or Grok sessions you started outside agmux",
];

/** Shorter phrasing for the constrained join step, same meaning and order. */
export const SHARED_SHORT = [
  "Token counts from agmux sessions (in, out, cached) and estimated cost",
  "Active agent time, bucketed by hour — not idle app time",
  "Session activity by hour, turn counts, and tool-call counts",
  "Tool calls grouped by kind: terminal, edits, reads, search, web, subagents, MCP",
  "How many tool calls failed, where the provider reports an outcome",
  "How many files changed and how many lines were added or removed — counts only, never the lines",
  "Peak simultaneous sessions",
  "Which providers and models you used",
  "Project basenames — or a hash if the repo is private",
  "After-hours / weekend share and idle days",
  "Approval wait counts and total blocked time",
  "PR counts by size tier from selected GitHub repos when Leaderboard is on",
  "Explicitly added team account credentials — encrypted and shared with eligible members, separately from analytics",
];

export const NEVER_SHORT = [
  "Your prompts or the agent's replies",
  "Diffs, file contents, or code",
  "Absolute paths or your directory structure",
  "Terminal output, personal secrets, environment variables",
  "Personal provider credentials",
  "Live viewing of your session — no one can watch you work",
  "Sessions started outside agmux",
];

/**
 * The two-column block. Always two columns, always the same order and wording.
 * `single` stacks them for narrow contexts without changing the content.
 */
export function disclosureBlock({ sharedTitle, neverTitle, short = false, single = false } = {}) {
  const shared = short ? SHARED_SHORT : SHARED;
  const never = short ? NEVER_SHORT : NEVER;
  return html`
    <div class="dsc" ${raw(single ? 'style="grid-template-columns:1fr"' : "")}>
      <div class="shared">
        <div class="h">
          <i data-lucide="shield-check"></i>${sharedTitle || "Shared with owner & managers"}
        </div>
        <ul>
          ${shared.map((i) => html`<li>${i}</li>`)}
        </ul>
      </div>
      <div class="never">
        <div class="h"><i data-lucide="eye-off"></i>${neverTitle || "Never collected or shown"}</div>
        <ul>
          ${never.map((i) => html`<li>${i}</li>`)}
        </ul>
      </div>
    </div>
  `;
}
