import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skillsStore";
import type { McpServerInfo, CodexMcpServerInfo } from "../../lib/commands";

const listSkills = vi.fn();
const installSkill = vi.fn();
const uninstallSkill = vi.fn();
const listMcpServers = vi.fn();
const addMcpServer = vi.fn();
const removeMcpServer = vi.fn();
const codexListMcpServerStatus = vi.fn();

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listSkills,
  installSkill,
  uninstallSkill,
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  codexListMcpServerStatus,
}));

import { SKILL_CATEGORIES, useSkillsStore } from "../skillsStore";

const INITIAL = {
  skills: [],
  loading: false,
  error: null,
  installing: {},
  searchQuery: "",
  activeCategory: "all" as const,
  mcpServers: [],
  mcpLoading: false,
  mcpRemoving: {},
  codexMcpServers: [],
  codexMcpLoading: false,
};

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "skill-a",
    description: "desc",
    installed: false,
    source: "src",
    marketplace: "anthropic",
    ...overrides,
  };
}

function makeMcp(name = "srv", overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return { name, transport: "stdio", command: "x", args: [], ...overrides } as McpServerInfo;
}

describe("skillsStore", () => {
  beforeEach(() => {
    useSkillsStore.setState(INITIAL, false);
    listSkills.mockReset();
    installSkill.mockReset();
    uninstallSkill.mockReset();
    listMcpServers.mockReset();
    addMcpServer.mockReset();
    removeMcpServer.mockReset();
    codexListMcpServerStatus.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("constants and initial state", () => {
    it("starts with empty defaults", () => {
      const s = useSkillsStore.getState();
      expect(s.skills).toEqual([]);
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
      expect(s.searchQuery).toBe("");
      expect(s.activeCategory).toBe("all");
      expect(s.installing).toEqual({});
      expect(s.mcpServers).toEqual([]);
      expect(s.mcpRemoving).toEqual({});
      expect(s.codexMcpServers).toEqual([]);
    });

    it("SKILL_CATEGORIES exposes the expected category list", () => {
      expect(SKILL_CATEGORIES.map((c) => c.value)).toEqual([
        "all",
        "installed",
        "Official Plugins",
        "Community Plugins",
        "mcp",
      ]);
      expect(SKILL_CATEGORIES.every((c) => typeof c.label === "string")).toBe(true);
    });
  });

  describe("setSearchQuery / setActiveCategory", () => {
    it("setSearchQuery updates searchQuery", () => {
      useSkillsStore.getState().setSearchQuery("hello");
      expect(useSkillsStore.getState().searchQuery).toBe("hello");
    });

    it("setSearchQuery with empty string clears the query", () => {
      useSkillsStore.setState({ searchQuery: "x" });
      useSkillsStore.getState().setSearchQuery("");
      expect(useSkillsStore.getState().searchQuery).toBe("");
    });

    it("setActiveCategory updates activeCategory", () => {
      useSkillsStore.getState().setActiveCategory("installed");
      expect(useSkillsStore.getState().activeCategory).toBe("installed");
    });

    it("setActiveCategory accepts each known category", () => {
      for (const c of SKILL_CATEGORIES) {
        useSkillsStore.getState().setActiveCategory(c.value);
        expect(useSkillsStore.getState().activeCategory).toBe(c.value);
      }
    });
  });

  describe("fetchSkills", () => {
    it("populates skills and clears loading on success", async () => {
      const s1 = makeSkill({ name: "a" });
      const s2 = makeSkill({ name: "b" });
      listSkills.mockResolvedValueOnce([s1, s2]);
      await useSkillsStore.getState().fetchSkills();
      const s = useSkillsStore.getState();
      expect(s.skills).toEqual([s1, s2]);
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
    });

    it("toggles loading=true during the call", async () => {
      let resolveFn: ((v: Skill[]) => void) | null = null;
      listSkills.mockReturnValueOnce(
        new Promise((r) => {
          resolveFn = r;
        }),
      );
      const promise = useSkillsStore.getState().fetchSkills();
      expect(useSkillsStore.getState().loading).toBe(true);
      resolveFn!([]);
      await promise;
      expect(useSkillsStore.getState().loading).toBe(false);
    });

    it("captures errors as a string and clears loading", async () => {
      listSkills.mockRejectedValueOnce(new Error("net fail"));
      await useSkillsStore.getState().fetchSkills();
      const s = useSkillsStore.getState();
      expect(s.loading).toBe(false);
      expect(s.error).toContain("net fail");
    });
  });

  describe("installSkill", () => {
    it("flags installing during call and unflags after", async () => {
      installSkill.mockResolvedValueOnce(undefined);
      listSkills.mockResolvedValue([]);
      const p = useSkillsStore.getState().installSkill("foo", "anthropic");
      expect(useSkillsStore.getState().installing["foo"]).toBe(true);
      await p;
      expect(useSkillsStore.getState().installing["foo"]).toBeUndefined();
    });

    it("calls installSkill then refreshes via fetchSkills", async () => {
      installSkill.mockResolvedValueOnce(undefined);
      listSkills.mockResolvedValueOnce([makeSkill({ name: "foo", installed: true })]);
      await useSkillsStore.getState().installSkill("foo", "anthropic");
      expect(installSkill).toHaveBeenCalledWith("foo", "anthropic");
      expect(listSkills).toHaveBeenCalled();
      expect(useSkillsStore.getState().skills[0].installed).toBe(true);
    });

    it("clears installing flag even on failure", async () => {
      installSkill.mockRejectedValueOnce(new Error("nope"));
      await useSkillsStore.getState().installSkill("foo", "anthropic");
      expect(useSkillsStore.getState().installing["foo"]).toBeUndefined();
    });
  });

  describe("uninstallSkill", () => {
    it("flags installing during the call and clears it after", async () => {
      uninstallSkill.mockResolvedValueOnce(undefined);
      listSkills.mockResolvedValue([]);
      const p = useSkillsStore.getState().uninstallSkill("foo", "anthropic");
      expect(useSkillsStore.getState().installing["foo"]).toBe(true);
      await p;
      expect(useSkillsStore.getState().installing["foo"]).toBeUndefined();
    });

    it("clears installing flag even on failure", async () => {
      uninstallSkill.mockRejectedValueOnce(new Error("oops"));
      await useSkillsStore.getState().uninstallSkill("foo", "anthropic");
      expect(useSkillsStore.getState().installing["foo"]).toBeUndefined();
    });
  });

  describe("fetchMcpServers", () => {
    it("populates mcpServers on success", async () => {
      const list = [makeMcp("a"), makeMcp("b")];
      listMcpServers.mockResolvedValueOnce(list);
      await useSkillsStore.getState().fetchMcpServers();
      const s = useSkillsStore.getState();
      expect(s.mcpServers).toEqual(list);
      expect(s.mcpLoading).toBe(false);
    });

    it("toggles mcpLoading during the call", async () => {
      let resolveFn: ((v: McpServerInfo[]) => void) | null = null;
      listMcpServers.mockReturnValueOnce(
        new Promise((r) => {
          resolveFn = r;
        }),
      );
      const p = useSkillsStore.getState().fetchMcpServers();
      expect(useSkillsStore.getState().mcpLoading).toBe(true);
      resolveFn!([]);
      await p;
      expect(useSkillsStore.getState().mcpLoading).toBe(false);
    });

    it("clears mcpLoading on failure (no error stored)", async () => {
      listMcpServers.mockRejectedValueOnce(new Error("x"));
      await useSkillsStore.getState().fetchMcpServers();
      expect(useSkillsStore.getState().mcpLoading).toBe(false);
    });
  });

  describe("addMcpServer", () => {
    it("calls add then refreshes the list", async () => {
      addMcpServer.mockResolvedValueOnce(undefined);
      listMcpServers.mockResolvedValueOnce([makeMcp("x")]);
      await useSkillsStore.getState().addMcpServer("x", "stdio", "echo", [], {}, "user");
      expect(addMcpServer).toHaveBeenCalledWith("x", "stdio", "echo", [], {}, "user");
      expect(useSkillsStore.getState().mcpServers).toHaveLength(1);
    });
  });

  describe("removeMcpServer", () => {
    it("flags mcpRemoving during the call, then clears", async () => {
      removeMcpServer.mockResolvedValueOnce(undefined);
      listMcpServers.mockResolvedValue([]);
      const p = useSkillsStore.getState().removeMcpServer("foo");
      expect(useSkillsStore.getState().mcpRemoving["foo"]).toBe(true);
      await p;
      expect(useSkillsStore.getState().mcpRemoving["foo"]).toBeUndefined();
    });

    it("clears mcpRemoving even on failure", async () => {
      removeMcpServer.mockRejectedValueOnce(new Error("x"));
      await useSkillsStore.getState().removeMcpServer("foo");
      expect(useSkillsStore.getState().mcpRemoving["foo"]).toBeUndefined();
    });
  });

  describe("fetchCodexMcpServers", () => {
    it("returns early when workDir is empty without changing state", async () => {
      const before = useSkillsStore.getState();
      await useSkillsStore.getState().fetchCodexMcpServers("");
      expect(codexListMcpServerStatus).not.toHaveBeenCalled();
      expect(useSkillsStore.getState().codexMcpServers).toBe(before.codexMcpServers);
      expect(useSkillsStore.getState().codexMcpLoading).toBe(false);
    });

    it("populates codexMcpServers from servers field", async () => {
      const servers: CodexMcpServerInfo[] = [
        { id: "1", name: "a", status: "connected" } as CodexMcpServerInfo,
      ];
      codexListMcpServerStatus.mockResolvedValueOnce({ servers });
      await useSkillsStore.getState().fetchCodexMcpServers("/tmp/wd");
      const s = useSkillsStore.getState();
      expect(s.codexMcpServers).toEqual(servers);
      expect(s.codexMcpLoading).toBe(false);
    });

    it("falls back to empty array when servers field is missing", async () => {
      codexListMcpServerStatus.mockResolvedValueOnce({});
      await useSkillsStore.getState().fetchCodexMcpServers("/tmp/wd");
      expect(useSkillsStore.getState().codexMcpServers).toEqual([]);
    });

    it("silently degrades to empty list on rejection", async () => {
      codexListMcpServerStatus.mockRejectedValueOnce(new Error("server down"));
      await useSkillsStore.getState().fetchCodexMcpServers("/tmp/wd");
      const s = useSkillsStore.getState();
      expect(s.codexMcpServers).toEqual([]);
      expect(s.codexMcpLoading).toBe(false);
    });
  });
});
