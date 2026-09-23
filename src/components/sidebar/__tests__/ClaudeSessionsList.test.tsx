/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  ClaudeSessionsForProject,
  formatTime,
  getSessionsForProject,
} from "../ClaudeSessionsList";
import type { ClaudeSession } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => cleanup());

const session: ClaudeSession = {
  id: "s1",
  preview: "Hello world prompt",
  updated_at: new Date().toISOString(),
  cwd: "/tmp/proj",
  model: null,
  lines_added: 0,
  lines_removed: 0,
  files_changed: 0,
};

describe("ClaudeSessionsList helpers", () => {
  it("getSessionsForProject filters sessions to a given path", () => {
    const sessions: ClaudeSession[] = [
      { ...session, id: "a", cwd: "/tmp/a" },
      { ...session, id: "b", cwd: "/tmp/b" },
      { ...session, id: "c", cwd: "/tmp/a", preview: "Session abc-123" }, // default name — filtered
    ];
    const filtered = getSessionsForProject(sessions, "/tmp/a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("formatTime returns 'today' for today's date", () => {
    expect(formatTime(new Date().toISOString())).toBe("today");
  });

  it("formatTime returns empty string for null", () => {
    expect(formatTime(null)).toBe("");
  });

  it("formatTime returns 'yesterday' for 1-day-old date", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    expect(formatTime(d.toISOString())).toBe("yesterday");
  });

  it("formatTime returns 'Nd ago' for dates 2-6 days old", () => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    expect(formatTime(d.toISOString())).toBe("3d ago");
  });

  it("formatTime returns localeDate for dates >= 7 days old", () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const result = formatTime(d.toISOString());
    expect(result).not.toBe("today");
    expect(result).not.toMatch(/^\d+d ago$/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("formatTime returns empty string for undefined", () => {
    expect(formatTime(undefined)).toBe("");
  });

  it("formatTime returns empty string for malformed date string", () => {
    expect(formatTime("not-a-date")).toBe("");
  });

  it("getSessionsForProject excludes default-named sessions like 'Session abc-123'", () => {
    const sessions: ClaudeSession[] = [
      { ...session, id: "a", cwd: "/p", preview: "Session abc-123" },
      { ...session, id: "b", cwd: "/p", preview: "Real conversation" },
    ];
    const filtered = getSessionsForProject(sessions, "/p");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("getSessionsForProject returns empty array for no matches", () => {
    const sessions: ClaudeSession[] = [
      { ...session, id: "a", cwd: "/x" },
    ];
    expect(getSessionsForProject(sessions, "/y")).toEqual([]);
  });

  it("getSessionsForProject returns empty when given empty input", () => {
    expect(getSessionsForProject([], "/anywhere")).toEqual([]);
  });
});

describe("ClaudeSessionsForProject", () => {
  it("renders nothing when sessions array is empty", () => {
    const { container } = render(<ClaudeSessionsForProject sessions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a row for each session", () => {
    render(
      <ClaudeSessionsForProject
        sessions={[
          { ...session, id: "s1", preview: "First task" },
          { ...session, id: "s2", preview: "Second task" },
        ]}
      />,
    );
    expect(screen.getByText("First task")).toBeTruthy();
    expect(screen.getByText("Second task")).toBeTruthy();
  });

  it("renders the CC badge for each session", () => {
    render(
      <ClaudeSessionsForProject
        sessions={[{ ...session, id: "s1", preview: "Task X" }]}
      />,
    );
    const badges = screen.getAllByText("CC");
    expect(badges.length).toBeGreaterThan(0);
  });

  it("shows 'Show more' when sessions exceed page size", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...session,
      id: `s${i}`,
      preview: `Task ${i}`,
    }));
    render(<ClaudeSessionsForProject sessions={many} />);
    // Page size default is 5
    expect(screen.getByText(/Show more/)).toBeTruthy();
  });

  it("renders rename button for hovering", () => {
    render(
      <ClaudeSessionsForProject
        sessions={[{ ...session, id: "s1", preview: "Task 1" }]}
      />,
    );
    expect(screen.getByLabelText("Rename session")).toBeTruthy();
  });
});
