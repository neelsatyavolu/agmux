import { codexListThreads } from "./commands";
import type { CodexThread } from "../components/sidebar/CodexSessionsList";

const STORAGE_KEY = "agmux-codex-threads-v1";

function readSnapshot(): CodexThread[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((t): t is CodexThread =>
      t != null && typeof t.id === "string" && typeof t.cwd === "string" &&
      typeof t.preview === "string" &&
      (typeof t.createdAt === "number" || typeof t.createdAt === "string") &&
      (typeof t.updatedAt === "number" || typeof t.updatedAt === "string")
    ).slice(0, 100).map((t) => ({ ...t, status: { type: "notLoaded" } }));
  } catch {
    return [];
  }
}

let threads = readSnapshot();
let inFlight: Promise<CodexThread[]> | undefined;

export function getCachedCodexThreads(): CodexThread[] {
  return threads;
}

/** thread/list is global, even though the server is started in a workspace.
 * Share overlapping Home/sidebar requests; never persist transcript payloads. */
export function refreshCodexThreads(workDir: string): Promise<CodexThread[]> {
  if (inFlight) return inFlight;
  inFlight = codexListThreads(workDir).then((result) => {
    threads = (result as { data?: CodexThread[] })?.data ?? [];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(threads.slice(0, 100).map((t) => ({
        id: t.id,
        cwd: t.cwd ?? "",
        preview: (t.preview ?? "").slice(0, 1000),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        status: { type: "notLoaded" },
        model: t.model,
        source: t.source,
      }))));
    } catch {
      // Storage may be unavailable/full; the live list still works.
    }
    return threads;
  }).finally(() => { inFlight = undefined; });
  return inFlight;
}
