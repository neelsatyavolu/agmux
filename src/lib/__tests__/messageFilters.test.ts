import { describe, expect, it } from "vitest";
import {
  cleanMessageContent,
  cleanSearchSnippet,
  isCompactingMessage,
  isSessionContinuationMessage,
  stripAnsiCodes,
  stripSystemTags,
} from "../messageFilters";

describe("stripSystemTags", () => {
  it("removes paired block-tag content", () => {
    const input = "before<system-reminder>hidden stuff</system-reminder>after";
    expect(stripSystemTags(input)).toBe("beforeafter");
  });

  it("removes multiple distinct block tags", () => {
    const input =
      "a<command-name>x</command-name>b<command-message>y</command-message>c";
    expect(stripSystemTags(input)).toBe("abc");
  });

  it("removes multiline block content", () => {
    const input = `before
<system-reminder>
line 1
line 2
</system-reminder>
after`;
    expect(stripSystemTags(input)).toBe("before\n\nafter");
  });

  it("removes orphan closing tags", () => {
    const input = "hello</system-reminder>world";
    expect(stripSystemTags(input)).toBe("helloworld");
  });

  it("leaves untouched text that has no block tags", () => {
    expect(stripSystemTags("just plain text")).toBe("just plain text");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripSystemTags("  hello  ")).toBe("hello");
  });

  it("handles tags with attributes on the opening tag", () => {
    const input = `<system-reminder priority="high">ignore me</system-reminder>kept`;
    expect(stripSystemTags(input)).toBe("kept");
  });
});

describe("isSessionContinuationMessage", () => {
  it("detects the continuation header case-insensitively", () => {
    expect(
      isSessionContinuationMessage(
        "This session is being continued from a previous conversation.",
      ),
    ).toBe(true);
    expect(
      isSessionContinuationMessage(
        "THIS SESSION IS BEING CONTINUED FROM A PREVIOUS run.",
      ),
    ).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isSessionContinuationMessage("hello world")).toBe(false);
    expect(isSessionContinuationMessage("")).toBe(false);
  });
});

describe("isCompactingMessage", () => {
  it("detects compaction notices case-insensitively", () => {
    expect(isCompactingMessage("Compacting conversation…")).toBe(true);
    expect(isCompactingMessage("COMPACTING CONVERSATION now")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isCompactingMessage("compacting files")).toBe(false);
    expect(isCompactingMessage("")).toBe(false);
  });
});

describe("cleanMessageContent", () => {
  it("returns the text and an empty notifications array for plain input", () => {
    const result = cleanMessageContent("hello world");
    expect(result.text).toBe("hello world");
    expect(result.notifications).toEqual([]);
  });

  it("strips system-reminder tags from the text", () => {
    const input = "visible<system-reminder>hidden</system-reminder>again";
    const result = cleanMessageContent(input);
    expect(result.text).toBe("visibleagain");
  });

  it("extracts task-notification blocks into the notifications array", () => {
    const input =
      "hi <task-notification><task-id>t1</task-id><status>done</status><summary>build ok</summary></task-notification> bye";
    const result = cleanMessageContent(input);
    expect(result.notifications).toEqual([
      { taskId: "t1", status: "done", summary: "build ok" },
    ]);
    // The task-notification block is also removed from the text body
    expect(result.text).not.toContain("<task-notification");
  });

  it("strips ANSI CSI colour sequences", () => {
    const input = "\x1b[31mred\x1b[0m text";
    const result = cleanMessageContent(input);
    expect(result.text).toBe("red text");
  });

  it("strips ANSI OSC sequences (the garbled-title problem)", () => {
    const input = "\x1b]0;Claude Code\x07clean text";
    const result = cleanMessageContent(input);
    expect(result.text).toBe("clean text");
  });

  it("drops noisy lines like Caveat, [Request interrupted, Full transcript", () => {
    const input = [
      "first line",
      "Caveat: noisy",
      "  [Request interrupted by user]",
      "Full transcript available at: /tmp/foo",
      "last line",
    ].join("\n");
    const result = cleanMessageContent(input);
    expect(result.text).toBe("first line\nlast line");
  });

  it("handles an empty string without throwing", () => {
    const result = cleanMessageContent("");
    expect(result.text).toBe("");
    expect(result.notifications).toEqual([]);
  });
});

describe("cleanSearchSnippet", () => {
  it("strips truecolor SGR and cursor moves from PTY dumps", () => {
    const raw =
      "\x1b[?2026h\x1b[9;6H\x1b[38;2;108;108;108;48;2;20;20;20mhello world\x1b[0m";
    expect(cleanSearchSnippet(raw)).toBe("hello world");
  });

  it("returns empty for pure ANSI residue", () => {
    const raw = "\x1b[?2026h\x1b[9;6H\x1b[38;2;108;108;108m\x1b[39;122H";
    expect(cleanSearchSnippet(raw)).toBe("");
  });

  it("collapses whitespace after stripping", () => {
    expect(cleanSearchSnippet("  foo   \n  bar  ")).toBe("foo bar");
  });
});

describe("stripAnsiCodes", () => {
  it("removes OSC title sequences", () => {
    expect(stripAnsiCodes("\x1b]0;Claude Code\x07clean")).toBe("clean");
  });
});
