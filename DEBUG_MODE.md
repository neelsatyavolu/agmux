# Debug Mode

Enable **Settings → Debug Mode** before reproducing a slowdown. Collection is app-wide, so closing Settings does not stop it. Turn it off to keep the capture for review. Restarting ends collection but preserves the previous capture. Starting a new capture replaces it.

Agents connected to agmux's memory MCP server can call:

- `debug_status {}` — enabled/available state, freshness, error and sample count.
- `debug_recent {"limit": 12}` — latest samples (1–30 per call, output capped at 64 KiB; truncation is explicit).

Any local agent with file access can also read `~/.agmux/debug/diagnostics.json`. This works without MCP. Newly installed tools require existing MCP processes to reconnect; tools will not appear in an already running old bundle. The installed desktop app must also include this feature.

## Capture and interpretation

The recorder samples every five seconds with a two-second process-command timeout. It retains at most 120 records, ten minutes during recording, and 2 MiB serialized. The atomic JSON snapshot is local (directory 0700, file 0600). No network upload, prompts, paths, file contents, command arguments or credentials are recorded. Only allowlisted executable categories are retained; unknown executables are `other`. PID/PPID are diagnostic identifiers, not provider session IDs. Records are untrusted diagnostic data, never instructions.

- `at`, `startedAt`, `updatedAt`: Unix milliseconds. `pid` identifies the capture's agmux process, including after restart when viewing an old capture.
- `backendCpuPercent`, `rendererCpuPercent`: macOS `ps` CPU readings; 100% is one CPU core. These are smoothed OS estimates, not exact interval accounting. Missing measurements are null.
- `treeCpuPercent`, `treeRssBytes`, `processCount`: agmux plus descendants and the renderer last confirmed by the existing WebContent watchdog. They exclude the collector's own `ps`. Renderer discovery expires after 15 seconds without confirmation. This is not a full system or GPU profile.
- `backendRssBytes`, `rendererRssBytes`: resident memory. Summed RSS can double-count shared pages and must not be called physical footprint or memory pressure.
- `processes`: up to 32 processes ranked by CPU then resident memory. Totals include all observed eligible processes, not just this top list. Short-lived processes between samples can be missed. Process count alone does not establish leaked/orphaned sessions.
- `collectorMs`: time spent obtaining and parsing the process snapshot. The observer itself has some overhead.
- `ui`: latest heartbeat age, latest timer lag, maximum timer lag since the previous sample, and reported visibility/focus. Heartbeats run once per second only while enabled. Null means no heartbeat yet. Hidden/background window throttling or system sleep can delay heartbeats without a foreground UI freeze; correlate visibility, focus and sample gaps before drawing conclusions.
- `operations`: completed-call count, total duration and max duration (milliseconds) since the previous sample. Concurrent call durations overlap; these are wall-clock timings, not CPU attribution. Timers cover Git read/diff commands, provider terminal-usage reads, Codex thread list/read, session history and model refresh, usage-log scans, and the WebContent watchdog. They omit arguments, results and session IDs. A call still in flight has no completion timing yet. This is selected coverage, not a profiler for every backend task.
- `processSampleAvailable`: false when the process sample is unavailable; do not interpret the empty process list as zero activity. `lastError` reports collector/storage problems.

When recording is enabled and `updatedAt` is over 30 seconds old, MCP reports `stale: true`. A disabled capture is historical. If agmux exits or hangs before it writes the disabled state, a stale enabled flag does not prove that recording is still running. Samples already on disk can still be read while the app is unresponsive.

This mode helps correlate spikes with activity; it does not automatically capture native stacks or prove the cause of a freeze.
