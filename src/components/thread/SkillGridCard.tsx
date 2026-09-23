import { useState } from "react";
import { Check, Download, Loader2, Trash2, Blocks, Globe } from "lucide-react";
import type { Skill } from "../../stores/skillsStore";

interface SkillGridCardProps {
  skill: Skill;
  installing: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}

const CATEGORY_ICONS: Record<string, typeof Blocks> = {
  "Official Plugins": Blocks,
  "Community Plugins": Globe,
};

const SOURCE_LABELS: Record<string, string> = {
  official: "Official",
  community: "Community",
};

export function SkillGridCard({ skill, installing, onInstall, onUninstall }: SkillGridCardProps) {
  const [hovered, setHovered] = useState(false);

  const CategoryIcon = CATEGORY_ICONS[skill.category ?? ""] ?? Blocks;
  const sourceLabel = SOURCE_LABELS[skill.source] ?? skill.source;

  // Generate a deterministic accent color from name
  const nameHash = skill.name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const accents = [
    "from-blue-500/20 to-blue-600/5 ring-blue-500/20 text-blue-400",
    "from-purple-500/20 to-purple-600/5 ring-purple-500/20 text-purple-400",
    "from-[color-mix(in_srgb,var(--accent)_20%,transparent)] to-[color-mix(in_srgb,var(--accent)_5%,transparent)] ring-[color:var(--accent-border)] text-[color:var(--accent)]",
    "from-amber-500/20 to-amber-600/5 ring-amber-500/20 text-amber-400",
    "from-rose-500/20 to-rose-600/5 ring-rose-500/20 text-rose-400",
    "from-cyan-500/20 to-cyan-600/5 ring-cyan-500/20 text-cyan-400",
  ];
  const accent = accents[nameHash % accents.length];
  const accentParts = accent.split(" ");

  return (
    <div
      className="group flex flex-col rounded-xl border border-white/[0.06] bg-zinc-900/50 p-4 transition-all duration-200 hover:border-white/[0.1] hover:bg-zinc-800/50"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top: icon + badges */}
      <div className="mb-3 flex items-start justify-between">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ring-1 ${accentParts.slice(0, 3).join(" ")}`}
        >
          <CategoryIcon size={18} className={accentParts[3]} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            {sourceLabel}
          </span>
          {skill.installed && (
            <span className="rounded-full bg-[var(--accent-dim)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent)]">
              Installed
            </span>
          )}
        </div>
      </div>

      {/* Name + author + description */}
      <h3 className="mb-0.5 text-sm font-semibold text-zinc-100">
        {skill.name}
      </h3>
      {skill.author && (
        <p className="mb-1 text-[11px] text-zinc-400">
          by {skill.author}
        </p>
      )}
      <p className="mb-4 line-clamp-2 flex-1 text-xs leading-relaxed text-zinc-400">
        {skill.description}
      </p>

      {/* Category tag */}
      {skill.category && (
        <div className="mb-3">
          <span className="rounded-md bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
            {skill.category}
          </span>
        </div>
      )}

      {/* Action button */}
      <div className="mt-auto">
        {installing ? (
          <div className="flex h-8 items-center justify-center rounded-lg bg-zinc-800 text-xs text-zinc-400">
            <Loader2 size={14} className="mr-1.5 animate-spin" />
            Installing...
          </div>
        ) : skill.installed ? (
          hovered ? (
            <button
              onClick={onUninstall}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/10 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
            >
              <Trash2 size={13} />
              Uninstall
            </button>
          ) : (
            <div className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] text-xs font-medium text-[color:var(--accent)]/70">
              <Check size={13} />
              Up to date
            </div>
          )
        ) : (
          <button
            onClick={onInstall}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600/20 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-600/30"
          >
            <Download size={13} />
            Install
          </button>
        )}
      </div>
    </div>
  );
}
