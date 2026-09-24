/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const passthrough = (tag: string) => {
    const Comp = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => {
      const Tag = tag as keyof React.JSX.IntrinsicElements;
      return <Tag {...(props as object)}>{children}</Tag>;
    };
    return Comp;
  };
  const components = new Map<string, ReturnType<typeof passthrough>>();
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: new Proxy({}, { get: (_t, key: string) => {
      if (!components.has(key)) components.set(key, passthrough(key));
      return components.get(key);
    } }),
  };
});

import { FocusSection } from "../FocusSection";
import { useUiStore } from "../../../stores/uiStore";
import { resetAllStores } from "../../../test-helpers/resetStores";
import { FOCUS_GROUP_EXPAND_KEY, onFocusNewSession, type FocusNewSessionDetail } from "../../../lib/focusView";
import type { Project } from "../../../lib/types";

function makeProject(id: string, name: string): Project {
  return { id, name, repo_path: `/tmp/${name}`, conventions: "[]", created_at: new Date().toISOString() };
}

const projects = [makeProject("p1", "alpha"), makeProject("p2", "beta")];

afterEach(() => cleanup());
beforeEach(() => {
  localStorage.clear();
  resetAllStores();
});

describe("FocusSection", () => {
  it("hands its list element to the caller and shows an empty state", () => {
    const onListElement = vi.fn();
    render(<FocusSection projects={projects} windowHours={24} onListElement={onListElement} />);
    const el = onListElement.mock.calls[0][0] as HTMLElement;
    expect(el.hasAttribute("data-focus-list")).toBe(true);
    expect(screen.getByText("Nothing active in the last 24 hours.")).toBeTruthy();
  });

  it("counts rows that project groups portal into the list", async () => {
    let listEl: HTMLElement | null = null;
    render(<FocusSection projects={projects} windowHours={4} onListElement={(el) => { listEl = el; }} />);
    await act(async () => {
      listEl!.appendChild(document.createElement("div"));
      listEl!.appendChild(document.createElement("div"));
    });
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText(/Nothing active/)).toBeNull();
  });

  it("collapses without unmounting the list", () => {
    let listEl: HTMLElement | null = null;
    render(<FocusSection projects={projects} windowHours={24} onListElement={(el) => { listEl = el; }} />);
    fireEvent.click(screen.getByText("Focus"));
    expect(useUiStore.getState().projectExpandedById[FOCUS_GROUP_EXPAND_KEY]).toBe(false);
    expect(listEl!.isConnected).toBe(true);
    expect(listEl!.style.display).toBe("none");
  });

  it("asks for a project before starting a new session", () => {
    const requests: FocusNewSessionDetail[] = [];
    const off = onFocusNewSession((d) => requests.push(d));
    render(<FocusSection projects={projects} windowHours={24} onListElement={() => {}} />);
    const plus = screen.getByLabelText("New session in a project");
    fireEvent.click(plus);
    expect(screen.getByText("New session in")).toBeTruthy();
    fireEvent.click(screen.getByText("beta"));
    expect(requests).toEqual([{ projectId: "p2", anchor: plus }]);
    expect(screen.queryByText("New session in")).toBeNull();
    off();
  });

  it("filters the project picker when there are many projects", () => {
    const many = Array.from({ length: 8 }, (_, i) => makeProject(`p${i}`, `proj-${i}`));
    const requests: FocusNewSessionDetail[] = [];
    const off = onFocusNewSession((d) => requests.push(d));
    render(<FocusSection projects={many} windowHours={24} onListElement={() => {}} />);
    fireEvent.click(screen.getByLabelText("New session in a project"));
    const search = screen.getByLabelText("Search projects");
    fireEvent.change(search, { target: { value: "proj-5" } });
    expect(screen.queryByText("proj-1")).toBeNull();
    expect(screen.getByText("proj-5")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(requests.map((r) => r.projectId)).toEqual(["p5"]);
    off();
  });
});
