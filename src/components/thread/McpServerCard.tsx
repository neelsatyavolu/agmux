import { Loader2, Server, Trash2 } from "lucide-react";
import type { McpServerInfo } from "../../stores/skillsStore";

interface McpServerCardProps {
  server: McpServerInfo;
  removing: boolean;
  onRemove: () => void;
}

const accents = [
  "from-blue-500/20 to-blue-600/5 ring-blue-500/20 text-blue-400",
  "from-purple-500/20 to-purple-600/5 ring-purple-500/20 text-purple-400",
  "from-[color-mix(in_srgb,var(--accent)_20%,transparent)] to-[color-mix(in_srgb,var(--accent)_5%,transparent)] ring-[color:var(--accent-border)] text-[color:var(--accent)]",
  "from-amber-500/20 to-amber-600/5 ring-amber-500/20 text-amber-400",
  "from-rose-500/20 to-rose-600/5 ring-rose-500/20 text-rose-400",
  "from-cyan-500/20 to-cyan-600/5 ring-cyan-500/20 text-cyan-400",
];

export function McpServerCard({ server, removing, onRemove }: McpServerCardProps) {
  const nameHash = server.name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const accent = accents[nameHash % accents.length];
  const accentParts = accent.split(" ");

  const argCount = server.args?.length ?? 0;
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const displayValue = server.transport === "sse" ? server.url : server.command;

  return (
    <div className="group flex flex-col rounded-xl border border-white/[0.06] bg-zinc-900/50 p-4 transition-all duration-200 hover:border-white/[0.1] hover:bg-zinc-800/50">
      {/* Top: icon + badges */}
      <div className="mb-3 flex items-start justify-between">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ring-1 ${accentParts.slice(0, 3).join(" ")}`}
        >
          <Server size={18} className={accentParts[3]} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            {server.transport}
          </span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            {server.scope}
          </span>
        </div>
      </div>

      {/* Name */}
      <h3 className="mb-1 text-sm font-semibold text-zinc-100">{server.name}</h3>

      {/* Project path for project/local-scoped servers */}
      {server.project_path && (
        <p className="mb-0.5 truncate text-[10px] text-zinc-500" title={server.project_path}>
          {server.project_path.split("/").pop()}
        </p>
      )}

      {/* Command or URL */}
      {displayValue && (
        <p className="mb-1 truncate text-xs text-zinc-400" title={displayValue}>
          {displayValue}
        </p>
      )}

      {/* Args + env var counts */}
      <div className="mb-4 flex flex-1 flex-wrap gap-1.5">
        {argCount > 0 && (
          <span className="rounded-md bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
            {argCount} {argCount === 1 ? "arg" : "args"}
          </span>
        )}
        {envCount > 0 && (
          <span className="rounded-md bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
            {envCount} env {envCount === 1 ? "var" : "vars"}
          </span>
        )}
      </div>

      {/* Remove button */}
      <div className="mt-auto">
        {removing ? (
          <div className="flex h-8 items-center justify-center rounded-lg bg-zinc-800 text-xs text-zinc-400">
            <Loader2 size={14} className="mr-1.5 animate-spin" />
            Removing...
          </div>
        ) : (
          <button
            onClick={onRemove}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/10 text-xs font-medium text-red-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-500/20"
          >
            <Trash2 size={13} />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
