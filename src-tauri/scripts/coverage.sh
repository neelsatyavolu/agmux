#!/usr/bin/env bash
# Run cargo llvm-cov with exclusions for files that are pure Tauri/OS glue
# (cannot be unit tested without full Tauri runtime).
set -euo pipefail

cd "$(dirname "$0")/.."

# Files excluded from coverage:
#   - Tauri command handlers (require State<AppState> + Tauri runtime)
#   - OS integration (PTY, sockets, file watchers, signal handlers)
#   - App entry/setup (main.rs, lib.rs)
#   - Subprocess wrappers (codex/app_server.rs, local_llm/server.rs)
#   - External HTTP/LLM service clients (ael/groq.rs, ael/openrouter.rs):
#     pure reqwest wrappers; cannot be unit-tested without network mocking.
#   - LLM trait dispatch (ael/llm.rs): factory + trait plumbing only,
#     instantiates real reqwest-backed providers.
EXCLUDE='commands/(codex|threads|opencode_sdk|skills|files|mcp|terminal|keep_awake|projects|usage|ael|ai_ask|app_visibility|autocomplete|local_llm|diff_stats)\.rs'
EXCLUDE+='|process/(io|spawn|kill|session)\.rs'
EXCLUDE+='|local_llm/server\.rs'
EXCLUDE+='|hooks/(script|droid_script)\.rs'
EXCLUDE+='|codex/app_server\.rs'
EXCLUDE+='|ael/(groq|openrouter|llm)\.rs'
EXCLUDE+='|main\.rs|lib\.rs|db/mod\.rs'

cargo llvm-cov --ignore-filename-regex "$EXCLUDE" "$@"
