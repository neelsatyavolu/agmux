# Grok CLI Research — for Xanom Integration

**Date:** 2026-05-14
**Scope:** Two distinct "Grok" CLIs exist. This document covers BOTH and labels each clearly. The recommendation for Xanom integration is at the bottom.

---

## 0. The Two CLIs — Disambiguation

| Aspect | **superagent-ai/grok-cli** (community, primary) | **xAI Grok Build** (official, beta) |
|---|---|---|
| Vendor | Superagent (community OSS) | xAI Corp (official) |
| Repo | https://github.com/superagent-ai/grok-cli | Closed/beta — announcement at https://x.ai/news/grok-build-cli, landing at https://x.ai/cli |
| npm package | `@vibe-kit/grok-cli` (legacy) and `grok-dev` (current primary) | `grok-build` |
| Binary | `grok` | `grok-build` (also `grok` once installed, per docs) |
| Maturity | Public, MIT-licensed, active | Early Beta — SuperGrok Heavy subscribers first |
| Affiliation note | "Not affiliated with, endorsed by, or sponsored by xAI Corp" | Official xAI product |

Most ecosystem mentions (DeepWiki, blog posts, the `~/.grok/grok.db` storage layout, AGENTS.md hierarchical loading, hooks compatible with Claude Code) refer to **superagent-ai/grok-cli**. The official xAI Grok Build is much newer and far less documented publicly.

---

## 1. Install Command

### superagent-ai/grok-cli
- Primary (current): `npm i -g grok-dev`
- Bun: `bun add -g @vibe-kit/grok-cli`
- Installer script: `curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash`
- Built with Bun + OpenTUI.

### xAI Grok Build (official)
- Installer: `curl -fsSL https://x.ai/cli/install.sh | bash`
- npm: `npm install -g grok-build`

---

## 2. Binary Name on PATH

- **superagent-ai/grok-cli:** `grok`
- **xAI Grok Build:** `grok-build` (some sources also report `grok` alias)

---

## 3. Interactive Mode

### superagent-ai/grok-cli
- Run: `grok` (no args) → starts interactive TUI built on OpenTUI.
- Slash commands include `/memory create`, `/help`, etc. (full reference at DeepWiki Command Reference page).
- Loads AGENTS.md / GROK.md automatically from a hierarchical lookup (see §9).

### xAI Grok Build
- Local-first TUI agent with up to 8 parallel sub-agents.
- Optional web UI synced via WebSocket. UNVERIFIED on exact slash-command set (docs are minimal in public).

---

## 4. Programmatic / Headless / SDK Mode

### superagent-ai/grok-cli
- **Headless flag:** `grok --prompt "..."` or `grok -p "..."` — runs single prompt, exits. Does not require terminal UI.
- **JSON event stream:** `grok --prompt "..." --format json` — emits newline-delimited JSON (JSONL) events: `step_start`, `text`, `tool_use`, `step_finish`, `error`. This is described as "OpenCode-style event schema" by community docs.
- **Model override:** `grok --model grok-code-fast-1 --prompt "..."`
- **No official JS/Python SDK package.** Programmatic usage is via the CLI itself in headless mode (parse JSONL on stdout). For pure API access, use xAI's HTTPS API directly (OpenAI-compatible).

### xAI Grok Build
- UNVERIFIED. No published programmatic SDK as of 2026-05-14. xAI's general developer interface is the HTTPS API (OpenAI-compatible) at api.x.ai, with Python SDK initialized via `XAI_API_KEY`.

---

## 5. Hooks

### superagent-ai/grok-cli
- **Yes — explicit 1:1 parity with Claude Code's hook system.**
- Hook events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit` (and likely `Stop`, `Notification` — UNVERIFIED on full set).
- Config lives in the settings.json files (see §6).
- Marketing language: "Your AGENTS.md, plugins, hooks, skills, and MCP servers all work out of the box."

### xAI Grok Build
- UNVERIFIED. No public hook documentation surfaced.

---

## 6. Settings / Config Files

### superagent-ai/grok-cli
- **User-level:** `~/.grok/user-settings.json`
- **Project-level:** `.grok/settings.json` (in repo root)
- Hooks, MCP servers, custom permissions configured here. Exact JSON schema UNVERIFIED but follows Claude Code's pattern per community docs.

### xAI Grok Build
- UNVERIFIED.

---

## 7. Session Storage — Path & Format

### superagent-ai/grok-cli (STRONGLY CONFIRMED)
- **Path:** `~/.grok/grok.db`
- **Format:** Single SQLite database file.
- **Driver:** Bun-native SQLite driver.
- **Mode:** WAL (Write-Ahead Logging) enabled, foreign keys enabled.
- **Stores:** workspaces, sessions, conversation transcripts, resource usage, compaction summaries.
- **Compaction behavior:** Messages before `firstKeptSeq` are replaced by a single system message containing the summary. Useful for long-running conversations.
- This is structurally similar to Xanom's own SQLite + WAL approach.

### xAI Grok Build
- UNVERIFIED. Likely has its own format; not publicly documented.

---

## 8. Authentication / API Key

### superagent-ai/grok-cli
- **Env var:** `GROK_API_KEY` (NOT `XAI_API_KEY`). The `getApiKey()` resolver checks this first.
- Get a key at `console.x.ai`.
- Note: At least one community fork (`grok-cli-hurry-mode`) uses `GROK_API_KEY` as well. xAI's *own* Python SDK uses `XAI_API_KEY` — these are different conventions.

### xAI Grok Build
- UNVERIFIED — likely uses xAI account auth via the `x.ai/cli` installer flow rather than raw env vars, but not publicly documented. Probably also accepts `XAI_API_KEY`.

---

## 9. Project Awareness — AGENTS.md / GROK.md

### superagent-ai/grok-cli
- **AGENTS.md: YES.** Hierarchical lookup from global user dir → git root → cwd. `AGENTS.override.md` wins per directory when present.
- **GROK.md: YES.** Project-memory file (auto-discovered, injected into conversations). Create via `/memory create`.
- This matches Xanom's existing `agents-md` provider awareness pattern.

### xAI Grok Build
- UNVERIFIED.

---

## 10. Models & Tools

### superagent-ai/grok-cli
- **Default model:** community sources cite `grok-4-1-fast` (DEFAULT_MODEL constant) — but **note xAI's May 15 retirement list includes grok-4-1-fast, grok-4-fast, grok-4, grok-code-fast-1**, so the default may shift. Check the live `DEFAULT_MODEL` in the repo before integrating.
- **Common models:** `grok-4-latest`, `grok-3-latest`, `grok-3-fast`, `grok-3-mini-fast`, `grok-code-fast-1`.
- **Built-in tools:** file ops (read/write/edit), shell execution, `search_x`, `search_web`. MCP servers extend further.
- **MCP support:** YES — explicit "Grok CLI Gets MCP Support" announcement; configurable via settings.json.
- **Context window:** community claims "1M+ tokens" — UNVERIFIED for all models; depends on model selected.

### xAI Grok Build
- **Default model:** `grok-code-fast-1` (70.8% SWE-Bench Verified, 256K context per xAI marketing). Subject to the May 15 retirement list.
- Up to 8 parallel sub-agents.

---

## Sources

- https://github.com/superagent-ai/grok-cli
- https://deepwiki.com/superagent-ai/grok-cli — overall structure
- https://deepwiki.com/superagent-ai/grok-cli/10.2-storage-and-persistence — SQLite at ~/.grok/grok.db, WAL, SessionStore
- https://deepwiki.com/superagent-ai/grok-cli/10.1-command-reference — slash commands & flags
- https://deepwiki.com/superagent-ai/grok-cli/7.3-custom-instructions — AGENTS.md hierarchy
- https://deepwiki.com/superagent-ai/grok-cli/5.3-api-clients — GROK_API_KEY, DEFAULT_MODEL
- https://deepwiki.com/superagent-ai/grok-cli/1.1-installation-and-setup
- https://github.com/superagent-ai/grok-cli/blob/main/AGENTS.md
- https://www.npmjs.com/package/@vibe-kit/grok-cli
- https://www.superagent.sh/blog/grok-cli-mcp-support — MCP support announcement
- https://x.ai/news/grok-build-cli — xAI Grok Build Early Beta
- https://x.ai/cli — Grok Build landing page
- https://docs.x.ai/developers/models — model list
- https://x.ai/news/grok-4-1-fast — model lifecycle

## Caveats

- The model landscape is shifting fast (May 15 2026 retirement of multiple grok-4 variants). Pin model names from the live repo, not this doc.
- "Hooks 1:1 with Claude Code" is community marketing language; exact event-name parity, payload shape, and exit-code conventions should be verified against the source before wiring Xanom's existing `xanom-hooks.sock` listener.
- `--format json` event schema ("OpenCode-style") is not formally specified in xAI docs; treat field names as load-bearing only after inspecting actual output.
- xAI's *own* Grok Build CLI is closed beta — almost everything beyond install and binary name is UNVERIFIED. Don't design Xanom integration against it yet; ship superagent-ai/grok-cli support first.
