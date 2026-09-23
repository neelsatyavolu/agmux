/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryMainPanel } from "../MemoryMainPanel";
import { useProjectStore } from "../../../stores/projectStore";
import type { SessionMemoryEntry } from "../../../lib/commands";

const memoryStyles = readFileSync("src/index.css", "utf8");

const memorySnapshot = vi.fn();
const memoryHealth = vi.fn();
const memoryArchiveDetailed = vi.fn();
const memoryRestoreDetailed = vi.fn();
const memoryResolveDetailed = vi.fn();
const memoryReopenDetailed = vi.fn();
const memoryUpdateDetailed = vi.fn();
const memorySupersedeDetailed = vi.fn();
const memoryConfirmBinding = vi.fn();
const memoryRevokeBinding = vi.fn();
const memoryClean = vi.fn();
const handoffList = vi.fn();
let projectRevision: number;
let projectEntries: SessionMemoryEntry[];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/commands", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/commands")>(
    "../../../lib/commands",
  );
  return {
    ...actual,
    memorySnapshot: (...args: unknown[]) => memorySnapshot(...args),
    memoryHealth: (...args: unknown[]) => memoryHealth(...args),
    memoryArchiveDetailed: (...args: unknown[]) => memoryArchiveDetailed(...args),
    memoryRestoreDetailed: (...args: unknown[]) => memoryRestoreDetailed(...args),
    memoryResolveDetailed: (...args: unknown[]) => memoryResolveDetailed(...args),
    memoryReopenDetailed: (...args: unknown[]) => memoryReopenDetailed(...args),
    memoryUpdateDetailed: (...args: unknown[]) => memoryUpdateDetailed(...args),
    memorySupersedeDetailed: (...args: unknown[]) => memorySupersedeDetailed(...args),
    memoryConfirmBinding: (...args: unknown[]) => memoryConfirmBinding(...args),
    memoryRevokeBinding: (...args: unknown[]) => memoryRevokeBinding(...args),
    memoryClean: (...args: unknown[]) => memoryClean(...args),
    handoffList: (...args: unknown[]) => handoffList(...args),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      {
        id: "proj-1",
        name: "agmux",
        repo_path: "/Users/neel/Documents/GitHub/agmux",
        created_at: "2026-01-01T00:00:00Z",
        conventions: "",
      },
      {
        id: "proj-2",
        name: "empty-app",
        repo_path: "/tmp/empty-app",
        created_at: "2026-01-01T00:00:00Z",
        conventions: "",
      },
    ],
    loading: false,
    error: null,
    fetchProjects: vi.fn().mockResolvedValue(undefined),
  } as never);

  projectRevision = 7;
  projectEntries = [
    {
      id: "e1",
      kind: "decision",
      title: "Use canvas terminal",
      content: "WebGL has DPR issues on WKWebView so we use Canvas.",
      source: "agent",
      authority: "agent",
      createdAt: "2026-07-12T08:00:00.000Z",
      updatedAt: "2026-07-12T08:00:00.000Z",
      archived: false,
      important: true,
      binding: false,
      bindingConfirmedAt: null,
      bindingConfirmedBy: null,
      status: "current",
      supersedes: [],
    },
    {
      id: "e2",
      kind: "issue",
      title: "Spinner hang",
      content: "False complete toast then hung spinner after Stop.",
      source: "agent",
      authority: "agent",
      createdAt: "2026-07-12T07:00:00.000Z",
      updatedAt: "2026-07-12T07:30:00.000Z",
      archived: false,
      important: false,
      binding: false,
      bindingConfirmedAt: null,
      bindingConfirmedBy: null,
      status: "current",
      supersedes: [],
    },
  ];
  memorySnapshot.mockImplementation(async (opts: { projectId?: string }) => {
    if (opts.projectId === "proj-1") {
      return { revision: projectRevision, entries: projectEntries };
    }
    return { revision: 0, entries: [] };
  });
  memoryHealth.mockImplementation(async (opts: { projectId?: string }) => {
    if (opts.projectId === "proj-1") {
      const active = projectEntries.filter(
        (entry) => !entry.archived && entry.status === "current",
      );
      return {
        revision: projectRevision,
        totalEntries: projectEntries.length,
        activeEntries: active.length,
        bindingCount: active.filter((entry) => entry.binding).length,
        needsReviewCount: active.filter((entry) => entry.important && !entry.binding).length,
        findings: [],
      };
    }
    return {
      revision: 0,
      totalEntries: 0,
      activeEntries: 0,
      bindingCount: 0,
      needsReviewCount: 0,
      findings: [],
    };
  });
  handoffList.mockImplementation(async (opts: { projectId?: string }) => {
    if (opts.projectId === "proj-1") {
      return [
        {
          id: "thread-1",
          threadId: "thread-1",
          providerSessionId: "",
          provider: "ClaudeCode",
          title: "Fix spinner hang",
          summary: "Root-caused false complete toast; spinner now clears on real Stop.",
          transcriptPath: "/tmp/session.jsonl",
          status: "active",
          cwd: "/Users/neel/Documents/GitHub/agmux",
          createdAt: "2026-07-12T08:00:00.000Z",
          updatedAt: "2026-07-12T09:00:00.000Z",
          source: "agent",
        },
      ];
    }
    return [];
  });
  memoryArchiveDetailed.mockImplementation(async ({ id }: { id: string }) => {
    projectRevision += 1;
    projectEntries = projectEntries.map((entry) =>
      entry.id === id ? { ...entry, archived: true } : entry,
    );
    return {
      revision: projectRevision,
      projectionWarning: null,
      entry: projectEntries.find((entry) => entry.id === id),
    };
  });
  memoryRestoreDetailed.mockImplementation(async ({ id }: { id: string }) => {
    projectRevision += 1;
    projectEntries = projectEntries.map((entry) =>
      entry.id === id ? { ...entry, archived: false } : entry,
    );
    return {
      revision: projectRevision,
      projectionWarning: null,
      entry: projectEntries.find((entry) => entry.id === id),
    };
  });
  memoryResolveDetailed.mockImplementation(async ({ id }: { id: string }) => ({
    revision: ++projectRevision,
    projectionWarning: null,
    entry: (projectEntries = projectEntries.map((entry) =>
      entry.id === id ? { ...entry, status: "resolved" as const } : entry,
    )).find((entry) => entry.id === id),
  }));
  memoryReopenDetailed.mockImplementation(async ({ id }: { id: string }) => ({
    revision: ++projectRevision,
    projectionWarning: null,
    entry: (projectEntries = projectEntries.map((entry) =>
      entry.id === id ? { ...entry, status: "current" as const } : entry,
    )).find((entry) => entry.id === id),
  }));
  memoryUpdateDetailed.mockImplementation(
    async ({ id, title, content, important }: { id: string; title?: string; content?: string; important?: boolean }) => ({
      revision: ++projectRevision,
      projectionWarning: null,
      entry: (projectEntries = projectEntries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              ...(title === undefined ? {} : { title }),
              ...(content === undefined ? {} : { content }),
              ...(important === undefined ? {} : { important }),
            }
          : entry,
      )).find((entry) => entry.id === id),
    }),
  );
  memorySupersedeDetailed.mockImplementation(async ({ id }: { id: string }) => ({
    revision: ++projectRevision,
    projectionWarning: null,
    entry: projectEntries.find((candidate) => candidate.id === id),
  }));
  memoryConfirmBinding.mockImplementation(async ({ id }: { id: string }) => {
    projectRevision += 1;
    projectEntries = projectEntries.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            authority: "user",
            binding: true,
            bindingConfirmedAt: "2026-07-12T10:00:00.000Z",
            bindingConfirmedBy: "user",
          }
        : entry,
    );
    return {
      revision: projectRevision,
      projectionWarning: null,
      entry: projectEntries.find((entry) => entry.id === id),
    };
  });
  memoryRevokeBinding.mockImplementation(async ({ id }: { id: string }) => {
    projectRevision += 1;
    projectEntries = projectEntries.map((entry) =>
      entry.id === id
        ? { ...entry, binding: false, bindingConfirmedAt: null, bindingConfirmedBy: null }
        : entry,
    );
    return {
      revision: projectRevision,
      projectionWarning: null,
      entry: projectEntries.find((entry) => entry.id === id),
    };
  });
  memoryClean.mockImplementation(async () => {
    let clearedImportant = 0;
    let archivedSuperseded = 0;
    let archivedResolved = 0;
    projectEntries = projectEntries.map((entry) => {
      if (entry.archived) return entry;
      let next = entry;
      if (entry.important) {
        clearedImportant += 1;
        next = { ...next, important: false };
      }
      if (entry.status === "superseded") {
        archivedSuperseded += 1;
        next = { ...next, archived: true };
      } else if (entry.kind === "issue" && entry.status === "resolved") {
        archivedResolved += 1;
        next = { ...next, archived: true };
      }
      return next;
    });
    const cleared = clearedImportant + archivedSuperseded + archivedResolved;
    if (cleared > 0) projectRevision += 1;
    return {
      clearedImportant,
      archivedSuperseded,
      archivedResolved,
      cleared,
      revision: projectRevision,
      projectionWarning: null,
    };
  });
});

describe("MemoryMainPanel", () => {
  it("loads projects collapsed by default (hides entry titles until expand)", async () => {
    render(<MemoryMainPanel />);
    expect(screen.getByTestId("memory-main-panel")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("agmux")).toBeTruthy();
    });
    // Collapsed: project name visible, entry/session titles not
    expect(screen.queryByText("Use canvas terminal")).toBeNull();
    expect(screen.queryByText("Fix spinner hang")).toBeNull();
    expect(handoffList).toHaveBeenCalled();
  });

  it("separates durable memory from session history", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Use canvas terminal")).toBeTruthy();
      expect(screen.queryByText("Fix spinner hang")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    await waitFor(() => expect(screen.getByText("Fix spinner hang")).toBeTruthy());
    expect(screen.queryByText("Use canvas terminal")).toBeNull();
    expect(screen.getByText(/Root-caused false complete/)).toBeTruthy();
    expect(screen.getAllByTestId("mem-session-entry").length).toBe(1);
    expect(screen.getByText("Recorded by agent")).toBeTruthy();
  });

  it("expands projects automatically for search matches", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Search durable memory…"), {
      target: { value: "canvas" },
    });
    await waitFor(() => expect(screen.getByText("Use canvas terminal")).toBeTruthy());
  });

  it("archives an entry when expanded", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Use canvas terminal")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Archive Use canvas terminal"));
    await waitFor(() => {
      expect(memoryArchiveDetailed).toHaveBeenCalledWith({
        projectId: "proj-1",
        id: "e1",
        expectedRevision: 7,
      });
      expect(screen.queryByText("Use canvas terminal")).toBeNull();
    });
    expect(
      memorySnapshot.mock.calls.filter(([opts]) => opts.projectId === "proj-1"),
    ).toHaveLength(2);
    expect(
      memoryHealth.mock.calls.filter(([opts]) => opts.projectId === "proj-1"),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(memoryRestoreDetailed).toHaveBeenCalledWith({
        projectId: "proj-1",
        id: "e1",
        expectedRevision: 8,
      }),
    );
  });

  it("edits and resolves a durable memory", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Spinner hang")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Edit Spinner hang"));
    fireEvent.change(screen.getByLabelText("Memory title"), {
      target: { value: "Spinner lifecycle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(memoryUpdateDetailed).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 7 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(memoryResolveDetailed).toHaveBeenCalledWith({
        projectId: "proj-1",
        id: "e2",
        expectedRevision: 8,
      }),
    );
  });

  it("keeps session history available when durable memory fails", async () => {
    memorySnapshot.mockImplementation(async (opts: { projectId?: string }) => {
      if (opts.projectId === "proj-1") throw new Error("memory store is malformed");
      return { revision: 0, entries: [] };
    });
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Fix spinner hang")).toBeTruthy());
    expect(screen.queryByText(/Couldn’t load durable memory/)).toBeNull();
  });

  it("shows health counts and filters important attention entries", async () => {
    memoryHealth.mockImplementation(async (opts: { projectId?: string }) =>
      opts.projectId === "proj-1"
        ? {
            revision: 7,
            totalEntries: 2,
            activeEntries: 2,
            bindingCount: 0,
            needsReviewCount: 1,
            findings: [
              { code: "secret_candidate", count: 1 },
              { code: "projection_omitted", count: 4 },
            ],
          }
        : {
            revision: 0,
            totalEntries: 0,
            activeEntries: 0,
            bindingCount: 0,
            needsReviewCount: 0,
            findings: [],
          },
    );
    render(<MemoryMainPanel />);
    await waitFor(() =>
      expect(screen.getByLabelText("Memory health").textContent).toContain("2 active"),
    );
    expect(screen.getByLabelText("Memory health").textContent).toContain("0 binding");
    expect(screen.getByLabelText("Memory health").textContent).toContain("1 important (non-binding)");
    expect(screen.getByLabelText("Memory health").textContent).toContain("1 privacy candidates");
    expect(screen.getByLabelText("Memory health").textContent).toContain(
      "4 omitted from local projection",
    );

    fireEvent.click(screen.getByRole("button", { name: "Important" }));
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Use canvas terminal")).toBeTruthy());
    expect(screen.queryByText("Spinner hang")).toBeNull();
  });

  it("does not offer a user confirm-binding gate for important agent memories", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Use canvas terminal")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Review binding/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm binding/i })).toBeNull();
    expect(screen.queryByText(/Agents will treat this as a confirmed constraint/)).toBeNull();
    expect(memoryConfirmBinding).not.toHaveBeenCalled();
  });

  it("cleans important flags and lifecycle clutter after confirmation", async () => {
    projectEntries = [
      {
        ...projectEntries[0],
        important: true,
        binding: true,
        bindingConfirmedAt: "2026-07-12T10:00:00.000Z",
        bindingConfirmedBy: "agent",
      },
      {
        ...projectEntries[1],
        important: true,
        binding: false,
        status: "superseded",
      },
      {
        id: "e3",
        kind: "issue",
        title: "Resolved hang",
        content: "fixed",
        source: "agent",
        authority: "agent",
        createdAt: "2026-07-12T06:00:00.000Z",
        updatedAt: "2026-07-12T06:30:00.000Z",
        archived: false,
        important: false,
        binding: false,
        bindingConfirmedAt: null,
        bindingConfirmedBy: null,
        status: "resolved",
        supersedes: [],
      },
    ];
    memoryClean.mockImplementation(async () => {
      projectRevision += 1;
      projectEntries = projectEntries.map((entry) => {
        if (entry.archived) return entry;
        return {
          ...entry,
          important: false,
          archived:
            entry.status === "superseded" ||
            (entry.kind === "issue" && entry.status === "resolved")
              ? true
              : entry.archived,
        };
      });
      return {
        clearedImportant: 2,
        archivedSuperseded: 1,
        archivedResolved: 1,
        cleared: 4,
        revision: projectRevision,
        projectionWarning: null,
      };
    });
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByLabelText("Clean memories")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Clean memories"));
    const dialog = screen.getByLabelText("Confirm clean memories");
    expect(dialog.textContent).toMatch(/archive 1 superseded/);
    expect(dialog.textContent).toMatch(/archive 1 resolved issue/);
    expect(memoryClean).not.toHaveBeenCalled();
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Clean memories"),
      )!,
    );
    await waitFor(() =>
      expect(memoryClean).toHaveBeenCalledWith({
        projectId: "proj-1",
        expectedRevision: 7,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Memory health").textContent).toContain("0 important (non-binding)"),
    );
    expect(projectEntries.find((entry) => entry.id === "e1")?.binding).toBe(true);
    expect(projectEntries.find((entry) => entry.id === "e2")?.archived).toBe(true);
    expect(projectEntries.find((entry) => entry.id === "e3")?.archived).toBe(true);
    expect(projectEntries.every((entry) => !entry.important)).toBe(true);
  });

  it("reloads authoritative snapshot and health after revoking binding", async () => {
    const initial = await memorySnapshot({ projectId: "proj-1" });
    let revoked = false;
    memorySnapshot.mockImplementation(async (opts: { projectId?: string }) => {
      if (opts.projectId !== "proj-1") return { revision: 0, entries: [] };
      if (!revoked) {
        return {
          revision: 8,
          entries: initial.entries.map((entry: { id: string }) =>
            entry.id === "e1"
              ? {
                  ...entry,
                  title: "Authoritative canvas constraint",
                  binding: true,
                  authority: "agent",
                  bindingConfirmedAt: "2026-07-12T10:00:00.000Z",
                  bindingConfirmedBy: "agent",
                }
              : entry,
          ),
        };
      }
      return {
        revision: 9,
        entries: initial.entries.map((entry: { id: string }) =>
          entry.id === "e1"
            ? {
                ...entry,
                title: "Authoritative canvas constraint",
                binding: false,
                authority: "user",
                bindingConfirmedAt: null,
                bindingConfirmedBy: null,
              }
            : entry,
        ),
      };
    });
    memoryHealth.mockImplementation(async (opts: { projectId?: string }) =>
      opts.projectId === "proj-1"
        ? {
            revision: revoked ? 9 : 8,
            totalEntries: 2,
            activeEntries: 2,
            bindingCount: revoked ? 0 : 1,
            needsReviewCount: 1,
            findings: [],
          }
        : {
            revision: 0,
            totalEntries: 0,
            activeEntries: 0,
            bindingCount: 0,
            needsReviewCount: 0,
            findings: [],
          },
    );
    memoryRevokeBinding.mockImplementation(async () => {
      revoked = true;
      return { revision: 9, entry: initial.entries[0], projectionWarning: null };
    });
    memorySnapshot.mockClear();

    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    await waitFor(() => expect(screen.getByText("Authoritative canvas constraint")).toBeTruthy());
    expect(screen.getByLabelText("Memory health").textContent).toContain("1 binding");
    fireEvent.click(screen.getByRole("button", { name: "Revoke binding Authoritative canvas constraint" }));

    await waitFor(() =>
      expect(memoryRevokeBinding).toHaveBeenCalledWith({
        projectId: "proj-1",
        id: "e1",
        expectedRevision: 8,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Memory health").textContent).toContain("0 binding"),
    );
  });

  it("reloads and preserves warnings when supersede fails after an edit commits", async () => {
    const initial = await memorySnapshot({ projectId: "proj-1" });
    let updated = false;
    memorySnapshot.mockImplementation(async (opts: { projectId?: string }) => {
      if (opts.projectId !== "proj-1") return { revision: 0, entries: [] };
      return {
        revision: updated ? 8 : 7,
        entries: initial.entries.map((entry: { id: string }) =>
          entry.id === "e1" && updated
            ? { ...entry, title: "Authoritative edited title" }
            : entry,
        ),
      };
    });
    memoryUpdateDetailed.mockImplementation(async () => {
      updated = true;
      return {
        revision: 8,
        entry: { ...initial.entries[0], title: "Authoritative edited title" },
        projectionWarning: "Update committed but projection lagged",
      };
    });
    memorySupersedeDetailed.mockRejectedValueOnce(new Error("supersede blocked by authority"));
    memorySnapshot.mockClear();

    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Edit Use canvas terminal"));
    fireEvent.change(screen.getByLabelText("Memory title"), {
      target: { value: "Authoritative edited title" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByText("Authoritative edited title")).toBeTruthy());
    expect(screen.getByText("supersede blocked by authority")).toBeTruthy();
    expect(screen.getByText("Update committed but projection lagged")).toBeTruthy();
    expect(
      memorySnapshot.mock.calls.filter(([opts]) => opts.projectId === "proj-1"),
    ).toHaveLength(2);
  });

  it("merges projection warnings when edit and supersede both commit", async () => {
    memoryUpdateDetailed.mockResolvedValueOnce({
      revision: 8,
      entry: projectEntries[0],
      projectionWarning: "Edit projection warning",
    });
    memorySupersedeDetailed.mockResolvedValueOnce({
      revision: 9,
      entry: projectEntries[0],
      projectionWarning: "Supersede projection warning",
    });

    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Edit Use canvas terminal"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(screen.getByText(/Edit projection warning · Supersede projection warning/)).toBeTruthy(),
    );
  });

  it("marks committed supersede targets inactive when authoritative refresh fails", async () => {
    memoryUpdateDetailed.mockImplementationOnce(async ({ id }: { id: string }) => ({
      revision: ++projectRevision,
      entry: projectEntries.find((entry) => entry.id === id),
      projectionWarning: "Edit projection warning",
    }));
    memorySupersedeDetailed.mockImplementationOnce(
      async ({ id, targetIds }: { id: string; targetIds: string[] }) => {
        projectRevision += 1;
        projectEntries = projectEntries.map((entry) =>
          targetIds.includes(entry.id)
            ? { ...entry, status: "superseded" as const }
            : entry.id === id
              ? { ...entry, supersedes: targetIds }
              : entry,
        );
        return {
          revision: projectRevision,
          entry: projectEntries.find((entry) => entry.id === id),
          projectionWarning: "Supersede projection warning",
        };
      },
    );

    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Edit Use canvas terminal"));
    fireEvent.click(screen.getByRole("checkbox"));
    memorySnapshot.mockRejectedValueOnce(new Error("snapshot temporarily unavailable"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByText(/Saved, but refresh failed/)).toBeTruthy());
    expect(screen.queryByText("Spinner hang")).toBeNull();
    expect(screen.getByText(/Edit projection warning · Supersede projection warning/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByText("Spinner hang")).toBeTruthy();
  });

  it("reloads the project after a stale revision error", async () => {
    memoryArchiveDetailed.mockRejectedValueOnce(
      new Error("stale memory revision: expected 7, current 8"),
    );
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Archive Use canvas terminal"));

    await waitFor(() => expect(memorySnapshot.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText(/Memory changed elsewhere and was reloaded/)).toBeTruthy();
  });

  it("discards a stale edit draft and requires a fresh edit from authoritative state", async () => {
    memoryUpdateDetailed.mockImplementationOnce(async () => {
      projectRevision = 8;
      projectEntries = projectEntries.map((entry) =>
        entry.id === "e1" ? { ...entry, title: "Concurrent authoritative title" } : entry,
      );
      throw new Error("stale memory revision: expected 7, current 8");
    });

    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Edit Use canvas terminal"));
    fireEvent.change(screen.getByLabelText("Memory title"), {
      target: { value: "Stale local draft" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByText("Concurrent authoritative title")).toBeTruthy());
    expect(screen.queryByLabelText("Memory title")).toBeNull();
    expect(screen.getByText(/Memory changed elsewhere and was reloaded/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Edit Concurrent authoritative title"));
    expect((screen.getByLabelText("Memory title") as HTMLInputElement).value).toBe(
      "Concurrent authoritative title",
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a non-stale validation draft open for correction", async () => {
    memoryUpdateDetailed.mockRejectedValueOnce(new Error("title must not be empty"));
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Edit Use canvas terminal"));
    fireEvent.change(screen.getByLabelText("Memory title"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByText("title must not be empty")).toBeTruthy());
    expect(screen.getByLabelText("Memory title")).toBeTruthy();
  });

  it("keeps a committed archive operable when authoritative refresh fails", async () => {
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    memorySnapshot.mockRejectedValueOnce(new Error("snapshot temporarily unavailable"));
    fireEvent.click(screen.getByLabelText("Archive Use canvas terminal"));

    await waitFor(() => expect(screen.getByText(/Saved, but refresh failed/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.queryByText("Use canvas terminal")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() =>
      expect(screen.queryByText(/Saved, but refresh failed/)).toBeNull(),
    );
  });

  it("surfaces projection warnings after a committed mutation", async () => {
    memoryArchiveDetailed.mockResolvedValueOnce({
      revision: 8,
      entry: { ...(await memorySnapshot({ projectId: "proj-1" })).entries[0], archived: true },
      projectionWarning: "MEMORY.md projection could not be refreshed",
    });
    memorySnapshot.mockClear();
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByText("agmux")).toBeTruthy());
    fireEvent.click(screen.getByText("agmux").closest("button")!);
    fireEvent.click(screen.getByLabelText("Archive Use canvas terminal"));
    await waitFor(() =>
      expect(screen.getByText("MEMORY.md projection could not be refreshed")).toBeTruthy(),
    );
  });

  it("uses view-specific search and empty-state copy", async () => {
    memorySnapshot.mockResolvedValue({ revision: 0, entries: [] });
    handoffList.mockResolvedValue([]);
    render(<MemoryMainPanel />);
    await waitFor(() => expect(screen.getByPlaceholderText("Search durable memory…")).toBeTruthy());
    expect(screen.getByText("No durable memory yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.getByPlaceholderText("Search session history…")).toBeTruthy();
    expect(screen.getByText("No session history yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByPlaceholderText("Search archived memory…")).toBeTruthy();
    expect(screen.getByText("No archived memory yet")).toBeTruthy();
  });

  it("uses high-contrast light-theme colors for trust status text", () => {
    expect(memoryStyles).toContain(
      'html[data-mode="light"] .mem-health-counts [data-warning="true"]',
    );
    expect(memoryStyles).toMatch(/html\[data-mode="light"\] \.mem-health-finding[\s\S]*?#92400e/);
    expect(memoryStyles).toMatch(/html\[data-mode="light"\] \.mem-kind-binding[\s\S]*?#166534/);
    expect(memoryStyles).toMatch(/html\[data-mode="light"\] \.mem-kind-review[\s\S]*?#92400e/);
  });
});
