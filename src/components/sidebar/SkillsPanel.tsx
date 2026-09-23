import { useEffect, useMemo } from "react";
import { Search, RefreshCw, Package, Server } from "lucide-react";
import { useSkillsStore, SKILL_CATEGORIES, type SkillCategory } from "../../stores/skillsStore";

export function SkillsPanel() {
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const searchQuery = useSkillsStore((s) => s.searchQuery);
  const activeCategory = useSkillsStore((s) => s.activeCategory);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const setSearchQuery = useSkillsStore((s) => s.setSearchQuery);
  const setActiveCategory = useSkillsStore((s) => s.setActiveCategory);
  const mcpServers = useSkillsStore((s) => s.mcpServers);
  const fetchMcpServers = useSkillsStore((s) => s.fetchMcpServers);

  useEffect(() => {
    fetchSkills();
    fetchMcpServers();
  }, [fetchSkills, fetchMcpServers]);

  const installedCount = useMemo(
    () => skills.filter((s) => s.installed).length,
    [skills],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const skill of skills) {
      const cat = skill.category ?? "Custom Commands";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [skills]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Search bar + refresh */}
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-4">
        <div className="relative flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search skills..."
            className="h-7 w-full rounded-md border border-white/5 bg-zinc-800/60 pl-7 pr-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-600/50 focus:ring-1 focus:ring-blue-600/20"
          />
        </div>
        <button
          onClick={fetchSkills}
          disabled={loading}
          aria-label="Refresh skills"
          title="Refresh skills"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/5 bg-zinc-800/60 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-300 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Stats */}
      <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-white/5 bg-zinc-800/30 px-3 py-2.5">
        <Package size={14} className="shrink-0 text-blue-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-zinc-200">
            {installedCount} installed
          </p>
          <p className="text-[10px] text-zinc-400">
            {skills.length} available
          </p>
        </div>
        <div className="flex items-center gap-1 text-zinc-400">
          <Server size={12} />
          <span className="text-[10px]">{mcpServers.length}</span>
        </div>
      </div>

      {/* Category filters */}
      <div className="px-3 pb-2">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Categories
        </p>
        <div className="space-y-1">
          {SKILL_CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.value;
            const count =
              cat.value === "all"
                ? skills.length
                : cat.value === "installed"
                  ? installedCount
                  : cat.value === "mcp"
                    ? mcpServers.length
                    : categoryCounts[cat.value] ?? 0;
            return (
              <button
                key={cat.value}
                onClick={() => setActiveCategory(cat.value as SkillCategory)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors
                  ${isActive
                    ? "bg-white/[0.08] font-semibold text-zinc-100"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                  }`}
              >
                <span>{cat.label}</span>
                <span
                  className={`text-[10px] ${
                    isActive ? "text-zinc-300" : "text-zinc-500"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
