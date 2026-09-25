/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CoworkToolLine } from "../CoworkToolLine";

vi.mock("../ToolDetailDialog", () => ({
  ToolDetailDialog: () => null,
}));

afterEach(() => cleanup());

describe("CoworkToolLine", () => {
  it("shows progressive Read status without expanding result body", () => {
    const { rerender } = render(
      <CoworkToolLine
        name="Read"
        toolId="t1"
        input={{ file_path: "/Users/me/project/notes.md" }}
        pending
      />,
    );
    const line = screen.getByTestId("cowork-tool-line");
    expect(line.getAttribute("data-status")).toBe("running");
    const lead = screen.getByText("Reading file");
    expect(lead).toBeTruthy();
    // Lead verb is muted; subject path is brighter
    expect(lead.className).toMatch(/text-muted|text-\[var\(--text-muted\)\]/);
    const subject = screen.getByText(/notes\.md/);
    expect(subject.className).toMatch(/text-secondary|text-\[var\(--text-secondary\)\]/);
    // File paths are machine text — subject stays mono.
    expect(subject.className).toContain("font-mono");
    expect(screen.queryByText("hide")).toBeNull();
    expect(screen.queryByText("output")).toBeNull();

    rerender(
      <CoworkToolLine
        name="Read"
        toolId="t1"
        input={{ file_path: "/Users/me/project/notes.md" }}
        result={{ content: "file body ".repeat(50), isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText("Read file")).toBeTruthy();
    expect(screen.getByTestId("cowork-tool-line").getAttribute("data-status")).toBe("ok");
    expect(screen.queryByText(/file body file body/)).toBeNull();
  });

  it("uses Running/Ran command for Bash", () => {
    const { rerender } = render(
      <CoworkToolLine
        name="Bash"
        toolId="t2"
        input={{ command: "ls -la", description: "List files" }}
        pending
      />,
    );
    expect(screen.getByText("Running command")).toBeTruthy();
    expect(screen.getByText("List files")).toBeTruthy();

    rerender(
      <CoworkToolLine
        name="Bash"
        toolId="t2"
        input={{ command: "ls -la", description: "List files" }}
        result={{ content: "a\nb\nc\n".repeat(100), isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText("Ran command")).toBeTruthy();
    expect(screen.queryByText(/a\nb\nc/)).toBeNull();
  });

  it("shows simple MCP connector lines without dumping payloads", () => {
    const { rerender } = render(
      <CoworkToolLine
        name="mcp__claude_ai_Gmail__search_threads"
        toolId="m1"
        input={{ query: "from:admissions after:2026/01/01" }}
        pending
      />,
    );
    // Search MCPs: "Searching Gmail for …query"
    expect(screen.getByText(/Searching Gmail for/i)).toBeTruthy();
    expect(screen.getByText(/from:admissions/)).toBeTruthy();
    // No raw mcp__ id or huge JSON
    expect(screen.queryByText(/mcp__/)).toBeNull();

    rerender(
      <CoworkToolLine
        name="mcp__Firecrawl__firecrawl_search"
        toolId="m1b"
        input={{ query: "University of Minnesota Twin Cities 2026 first-year application" }}
        result={{ content: "hits", isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText(/Searched Firecrawl for/i)).toBeTruthy();
    expect(screen.getByText(/University of Minnesota/)).toBeTruthy();

    rerender(
      <CoworkToolLine
        name="mcp__Slack__slack_send_message"
        toolId="m2"
        input={{ channel: "#general", message: "hello world ".repeat(40) }}
        result={{ content: JSON.stringify({ ok: true, ts: "1.2" }), isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText(/Updated Slack|Used Slack|Updating Slack/i)).toBeTruthy();
    expect(screen.queryByText(/"ok":\s*true/)).toBeNull();
  });

  it("subject mono follows tool kind: sans for prose, mono for commands/paths", () => {
    // Prose kind — a web search query reads as a sentence, not machine text.
    const { rerender } = render(
      <CoworkToolLine
        name="WebSearch"
        toolId="ws1"
        input={{ query: "best hiking trails near Boulder" }}
        pending
      />,
    );
    const querySubject = screen.getByText(/best hiking trails/);
    expect(querySubject.className).not.toContain("font-mono");

    // Command/path kind — a shell command (no description fallback) stays mono.
    rerender(
      <CoworkToolLine
        name="Bash"
        toolId="ws1"
        input={{ command: "ls -la" }}
        pending
      />,
    );
    const commandSubject = screen.getByText("ls -la");
    expect(commandSubject.className).toContain("font-mono");
  });

  it("read_files with multiple paths renders a prose count, not mono", () => {
    render(
      <CoworkToolLine
        name="read_files"
        toolId="rf1"
        input={{ paths: ["/a.ts", "/b.ts", "/c.ts"] }}
        pending
      />,
    );
    const countSubject = screen.getByText("3 files");
    expect(countSubject.className).not.toContain("font-mono");
  });

  it("humanizes ToolSearch select: queries and task tools", () => {
    const { rerender } = render(
      <CoworkToolLine
        name="ToolSearch"
        toolId="ts1"
        input={{ query: "select:TaskCreate,TaskUpdate" }}
        result={{ content: "ok", isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText("Found tools")).toBeTruthy();
    expect(screen.getByText(/TaskCreate, TaskUpdate/)).toBeTruthy();
    // No raw select: prefix in the subject
    expect(screen.queryByText(/select:/i)).toBeNull();

    rerender(
      <CoworkToolLine
        name="ToolSearch"
        toolId="ts2"
        input={{ query: "create task list todo tracking progress" }}
        pending
      />,
    );
    expect(screen.getByText("Finding tools")).toBeTruthy();
    expect(screen.getByText(/create task list/)).toBeTruthy();

    rerender(
      <CoworkToolLine
        name="TaskCreate"
        toolId="tc1"
        input={{ subject: "Research UMN supplements" }}
        result={{ content: '{"task":{"id":"1","subject":"Research UMN supplements"}}', isError: false }}
        pending={false}
      />,
    );
    expect(screen.getByText("Created task")).toBeTruthy();
    expect(screen.getByText(/Research UMN supplements/)).toBeTruthy();
  });
});

