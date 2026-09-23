import { getCachedHomeDir, openResolvedPath, resolvePath } from "./terminalLinks";

export function parseMarkdownFileHref(href: string): { path: string; line: number | null } {
  let raw = href.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();

  let line: number | null = null;
  const lineMatch = raw.match(/:(\d+)$/);
  if (lineMatch) {
    const without = raw.slice(0, -lineMatch[0].length);
    if (without && !without.endsWith("/")) {
      raw = without;
      line = Number(lineMatch[1]);
    }
  }

  if (raw.includes("%")) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // keep the raw href if it isn't valid percent-encoding
    }
  }

  return { path: raw, line };
}

export function isHttpOrMailtoHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

export function isLocalFileHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || isHttpOrMailtoHref(trimmed) || /^tel:/i.test(trimmed) || trimmed.startsWith("#")) {
    return false;
  }
  const { path } = parseMarkdownFileHref(trimmed);
  if (!path) return false;
  if (path.includes("://") && !/^file:/i.test(path)) return false;
  if (
    /^file:/i.test(path) ||
    path.startsWith("/") ||
    path.startsWith("~/") ||
    path.startsWith("./") ||
    path.startsWith("../")
  ) {
    return true;
  }
  if (path.includes("/")) return true;
  // Bare `notes.md` is a file. Scheme-less `example.com` is a host.
  if (/^(www\.)?[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co|edu|gov|info|xyz|me|us)$/i.test(path)) {
    return false;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(path);
}

function fileUrlToPath(s: string): string {
  if (!/^file:/i.test(s)) return s;
  let path = s.replace(/^file:\/\//i, "");
  if (path.startsWith("localhost/")) path = path.slice(9);
  if (path.includes("%")) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep
    }
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveMarkdownHref(href: string, workDir: string, homeDir = ""): string | null {
  if (!isLocalFileHref(href)) return null;
  const { path } = parseMarkdownFileHref(href);
  const raw = /^file:/i.test(path) ? fileUrlToPath(path) : path;
  const resolved = resolvePath(raw, workDir, homeDir);
  return resolved.startsWith("/") ? resolved : null;
}

export async function openMarkdownHref(href: string, workDir: string): Promise<boolean> {
  const { path } = parseMarkdownFileHref(href);
  const homeDir = path.startsWith("~/") ? await getCachedHomeDir() : "";
  const resolved = resolveMarkdownHref(href, workDir, homeDir);
  if (!resolved) return false;
  openResolvedPath(resolved);
  return true;
}
