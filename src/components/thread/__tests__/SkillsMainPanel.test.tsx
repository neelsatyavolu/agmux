/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../SkillGridCard", () => ({
  SkillGridCard: ({ skill }: { skill: { name: string } }) => <div data-testid="skill-card">{skill.name}</div>,
}));
vi.mock("../McpServerCard", () => ({
  McpServerCard: ({ server }: { server: { name: string } }) => <div data-testid="mcp-card">{server.name}</div>,
}));
vi.mock("../AddMcpServerDialog", () => ({
  AddMcpServerDialog: () => null,
}));
vi.mock("../../../lib/windowDrag", () => ({
  handleWindowDragStart: vi.fn(),
}));

import { SkillsMainPanel } from "../SkillsMainPanel";
import { useSkillsStore } from "../../../stores/skillsStore";

beforeEach(() => {
  useSkillsStore.setState({
    skills: [{ id: "x", name: "Test Skill", description: "d", source: "official", installed: false, path: "", marketplace: "off" } as never],
    mcpServers: [],
    loading: false,
    error: null,
    installing: {},
    mcpLoading: false,
    mcpRemoving: {},
    searchQuery: "",
    activeCategory: "all",
    fetchSkills: vi.fn().mockResolvedValue(undefined),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    fetchMcpServers: vi.fn().mockResolvedValue(undefined),
    removeMcpServer: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("SkillsMainPanel", () => {
  it("renders Skills title", () => {
    render(<SkillsMainPanel />);
    expect(screen.getByText("Skills")).toBeTruthy();
  });

  it("renders the description text", () => {
    render(<SkillsMainPanel />);
    expect(screen.getByText(/extend claude code/i)).toBeTruthy();
  });

  it("renders skill cards from store", () => {
    render(<SkillsMainPanel />);
    expect(screen.getByText("Test Skill")).toBeTruthy();
  });

  it("renders MCP Servers section", () => {
    render(<SkillsMainPanel />);
    expect(screen.getByRole("heading", { name: /mcp servers/i })).toBeTruthy();
  });

  it("shows empty state when no Claude Code MCP servers", () => {
    render(<SkillsMainPanel />);
    expect(screen.getByText(/no claude code mcp servers/i)).toBeTruthy();
  });

  it("shows loading spinner when loading and no skills (filtered by category)", () => {
    useSkillsStore.setState({ skills: [], loading: true, activeCategory: "installed" });
    render(<SkillsMainPanel />);
    expect(screen.getByText(/loading skills/i)).toBeTruthy();
  });

  it("shows error state with retry when error and no skills (filtered by category)", () => {
    useSkillsStore.setState({ skills: [], error: "Boom", loading: false, activeCategory: "installed" });
    render(<SkillsMainPanel />);
    expect(screen.getByText(/failed to load skills/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("filters skills by searchQuery in name", () => {
    useSkillsStore.setState({
      skills: [
        { id: "a", name: "alpha-skill", description: "", source: "official", installed: false, path: "", marketplace: "off" } as never,
        { id: "b", name: "beta-skill", description: "", source: "official", installed: false, path: "", marketplace: "off" } as never,
      ],
      searchQuery: "alpha",
    });
    render(<SkillsMainPanel />);
    expect(screen.getByText("alpha-skill")).toBeTruthy();
    expect(screen.queryByText("beta-skill")).toBeNull();
  });

  it("renders 'no matching skills' empty state when search has no matches", () => {
    useSkillsStore.setState({
      skills: [
        { id: "a", name: "alpha-skill", description: "", source: "official", installed: false, path: "", marketplace: "off" } as never,
      ],
      searchQuery: "doesnotexist",
    });
    render(<SkillsMainPanel />);
    expect(screen.getByText(/no matching skills/i)).toBeTruthy();
  });
});
