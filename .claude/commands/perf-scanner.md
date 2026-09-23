# perf-scanner

Scan the agmux codebase for performance issues using the perf-scanner agent.

## Usage

Run a full scan across all 7 areas (React rendering, Zustand stores, Tauri IPC, Rust backend, terminal/WASM, bundle size, memory leaks) and produce a prioritized report.

If arguments are provided (e.g., `/perf-scanner Zustand stores`), scope the scan to only that area.

## How

Launch the `perf-scanner` agent (from `.claude/agents/perf-scanner.md`) with the scan scope. Pass any user-provided arguments as the target area. If no arguments, scan everything.

Do NOT make any code changes — report findings only.
