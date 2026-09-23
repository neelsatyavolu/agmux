/**
 * Local completion engine using Fig/Amazon Q's open-source completion specs.
 * Dynamically imports specs per-command to avoid loading all 600+ specs at once.
 */

import lazySpecs from "@withfig/autocomplete/dynamic";

// Fig types are not exported as globals — use any with type assertions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FigSpec = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FigSubcommand = any;

// Cache loaded specs to avoid re-importing
const specCache = new Map<string, FigSpec | null>();

// Common commands that have Fig specs — used for fast "has spec" check
const KNOWN_COMMANDS = new Set([
  "git", "npm", "npx", "yarn", "pnpm", "docker", "kubectl", "aws",
  "cd", "ls", "cat", "cp", "mv", "rm", "mkdir", "chmod", "chown",
  "curl", "wget", "ssh", "scp", "tar", "zip", "unzip",
  "brew", "cargo", "go", "python", "python3", "pip", "pip3",
  "node", "deno", "bun", "make", "cmake",
  "grep", "find", "sed", "awk", "sort", "head", "tail",
  "ps", "kill", "top", "htop", "df", "du",
  "code", "vim", "nvim", "nano",
  "systemctl", "journalctl",
]);

async function loadSpec(command: string): Promise<FigSpec | null> {
  if (specCache.has(command)) {
    return specCache.get(command) ?? null;
  }

  const load = lazySpecs[command];
  if (!load) {
    specCache.set(command, null);
    return null;
  }

  try {
    // Use the package's exported lazy loader map instead of a private deep import.
    const mod = await load();
    const spec = mod.default as FigSpec;
    specCache.set(command, spec);
    return spec;
  } catch {
    specCache.set(command, null);
    return null;
  }
}

function extractBaseCommand(input: string): string {
  const trimmed = input.trimStart();
  const spaceIdx = trimmed.indexOf(" ");
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

/**
 * Walk the Fig spec tree to find matching completions for the partial input.
 * Returns the best completion suffix, or null if no match.
 */
function findCompletions(spec: FigSpec, parts: string[], partialLast: string): string[] {
  // Navigate to the right level in the spec tree
  let current: FigSubcommand | undefined;

  if (typeof spec === "function") return []; // Skip function-based specs
  current = spec as FigSubcommand;

  // Walk through completed parts to find the right subcommand context
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current?.subcommands) break;

    const subs = Array.isArray(current.subcommands) ? current.subcommands : [];
    const match = subs.find((sub: FigSubcommand) => {
      const names = Array.isArray(sub.name) ? sub.name : [sub.name];
      return names.some((n: unknown) => n === part);
    });

    if (match) {
      current = match;
    } else {
      break;
    }
  }

  if (!current) return [];

  const results: string[] = [];

  // Match subcommands
  if (current.subcommands) {
    const subs = Array.isArray(current.subcommands) ? current.subcommands : [];
    for (const sub of subs) {
      const names = Array.isArray(sub.name) ? sub.name : [sub.name];
      for (const name of names) {
        if (typeof name === "string" && name.startsWith(partialLast) && name !== partialLast) {
          results.push(name.slice(partialLast.length));
        }
      }
    }
  }

  // Match options
  if (current.options) {
    const opts = Array.isArray(current.options) ? current.options : [];
    for (const opt of opts) {
      const names = Array.isArray(opt.name) ? opt.name : [opt.name];
      for (const name of names) {
        if (typeof name === "string" && name.startsWith(partialLast) && name !== partialLast) {
          results.push(name.slice(partialLast.length));
        }
      }
    }
  }

  return results;
}

/**
 * Get a local completion for the given input string.
 * Returns the completion suffix (what to append), or null if no match.
 */
export async function getLocalCompletion(input: string): Promise<string | null> {
  const trimmed = input.trimStart();
  if (!trimmed) return null;

  const baseCmd = extractBaseCommand(trimmed);
  if (!baseCmd) return null;

  // If still typing the base command itself, check against KNOWN_COMMANDS
  if (!trimmed.includes(" ")) {
    for (const cmd of KNOWN_COMMANDS) {
      if (cmd.startsWith(baseCmd) && cmd !== baseCmd) {
        return cmd.slice(baseCmd.length);
      }
    }
    return null;
  }

  // Load the spec for this command
  const spec = await loadSpec(baseCmd);
  if (!spec) return null;

  // Split input into parts and find the partial last token
  const parts = trimmed.split(/\s+/);
  const lastPart = parts[parts.length - 1] ?? "";

  // If the input ends with a space, the partial is empty (suggest next token)
  const endsWithSpace = trimmed.endsWith(" ");
  const partialLast = endsWithSpace ? "" : lastPart;

  if (endsWithSpace) {
    // Push empty string as the "next" partial
    parts.push("");
  }

  const completions = findCompletions(spec, parts, partialLast);

  // Return the first (best) match
  return completions.length > 0 ? completions[0] ?? null : null;
}

export function hasSpec(command: string): boolean {
  return KNOWN_COMMANDS.has(command);
}
