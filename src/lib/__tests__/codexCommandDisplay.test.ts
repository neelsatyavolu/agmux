import { describe, expect, it } from "vitest";
import {
  commandNameFromCodexItem,
  codexCommandRowCopy,
  isCodexCommandItemType,
  summarizeCodexCommand,
  unwrapShellCommand,
} from "../codexCommandDisplay";

describe("codexCommandDisplay", () => {
  it("unwraps zsh -lc wrappers", () => {
    expect(unwrapShellCommand('/bin/zsh -lc "rg cache src"')).toBe("rg cache src");
  });

  it("summarizes a heredoc plus http.server to the runner line", () => {
    const cmd = `cat > /tmp/build.py <<'PY'\nprint(1)\nPY\npython3 /tmp/build.py\npython3 -m http.server 8767 --bind 127.0.0.1 --directory docs/designs`;
    expect(summarizeCodexCommand(cmd)).toBe(
      "python3 -m http.server 8767 --bind 127.0.0.1 --directory docs/designs",
    );
  });

  it("keeps the cat line for a write-only heredoc", () => {
    expect(summarizeCodexCommand("cat > /tmp/build.py <<'PY'\nprint(1)\nPY")).toBe(
      "cat > /tmp/build.py <<'PY'",
    );
  });

  it("labels a nameless live http.server from access logs", () => {
    const output = `127.0.0.1 - [07/Sep/2026 15:09:27] "GET /subagent-status-options.html HTTP/1.1" 200 -\n127.0.0.1 - [07/Sep/2026 15:09:28] code 404, message File not found`;
    expect(codexCommandRowCopy({ output })).toEqual({
      lead: "Serving",
      subject: "HTTP server",
    });
  });

  it("uses Serving with the banner host and port", () => {
    expect(codexCommandRowCopy({
      output: "Serving HTTP on 127.0.0.1 port 8767 ...",
    })).toEqual({
      lead: "Serving",
      subject: "python3 -m http.server 8767 --bind 127.0.0.1",
    });
  });

  it("uses Running for other in-flight commands", () => {
    expect(codexCommandRowCopy({ commandName: "npm test" })).toEqual({
      lead: "Running",
      subject: "npm test",
    });
  });

  it("keeps Ran once a command has finished", () => {
    expect(codexCommandRowCopy({ commandName: "ls", output: "a", exitCode: 0 })).toEqual({
      lead: "Ran",
      subject: "ls",
    });
  });

  it("does not show Running for history rows without an exit code", () => {
    expect(codexCommandRowCopy({ commandName: "npx tsc --noEmit", isHistory: true })).toEqual({
      lead: "Ran",
      subject: "npx tsc --noEmit",
    });
  });

  it("joins argv command arrays", () => {
    expect(commandNameFromCodexItem({ command: ["python3", "-m", "http.server", "8767"] }))
      .toBe("python3 -m http.server 8767");
    expect(isCodexCommandItemType("command_execution")).toBe(true);
    expect(isCodexCommandItemType("commandExecution")).toBe(true);
  });
});
