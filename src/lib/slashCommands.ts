import type { Provider } from "./types";

export type SlashCommandAction = "passthrough" | "local";

export interface SlashCommand {
  name: string;
  description: string;
  providers: Provider[];
  args?: string;
  action: SlashCommandAction;
  source?: string; // "built-in", "user", "project", "sdk", or plugin name
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Claude Code built-in commands ─────────────────────
  {
    name: "/help",
    description: "Show available commands and usage",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/clear",
    description: "Clear the conversation history",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/compact",
    description: "Compact the conversation to save context",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/cost",
    description: "Show token usage and cost for this session",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/doctor",
    description: "Run diagnostics on the Claude Code environment",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/memory",
    description: "Show or edit memory files (CLAUDE.md)",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/review",
    description: "Request a code review of recent changes",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/pr",
    description: "Create a pull request for current changes",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/model",
    description: "Switch the active Claude model",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/config",
    description: "Show or edit Claude Code configuration",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/permissions",
    description: "View or change tool permissions",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/login",
    description: "Log in to your Anthropic account",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/logout",
    description: "Log out of your Anthropic account",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/status",
    description: "Show session status and connection info",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/bug",
    description: "Report a bug in Claude Code",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/init",
    description: "Initialize CLAUDE.md in the current project",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/mcp",
    description: "List or manage MCP servers and tools",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/vim",
    description: "Toggle vim keybinding mode",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/terminal-setup",
    description: "Configure terminal integration (Shift+Enter)",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/ide",
    description: "Configure IDE integration",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/add-dir",
    description: "Add a directory to the session context",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/release-notes",
    description: "Show release notes for current version",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/listen",
    description: "Toggle listen mode (voice input)",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "built-in",
  },

  // ── Codex-only commands ───────────────────────────────
  // Mirrors codex-rs/tui/src/slash_command.rs (visible commands).
  // Re-sync if Codex adds/removes commands upstream.
  { name: "/model", description: "Choose model and reasoning effort", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/fast", description: "Toggle Fast mode for fastest inference", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/approvals", description: "Choose what Codex is allowed to do", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/permissions", description: "Choose what Codex is allowed to do", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/setup-default-sandbox", description: "Set up elevated agent sandbox", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/experimental", description: "Toggle experimental features", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/autoreview", description: "Approve one retry of a recent auto-review denial", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/memories", description: "Configure memory use and generation", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/skills", description: "Use skills to improve task performance", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/review", description: "Review current changes and find issues", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/rename", description: "Rename the current thread", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/new", description: "Start a new chat during a conversation", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/resume", description: "Resume a saved chat", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/fork", description: "Fork the current chat", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/init", description: "Create AGENTS.md with instructions for Codex", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/plan", description: "Switch to Plan mode", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/goal", description: "Set or view the goal for a long-running task", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/collab", description: "Change collaboration mode (experimental)", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/agent", description: "Switch the active agent thread", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/side", description: "Start a side conversation in an ephemeral fork", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/copy", description: "Copy last response as markdown", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/diff", description: "Show git diff (including untracked files)", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/mention", description: "Mention a file", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/title", description: "Configure terminal title items", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/statusline", description: "Configure status line items", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/theme", description: "Choose a syntax highlighting theme", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/apps", description: "Manage apps", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/plugins", description: "Browse plugins", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/logout", description: "Log out of Codex", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/quit", description: "Exit Codex", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/exit", description: "Exit Codex", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/feedback", description: "Send logs to maintainers", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/ps", description: "List background terminals", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/stop", description: "Stop all background terminals", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/personality", description: "Choose communication style", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/realtime", description: "Toggle realtime voice mode (experimental)", providers: ["Codex"], action: "passthrough", source: "built-in" },
  { name: "/settings", description: "Configure realtime mic/speaker", providers: ["Codex"], action: "passthrough", source: "built-in" },
];

export function getCommandsForProvider(provider: Provider): SlashCommand[] {
  return SLASH_COMMANDS.filter((cmd) => cmd.providers.includes(provider));
}

/** Merge built-in commands with dynamically discovered commands (user/project/plugin) */
export function mergeCommands(
  builtIn: SlashCommand[],
  dynamic: { name: string; description: string; source: string }[],
  provider: Provider = "ClaudeCode",
): SlashCommand[] {
  const builtInNames = new Set(builtIn.map((c) => c.name));
  const merged = [...builtIn];
  for (const cmd of dynamic) {
    if (!builtInNames.has(cmd.name)) {
      merged.push({
        name: cmd.name,
        description: cmd.description,
        providers: [provider],
        action: "passthrough",
        source: cmd.source,
      });
    }
  }
  return merged;
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  // Strip leading "/" so "/autopr" matches "/global-tools:autopr"
  const needle = query.replace(/^\//, "").toLowerCase();
  if (!needle) return commands;

  const matches = commands.filter((cmd) => {
    const haystack = cmd.name.replace(/^\//, "").toLowerCase();
    return haystack.includes(needle);
  });

  // Sort: exact prefix matches first, then contains matches, both alphabetical within group
  matches.sort((a, b) => {
    const aName = a.name.replace(/^\//, "").toLowerCase();
    const bName = b.name.replace(/^\//, "").toLowerCase();
    const aPrefix = aName.startsWith(needle);
    const bPrefix = bName.startsWith(needle);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return matches;
}

export function isSlashQuery(value: string): boolean {
  return value.startsWith("/") && !value.includes(" ");
}

/** Precomputed lookup for enriching SDK-discovered commands with known descriptions */
const KNOWN_BY_NAME = new Map(SLASH_COMMANDS.map((cmd) => [cmd.name, cmd]));

/**
 * Build SlashCommand objects from the SDK's session.init slash_commands[] array.
 * Uses known descriptions from the hardcoded list where available; otherwise
 * labels as "Custom command" (user/project commands and skills).
 */
export function buildCommandsFromSdk(sdkNames: string[]): SlashCommand[] {

  return sdkNames.map((raw) => {
    const name = raw.startsWith("/") ? raw : `/${raw}`;
    const known = KNOWN_BY_NAME.get(name);
    if (known) return known;
    return {
      name,
      description: "Custom command",
      providers: ["ClaudeCode"] as Provider[],
      action: "passthrough" as SlashCommandAction,
      source: "sdk",
    };
  });
}
