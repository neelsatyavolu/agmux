# context-mode — MANDATORY routing (Claude Code + context-mode plugin)

Protects the context window. A single unrouted command can dump tens of KB and waste the session.

## BLOCKED — do not use Bash for these

| Pattern | Instead |
|---------|---------|
| `curl` / `wget` | `ctx_fetch_and_index(url, source)` or `ctx_execute` with `fetch` |
| Inline HTTP in Bash (`fetch('http`, `requests.get(`, …) | `ctx_execute` |
| WebFetch tool | `ctx_fetch_and_index` then `ctx_search` |

## REDIRECT large I/O

| Tool | Rule |
|------|------|
| Bash | Only short commands (`git`, `ls`, `npm install`, …). Else `ctx_batch_execute` / `ctx_execute` |
| Read for analysis/summarize | `ctx_execute_file` (Edit needs normal Read) |
| Grep with large results | `ctx_execute` shell grep; print summary only |

## Tool hierarchy

1. **GATHER** — `ctx_batch_execute(commands, queries)`
2. **FOLLOW-UP** — `ctx_search(queries: [...])` (all questions in one call)
3. **PROCESSING** — `ctx_execute` / `ctx_execute_file`
4. **WEB** — `ctx_fetch_and_index` → `ctx_search`
5. **INDEX** — `ctx_index(content, source)`

## Output

- Prefer short replies; write large artifacts to files (path + one-line description).
- `ctx stats` / `ctx doctor` / `ctx upgrade` → call the matching MCP tool and show output.
