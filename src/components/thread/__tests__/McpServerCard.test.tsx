/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { McpServerCard } from "../McpServerCard";
import type { McpServerInfo } from "../../../lib/commands";

afterEach(() => cleanup());

const baseServer: McpServerInfo = {
  name: "fs-server",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  url: null,
  env: { TOKEN: "x" },
  scope: "project",
  project_path: "/Users/neel/proj",
};

describe("McpServerCard", () => {
  it("renders server name, transport and scope badges", () => {
    render(<McpServerCard server={baseServer} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("fs-server")).toBeTruthy();
    expect(screen.getByText("stdio")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
  });

  it("renders project basename when project_path is set", () => {
    render(<McpServerCard server={baseServer} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("displays command for stdio transport", () => {
    render(<McpServerCard server={baseServer} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("node")).toBeTruthy();
  });

  it("displays URL for sse transport", () => {
    const sse: McpServerInfo = {
      ...baseServer,
      transport: "sse",
      command: null,
      url: "https://example.com/sse",
      args: [],
      env: null,
      project_path: null,
    };
    render(<McpServerCard server={sse} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("https://example.com/sse")).toBeTruthy();
  });

  it("renders args and env counts (singular vs plural)", () => {
    render(<McpServerCard server={baseServer} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("1 arg")).toBeTruthy();
    expect(screen.getByText("1 env var")).toBeTruthy();

    cleanup();
    const multi: McpServerInfo = {
      ...baseServer,
      args: ["a", "b"],
      env: { A: "1", B: "2" },
    };
    render(<McpServerCard server={multi} removing={false} onRemove={vi.fn()} />);
    expect(screen.getByText("2 args")).toBeTruthy();
    expect(screen.getByText("2 env vars")).toBeTruthy();
  });

  it("calls onRemove when Remove button is clicked", () => {
    const onRemove = vi.fn();
    render(<McpServerCard server={baseServer} removing={false} onRemove={onRemove} />);
    fireEvent.click(screen.getByText("Remove"));
    expect(onRemove).toHaveBeenCalled();
  });

  it("shows Removing... state when removing prop is true", () => {
    render(<McpServerCard server={baseServer} removing={true} onRemove={vi.fn()} />);
    expect(screen.getByText("Removing...")).toBeTruthy();
    expect(screen.queryByText("Remove")).toBeNull();
  });
});
