import { useEffect, useRef } from "react";
import { Terminal, Hash, FileText } from "lucide-react";
import { motion } from "framer-motion";
import type { SlashCommand } from "../../lib/slashCommands";
import type { Provider } from "../../lib/types";

interface Props {
  commands: SlashCommand[];
  activeIndex: number;
  provider: Provider;
  onSelect: (command: SlashCommand) => void;
}

const PROVIDER_ICON_CLASS: Record<Provider, string> = {
  ClaudeCode: "text-amber-400",
  Codex: "text-blue-400",
  Droid: "text-zinc-200",
  Kimi: "text-purple-400",
  Pi: "text-zinc-200",
  OpenCode: "text-cyan-400",
  MLX: "text-amber-400",
  Grok: "text-zinc-300",
  Cursor: "text-zinc-300",
  Cline: "text-zinc-200",
  Gemini: "text-blue-300",
  Hermes: "text-amber-200",
};

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  "built-in": { label: "Built-in", color: "text-zinc-500" },
  "user": { label: "User", color: "text-blue-400" },
  "project": { label: "Project", color: "text-green-400" },
};

export function SlashCommandPopup({ commands, activeIndex, provider, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (commands.length === 0) return null;

  const iconClass = PROVIDER_ICON_CLASS[provider];
  const activeCommand = commands[activeIndex] ?? null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute bottom-full left-0 right-0 z-40 mb-1 mx-4 rounded-xl border border-white/10 bg-[var(--surface-popover)] shadow-2xl overflow-hidden backdrop-blur-md"
      role="listbox"
      aria-label="Slash commands"
    >
      <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-3 py-2">
        <Hash size={11} className="text-zinc-400" />
        <span className="text-xs text-zinc-400 font-medium">Slash commands</span>
        <span className="ml-auto text-xs text-zinc-500"><span className="ui-kbd">Esc</span> to close</span>
      </div>
      <div className="flex">
        {/* Command list */}
        <div ref={listRef} className="max-h-64 w-1/2 overflow-y-auto border-r border-white/5 py-1">
          {commands.map((cmd, index) => {
            const isActive = index === activeIndex;
            const isShared = cmd.providers.length > 1;
            return (
              <button
                key={cmd.name}
                ref={isActive ? activeRef : undefined}
                role="option"
                aria-selected={isActive}
                onClick={() => onSelect(cmd)}
                className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-indigo-500/10 fx-press" : "hover:bg-white/5"
                }`}
              >
                <Terminal
                  size={13}
                  className={`mt-0.5 shrink-0 ${isActive ? "text-indigo-400" : iconClass}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-mono text-xs font-semibold ${
                        isActive ? "text-indigo-300" : "text-zinc-100"
                      }`}
                    >
                      {cmd.name}
                    </span>
                    {isShared && (
                      <span className="rounded bg-white/5 px-1 py-0.5 text-[10px] text-zinc-400">
                        shared
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-400 leading-snug">{cmd.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Preview pane */}
        <div className="max-h-64 w-1/2 overflow-y-auto p-3">
          {activeCommand ? (
            <div className="space-y-3">
              <div>
                <span className="font-mono text-sm font-semibold text-indigo-300">
                  {activeCommand.name}
                </span>
                {activeCommand.args && (
                  <span className="ml-2 text-xs text-zinc-500">{activeCommand.args}</span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-zinc-300">{activeCommand.description}</p>
              <div className="flex items-center gap-3 text-[10px]">
                {activeCommand.source && (
                  <span className="flex items-center gap-1">
                    <FileText size={10} className="text-zinc-500" />
                    <span className={SOURCE_LABELS[activeCommand.source]?.color ?? "text-zinc-500"}>
                      {SOURCE_LABELS[activeCommand.source]?.label ?? activeCommand.source}
                    </span>
                  </span>
                )}
                <span className="text-zinc-600">
                  {activeCommand.providers.join(", ")}
                </span>
              </div>
              {activeCommand.action === "passthrough" && (
                <div className="rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-1.5 text-[10px] text-zinc-500">
                  Sent directly to the agent
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-600">
              Select a command
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
