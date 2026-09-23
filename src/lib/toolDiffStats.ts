import { isPatchText, summarizePatchText } from "./patchParser";

export type FileToolKind = "edit" | "write" | "delete";

export interface ToolDiffStats {
  path: string;
  added: number;
  removed: number;
  diffString: string | null;
  kind: FileToolKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "";
}

export function countContentLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

/** Cursor (and some MCP) tool results wrap stats in `{ status, value }`. */
export function parseToolResultValue(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    if (isRecord(parsed.value)) return parsed.value;
    return parsed;
  } catch {
    return null;
  }
}

export function toolFilePath(input: Record<string, unknown>): string {
  return pickString(input.file_path, input.filePath, input.path, input.target_file, input.targetFile);
}

export function classifyFileTool(name: string): FileToolKind | null {
  const n = name.toLowerCase();
  if (
    n === "edit" ||
    n === "multiedit" ||
    n === "multi_edit" ||
    n === "edit_file" ||
    n === "edit_lines" ||
    n === "search_replace" ||
    n === "applypatch" ||
    n === "apply_patch" ||
    n === "apply_patch_freeform" ||
    n === "patch" ||
    n === "applyagentdiff" ||
    n === "mcp__filesystem__edit_file"
  ) {
    return "edit";
  }
  if (n === "write" || n === "write_file" || n === "mcp__filesystem__write_file") {
    return "write";
  }
  if (n === "delete") return "delete";
  return null;
}

function countRangeLines(startLine: unknown, endLine: unknown): number {
  const start = Number(startLine);
  const end = Number(endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start + 1;
}

function countEditInputLines(input: Record<string, unknown>): { added: number; removed: number } {
  if (input.start_line != null && input.end_line != null) {
    return {
      added: countContentLines(pickString(input.new, input.new_string, input.newString, input.newText)),
      removed: countRangeLines(input.start_line, input.end_line),
    };
  }

  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (edits && edits.length > 0) {
    return edits.reduce(
      (totals, raw) => {
        if (!isRecord(raw)) return totals;
        return {
          added: totals.added + countContentLines(
            pickString(raw.new_string, raw.newString, raw.newText, raw.new),
          ),
          removed: totals.removed + countContentLines(
            pickString(raw.old_string, raw.oldString, raw.oldText, raw.old),
          ),
        };
      },
      { added: 0, removed: 0 },
    );
  }

  return {
    added: countContentLines(pickString(input.new_string, input.newString, input.newText, input.new)),
    removed: countContentLines(pickString(input.old_string, input.oldString, input.oldText, input.old)),
  };
}

/**
 * Line-change stats for a file-mutating tool. Prefers provider-reported
 * `linesAdded` / `linesRemoved` / `diffString` (Cursor), then a patch body,
 * then old/new string counts.
 */
export function toolDiffStats(
  name: string,
  input: Record<string, unknown>,
  result?: { content: string; isError: boolean },
): ToolDiffStats | null {
  const kind = classifyFileTool(name);
  if (!kind) return null;

  const path = toolFilePath(input);
  const payload = result && !result.isError ? parseToolResultValue(result.content) : null;
  const resultPatch = result && !result.isError && isPatchText(result.content) ? result.content : "";
  const diffString =
    pickString(
      payload?.diffString,
      input.patch,
      input.patchContent,
      input.diff,
      resultPatch,
    ) || null;

  let added = 0;
  let removed = 0;
  if (typeof payload?.linesAdded === "number" && Number.isFinite(payload.linesAdded)) {
    added = Math.max(0, Math.trunc(payload.linesAdded));
  }
  if (typeof payload?.linesRemoved === "number" && Number.isFinite(payload.linesRemoved)) {
    removed = Math.max(0, Math.trunc(payload.linesRemoved));
  }
  if (
    kind === "write" &&
    added === 0 &&
    typeof payload?.linesCreated === "number" &&
    Number.isFinite(payload.linesCreated)
  ) {
    added = Math.max(0, Math.trunc(payload.linesCreated));
  }

  if (added === 0 && removed === 0) {
    if (diffString) {
      const summary = summarizePatchText(diffString);
      if (summary) {
        added = summary.additions;
        removed = summary.deletions;
      }
    } else if (kind === "write") {
      added = countContentLines(pickString(input.content, input.fileText, input.new_string));
    } else if (kind === "edit") {
      const counted = countEditInputLines(input);
      added = counted.added;
      removed = counted.removed;
    }
  }

  if (!path && added === 0 && removed === 0 && !diffString) return null;
  return { path, added, removed, diffString, kind };
}
