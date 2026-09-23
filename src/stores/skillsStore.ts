import { create } from "zustand";
import type { McpServerInfo, CodexMcpServerInfo } from "../lib/commands";

export type { McpServerInfo, CodexMcpServerInfo };

export interface Skill {
  name: string;
  description: string;
  author?: string | null;
  installed: boolean;
  source: string;
  marketplace: string;
  category?: string;
  tags?: string[] | null;
}

export type SkillCategory = "all" | "installed" | "Official Plugins" | "Community Plugins" | "mcp";

export const SKILL_CATEGORIES: { value: SkillCategory; label: string }[] = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "Official Plugins", label: "Official" },
  { value: "Community Plugins", label: "Community" },
  { value: "mcp", label: "MCP Servers" },
];

interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  installing: Record<string, boolean>;
  searchQuery: string;
  activeCategory: SkillCategory;

  mcpServers: McpServerInfo[];
  mcpLoading: boolean;
  mcpRemoving: Record<string, boolean>;

  codexMcpServers: CodexMcpServerInfo[];
  codexMcpLoading: boolean;

  fetchSkills: () => Promise<void>;
  installSkill: (name: string, marketplace: string) => Promise<void>;
  uninstallSkill: (name: string, marketplace: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setActiveCategory: (category: SkillCategory) => void;

  fetchMcpServers: () => Promise<void>;
  addMcpServer: (
    name: string,
    transport: string,
    commandOrUrl: string,
    args: string[],
    env: Record<string, string>,
    scope: string,
  ) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  fetchCodexMcpServers: (workDir: string) => Promise<void>;
}

const EMPTY_SKILLS: Skill[] = [];
const EMPTY_INSTALLING: Record<string, boolean> = {};
const EMPTY_MCP_SERVERS: McpServerInfo[] = [];
const EMPTY_MCP_REMOVING: Record<string, boolean> = {};
const EMPTY_CODEX_MCP_SERVERS: CodexMcpServerInfo[] = [];

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: EMPTY_SKILLS,
  loading: false,
  error: null,
  installing: EMPTY_INSTALLING,
  searchQuery: "",
  activeCategory: "all",

  mcpServers: EMPTY_MCP_SERVERS,
  mcpLoading: false,
  mcpRemoving: EMPTY_MCP_REMOVING,

  codexMcpServers: EMPTY_CODEX_MCP_SERVERS,
  codexMcpLoading: false,

  fetchSkills: async () => {
    set({ loading: true, error: null });
    try {
      const { listSkills } = await import("../lib/commands");
      const skills = await listSkills();
      set({ skills, loading: false });
    } catch (err) {
      console.error("Failed to fetch skills:", err);
      set({ loading: false, error: String(err) });
    }
  },

  installSkill: async (name: string, marketplace: string) => {
    set((s) => ({ installing: { ...s.installing, [name]: true } }));
    try {
      const { installSkill } = await import("../lib/commands");
      await installSkill(name, marketplace);
      await get().fetchSkills();
    } catch (err) {
      console.error(`Failed to install skill ${name}:`, err);
    } finally {
      set((s) => {
        const next = { ...s.installing };
        delete next[name];
        return { installing: next };
      });
    }
  },

  uninstallSkill: async (name: string, marketplace: string) => {
    set((s) => ({ installing: { ...s.installing, [name]: true } }));
    try {
      const { uninstallSkill } = await import("../lib/commands");
      await uninstallSkill(name, marketplace);
      await get().fetchSkills();
    } catch (err) {
      console.error(`Failed to uninstall skill ${name}:`, err);
    } finally {
      set((s) => {
        const next = { ...s.installing };
        delete next[name];
        return { installing: next };
      });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setActiveCategory: (category) => set({ activeCategory: category }),

  fetchMcpServers: async () => {
    set({ mcpLoading: true });
    try {
      const { listMcpServers } = await import("../lib/commands");
      const mcpServers = await listMcpServers();
      set({ mcpServers, mcpLoading: false });
    } catch (err) {
      console.error("Failed to fetch MCP servers:", err);
      set({ mcpLoading: false });
    }
  },

  addMcpServer: async (
    name: string,
    transport: string,
    commandOrUrl: string,
    args: string[],
    env: Record<string, string>,
    scope: string,
  ) => {
    const { addMcpServer } = await import("../lib/commands");
    await addMcpServer(name, transport, commandOrUrl, args, env, scope);
    await get().fetchMcpServers();
  },

  removeMcpServer: async (name: string) => {
    set((s) => ({ mcpRemoving: { ...s.mcpRemoving, [name]: true } }));
    try {
      const { removeMcpServer } = await import("../lib/commands");
      await removeMcpServer(name);
      await get().fetchMcpServers();
    } catch (err) {
      console.error(`Failed to remove MCP server ${name}:`, err);
    } finally {
      set((s) => {
        const next = { ...s.mcpRemoving };
        delete next[name];
        return { mcpRemoving: next };
      });
    }
  },

  fetchCodexMcpServers: async (workDir: string) => {
    if (!workDir) return;
    set({ codexMcpLoading: true });
    try {
      const { codexListMcpServerStatus } = await import("../lib/commands");
      const result = await codexListMcpServerStatus(workDir);
      set({ codexMcpServers: result.servers ?? EMPTY_CODEX_MCP_SERVERS, codexMcpLoading: false });
    } catch {
      // Codex server may not be running — silently degrade
      set({ codexMcpServers: EMPTY_CODEX_MCP_SERVERS, codexMcpLoading: false });
    }
  },
}));
