export interface AgentChildTool {
  name: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  pending: boolean;
}

export interface ToolRendererProps {
  input: Record<string, unknown>;
  result: string | null;
  isError: boolean;
  isPending: boolean;
  /** Nested tool calls made by an Agent/Task tool */
  childTools?: AgentChildTool[];
}

/**
 * Strip the session workDir prefix so tool rows show project-relative paths
 * (e.g. `docs/plan.md` instead of `/Users/…/apexline/docs/plan.md`).
 *
 * Display-only. Paths outside workDir are left absolute.
 */
export function relativeToWorkDir(
  path: string,
  workDir: string | null | undefined,
): string {
  if (!path || !workDir) return path;
  const root = workDir.replace(/\/+$/, "");
  if (!root) return path;
  if (path === root) return ".";
  const prefix = `${root}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

/**
 * Strip absolute project-directory prefix, returning a short relative path.
 * Prefer stripping `workDir` when known; otherwise use well-known markers;
 * fall back to the filename.
 */
export function shortenPath(fullPath: string, workDir?: string | null): string {
  if (!fullPath) return fullPath;
  if (workDir) {
    const rel = relativeToWorkDir(fullPath, workDir);
    if (rel !== fullPath) return rel;
  }
  // Find well-known project-root markers and return everything after the project dir
  const markers = ["/src-tauri/", "/src/", "/migrations/", "/public/"];
  for (const marker of markers) {
    const idx = fullPath.indexOf(marker);
    if (idx !== -1) return fullPath.slice(idx + 1); // skip leading /
  }
  // Fallback: just the filename
  return fullPath.split("/").pop() ?? fullPath;
}

export type ToolResultKind = "success" | "denied" | "limit" | "error";

export function classifyToolResult(result?: { content: string; isError: boolean }): ToolResultKind {
  if (!result?.isError) return "success";

  const content = result.content.toLowerCase();

  if (
    content.includes("doesn't want to proceed") ||
    content.includes("does not want to proceed") ||
    content.includes("permission denied") ||
    content.includes("denied by user") ||
    content.includes("user denied")
  ) {
    return "denied";
  }

  if (
    content.includes("hit your limit") ||
    content.includes("rate limit") ||
    content.includes("too many requests")
  ) {
    return "limit";
  }

  return "error";
}

const TOOL_STATUS_PREFIX = /^(running|ran|done|failed|calling|using)\s+/i;

const TOOL_NAME_ALIASES: Record<string, string> = {
  find_file: "find_file",
  find_by_name: "find_file",
  file_search: "find_file",
  view_file: "view_file",
  client_view_file: "view_file",
  view_file_range: "view_file",
  list_directory: "list_dir",
  search_directory: "grep",
  search_dir: "grep",
  create_file: "write_file",
  write_to_file: "write_file",
  replace_file_content: "edit_file",
  search_web: "web_search",
  read_url_content: "web_fetch",
};

/** Strip ACP status prefixes (`Running find_file`) and map Antigravity aliases. */
export function canonicalToolName(name: string): string {
  let n = name.trim().replace(/^`+|`+$/g, "");
  n = n.replace(TOOL_STATUS_PREFIX, "").trim().replace(/^`+|`+$/g, "");
  const lower = n.toLowerCase().replace(/-/g, "_");
  return TOOL_NAME_ALIASES[lower] ?? n;
}

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "AbsolutePath",
  "TargetFile",
  "DirectoryPath",
  "Path",
  "FilePath",
] as const;

export function filePathFromToolInput(input: Record<string, unknown>): string {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
