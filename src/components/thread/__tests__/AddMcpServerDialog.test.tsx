/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const addMcpServerMock = vi.fn();
vi.mock("../../../stores/skillsStore", () => ({
  useSkillsStore: (
    selector: (s: { addMcpServer: typeof addMcpServerMock }) => unknown,
  ) => selector({ addMcpServer: addMcpServerMock }),
}));

import { AddMcpServerDialog } from "../AddMcpServerDialog";

afterEach(() => cleanup());
beforeEach(() => addMcpServerMock.mockReset().mockResolvedValue(undefined));

describe("AddMcpServerDialog", () => {
  it("returns null when open is false", () => {
    const { container } = render(
      <AddMcpServerDialog open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog title and Name input when open", () => {
    render(<AddMcpServerDialog open={true} onClose={vi.fn()} />);
    expect(screen.getByText("Add MCP Server")).toBeTruthy();
    expect(screen.getByPlaceholderText("e.g. filesystem")).toBeTruthy();
  });

  it("shows Command input by default for stdio transport", () => {
    render(<AddMcpServerDialog open={true} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText("e.g. npx")).toBeTruthy();
  });

  it("switches to URL input when sse transport is selected", () => {
    render(<AddMcpServerDialog open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("sse"));
    // After switching, the placeholder should be the URL one — find by URL label
    expect(screen.queryByPlaceholderText("e.g. npx")).toBeNull();
  });

  it("shows error when name is empty on submit", async () => {
    render(<AddMcpServerDialog open={true} onClose={vi.fn()} />);
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText("Name is required.")).toBeTruthy(),
    );
    expect(addMcpServerMock).not.toHaveBeenCalled();
  });

  it("shows error when command is empty for stdio", async () => {
    render(<AddMcpServerDialog open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. filesystem"), {
      target: { value: "myserver" },
    });
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText("Command is required.")).toBeTruthy(),
    );
  });

  it("calls addMcpServer with parsed args and env on valid submit", async () => {
    const onClose = vi.fn();
    render(<AddMcpServerDialog open={true} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. filesystem"), {
      target: { value: "fs" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. npx"), {
      target: { value: "node" },
    });
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(addMcpServerMock).toHaveBeenCalled());
    expect(addMcpServerMock).toHaveBeenCalledWith(
      "fs",
      "stdio",
      "node",
      [],
      {},
      "user",
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("calls onClose when X button clicked", () => {
    const onClose = vi.fn();
    render(<AddMcpServerDialog open={true} onClose={onClose} />);
    const closeBtn = document.querySelector(".lucide-x")!.closest("button")!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
