/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ApprovalBanner } from "../ApprovalBanner";

afterEach(() => cleanup());

const noop = () => {};

describe("ApprovalBanner — approval type (banner variant)", () => {
  it("renders Accept and Deny buttons", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByRole("button", { name: /accept/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /deny/i })).toBeTruthy();
  });

  it("shows tool name when provided", () => {
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("shows 'Permission required' when no tool name", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByText("Permission required")).toBeTruthy();
  });

  it("calls onApprove when Accept is clicked", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        onApprove={onApprove}
        onReject={noop}
        onAnswer={noop}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("calls onReject when Deny is clicked", () => {
    const onReject = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={onReject}
        onAnswer={noop}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("shows 'Allow for Project' button when onAllowForSession provided", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        onAllowForSession={noop}
      />
    );
    expect(screen.getByText("Allow for Project")).toBeTruthy();
  });

  it("does not show 'Allow for Project' button when onAllowForSession is absent", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.queryByText("Allow for Project")).toBeNull();
  });

  it("shows pending count badge when pendingCount > 1", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        pendingCount={3}
      />
    );
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("does not show count badge when pendingCount is 1", () => {
    render(
      <ApprovalBanner
        type="approval"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        pendingCount={1}
      />
    );
    expect(screen.queryByText(/1\//)).toBeNull();
  });
});

describe("ApprovalBanner — flat style surfaces", () => {
  it("marks the inline banner surfaces for the flat style", () => {
    const { container } = render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(container.querySelector(".approval-card")).toBeTruthy();
    expect(container.querySelector(".approval-icon")).toBeTruthy();
    expect(container.querySelector(".approval-accept")?.textContent).toMatch(/Accept/);
  });

  it("marks the dialog surfaces for the flat style", () => {
    const { container } = render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        description={JSON.stringify({ command: "npm install" })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(container.querySelector(".approval-card")).toBeTruthy();
    expect(container.querySelector(".approval-icon")).toBeTruthy();
    expect(container.querySelector(".approval-accept")?.textContent).toMatch(/Accept/);
    expect(container.querySelector(".approval-footer")).toBeTruthy();
  });
});

describe("ApprovalBanner — approval type (dialog variant)", () => {
  it("renders in dialog variant without crashing", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Edit"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByRole("button", { name: /accept/i })).toBeTruthy();
  });

  it("keeps dialog allow-pattern options outside clipped containers", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        allowPatterns={["git commit *", "git *"]}
        onAllowPattern={noop}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /always allow/i }));
    expect(screen.getByRole("button", { name: "git commit *" })).toBeTruthy();

    const dialogCard = screen.getByText("Bash").closest(".relative.w-full");
    expect(dialogCard?.className).not.toContain("overflow-hidden");
  });
});

describe("ApprovalBanner — Task 14 M1/L6: banner vs dialog button sizing, Always allow neutral, Deny kbd contrast", () => {
  it("inline banner uses md (30px) Deny/Accept, not lg (40px)", () => {
    render(
      <ApprovalBanner type="approval" toolName="Bash" onApprove={noop} onReject={noop} onAnswer={noop} />
    );
    expect(screen.getByRole("button", { name: /deny/i }).getAttribute("data-size")).toBe("md");
    expect(screen.getByRole("button", { name: /accept/i }).getAttribute("data-size")).toBe("md");
  });

  it("dialog keeps lg (40px) Deny/Accept", () => {
    render(
      <ApprovalBanner type="approval" variant="dialog" toolName="Bash" onApprove={noop} onReject={noop} onAnswer={noop} />
    );
    expect(screen.getByRole("button", { name: /deny/i }).getAttribute("data-size")).toBe("lg");
    expect(screen.getByRole("button", { name: /accept/i }).getAttribute("data-size")).toBe("lg");
  });

  it("banner's Allow for Project is a 30px neutral (fx-quiet) button", () => {
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        onAllowForSession={noop}
      />
    );
    const btn = screen.getByRole("button", { name: /allow for project/i });
    expect(btn.className).toContain("fx-quiet");
    expect(btn.className).toContain("min-h-[30px]");
  });

  it("dialog's Allow for Project is a 40px neutral (fx-quiet) button", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        onAllowForSession={noop}
      />
    );
    const btn = screen.getByRole("button", { name: /allow for project/i });
    expect(btn.className).toContain("fx-quiet");
    expect(btn.className).toContain("min-h-[40px]");
  });

  it("banner's Always allow menu is a 30px neutral (fx-quiet) button", () => {
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        allowPatterns={["git push *", "git *"]}
        onAllowPattern={noop}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    const btn = screen.getByRole("button", { name: /always allow/i });
    expect(btn.className).toContain("fx-quiet");
    expect(btn.className).toContain("min-h-[30px]");
  });

  it("dialog's Always allow menu is a 40px neutral (fx-quiet) button", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        allowPatterns={["git push *", "git *"]}
        onAllowPattern={noop}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    const btn = screen.getByRole("button", { name: /always allow/i });
    expect(btn.className).toContain("fx-quiet");
    expect(btn.className).toContain("min-h-[40px]");
  });

  it("L6: Deny's shortcut hint no longer dims to ~3.8:1 (opacity-70 dropped)", () => {
    render(
      <ApprovalBanner type="approval" toolName="Bash" onApprove={noop} onReject={noop} onAnswer={noop} />
    );
    const denyBtn = screen.getByRole("button", { name: /deny/i });
    const kbd = denyBtn.querySelector(".ui-kbd");
    expect(kbd?.className).not.toContain("opacity-70");
  });
});

describe("ApprovalBanner — question type", () => {
  it("renders input and Send button", () => {
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy();
    expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
  });

  it("Send button is disabled when input is empty", () => {
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onAnswer with typed text when Send is clicked", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={onAnswer}
      />
    );
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "my answer" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onAnswer).toHaveBeenCalledWith("my answer");
  });

  it("shows description when provided", () => {
    render(
      <ApprovalBanner
        type="question"
        description="What is your name?"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />
    );
    expect(screen.getByText("What is your name?")).toBeTruthy();
  });
});

describe("ApprovalBanner — Final coverage gaps", () => {
  it("Cmd+Enter triggers onApprove via keyboard shortcut", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={onApprove}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    const ev = new KeyboardEvent("keydown", { key: "Enter", metaKey: true });
    window.dispatchEvent(ev);
    expect(onApprove).toHaveBeenCalled();
  });

  it("Cmd+Backspace triggers onReject via keyboard shortcut", () => {
    const onReject = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={noop}
        onReject={onReject}
        onAnswer={noop}
      />,
    );
    const ev = new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true });
    window.dispatchEvent(ev);
    expect(onReject).toHaveBeenCalled();
  });

  it("non-meta keystrokes do not trigger callbacks", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        onApprove={onApprove}
        onReject={onReject}
        onAnswer={noop}
      />,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("question type does not register the Cmd+Enter approval shortcut", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalBanner
        type="question"
        onApprove={onApprove}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("renders Edit ToolDetail with action label and old_string preview", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Edit"
        description={JSON.stringify({
          file_path: "/Users/neel/Documents/GitHub/xanom/foo.ts",
          old_string: "const x = 1;",
        })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("foo.ts")).toBeTruthy();
    // The action label is "Edit" — rendered uppercased via CSS but text is "Edit"
    expect(screen.getAllByText(/Edit/i).length).toBeGreaterThan(0);
  });

  it("renders Bash ToolDetail with command", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        description={JSON.stringify({ command: "npm install" })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("npm install")).toBeTruthy();
  });

  it("renders Grep ToolDetail with pattern + path", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Grep"
        description={JSON.stringify({ pattern: "TODO", path: "/Users/neel/src" })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("TODO")).toBeTruthy();
    expect(screen.getByText(/in ~\/src/)).toBeTruthy();
  });

  it("renders Task ToolDetail with description", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Task"
        description={JSON.stringify({ description: "investigate bug" })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("investigate bug")).toBeTruthy();
  });

  it("renders fallback key/value pairs for unknown tool input", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Unknown"
        description={JSON.stringify({ foo_bar: "baz", count: 5 })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("foo bar")).toBeTruthy();
    expect(screen.getByText("baz")).toBeTruthy();
  });

  it("renders raw fallback when JSON is invalid and no toolName", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        description="raw plain text"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("raw plain text")).toBeTruthy();
  });

  it("regex-extracts file_path from broken JSON", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Read"
        description={'{"file_path": "/Users/neel/x.txt", malformed'}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("x.txt")).toBeTruthy();
  });

  it("regex-extracts command from broken JSON", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        description={'{"command": "ls -la", broken'}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("Send button does not call onAnswer when input is whitespace-only", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={onAnswer}
      />,
    );
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Enter key sends an answer", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={onAnswer}
      />,
    );
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith("hello");
  });

  it("Shift+Enter does not send an answer", () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalBanner
        type="question"
        onApprove={noop}
        onReject={noop}
        onAnswer={onAnswer}
      />,
    );
    const input = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("question variant=dialog wraps content in dialog shell", () => {
    render(
      <ApprovalBanner
        type="question"
        variant="dialog"
        description="Pick a value"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("Input Required")).toBeTruthy();
    expect(screen.getByText("Pick a value")).toBeTruthy();
  });

  it("renders allow-for-session in dialog variant when callback provided", () => {
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        onAllowForSession={noop}
      />,
    );
    expect(screen.getByText("Allow for Project")).toBeTruthy();
  });

  it("clicking Allow for Project triggers onAllowForSession", () => {
    const onAllow = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
        onAllowForSession={onAllow}
      />,
    );
    fireEvent.click(screen.getByText("Allow for Project"));
    expect(onAllow).toHaveBeenCalled();
  });

  it("truncates very long commands with an ellipsis", () => {
    const longCmd = "a".repeat(400);
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Bash"
        description={JSON.stringify({ command: longCmd })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText(/…$/)).toBeTruthy();
  });

  it("truncates very long descriptions with an ellipsis (Task)", () => {
    const longDesc = "x".repeat(300);
    render(
      <ApprovalBanner
        type="approval"
        variant="dialog"
        toolName="Task"
        description={JSON.stringify({ description: longDesc })}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText(/…$/)).toBeTruthy();
  });

  it("uses dismiss callback (not onReject) when timer hits 0 and onDismiss provided", async () => {
    const onDismiss = vi.fn();
    const onReject = vi.fn();
    // Already-elapsed window so countdown reads 0 immediately.
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        startTime={Date.now() - 60_000}
        timeoutSeconds={5}
        onApprove={noop}
        onReject={onReject}
        onAnswer={noop}
        onDismiss={onDismiss}
      />,
    );
    // Allow the useEffect from useCountdown to fire one tick.
    await new Promise((r) => setTimeout(r, 20));
    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("falls back to onReject when timer is 0 and no onDismiss provided", async () => {
    const onReject = vi.fn();
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        startTime={Date.now() - 60_000}
        timeoutSeconds={5}
        onApprove={noop}
        onReject={onReject}
        onAnswer={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onReject).toHaveBeenCalled();
  });

  it("renders countdown timer when running (banner)", async () => {
    render(
      <ApprovalBanner
        type="approval"
        toolName="Bash"
        startTime={Date.now()}
        timeoutSeconds={45}
        onApprove={noop}
        onReject={noop}
        onAnswer={noop}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/^(45|44)s$/)).toBeTruthy();
  });
});
