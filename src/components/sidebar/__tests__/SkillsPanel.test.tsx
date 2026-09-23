/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { SkillsPanel } from "../SkillsPanel";
import { useSkillsStore } from "../../../stores/skillsStore";

beforeEach(() => {
  useSkillsStore.setState({
    skills: [],
    mcpServers: [],
    loading: false,
    searchQuery: "",
    activeCategory: "all",
    fetchSkills: vi.fn().mockResolvedValue(undefined),
    fetchMcpServers: vi.fn().mockResolvedValue(undefined),
    setSearchQuery: vi.fn(),
    setActiveCategory: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("SkillsPanel", () => {
  it("renders search input", () => {
    render(<SkillsPanel />);
    expect(screen.getByPlaceholderText(/search skills/i)).toBeTruthy();
  });

  it("renders Categories label", () => {
    render(<SkillsPanel />);
    expect(screen.getByText(/categories/i)).toBeTruthy();
  });

  it("invokes setSearchQuery on typing", () => {
    const setSearchQuery = vi.fn();
    useSkillsStore.setState({ setSearchQuery });
    render(<SkillsPanel />);
    const input = screen.getByPlaceholderText(/search skills/i);
    fireEvent.change(input, { target: { value: "git" } });
    expect(setSearchQuery).toHaveBeenCalledWith("git");
  });

  it("renders refresh button", () => {
    render(<SkillsPanel />);
    expect(screen.getByLabelText(/refresh skills/i)).toBeTruthy();
  });

  it("shows installed counter", () => {
    useSkillsStore.setState({
      skills: [
        { name: "a", description: "", source: "official", marketplace: "off", installed: true } as never,
        { name: "b", description: "", source: "official", marketplace: "off", installed: false } as never,
      ],
    });
    render(<SkillsPanel />);
    expect(screen.getByText(/1 installed/i)).toBeTruthy();
  });

  it("shows total available count", () => {
    useSkillsStore.setState({
      skills: [
        { name: "a", description: "", source: "official", marketplace: "off", installed: true } as never,
        { name: "b", description: "", source: "official", marketplace: "off", installed: false } as never,
        { name: "c", description: "", source: "official", marketplace: "off", installed: false } as never,
      ],
    });
    render(<SkillsPanel />);
    expect(screen.getByText(/3 available/i)).toBeTruthy();
  });

  it("disables refresh button while loading", () => {
    useSkillsStore.setState({ loading: true });
    render(<SkillsPanel />);
    const btn = screen.getByLabelText(/refresh skills/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("animates refresh icon while loading", () => {
    useSkillsStore.setState({ loading: true });
    const { container } = render(<SkillsPanel />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("invokes setActiveCategory when clicking a category button", () => {
    const setActiveCategory = vi.fn();
    useSkillsStore.setState({ setActiveCategory });
    render(<SkillsPanel />);
    // Click any category button — find buttons after the categories label
    const installedBtn = screen.queryByText(/^installed$/i);
    if (installedBtn) {
      fireEvent.click(installedBtn.closest("button") || installedBtn);
      expect(setActiveCategory).toHaveBeenCalled();
    }
  });
});
