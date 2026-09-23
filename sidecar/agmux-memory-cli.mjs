/**
 * agmux-memory CLI — Bash-callable fallback when MCP tools are not yet listed.
 *
 * Env (same as MCP server):
 *   AGMUX_MEMORY_STORE, AGMUX_MEMORY_MD, AGMUX_PROJECT_ID
 *   AGMUX_HANDOFF_STORE, AGMUX_SESSIONS_MD
 *
 * Usage:
 *   node agmux-memory-cli.mjs list
 *   node agmux-memory-cli.mjs add --title "..." --content "..." [--kind decision] [--important]
 *   node agmux-memory-cli.mjs get <id>
 *   node agmux-memory-cli.mjs archive <id>
 *   node agmux-memory-cli.mjs restore <id>
 *   node agmux-memory-cli.mjs resolve <id>
 *   node agmux-memory-cli.mjs reopen <id>
 *   node agmux-memory-cli.mjs supersede <id> <target-id> [...target-ids]
 *   node agmux-memory-cli.mjs sessions [--limit N]
 *   node agmux-memory-cli.mjs session <id>
 *
 * Exit 0 on success; non-zero + message on stderr on failure.
 * Shebang is added only by esbuild banner (do not put #! here).
 */

import {
  withStore,
  listEntries,
  getEntry,
  addEntry,
  updateEntry,
  archiveEntry,
  restoreEntry,
  resolveEntry,
  reopenEntry,
  supersedeEntry,
  loadStore,
  resolvePaths,
  formatEntryListLine,
  memoryHealth,
} from "./agmux-memory-store.mjs";
import {
  loadHandoffStore,
  resolveHandoffPaths,
  listSessions,
  getSession,
  formatSessionListLine,
  withHandoffStore,
  upsertSession,
  currentSessionId,
} from "./agmux-handoff-store.mjs";
import {
  searchProject,
  formatSearchHits,
  sessionExcerpt,
  formatSessionExcerpt,
} from "./agmux-search.mjs";

const MEMORY_KINDS = ["note", "decision", "pin", "issue", "fact"];
const SEARCH_SCOPES = ["all", "memory", "session"];
const EXCERPT_ORIGINS = ["head", "tail"];

function usage() {
  return `Usage:
  agmux-memory-cli list [--kind KIND] [--include-archived]
  agmux-memory-cli add --title TITLE --content CONTENT [--kind KIND] [--important] [--binding]
  agmux-memory-cli update <id> [--title TITLE] [--content CONTENT] [--kind KIND] [--important|--not-important] [--binding|--not-binding]
  agmux-memory-cli get <id>
  agmux-memory-cli health
  agmux-memory-cli archive <id>
  agmux-memory-cli restore <id>
  agmux-memory-cli resolve <id>
  agmux-memory-cli reopen <id>
  agmux-memory-cli supersede <id> <target-id> [...target-ids]
  agmux-memory-cli search QUERY [--scope all|memory|session] [--limit N]
  agmux-memory-cli sessions [--limit N]
  agmux-memory-cli session <id>
  agmux-memory-cli session-excerpt <id> [--max-chars N] [--from head|tail]
  agmux-memory-cli session-upsert --summary "..." [--title TITLE] [--id ID]`;
}

function enumValue(value, { name, values, fallback = undefined }) {
  if (value == null) return fallback;
  const normalized = String(value).toLowerCase().trim();
  if (!values.includes(normalized)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return normalized;
}

function boundedInteger(value, { name, fallback, min, max }) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function writeMutation(outcome, text) {
  const warning = outcome.projectionWarning
    ? `\nWarning: ${outcome.projectionWarning}`
    : "";
  process.stdout.write(`${text}${warning}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--title" ||
      a === "--content" ||
      a === "--kind" ||
      a === "--summary" ||
      a === "--id" ||
      a === "--scope" ||
      a === "--from" ||
      a === "--limit"
    ) {
      args[a.slice(2)] = argv[++i] ?? "";
    } else if (a === "--max-chars") {
      args.maxChars = argv[++i] ?? "";
    } else if (a === "--include-archived") {
      args.includeArchived = true;
    } else if (a === "--important") {
      args.important = true;
    } else if (a === "--not-important") {
      args.important = false;
    } else if (a === "--binding") {
      args.binding = true;
    } else if (a === "--not-binding") {
      args.binding = false;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      args._.push(a);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage() + "\n");
    process.exit(cmd ? 0 : 1);
  }

  const { storePath, projectId } = resolvePaths();

  switch (cmd) {
    case "list": {
      const store = loadStore(storePath, projectId);
      const kind = enumValue(args.kind, {
        name: "kind", values: MEMORY_KINDS, fallback: null,
      });
      const entries = listEntries(store, {
        includeArchived: Boolean(args.includeArchived),
        kind,
      });
      if (entries.length === 0) {
        process.stdout.write("No memory entries.\n");
        return;
      }
      process.stdout.write(
        `Project memory (${entries.length}) — timestamps UTC ISO:\n\n${entries
          .map(formatEntryListLine)
          .join("\n\n")}\n`,
      );
      return;
    }
    case "add": {
      if (!args.title || !args.content) {
        throw new Error("add requires --title and --content");
      }
      const kind = enumValue(args.kind, {
        name: "kind", values: MEMORY_KINDS, fallback: "note",
      });
      const outcome = withStore(process.env, (store) =>
        addEntry(store, {
          title: args.title,
          content: args.content,
          kind,
          source: "agent",
          important: Boolean(args.important),
          binding: Boolean(args.binding),
        }),
      );
      const { result } = outcome;
      const flags = [
        result.binding ? "[BINDING]" : "",
        result.important ? "[IMPORTANT]" : "",
      ].filter(Boolean).join(" ");
      const flagSuffix = flags ? ` ${flags}` : "";
      writeMutation(
        outcome,
        `Added memory \`${result.id}\` (${result.kind})${flagSuffix}: ${result.title}\ncreated: ${result.createdAt}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    case "update": {
      const id = args._[1];
      if (!id) throw new Error("update requires <id>");
      if (
        args.title == null &&
        args.content == null &&
        args.kind == null &&
        args.important === undefined &&
        args.binding === undefined
      ) {
        throw new Error(
          "update requires at least one of --title, --content, --kind, --important, --not-important, --binding, --not-binding",
        );
      }
      const kind = enumValue(args.kind, {
        name: "kind", values: MEMORY_KINDS,
      });
      const outcome = withStore(process.env, (store) =>
        updateEntry(store, id, {
          title: args.title,
          content: args.content,
          kind,
          actor: "agent",
          important: args.important,
          binding: args.binding,
        }),
      );
      const { result } = outcome;
      const flags = [
        result.binding ? "[BINDING]" : "",
        result.important ? "[IMPORTANT]" : "",
      ].filter(Boolean).join(" ");
      const flagSuffix = flags ? ` ${flags}` : "";
      writeMutation(
        outcome,
        `Updated memory \`${result.id}\`${flagSuffix}: ${result.title}\ncreated: ${result.createdAt}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    case "get": {
      const id = args._[1];
      if (!id) throw new Error("get requires <id>");
      const store = loadStore(storePath, projectId);
      const entry = getEntry(store, id);
      if (!entry) throw new Error(`not found: ${id}`);
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
      return;
    }
    case "health": {
      const store = loadStore(storePath, projectId);
      process.stdout.write(JSON.stringify(memoryHealth(store), null, 2) + "\n");
      return;
    }
    case "archive": {
      const id = args._[1];
      if (!id) throw new Error("archive requires <id>");
      const outcome = withStore(process.env, (store) =>
        archiveEntry(store, id, { actor: "agent" }),
      );
      const { result } = outcome;
      writeMutation(
        outcome,
        `Archived memory \`${result.id}\`: ${result.title}\ncreated: ${result.createdAt}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    case "restore":
    case "resolve":
    case "reopen": {
      const id = args._[1];
      if (!id) throw new Error(`${cmd} requires <id>`);
      const mutate =
        cmd === "restore" ? restoreEntry : cmd === "resolve" ? resolveEntry : reopenEntry;
      const outcome = withStore(process.env, (store) =>
        mutate(store, id, { actor: "agent" }),
      );
      const { result } = outcome;
      writeMutation(
        outcome,
        `${cmd[0].toUpperCase()}${cmd.slice(1)}d memory \`${result.id}\`: ${result.title}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    case "supersede": {
      const id = args._[1];
      const targetIds = args._.slice(2);
      if (!id || targetIds.length === 0) {
        throw new Error("supersede requires <id> and at least one <target-id>");
      }
      const outcome = withStore(process.env, (store) =>
        supersedeEntry(store, id, targetIds, { actor: "agent" }),
      );
      const { result } = outcome;
      writeMutation(
        outcome,
        `Updated memory \`${result.id}\` to supersede ${targetIds.join(", ")}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    case "search": {
      const query = args._.slice(1).join(" ").trim();
      if (!query) throw new Error("search requires a query");
      const scope = enumValue(args.scope, {
        name: "scope", values: SEARCH_SCOPES, fallback: "all",
      });
      const limit = boundedInteger(args.limit, {
        name: "limit", fallback: 12, min: 1, max: 40,
      });
      const hits = searchProject({
        query,
        scope,
        limit,
      });
      process.stdout.write(formatSearchHits(hits, query) + "\n");
      return;
    }
    case "sessions": {
      const { storePath, projectId } = resolveHandoffPaths();
      const store = loadHandoffStore(storePath, projectId);
      const limit = boundedInteger(args.limit, {
        name: "limit", fallback: 10, min: 1, max: 40,
      });
      const sessions = listSessions(store, { limit });
      if (sessions.length === 0) {
        process.stdout.write("No session handoffs yet.\n");
        return;
      }
      process.stdout.write(
        `Session handoffs (${sessions.length}, newest first):\n\n${sessions
          .map(formatSessionListLine)
          .join("\n\n")}\n`,
      );
      return;
    }
    case "session": {
      const id = args._[1];
      if (!id) throw new Error("session requires <id>");
      const { storePath, projectId } = resolveHandoffPaths();
      const store = loadHandoffStore(storePath, projectId);
      const session = getSession(store, id);
      if (!session) throw new Error(`not found: ${id}`);
      process.stdout.write(JSON.stringify(session, null, 2) + "\n");
      return;
    }
    case "session-excerpt": {
      const id = args._[1];
      if (!id) throw new Error("session-excerpt requires <id>");
      const maxChars = boundedInteger(args.maxChars, {
        name: "max-chars", fallback: 4000, min: 200, max: 12000,
      });
      const from = enumValue(args.from, {
        name: "from", values: EXCERPT_ORIGINS, fallback: "tail",
      });
      const result = sessionExcerpt({
        id,
        maxChars,
        from,
      });
      process.stdout.write(formatSessionExcerpt(result) + "\n");
      return;
    }
    case "session-upsert": {
      if (!args.summary) throw new Error("session-upsert requires --summary");
      const id = String(args.id || currentSessionId() || "").trim();
      if (!id) {
        throw new Error(
          "session-upsert needs --id or AGMUX_THREAD_ID / XANOM_SESSION_ID in env",
        );
      }
      let created = false;
      const outcome = withHandoffStore(process.env, (store) => {
        const existing = getSession(store, id);
        created = !existing;
        return upsertSession(store, {
          id,
          threadId: id,
          title: args.title || existing?.title || "Session",
          summary: args.summary,
          status: "idle",
          source: "agent",
        });
      });
      const { result } = outcome;
      writeMutation(
        outcome,
        `${created ? "Created" : "Updated"} session \`${result.id}\`: ${result.title}\nupdated: ${result.updatedAt}`,
      );
      return;
    }
    default:
      throw new Error(`unknown command: ${cmd}\n${usage()}`);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`Error: ${e?.message || e}\n`);
  process.exit(1);
}
