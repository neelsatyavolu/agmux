#!/usr/bin/env bash
# Smoke-test agmux project memory the way agents receive it:
#  1) MCP stdio tools (deterministic)
#  2) Claude/Grok/Codex CLI flags + optional live prompt that must echo the instruction
#
# Usage:
#   ./scripts/test-project-memory-cli.sh           # MCP + flag dry-runs
#   ./scripts/test-project-memory-cli.sh --live    # also call LLMs (needs auth, costs tokens)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/agmux-mem-cli.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

LIVE=0
if [[ "${1:-}" == "--live" ]]; then LIVE=1; fi

STORE="$TMP/memory.json"
MD="$TMP/.agmux/MEMORY.md"
MCP_CFG="$TMP/claude-mcp.json"
PROJECT_ID="cli-test-project"
NODE="${NODE:-node}"
MCP_SCRIPT="$ROOT/sidecar/agmux-memory-mcp.mjs"
if [[ ! -f "$MCP_SCRIPT" ]]; then
  MCP_SCRIPT="$ROOT/sidecar/dist/agmux-memory-mcp.bundle.mjs"
fi
if [[ ! -f "$MCP_SCRIPT" ]]; then
  echo "FAIL: MCP script not found (run: cd sidecar && node build.mjs)"
  exit 1
fi

export AGMUX_MEMORY_STORE="$STORE"
export AGMUX_MEMORY_MD="$MD"
export AGMUX_PROJECT_ID="$PROJECT_ID"

INSTRUCTIONS="## agmux project memory (REQUIRED)
You MUST use project memory on this project. It is shared by every agent and terminal (Claude, Grok, Codex, etc.).

Start of every non-trivial turn:
1. Call memory_list (or Read \`$MD\`) before planning or editing.
2. Treat existing pins/decisions as binding unless the user overrides them.

During/after work:
3. If you made a durable decision, discovered a non-obvious fact, or fixed a non-obvious issue, you MUST memory_add it before your final reply.
4. Use MCP server \`agmux-memory\` tools: memory_list, memory_get, memory_add, memory_update, memory_archive.
5. Never store secrets (API keys, tokens, passwords).

Skipping memory_list / memory_add when the above apply is a task failure.
File projection: \`$MD\`"

pass=0
fail=0
ok() { echo "  PASS: $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $*"; fail=$((fail + 1)); }

echo "== 1) MCP stdio (memory_add → memory_list) =="
# One-shot JSON-RPC over stdin
RESP="$(
  {
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli-test","version":"0"}}}'
    echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_add","arguments":{"title":"CLI smoke","content":"memory works from CLI test","kind":"fact"}}}'
    echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_list","arguments":{}}}'
  } | "$NODE" "$MCP_SCRIPT" 2>/dev/null | tail -n 3
)"
if echo "$RESP" | grep -q 'CLI smoke'; then
  ok "MCP add+list returned entry"
else
  bad "MCP response missing entry: $RESP"
fi
if [[ -f "$MD" ]] && grep -q 'CLI smoke' "$MD"; then
  ok "MEMORY.md projection written"
else
  bad "MEMORY.md missing or empty"
fi

echo "== 2) Claude CLI flags (parse + dry path) =="
cat > "$MCP_CFG" <<EOF
{
  "mcpServers": {
    "agmux-memory": {
      "command": "$NODE",
      "args": ["$MCP_SCRIPT"],
      "env": {
        "AGMUX_PROJECT_ID": "$PROJECT_ID",
        "AGMUX_MEMORY_STORE": "$STORE",
        "AGMUX_MEMORY_MD": "$MD"
      }
    }
  }
}
EOF
if claude --help 2>&1 | grep -q 'append-system-prompt'; then
  ok "claude supports --append-system-prompt"
else
  bad "claude missing --append-system-prompt"
fi
if claude --help 2>&1 | grep -q 'mcp-config'; then
  ok "claude supports --mcp-config"
else
  bad "claude missing --mcp-config"
fi

echo "== 3) Grok CLI flags =="
if grok --help 2>&1 | grep -q -- '--rules'; then
  ok "grok supports --rules"
else
  bad "grok missing --rules"
fi

echo "== 4) Codex CLI flags =="
if codex --help 2>&1 | grep -q '\-c, --config'; then
  ok "codex supports -c config overrides"
else
  bad "codex missing -c"
fi
# Validate TOML value shape for developer_instructions (parse-only via python)
python3 - <<'PY' && ok "developer_instructions TOML string is valid" || bad "developer_instructions TOML invalid"
import tomllib, os, pathlib
md = os.environ["AGMUX_MEMORY_MD"]
instr = f'''## agmux project memory
Prefer MCP tools memory_list / memory_add. File: {md}'''
# Same shape as Rust session_instructions_toml_quoted + -c key
import re
# tomllib needs a full document
doc = f'developer_instructions = """{instr}"""'
tomllib.loads(doc)
# mcp_servers inline table (simplified)
node = "node"
script = "mcp.mjs"
val = f'{{ command = "{node}", args = ["{script}"], env = {{ AGMUX_PROJECT_ID = "x" }} }}'
tomllib.loads(f"mcp_servers = {{ agmux_memory = {val} }}".replace("agmux_memory", '"agmux-memory"') if False else f'''
[mcp_servers."agmux-memory"]
command = "node"
args = ["mcp.mjs"]
''')
print("ok")
PY

if [[ "$LIVE" -eq 1 ]]; then
  echo "== 5) LIVE: Claude print — must echo memory instruction =="
  # Ask only to confirm the appended system prompt is present (no tools required).
  OUT="$(
    claude -p "Reply with exactly one line. If your instructions mention 'agmux project memory', print: MEMORY_INSTRUCTION_OK. Otherwise print: MEMORY_INSTRUCTION_MISSING." \
      --append-system-prompt "$INSTRUCTIONS" \
      --mcp-config "$MCP_CFG" \
      --output-format text \
      --max-turns 1 \
      2>/dev/null || true
  )"
  echo "  claude said: ${OUT//$'\n'/ | }"
  if echo "$OUT" | grep -q 'MEMORY_INSTRUCTION_OK'; then
    ok "Claude received append-system-prompt memory instruction"
  else
    bad "Claude did not acknowledge memory instruction"
  fi

  echo "== 6) LIVE: Grok headless — must echo memory instruction =="
  # Grok single-turn is -p/--single (not --prompt).
  OUT="$(
    grok -p "Reply with exactly one line. If your instructions mention 'agmux project memory', print: MEMORY_INSTRUCTION_OK. Otherwise print: MEMORY_INSTRUCTION_MISSING." \
      --rules "$INSTRUCTIONS" \
      --output-format plain \
      2>/dev/null || true
  )"
  echo "  grok said: ${OUT//$'\n'/ | }"
  if echo "$OUT" | grep -q 'MEMORY_INSTRUCTION_OK'; then
    ok "Grok received --rules memory instruction"
  else
    bad "Grok did not acknowledge memory instruction"
  fi

  echo "== 7) LIVE: Codex exec — must echo memory instruction =="
  # Escape for -c TOML double quotes
  INSTR_ESC="${INSTRUCTIONS//\\/\\\\}"
  INSTR_ESC="${INSTR_ESC//\"/\\\"}"
  INSTR_ESC="${INSTR_ESC//$'\n'/\\n}"
  OUT="$(
    codex exec -c "developer_instructions=\"$INSTR_ESC\"" \
      "Reply with exactly one line. If your developer/system instructions mention 'agmux project memory', print: MEMORY_INSTRUCTION_OK. Otherwise print: MEMORY_INSTRUCTION_MISSING." \
      2>/dev/null | tail -n 20 || true
  )"
  echo "  codex said: ${OUT//$'\n'/ | }"
  if echo "$OUT" | grep -q 'MEMORY_INSTRUCTION_OK'; then
    ok "Codex received developer_instructions memory blurb"
  else
    bad "Codex did not acknowledge memory instruction (or CLI auth/format differs)"
  fi
else
  echo "== 5–7) LIVE LLM checks skipped (pass --live to run) =="
fi

echo
echo "Results: $pass passed, $fail failed (tmpdir $TMP kept until exit)"
if [[ "$fail" -gt 0 ]]; then exit 1; fi
exit 0
