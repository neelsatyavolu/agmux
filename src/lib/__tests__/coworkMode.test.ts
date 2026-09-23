import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorage } from "./_localStorage";
import { setCodexSessionMode } from "../codexSessionMode";
import { setCodexWorkProfile } from "../chatgptWorkProfile";
import {
  coworkDraftProvider,
  intersectCoworkProviders,
  isClaudeCoworkThread,
  isCodexWorkSession,
  isCoworkAppMode,
  isCoworkDraftProvider,
  isCoworkSidebarItem,
  setCoworkAppMode,
  toggleCoworkAppMode,
} from "../coworkMode";
import { useUiStore } from "../../stores/uiStore";
import { useProjectStore } from "../../stores/projectStore";
import { addCoworkFolder, resetCoworkFoldersForTests } from "../coworkFolders";
import { resolveCoworkDraftProject } from "../coworkMode";

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  installLocalStorage();
});

describe("coworkMode", () => {
  it("recognizes the cowork app mode", () => {
    expect(isCoworkAppMode("cowork")).toBe(true);
    expect(isCoworkAppMode("agent")).toBe(false);
    expect(isCoworkAppMode("task")).toBe(false);
  });

  it("restricts draft providers to Claude, Codex, and Grok", () => {
    expect(isCoworkDraftProvider("ClaudeCode")).toBe(true);
    expect(isCoworkDraftProvider("Codex")).toBe(true);
    expect(isCoworkDraftProvider("Grok")).toBe(true);
    expect(isCoworkDraftProvider("Cursor")).toBe(false);
    expect(coworkDraftProvider("Grok")).toBe("Grok");
    expect(coworkDraftProvider("Codex")).toBe("Codex");
    expect(intersectCoworkProviders(["Cursor", "Codex", "Grok"])).toEqual(["Codex", "Grok"]);
    expect(intersectCoworkProviders([])).toEqual([]);
    expect(intersectCoworkProviders(null)).toEqual(["ClaudeCode", "Codex", "Grok"]);
  });

  it("isClaudeCoworkThread only matches Claude SDK cowork", () => {
    expect(
      isClaudeCoworkThread({
        provider: "ClaudeCode",
        agent_profile: "cowork",
        interaction_mode: "sdk",
      }),
    ).toBe(true);
    expect(
      isClaudeCoworkThread({
        provider: "ClaudeCode",
        agent_profile: null,
        interaction_mode: "sdk",
      }),
    ).toBe(false);
    expect(
      isClaudeCoworkThread({
        provider: "ClaudeCode",
        agent_profile: "cowork",
        interaction_mode: "pty",
      }),
    ).toBe(false);
    expect(
      isClaudeCoworkThread({
        provider: "Codex",
        agent_profile: "cowork",
        interaction_mode: "sdk",
      }),
    ).toBe(false);
  });

  it("isCodexWorkSession requires Work mark and not terminal", () => {
    setCodexWorkProfile("w1");
    setCodexSessionMode("w1", "chat");
    expect(isCodexWorkSession("w1")).toBe(true);

    setCodexSessionMode("w1", "terminal");
    expect(isCodexWorkSession("w1")).toBe(false);

    setCodexSessionMode("w2", "chat");
    expect(isCodexWorkSession("w2")).toBe(false);
  });

  it("shows a loading flag immediately when entering cowork", () => {
    useUiStore.setState({ appMode: "agent", coworkLoading: false });
    setCoworkAppMode(true);
    expect(useUiStore.getState().appMode).toBe("cowork");
    expect(useUiStore.getState().coworkLoading).toBe(true);
    setCoworkAppMode(false);
    expect(useUiStore.getState().appMode).toBe("agent");
    expect(useUiStore.getState().coworkLoading).toBe(false);
  });

  it("ignores a second enter while Cowork is still opening", () => {
    useUiStore.setState({ appMode: "agent", coworkLoading: false });
    toggleCoworkAppMode();
    expect(useUiStore.getState().appMode).toBe("cowork");
    expect(useUiStore.getState().coworkLoading).toBe(true);
    setCoworkAppMode(true);
    expect(useUiStore.getState().appMode).toBe("cowork");
  });

  it("allows leaving Cowork while the overlay is still up", () => {
    useUiStore.setState({ appMode: "agent", coworkLoading: false });
    toggleCoworkAppMode();
    expect(useUiStore.getState().coworkLoading).toBe(true);
    toggleCoworkAppMode();
    expect(useUiStore.getState().appMode).toBe("agent");
    expect(useUiStore.getState().coworkLoading).toBe(false);
  });

  it("resolveCoworkDraftProject prefers the selected cowork folder", () => {
    resetCoworkFoldersForTests([]);
    addCoworkFolder("/Users/neel/Colleges");
    addCoworkFolder("/Users/neel/Documents/GitHub/agmux");
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Colleges", repo_path: "/Users/neel/Colleges", conventions: "", created_at: "" },
        { id: "p2", name: "agmux", repo_path: "/Users/neel/Documents/GitHub/agmux", conventions: "", created_at: "" },
      ],
    });
    useUiStore.setState({ selectedProjectId: "p2" });
    expect(resolveCoworkDraftProject()?.id).toBe("p2");
    resetCoworkFoldersForTests([]);
  });

  it("filters sidebar items to Claude Cowork, ChatGPT Work, and Grok Cowork", () => {
    setCodexWorkProfile("cx");
    setCodexSessionMode("cx", "chat");
    expect(
      isCoworkSidebarItem({
        kind: "thread",
        provider: "ClaudeCode",
        agentProfile: "cowork",
        interactionMode: "sdk",
      }),
    ).toBe(true);
    expect(
      isCoworkSidebarItem({
        kind: "thread",
        provider: "Grok",
        agentProfile: "cowork",
        interactionMode: "grok-sdk",
      }),
    ).toBe(true);
    expect(isCoworkSidebarItem({ kind: "codex", id: "cx" })).toBe(true);
    expect(
      isCoworkSidebarItem({
        kind: "thread",
        provider: "ClaudeCode",
        agentProfile: null,
        interactionMode: "sdk",
      }),
    ).toBe(false);
    expect(isCoworkSidebarItem({ kind: "claude", id: "term" })).toBe(false);
    expect(isCoworkSidebarItem({ kind: "kimi", id: "k" })).toBe(false);
  });
});
