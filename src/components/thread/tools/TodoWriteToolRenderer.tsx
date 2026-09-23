import { CheckCircle2, Circle, Loader2, ListTodo } from "lucide-react";
import type { ToolRendererProps } from "./types";

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

function parseTodos(input: Record<string, unknown>): TodoItem[] {
  const raw = input.todos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => t != null && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      content: String(t.content ?? ""),
      status: (["pending", "in_progress", "completed"].includes(String(t.status)) ? String(t.status) : "pending") as TodoItem["status"],
    }));
}

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={13} className="text-[color:var(--accent)] shrink-0" />;
    case "in_progress":
      return <Loader2 size={13} className="animate-spin text-amber-400 shrink-0" />;
    default:
      return <Circle size={13} className="text-zinc-500 shrink-0" />;
  }
}

export function TodoWriteToolRenderer({ input }: ToolRendererProps): React.ReactElement {
  const todos = parseTodos(input);
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const total = todos.length;
  const allDone = total > 0 && completed === total;

  if (total === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-[11px] text-zinc-500">
        Empty to-do list
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border transition-colors duration-200 ${
        inProgress > 0
          ? "border-amber-500/15 bg-amber-500/[0.03]"
          : allDone
            ? "border-[color:var(--accent)]/15 bg-[var(--accent)]/[0.02]"
            : "border-white/[0.06] bg-white/[0.02]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-2">
        <ListTodo size={13} className={allDone ? "text-[color:var(--accent)]" : "text-violet-400"} />
        <span className="text-xs font-medium text-zinc-300">
          {completed}/{total} completed
        </span>
        {allDone && (
          <span className="rounded-full border border-[color:var(--accent)]/20 bg-[var(--accent-dim)] px-1.5 py-px text-[9px] font-medium text-[color:var(--accent)]">
            done
          </span>
        )}
        {inProgress > 0 && (
          <span className="flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-px text-[9px] font-medium text-amber-400">
            <Loader2 size={8} className="animate-spin" />
            {inProgress} active
          </span>
        )}
      </div>

      {/* Task list */}
      <div className="border-t border-white/5 px-3 py-2 space-y-0.5 max-h-72 overflow-y-auto">
        {todos.map((todo) => (
          <div key={todo.id} className="flex items-start gap-2.5 rounded-lg px-1.5 py-1">
            <div className="mt-0.5">
              <StatusIcon status={todo.status} />
            </div>
            <span
              className={`text-[11.5px] leading-relaxed ${
                todo.status === "completed"
                  ? "text-zinc-500 line-through"
                  : todo.status === "in_progress"
                    ? "text-amber-300"
                    : "text-zinc-300"
              }`}
            >
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
