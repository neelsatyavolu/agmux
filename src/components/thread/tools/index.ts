import type React from "react";
import type { ToolRendererProps } from "./types";
import { ReadToolRenderer } from "./ReadToolRenderer";
import { WriteToolRenderer } from "./WriteToolRenderer";
import { EditToolRenderer } from "./EditToolRenderer";
import { ApplyPatchToolRenderer } from "./ApplyPatchToolRenderer";
import { BashToolRenderer } from "./BashToolRenderer";
import { GlobToolRenderer, GrepToolRenderer } from "./GlobGrepToolRenderer";
import { TaskToolRenderer } from "./TaskToolRenderer";
import { AskUserToolRenderer } from "./AskUserToolRenderer";
import { TodoWriteToolRenderer } from "./TodoWriteToolRenderer";

const TOOL_REGISTRY: Record<string, React.ComponentType<ToolRendererProps>> = {
  // Claude / SDK casing
  Read: ReadToolRenderer,
  read_file: ReadToolRenderer,
  Write: WriteToolRenderer,
  Edit: EditToolRenderer,
  edit_file: EditToolRenderer,
  edit_lines: EditToolRenderer,
  multi_edit: EditToolRenderer,
  MultiEdit: EditToolRenderer,
  "mcp__filesystem__edit_file": EditToolRenderer,
  write_file: WriteToolRenderer,
  "mcp__filesystem__write_file": WriteToolRenderer,
  ApplyPatch: ApplyPatchToolRenderer,
  apply_patch: ApplyPatchToolRenderer,
  apply_patch_freeform: ApplyPatchToolRenderer,
  Bash: BashToolRenderer,
  Glob: GlobToolRenderer,
  Grep: GrepToolRenderer,
  Task: TaskToolRenderer,
  Agent: TaskToolRenderer,
  AskUserQuestion: AskUserToolRenderer,
  TodoWrite: TodoWriteToolRenderer,
  TodoRead: TodoWriteToolRenderer,
  // claude-agent-sdk ≥0.3.142 task-management tools — normally filtered out of
  // the inline message stream and surfaced in ChatTasksPanel, but registered
  // here as a defensive fallback so they don't render as raw blobs.
  TaskCreate: TodoWriteToolRenderer,
  TaskUpdate: TodoWriteToolRenderer,
  TaskGet: TodoWriteToolRenderer,
  TaskList: TodoWriteToolRenderer,
  // Grok native tool names
  search_replace: EditToolRenderer,
  run_command: BashToolRenderer,
  run_terminal_command: BashToolRenderer,
  todo_write: TodoWriteToolRenderer,
  ask_user_question: AskUserToolRenderer,
  // OpenCode casing — same underlying tools, lowercase names
  read: ReadToolRenderer,
  write: WriteToolRenderer,
  edit: EditToolRenderer,
  bash: BashToolRenderer,
  glob: GlobToolRenderer,
  grep: GrepToolRenderer,
  task: TaskToolRenderer,
  agent: TaskToolRenderer,
  todowrite: TodoWriteToolRenderer,
  todoread: TodoWriteToolRenderer,
  patch: ApplyPatchToolRenderer,
};

export function getToolRenderer(name: string): React.ComponentType<ToolRendererProps> | null {
  if (!name) return null;
  // Exact match first; then case-insensitive fallback so variants like
  // "Bash"/"bash"/"BASH" all resolve to the same rich renderer regardless of
  // which provider emitted the tool name.
  return TOOL_REGISTRY[name] ?? TOOL_REGISTRY[name.toLowerCase()] ?? null;
}

export type { ToolRendererProps };
