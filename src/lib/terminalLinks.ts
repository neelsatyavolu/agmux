import type { ILink } from "@xterm/xterm";
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { useUiStore } from "../stores/uiStore";

const EDITOR_SUPPORTED_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "md", "mdx", "json", "jsonc", "toml",
  "css", "scss", "less", "html", "htm",
  "py", "go", "yaml", "yml", "sql", "sh", "bash", "zsh",
  "svg", "cfg", "txt", "log", "env", "ini",
  "vue", "svelte", "proto", "graphql", "zig",
  "c", "h", "cpp", "hpp", "cc", "java", "kt", "swift", "rb", "php",
  "xml", "lock", "conf",
]);

function getExtension(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function isEditorSupported(path: string): boolean {
  const ext = getExtension(path);
  if (ext === null) return false;
  return EDITOR_SUPPORTED_EXTENSIONS.has(ext);
}

/** Open a resolved filesystem path in the in-app editor, or the OS default app. */
export function openResolvedPath(resolved: string): void {
  if (isEditorSupported(resolved)) {
    useUiStore.getState().openFile(resolved);
    return;
  }
  import("@tauri-apps/plugin-opener")
    .then(({ openPath }) => openPath(resolved))
    .catch((err) => {
      console.error("Failed to open path externally:", err);
      useUiStore.getState().openFile(resolved);
    });
}

// ---------------------------------------------------------------------------
// Cached home directory — a filesystem call that never changes at runtime.
// Shared across all terminal views so each one doesn't duplicate the cache.
// ---------------------------------------------------------------------------

let _cachedHomeDir: string | null = null;
export async function getCachedHomeDir(): Promise<string> {
  if (_cachedHomeDir !== null) return _cachedHomeDir;
  try {
    _cachedHomeDir = await tauriHomeDir();
  } catch {
    _cachedHomeDir = "";
  }
  return _cachedHomeDir;
}

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

const EXTENSIONS =
  "ts|tsx|js|jsx|rs|md|json|toml|css|html|py|go|yaml|yml|sql|sh|svg|lock|" +
  "cfg|txt|log|env|scss|less|vue|svelte|proto|graphql|zig|wasm";

// Path character class: word chars, dots, slashes, @, ~, +, -
const PC = "[\\w./@~+\\-]";

/**
 * Combined file path regex. Matches four forms (order = most specific first):
 *   1. Paths with a recognised extension:  src/foo.ts, ./bar.md
 *   2. Absolute paths with 2+ segments:    /usr/local/bin/thing
 *   3. Relative-prefixed:                  ./foo, ../bar/baz
 *   4. Home-relative:                      ~/Documents/foo.ts
 *
 * Uses a capturing group (index 1) so callers get just the path, not leading
 * whitespace or punctuation that may be part of the full match.
 */
/**
 * Match http(s) URLs. Stops at whitespace and common trailing punctuation
 * that's typically not part of the URL (closing parens/brackets, sentence
 * punctuation). We strip a trailing `.,;:!?)` in the activate path too.
 */
export const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/g;

export const FILE_PATH_REGEX = new RegExp(
  `(?:^|(?<=[^\\w/]))` +
  `(${PC}+\\.(?:${EXTENSIONS})` +
  `|/(?:${PC}+/)+${PC}*` +
  `|\\.{1,2}/${PC}+` +
  `|~/${PC}+)` +
  `(?=[^\\w]|$)`,
  "g"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip surrounding punctuation that terminals commonly wrap paths in:
 * parens (), brackets [], braces {}, quotes, trailing colons/commas/semicolons.
 */
export function stripSurrounding(raw: string): string {
  return raw
    .replace(/^[([{'"]+/, "")
    .replace(/[)\]}'",;:]+$/, "");
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw detected path to an absolute filesystem path.
 *
 * Rules (in priority order):
 *  - Starts with /      → already absolute, use as-is
 *  - Starts with ~/     → expand home dir
 *  - Starts with ./ or ../  → resolve relative to projectPath
 *  - Bare relative (src/foo.ts) → join with projectPath
 */
export function resolvePath(
  raw: string,
  projectPath: string,
  homeDir: string
): string {
  const path = stripSurrounding(raw);

  if (path.startsWith("/")) return path;

  if (!projectPath && !path.startsWith("~/")) return path;

  if (path.startsWith("~/")) {
    return homeDir.replace(/\/$/, "") + "/" + path.slice(2);
  }

  const base = projectPath.replace(/\/$/, "");

  if (path.startsWith("./")) {
    return base + "/" + path.slice(2);
  }

  // Handles ../ and bare relative paths
  return _joinPath(base, path);
}

/** Join base + relative, resolving .. segments. */
function _joinPath(base: string, relative: string): string {
  const parts = (base + "/" + relative).split("/").filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (part === "..") result.pop();
    else if (part !== ".") result.push(part);
  }
  return "/" + result.join("/");
}

// ---------------------------------------------------------------------------
// ILink factory
// ---------------------------------------------------------------------------

/**
 * Scan one terminal row (`text`) for file paths and return xterm.js ILink
 * objects. Called by the ILinkProvider registered in ClaudeTerminalView.
 *
 * Note: xterm.js uses 1-indexed buffer cell positions for the `x` field
 * (1 == first column), unlike ghostty's 0-indexed scheme. We add +1 to the
 * raw match offset to convert.
 *
 * @param text        Full text of the terminal row (from translateToString)
 * @param y           Absolute buffer row index (passed straight to ILink.range)
 * @param projectPath Absolute path of the project repo root
 * @param homeDir     User's home directory (e.g. /Users/neel)
 */
export function makeFileLinks(
  text: string,
  y: number,
  projectPath: string,
  homeDir: string
): ILink[] {
  const links: ILink[] = [];
  let match: RegExpExecArray | null;
  const urlRanges: Array<[number, number]> = [];

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    let url = match[0];
    // Strip trailing punctuation that's likely not part of the URL.
    const trimmed = url.replace(/[.,;:!?)\]'"]+$/, "");
    const startX = match.index + 1;
    const endX = startX + trimmed.length - 1;
    url = trimmed;
    urlRanges.push([match.index, match.index + trimmed.length]);

    links.push({
      text: url,
      range: {
        start: { x: startX, y },
        end: { x: endX, y },
      },
      activate(_event: MouseEvent, _text: string) {
        // Open in the OS default browser.
        // Terminal link activation is typically ⌘/Ctrl+click (xterm hover + click).
        import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(url))
          .catch((err) => {
            console.error("Failed to open URL:", err);
          });
      },
    });
  }

  FILE_PATH_REGEX.lastIndex = 0;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const raw = match[1];
    const rawStart = match.index + (match[0].length - raw.length);
    const rawEnd = rawStart + raw.length;
    const overlapsUrl = urlRanges.some(
      ([s, e]) => rawStart < e && rawEnd > s,
    );
    if (overlapsUrl) continue;
    // match[0] may include a leading non-word char; match[1] starts at the path.
    // xterm.js uses 1-indexed cell positions, so add 1.
    const startX = match.index + (match[0].length - raw.length) + 1;
    const endX = startX + raw.length - 1;
    const resolved = resolvePath(raw, projectPath, homeDir);

    links.push({
      text: raw,
      range: {
        start: { x: startX, y },
        end: { x: endX, y },
      },
      activate(_event: MouseEvent, _text: string) {
        // Opens the agent-mode EditorPanel overlay, which renders the
        // FileTree alongside the editor. In xterm this activate handler
        // fires on cmd/ctrl-click (xterm's built-in convention for
        // link activation). For files the in-app editor can't render
        // (binaries, dmgs, images we don't handle), fall back to the
        // OS default application via the opener plugin.
        openResolvedPath(resolved);
      },
    });
  }

  return links;
}
