import { useState } from "react";
import { Check, Download, Loader2, Trash2 } from "lucide-react";
import type { Skill } from "../../stores/skillsStore";

interface SkillCardProps {
  skill: Skill;
  installing: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  official: "Official",
  community: "Community",
};

export function SkillCard({ skill, installing, onInstall, onUninstall }: SkillCardProps) {
  const [hovered, setHovered] = useState(false);

  const sourceLabel = SOURCE_LABELS[skill.source] ?? skill.source;

  return (
    <div
      className="group rounded-lg border border-white/5 bg-zinc-800/40 px-3 py-2.5 transition-colors hover:bg-zinc-800/70"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-zinc-100">
              {skill.name}
            </span>
            <span className="shrink-0 rounded-full bg-zinc-700/60 px-1.5 py-px text-[9px] font-medium text-zinc-400">
              {sourceLabel}
            </span>
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-zinc-400">
              {skill.description}
            </p>
          )}
          {skill.category && (
            <span className="mt-1 inline-block text-[9px] text-zinc-500">
              {skill.category}
            </span>
          )}
        </div>

        <div className="shrink-0 pt-0.5">
          {installing ? (
            <div className="flex h-6 w-6 items-center justify-center">
              <Loader2 size={13} className="animate-spin text-blue-400" />
            </div>
          ) : skill.installed ? (
            hovered ? (
              <button
                onClick={onUninstall}
                className="flex h-6 items-center gap-1 rounded-md bg-red-500/10 px-1.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
              >
                <Trash2 size={10} />
                Remove
              </button>
            ) : (
              <div className="flex h-6 items-center gap-1 rounded-md bg-[var(--accent-dim)] px-1.5 text-[10px] font-medium text-[color:var(--accent)]">
                <Check size={10} />
                Installed
              </div>
            )
          ) : (
            <button
              onClick={onInstall}
              className="flex h-6 items-center gap-1 rounded-md bg-blue-600/20 px-1.5 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-600/30"
            >
              <Download size={10} />
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
