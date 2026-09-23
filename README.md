# agmux

A macOS app for running AI coding agents side by side: Claude Code, Codex, Cursor, Droid, Kimi, Pi, OpenCode, Grok, Cline, Gemini, Hermes and local MLX models, in terminals or structured chat.

Download: [agmux.dev](https://agmux.dev) · Homebrew: `brew install --cask neel-xanom/agmux/agmux`

## Build from source

Requirements: macOS, Node 24, npm, and a stable Rust toolchain.

```bash
npm ci
(cd sidecar && npm ci && npm run build)
npx tauri dev                    # run the app
npx tauri build --no-bundle      # release build
```

Checks:

```bash
npx tsc --noEmit
npm test
(cd sidecar && npm test)
(cd src-tauri && cargo test -p xanom)
```

Optional AI helpers (terminal autocomplete fallback, Ask via OpenRouter) read `GROQ_API_KEY` / `OPENROUTER_API_KEY` from the environment. Without them, those helpers use a local model or stay off.

## Repository layout

| Path | What |
|------|------|
| `src/` | React UI |
| `src-tauri/` | Rust backend (Tauri 2) |
| `sidecar/` | Node bridges for SDK-based agents and the project-memory MCP server |
| `remote-relay/`, `remote-mobile/` | Phone remote control (relay Worker, PWA, iOS shell) |
| `teams-service/` | Teams analytics service (Cloudflare Worker + D1) |
| `analytics-service/` | Anonymous product analytics service |

Contributor and agent conventions live in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)
