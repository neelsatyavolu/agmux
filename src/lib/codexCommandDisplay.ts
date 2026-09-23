/** Strip the `/bin/zsh -lc "…"` wrapper Codex puts around shell commands. */
export function unwrapShellCommand(raw: string): string {
  const shellWrapMatch = raw.match(/^\/bin\/(?:zsh|bash|sh)\s+-\w*c\s+["'](.+?)["']$/s);
  return shellWrapMatch ? shellWrapMatch[1] : raw;
}

export function isCodexCommandItemType(type?: string | null): boolean {
  return type === "commandExecution" || type === "command_execution";
}

export function commandNameFromCodexItem(item: { command?: unknown }): string {
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.command)) {
    return item.command.map((part) => String(part)).filter(Boolean).join(" ");
  }
  return "";
}

const SUBJECT_MAX = 88;
const RUNNER_LINE = /^(?:python3?|node|npm|npx|pnpm|yarn|bun|cargo|go|ruby|php|java|deno)\b|http\.server\b/;
const HEREDOC_END = /^(?:PY|EOF|EOT|END|SQL|HTML|JS)$/;

function truncateSubject(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= SUBJECT_MAX) return compact;
  return `${compact.slice(0, SUBJECT_MAX - 1)}…`;
}

function isHttpServerOutput(output: string): boolean {
  return /Serving HTTP on /i.test(output)
    || /"GET \S+ HTTP\/1\.\d"/i.test(output)
    || /code 404, message File not found/i.test(output);
}

function inferCommandFromOutput(output: string): string {
  const serving = output.match(/Serving HTTP on (\S+) port (\d+)/i);
  if (serving) {
    const host = serving[1];
    const port = serving[2];
    return host === "0.0.0.0"
      ? `python3 -m http.server ${port}`
      : `python3 -m http.server ${port} --bind ${host}`;
  }
  if (isHttpServerOutput(output)) return "HTTP server";
  return "";
}

/** Prefer the actual runner line of a heredoc/compound shell, not the cat preamble. */
export function summarizeCodexCommand(raw?: string, output?: string): string {
  const unwrapped = unwrapShellCommand((raw ?? "").trim());
  if (unwrapped) {
    const lines = unwrapped.split("\n").map((line) => line.trim()).filter(Boolean);
    const runner = [...lines].reverse().find((line) => RUNNER_LINE.test(line));
    if (runner) return truncateSubject(runner);
    const last = lines[lines.length - 1] ?? unwrapped;
    if (lines.length > 1 && HEREDOC_END.test(last)) return truncateSubject(lines[0]);
    return truncateSubject(last);
  }
  return inferCommandFromOutput(output ?? "");
}

export function codexCommandRowCopy(opts: {
  commandName?: string;
  output?: string;
  exitCode?: number;
  isHistory?: boolean;
}): { lead: string; subject: string } {
  const running = opts.exitCode === undefined && !opts.isHistory;
  const subject = summarizeCodexCommand(opts.commandName, opts.output);
  const http = /http\.server\b/i.test(subject)
    || subject === "HTTP server"
    || isHttpServerOutput(opts.output ?? "");
  if (running && http) return { lead: "Serving", subject: subject || "HTTP" };
  if (running) return { lead: "Running", subject: subject || "command" };
  return { lead: "Ran", subject };
}
