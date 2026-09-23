import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { conversationItemsFromExec, renderCodexToolItem, renderTimelineEntry, type ConversationItem } from "../CodexSessionView";

afterEach(cleanup);
function Tool({ item }: { item: ConversationItem }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return renderCodexToolItem(item, open, setOpen);
}
const shell = (output: string, extra = {}) => [{ type: "input_text", text: JSON.stringify({ output, ...extra }) }];

describe("actual Codex exec tool rendering", () => {
  it("shows an incomplete shell snapshot without a success badge or live spinner", () => {
    const [item] = conversationItemsFromExec({ callId: "snapshot", timestamp: 1, source: 'text(await tools.exec_command({cmd:"npm test"}));', result: shell("starting", { session_id: 42 }) });
    const view = render(<Tool item={item} />);
    expect(view.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("idle");
    expect(view.getByText("No exit status recorded")).toBeTruthy();
    fireEvent.click(view.getByTestId("codex-tool-row"));
    expect(view.getByTestId("codex-term").getAttribute("data-status")).toBe("idle");
    expect(view.getByText("starting")).toBeTruthy();
  });
  it("renders rejection as failure without fabricating an exit code", () => {
    const [item] = conversationItemsFromExec({ callId: "reject", timestamp: 1, source: 'text(await Promise.allSettled([tools.exec_command({cmd:"npm test"})]));', result: [{ type: "input_text", text: JSON.stringify([{ status: "rejected", reason: "permission denied" }]) }] });
    const view = render(<Tool item={item} />);
    expect(view.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("error");
    expect(view.getByText("Failed")).toBeTruthy();
    fireEvent.click(view.getByTestId("codex-tool-row"));
    expect(view.getByTestId("codex-term").textContent).toContain("permission denied");
    expect(view.queryByText("exit 1")).toBeNull();
  });
  it("preserves the full command and escaped/truncated output in the expanded panel", () => {
    const command = 'python3 - <<\'PY\'\nprint("<script>display only</script>")\n' + "# long input\n".repeat(20) + 'PY';
    const output = 'Warning: truncated output\n<script>never execute</script>\nLiteral \\n C:\\tmp';
    const [item] = conversationItemsFromExec({ callId: "long", timestamp: 1, source: `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`, result: shell(output, { exit_code: 0 }) });
    const view = render(<Tool item={item} />);
    fireEvent.click(view.getByTestId("codex-tool-row"));
    expect(view.getByTestId("codex-term").textContent).toContain(command);
    const heading = [...view.getByTestId("codex-term").querySelectorAll("[title]")].find((el) => el.getAttribute("title") === command);
    expect(heading).toBeTruthy();
    expect(heading!.classList.contains("truncate")).toBe(false);
    expect(view.getByTestId("codex-term").textContent).toContain(output);
    expect(view.container.querySelector("script")).toBeNull();
  });
  it("makes missing results explicit while retaining unresolved source", () => {
    const source = 'if (enabled) text(await tools.exec_command({cmd:resolve()}));';
    const [item] = conversationItemsFromExec({ callId: "missing", timestamp: 1, isHistory: true, source });
    const view = render(<Tool item={item} />);
    expect(view.getByText("Code execution")).toBeTruthy();
    expect(view.getByText("Result unavailable")).toBeTruthy();
    fireEvent.click(view.getByTestId("codex-tool-row"));
    expect(view.getByTestId("codex-output").textContent).toContain(source);
  });
});

it("does not mark a batch of captured shell snapshots as live or successful", () => {
  const items = conversationItemsFromExec({ callId: "batch-snapshot", timestamp: 1, source: 'text(await Promise.all([tools.exec_command({cmd:"npm test"}),tools.exec_command({cmd:"npm run lint"})]));', result: [{ type: "input_text", text: JSON.stringify([{ output: "started", session_id: 1 }, { output: "started", session_id: 2 }]) }] });
  const view = render(<>{renderTimelineEntry({ kind: "toolGroup", timestamp: 1, items }, {}, () => {}, true)}</>);
  expect(view.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("idle");
  expect(view.getByText("No exit status recorded")).toBeTruthy();
});

it("bounds enormous saved text output with an explicit display notice", () => {
  const body = "large output ".repeat(30000);
  const [item] = conversationItemsFromExec({ callId: "large", timestamp: 1, source: 'text(await tools.exec_command({cmd:"cat log"}));', result: shell(body, { exit_code: 0 }) });
  const view = render(<Tool item={item} />);
  fireEvent.click(view.getByTestId("codex-tool-row"));
  expect(view.container.textContent!.length).toBeLessThan(70000);
  expect(view.getByRole("button", { name: "Show more output" })).toBeTruthy();
  expect(item.content).toBe(body);
});

it("retains unfamiliar collaboration tools such as saved followup tasks", () => {
  const item: ConversationItem = { id: "followup", type: "tool", content: "Task queued", timestamp: 1, isHistory: true, toolName: "collaboration.followup_task", toolInput: { prompt: "Check the revised UI" } };
  const view = render(<Tool item={item} />);
  expect(view.getByTestId("codex-tool-row").textContent).toContain("collaboration.followup_task");
  fireEvent.click(view.getByTestId("codex-tool-row"));
  expect(view.getByTestId("codex-output").textContent).toContain("Check the revised UI");
  expect(view.getByTestId("codex-output").textContent).toContain("Task queued");
});
