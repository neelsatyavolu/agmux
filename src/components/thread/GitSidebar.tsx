import { useSharedSessionPanels } from "./SessionPanelsContext";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  RefreshCw,
  GitCommit,
  Upload,
  Loader2,
  Check,
  GitBranch,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  RotateCcw,
  Plus,
  Copy,
  Sparkles,
  AlertTriangle,
  GitPullRequest,
  FolderGit2,
  ArrowUp,
  ArrowDown,
  X,
  Rows3,
  AlignJustify,
  ScrollText,
  ChevronsUpDown,
  ExternalLink,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  getGitBranchDiff,
  getGitUnstagedDiff,
  getGitStagedDiff,
  getGitCommittedDiff,
  getGitInfo,
  gitStageFile,
  gitStageAll,
  gitDiscardAllLocalChanges,
  checkIsGitRepo,
  gitInitAndPublish,
  gitListBranches,
  gitCheckoutBranch,
  gitCreateAndCheckoutBranch,
  gitCommitOnly,
  gitCommitAndPushV2,
  gitCommitAndCreatePr,
  generateCommitContent,
} from "../../lib/commands";
import type { GitBranch as GitBranchType } from "../../lib/commands";
import {
  useSettingsStore,
  commitMessageCandidates,
} from "../../stores/settingsStore";
import type { GitAccount } from "../../stores/settingsStore";
import type { FileChangeEvent } from "../../lib/types";

// ── Stable empty refs ────────────────────────────────────────
const EMPTY_GIT_ACCOUNTS: GitAccount[] = [];
const EMPTY_FILES: ParsedFile[] = [];
const EMPTY_BRANCHES: GitBranchType[] = [];

// ── Types ─────────────────────────────────────────────────────
interface Props {
  workDir: string;
  /**
   * Called after "Commit & Create PR" completes. Receives the raw output
   * string from `gh pr create` (typically the PR URL) and the parsed PR
   * number if one could be extracted. Task mode uses this to persist the
   * PR link back to the `tasks` table.
   */
  onPrCreated?: (prUrl: string, prNumber: number | null) => void;
  open: boolean;
  threadId?: string | null;
}

type FileStatus = "added" | "deleted" | "modified" | "unknown";
type ViewMode = "unstaged" | "staged" | "committed" | "branch";
type CommitAction = "commit" | "push" | "pr";
type DiffLayout = "stacked" | "strip" | "scroll" | "dropdown";

const DIFF_LAYOUT_STORAGE_KEY = "xanom.gitSidebar.diffLayout";
const PANEL_WIDTH_STORAGE_KEY = "xanom.gitSidebar.panelWidth";
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 1000;


const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  committed: "Committed",
  branch: "Branch",
};

const COMMIT_ACTION_LABELS: Record<CommitAction, string> = {
  commit: "Commit",
  push: "Commit & Push",
  pr: "Commit & Create PR",
};

/** Label flips to "Commit & Push New Branch" when the branch has no upstream yet. */
function commitActionLabel(action: CommitAction, hasUpstream: boolean): string {
  if (action === "push" && !hasUpstream) return "Commit & Push New Branch";
  return COMMIT_ACTION_LABELS[action];
}

interface ParsedFile {
  path: string;
  filename: string;
  directory: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  rawDiff: string;
}

const SUSPICIOUS_PATTERNS = [
  /\.env($|\.|\/)/i,
  /\.key$/i,
  /\.pem$/i,
  /credentials/i,
  /\.secret/i,
  /id_rsa/i,
];

function isSuspicious(path: string): boolean {
  return SUSPICIOUS_PATTERNS.some((p) => p.test(path));
}

function groupFilesByDir(files: ParsedFile[]): Record<string, ParsedFile[]> {
  const groups: Record<string, ParsedFile[]> = {};
  for (const file of files) {
    const parts = file.path.split("/");
    const dir = parts.length > 1 ? parts[0] : "/";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(file);
  }
  return groups;
}

// ── Diff parser ──────────────────────────────────────────────
function parseDiffFiles(diff: string): ParsedFile[] {
  if (!diff.trim()) return EMPTY_FILES;

  const files: ParsedFile[] = [];
  const lines = diff.split("\n");
  let current: Partial<ParsedFile> | null = null;
  let diffLines: string[] = [];

  const flush = () => {
    if (!current?.path) return;
    let additions = 0;
    let deletions = 0;
    for (const l of diffLines) {
      if (l.startsWith("+") && !l.startsWith("+++")) additions++;
      else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
    }
    const parts = current.path.split("/");
    const filename = parts[parts.length - 1] ?? current.path;
    const directory = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    files.push({
      path: current.path,
      filename,
      directory,
      status: current.status ?? "unknown",
      additions,
      deletions,
      rawDiff: diffLines.join("\n"),
    });
  };

  for (const line of lines) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) {
      flush();
      current = { path: match[1], status: "modified" };
      diffLines = [line];
      continue;
    }
    if (current) {
      diffLines.push(line);
      if (line.startsWith("new file mode")) {
        current = { ...current, status: "added" };
      } else if (line.startsWith("deleted file mode")) {
        current = { ...current, status: "deleted" };
      }
    }
  }
  flush();
  return files;
}

// ── Sub-components ────────────────────────────────────────────

// ── Design-kit primitives ─────────────────────────────────────

function StatusMark({ status, size = 14 }: { status: FileStatus; size?: number }) {
  const cfg: Record<FileStatus, { letter: string; fg: string; bg: string; border: string }> = {
    added: { letter: "A", fg: "var(--status-green)", bg: "rgba(52,211,153,0.14)", border: "rgba(52,211,153,0.35)" },
    deleted: { letter: "D", fg: "var(--status-red)", bg: "rgba(248,113,113,0.14)", border: "rgba(248,113,113,0.35)" },
    modified: { letter: "M", fg: "var(--status-blue)", bg: "rgba(96,165,250,0.14)", border: "rgba(96,165,250,0.35)" },
    unknown: { letter: "?", fg: "var(--text-tertiary)", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.10)" },
  };
  const c = cfg[status];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center leading-none"
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        fontSize: Math.round(size * 0.64),
        fontWeight: 600,
        letterSpacing: 0,
        fontFamily: "var(--font-mono)",
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
      }}
    >
      {c.letter}
    </span>
  );
}


function PathCrumbs({ path, size = 12 }: { path: string; size?: number }) {
  const parts = path.split("/");
  const filename = parts.pop() ?? path;
  return (
    <span
      className="inline-flex min-w-0 items-center"
      style={{ fontFamily: "var(--font-mono)", fontSize: size, letterSpacing: 0 }}
    >
      {parts.map((p, i) => (
        <span key={i} className="min-w-0 truncate">
          <span style={{ color: "var(--text-muted, #71717a)" }}>{p}</span>
          <span style={{ color: "var(--text-muted, #52525b)", margin: "0 2px" }}>/</span>
        </span>
      ))}
      <span className="truncate" style={{ color: "var(--text-primary, #fff)", fontWeight: 500 }}>
        {filename}
      </span>
    </span>
  );
}

function DiffBar({ add, del, width = 28 }: { add: number; del: number; width?: number }) {
  const total = add + del;
  const addPct = total === 0 ? 0 : (add / total) * 100;
  const delPct = total === 0 ? 0 : (del / total) * 100;
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-full"
      style={{ width, height: 3, background: "rgba(255,255,255,0.06)" }}
    >
      <span className="flex h-full w-full">
        <span className="fx-fill-green" style={{ width: `${addPct}%`, background: "#34d399" }} />
        <span className="fx-fill-red" style={{ width: `${delPct}%`, background: "#f87171" }} />
      </span>
    </span>
  );
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="ui-diff flex shrink-0 items-center gap-1.5 tabular-nums">
      {additions > 0 && <span style={{ color: "var(--status-green)" }}>+{additions}</span>}
      {deletions > 0 && <span style={{ color: "var(--status-red)" }}>−{deletions}</span>}
      {(additions > 0 || deletions > 0) && <DiffBar add={additions} del={deletions} width={24} />}
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="ui-eyebrow fx-graphite" style={{ color: "var(--status-green)" }}>
      {children}
    </span>
  );
}

type DiffLine = { k: "+" | "-" | " "; n1: number | ""; n2: number | ""; t: string };
type Hunk = { header: string; lines: DiffLine[] };

function parseHunks(rawDiff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = rawDiff.split("\n");
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity") ||
      line.startsWith("rename")
    ) {
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      oldLine = parseInt(m[1], 10);
      newLine = parseInt(m[2], 10);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push({ k: "+", n1: "", n2: newLine++, t: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push({ k: "-", n1: oldLine++, n2: "", t: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push({ k: " ", n1: oldLine++, n2: newLine++, t: line.slice(1) });
    }
  }
  return hunks;
}

function DiffHunk({ hunk, density = "comfortable" }: { hunk: Hunk; density?: "compact" | "comfortable" }) {
  const py = density === "compact" ? 1 : 2;
  const fs = density === "compact" ? 12 : 12.5;
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: fs,
        lineHeight: 1.55,
        color: "var(--text-secondary)",
        letterSpacing: 0,
      }}
    >
      {/* sticky hunk header */}
      <div
        className="sticky top-0 z-[1] px-3 py-1.5"
        style={{
          fontFamily: "var(--font-mono)",
          background: "var(--surface-code-panel)",
          backdropFilter: "blur(6px)",
          borderTop: "1px solid var(--glass-border)",
          borderBottom: "1px solid var(--glass-border)",
          color: "var(--text-muted)",
          fontSize: 11,
        }}
      >
        {hunk.header}
      </div>
      {hunk.lines.map((ln, i) => {
        const bg =
          ln.k === "+" ? "rgba(52,211,153,0.08)" : ln.k === "-" ? "rgba(248,113,113,0.08)" : "transparent";
        const signC = ln.k === "+" ? "var(--status-green)" : ln.k === "-" ? "var(--status-red)" : "var(--text-muted)";
        return (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "44px 14px minmax(0, 1fr)",
              background: bg,
              padding: `${py}px 0`,
            }}
          >
            <span
              className="select-none text-right"
              style={{
                color: "var(--text-muted)",
                paddingRight: 8,
                fontSize: 10.5,
                borderRight: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              {ln.k === "-" ? ln.n1 : ln.n2 || ln.n1}
            </span>
            <span
              className="select-none text-center font-semibold"
              style={{ color: signC }}
            >
              {ln.k === " " ? "" : ln.k}
            </span>
            <span
              className="whitespace-pre pr-4"
              style={{
                color: ln.k === " " ? "var(--text-muted)" : "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {ln.t || "\u00A0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DiffViewer({ rawDiff, density = "comfortable" }: { rawDiff: string; density?: "compact" | "comfortable" }) {
  const hunks = useMemo(() => parseHunks(rawDiff), [rawDiff]);
  if (hunks.length === 0) {
    return (
      <div
        className="px-5 py-8 text-center font-mono"
        style={{ color: "var(--text-muted)", fontSize: 11.5, background: "var(--surface-code-panel)" }}
      >
        <div className="mb-1">No hunks captured for this diff.</div>
      </div>
    );
  }
  return (
    <div style={{ background: "var(--surface-code-panel)" }}>
      {hunks.map((h, i) => (
        <DiffHunk key={i} hunk={h} density={density} />
      ))}
    </div>
  );
}

function ViewModeDropdown({
  value,
  onChange,
  fileCount,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  fileCount: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const modes: ViewMode[] = ["unstaged", "staged", "committed", "branch"];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-white/[0.06]"
      >
        <span className="text-[13px] font-medium text-zinc-200">{VIEW_MODE_LABELS[value]}</span>
        <span className="rounded px-1.5 py-0 text-[10px] font-medium tabular-nums text-zinc-500 bg-white/[0.05]">
          {fileCount}
        </span>
        <ChevronDown size={11} className="text-zinc-500" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute left-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-lg border shadow-xl shadow-black/40 backdrop-blur-xl"
            style={{ borderColor: "var(--glass-border-highlight)", background: "rgba(20, 20, 22, 0.92)" }}
          >
            {modes.map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.06]"
              >
                <span className={`flex-1 ${value === mode ? "font-medium text-zinc-100" : "text-zinc-400"}`}>
                  {VIEW_MODE_LABELS[mode]}
                </span>
                {value === mode && <Check size={12} className="shrink-0 text-zinc-300" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BranchSwitcher({
  workDir,
  current,
  onSwitched,
}: {
  workDir: string;
  current: string | null;
  onSwitched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchType[]>(EMPTY_BRANCHES);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    gitListBranches(workDir)
      .then((res) => setBranches(res.branches))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, workDir]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, filter]);

  const exactMatch = filtered.some(
    (b) => b.name.toLowerCase() === filter.trim().toLowerCase(),
  );
  const canCreate = filter.trim() && !exactMatch;

  const handleSwitch = async (name: string) => {
    setSwitching(name);
    setError(null);
    try {
      await gitCheckoutBranch(workDir, name);
      setOpen(false);
      onSwitched();
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitching(null);
    }
  };

  const handleCreate = async () => {
    const name = filter.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      await gitCreateAndCheckoutBranch(workDir, name);
      setOpen(false);
      setFilter("");
      onSwitched();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="rounded p-0.5 text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors"
        title="Switch branch"
        aria-label="Switch branch"
      >
        <ChevronDown size={11} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute right-0 top-full z-50 mt-1 w-[260px] overflow-hidden rounded-lg border shadow-xl shadow-black/40 backdrop-blur-xl"
            style={{ borderColor: "var(--glass-border-highlight)", background: "rgba(20, 20, 22, 0.92)" }}
          >
            <div className="p-2 hairline-b">
              <input
                autoFocus
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Find or create branch..."
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/40"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) handleCreate();
                }}
              />
            </div>

            <div className="max-h-[260px] overflow-y-auto py-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-zinc-500">
                  <Loader2 size={11} className="animate-spin" />
                  <span>Loading branches...</span>
                </div>
              ) : (
                <>
                  {filtered.map((b) => {
                    const isCurrent = b.name === current;
                    const isSwitching = switching === b.name;
                    return (
                      <button
                        key={`${b.is_remote ? "r" : "l"}-${b.name}`}
                        type="button"
                        disabled={isCurrent || isSwitching}
                        onClick={() => handleSwitch(b.name)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.06] disabled:opacity-60"
                      >
                        <GitBranch size={10} className={b.is_remote ? "text-sky-400/60" : "text-amber-400/70"} />
                        <span className={`flex-1 truncate font-mono ${isCurrent ? "text-zinc-100" : "text-zinc-400"}`}>
                          {b.name}
                        </span>
                        {b.is_remote && <span className="text-[9px] text-zinc-600 uppercase">remote</span>}
                        {isSwitching ? (
                          <Loader2 size={11} className="animate-spin text-zinc-400" />
                        ) : isCurrent ? (
                          <Check size={11} className="text-[color:var(--accent)]" />
                        ) : null}
                      </button>
                    );
                  })}

                  {canCreate && (
                    <button
                      type="button"
                      onClick={handleCreate}
                      disabled={creating}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[color:var(--accent)] transition-colors hover:bg-[var(--accent-dim)] disabled:opacity-60 hairline-t"
                    >
                      {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                      <span className="flex-1 truncate">
                        Create <span className="font-mono">{filter.trim()}</span>
                      </span>
                    </button>
                  )}

                  {!loading && filtered.length === 0 && !canCreate && (
                    <div className="px-3 py-4 text-center text-[11px] text-zinc-600">No branches</div>
                  )}
                </>
              )}
            </div>

            {error && (
              <div className="px-3 py-2 text-[11px] text-red-400 break-words hairline-t">{error}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CommitActionButton({
  action,
  onAction,
  onActionChange,
  disabled,
  busy,
  label,
  hasUpstream,
}: {
  action: CommitAction;
  onAction: () => void;
  onActionChange: (a: CommitAction) => void;
  disabled: boolean;
  busy: boolean;
  label: string;
  hasUpstream: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const icon =
    action === "commit" ? <GitCommit size={13} /> :
    action === "push" ? <ArrowUp size={13} /> :
    <GitPullRequest size={13} />;

  return (
    <div ref={ref} className="relative flex w-full">
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="flex-1 flex items-center justify-center gap-2 py-2 rounded-l-md bg-[var(--accent)] text-[#14110a] text-[12px] font-medium hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
        <span>{label}</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        disabled={disabled}
        className="px-2 rounded-r-md bg-[var(--accent)] text-[#14110a] border-l border-black/20 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Choose commit action"
      >
        <ChevronDown size={12} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute right-0 bottom-full z-50 mb-1 min-w-[200px] overflow-hidden rounded-lg border shadow-xl shadow-black/40 backdrop-blur-xl"
            style={{ borderColor: "var(--glass-border-highlight)", background: "rgba(20, 20, 22, 0.92)" }}
          >
            {(["commit", "push", "pr"] as CommitAction[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => {
                  onActionChange(a);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.06]"
              >
                {a === "commit" ? <GitCommit size={12} /> : a === "push" ? <ArrowUp size={12} /> : <GitPullRequest size={12} />}
                <span className="flex-1">{commitActionLabel(a, hasUpstream)}</span>
                {action === a && <Check size={11} className="text-[color:var(--accent)]" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PushConfirmDialog({
  action,
  commitMessage,
  files,
  onConfirm,
  onCancel,
  busy,
  hasUpstream,
}: {
  action: CommitAction;
  commitMessage: string;
  files: ParsedFile[];
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  hasUpstream: boolean;
}) {
  const suspiciousFiles = files.filter((f) => isSuspicious(f.path));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[420px] max-h-[80vh] flex flex-col rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 hairline-b">
          <span className="text-[13px] font-semibold text-zinc-100">
            Confirm {action === "commit" ? "commit" : action === "push" ? "push" : "PR"}
          </span>
          <button onClick={onCancel} className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-200 transition-colors">
            <X size={14} />
          </button>
        </div>
        <div className="px-4 pt-3 pb-2">
          <div className="text-[11px] text-zinc-500 mb-1">Commit message</div>
          <div className="rounded-md bg-white/[0.04] border border-white/[0.06] px-2.5 py-2 text-[13px] text-zinc-200 font-mono break-words">
            {commitMessage}
          </div>
        </div>
        {suspiciousFiles.length > 0 && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[12px] text-amber-300">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Suspicious files:</span>{" "}
              {suspiciousFiles.map((f) => f.path).join(", ")}. Review before committing.
            </div>
          </div>
        )}
        <div className="px-4 pb-1">
          <div className="text-[11px] text-zinc-500 mb-1">
            {files.length} file{files.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto mx-4 mb-3 rounded-md border border-white/[0.06] bg-white/[0.02]">
          {files.map((f) => (
            <div
              key={f.path}
              className={`flex items-center justify-between px-2.5 py-1.5 text-[12px] border-b border-white/[0.04] last:border-0 ${
                isSuspicious(f.path) ? "bg-amber-500/5" : ""
              }`}
            >
              <span className={`truncate font-mono ${isSuspicious(f.path) ? "text-amber-300" : "text-zinc-300"}`}>
                {f.path}
              </span>
              <div className="flex items-center gap-2 ml-2 shrink-0 font-mono text-[11px]">
                {f.additions > 0 && <span className="text-emerald-400/80">+{f.additions}</span>}
                {f.deletions > 0 && <span className="text-red-400/80">-{f.deletions}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 px-4 pb-4">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-md border border-white/[0.08] text-[13px] font-medium text-zinc-300 hover:text-zinc-100 hover:border-white/[0.14] hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md bg-[var(--accent)] text-[#14110a] text-[13px] font-medium hover:brightness-110 disabled:opacity-40 transition-colors"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : action === "commit" ? <GitCommit size={13} /> : action === "push" ? <ArrowUp size={13} /> : <GitPullRequest size={13} />}
            {busy ? "Working..." : `Confirm ${commitActionLabel(action, hasUpstream)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Layout switcher ──────────────────────────────────────────
function LayoutSwitcher({
  value,
  onChange,
}: {
  value: DiffLayout;
  onChange: (v: DiffLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const layouts: Array<{ value: DiffLayout; icon: React.ReactNode; label: string; desc: string }> = [
    { value: "stacked", icon: <Rows3 size={12} />, label: "Stacked", desc: "Directory groups with inline diffs" },
    { value: "strip", icon: <AlignJustify size={12} />, label: "Strip", desc: "Compact flat list" },
    { value: "scroll", icon: <ScrollText size={12} />, label: "Scroll", desc: "All diffs always open" },
    { value: "dropdown", icon: <ChevronsUpDown size={12} />, label: "Dropdown", desc: "Warp-style per-file cards" },
  ];

  const current = layouts.find((l) => l.value === value) ?? layouts[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors"
        title={`Layout: ${current.label}`}
        style={{ fontFamily: "var(--font-sans)" }}
      >
        <span className="shrink-0">{current.icon}</span>
        <span className="text-[11px]">{current.label}</span>
        <ChevronDown size={10} className="text-zinc-500" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute left-0 top-full z-50 mt-1 w-[220px] overflow-hidden rounded-lg border shadow-xl shadow-black/40 backdrop-blur-xl"
            style={{ borderColor: "var(--glass-border-highlight)", background: "rgba(20, 20, 22, 0.92)" }}
          >
            <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 hairline-b">
              Diff Layout
            </div>
            {layouts.map((l) => {
              const active = l.value === value;
              return (
                <button
                  key={l.value}
                  onClick={() => {
                    onChange(l.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                    active ? "bg-white/[0.04]" : "hover:bg-white/[0.06]"
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 ${active ? "text-[color:var(--accent)]" : "text-zinc-500"}`}>{l.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[12px] ${active ? "font-medium text-zinc-100" : "text-zinc-300"}`}>{l.label}</div>
                    <div className="text-[10px] text-zinc-500 leading-snug">{l.desc}</div>
                  </div>
                  {active && <Check size={11} className="mt-0.5 shrink-0 text-[color:var(--accent)]" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Warp-style dropdown card ─────────────────────────────────
function WarpFileCard({
  file,
  expanded,
  onToggle,
  onStage,
  onCopyPath,
  onRevert,
}: {
  file: ParsedFile;
  expanded: boolean;
  onToggle: () => void;
  onStage?: (path: string) => void;
  onCopyPath: (path: string) => void;
  onRevert?: (path: string) => void;
}) {
  const suspicious = isSuspicious(file.path);
  return (
    <div
      className="mx-2 my-1.5 overflow-hidden rounded-lg border bg-black/20"
      style={{ borderColor: "var(--glass-border)" }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.03] cursor-pointer ${
          suspicious ? "bg-amber-500/[0.05]" : ""
        }`}
      >
        <motion.span
          animate={{ rotate: expanded ? 0 : -90 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="shrink-0 text-zinc-500"
        >
          <ChevronDown size={12} />
        </motion.span>
        <StatusMark status={file.status} size={14} />
        <span className="min-w-0 flex-1 truncate" title={file.path}>
          <PathCrumbs path={file.path} size={12} />
        </span>

        {suspicious && <AlertTriangle size={11} className="shrink-0 text-amber-400/80" />}

        <span
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
          style={{ background: "rgba(255,255,255,0.04)" }}
        >
          {file.additions > 0 && <span className="text-emerald-400/90">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && <span className="text-zinc-600">·</span>}
          {file.deletions > 0 && <span className="text-red-400/90">-{file.deletions}</span>}
          {file.additions === 0 && file.deletions === 0 && <span className="text-zinc-500">0</span>}
        </span>

        <div
          className="flex shrink-0 items-center gap-0.5"
          role="presentation"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCopyPath(file.path);
            }}
            className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            title="Copy path"
          >
            <Copy size={11} />
          </button>
          {onStage && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStage(file.path);
              }}
              className="rounded p-1 text-zinc-500 hover:bg-[var(--accent-dim)] hover:text-[color:var(--accent)]"
              title="Stage file"
            >
              <Plus size={11} />
            </button>
          )}
          {onRevert && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRevert(file.path);
              }}
              className="rounded p-1 text-zinc-500 hover:bg-red-500/15 hover:text-red-400"
              title="Revert file"
            >
              <RotateCcw size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            title="Open file"
          >
            <ExternalLink size={11} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="diff"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <DiffViewer rawDiff={file.rawDiff} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

const GIT_PANEL_WIDTH_BY_LAYOUT: Record<DiffLayout, number> = {
  stacked: 546,
  strip: 520,
  scroll: 720,
  dropdown: 380,
};

export function GitSidebar(props: Props) {
  const sharedPanels = useSharedSessionPanels();
  return sharedPanels ? null : <GitSidebarContent {...props} />;
}

function GitSidebarContent({ workDir, open, threadId, onPrCreated }: Props) {
  // Slide animation (matches EditorPanel)
  const [mounted, setMounted] = useState(open);
  const [animating, setAnimating] = useState(false);
  // `will-change: width` only while the open/close width transition runs —
  // a permanent hint keeps the panel on its own compositor layer.
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setAnimating(true);
      setTransitioning(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimating(false));
      });
      const timer = setTimeout(() => setTransitioning(false), 350);
      return () => clearTimeout(timer);
    } else if (mounted) {
      setAnimating(true);
      setTransitioning(true);
      const timer = setTimeout(() => {
        setMounted(false);
        setAnimating(false);
        setTransitioning(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open, mounted]);

  const isOpen = open && !animating;
  const gitAccounts = useSettingsStore((s) => s.settings.gitAccounts ?? EMPTY_GIT_ACCOUNTS);

  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [checkingRepo, setCheckingRepo] = useState(false);

  // Init & publish
  const [selectedAccountIndex, setSelectedAccountIndex] = useState<number>(-1);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("master");
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null);

  // Diff & commit
  const [diff, setDiff] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{ success: boolean; message: string } | null>(null);
  const [commitAction, setCommitAction] = useState<CommitAction>("push");
  const [showConfirm, setShowConfirm] = useState(false);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);

  // AI message generation
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Branch / upstream
  const [branch, setBranch] = useState<string | null>(null);
  const [hasUpstream, setHasUpstream] = useState<boolean>(true);
  const [ahead, setAhead] = useState<number>(0);
  const [behind, setBehind] = useState<number>(0);
  const [copiedBranch, setCopiedBranch] = useState(false);

  // UI state
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("unstaged");
  const [diffLayout, setDiffLayoutState] = useState<DiffLayout>(() => {
    if (typeof window === "undefined") return "stacked";
    const stored = window.localStorage.getItem(DIFF_LAYOUT_STORAGE_KEY);
    return stored === "strip" || stored === "scroll" || stored === "dropdown" || stored === "stacked"
      ? stored
      : "stacked";
  });
  const widthStorageKey = `${PANEL_WIDTH_STORAGE_KEY}.${diffLayout}`;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const fallback = GIT_PANEL_WIDTH_BY_LAYOUT[diffLayout] ?? 420;
    if (typeof window === "undefined") return fallback;
    const stored = window.localStorage.getItem(`${PANEL_WIDTH_STORAGE_KEY}.${diffLayout}`);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
    }
    return fallback;
  });
  const [resizing, setResizing] = useState(false);
  // When layout changes, switch to that layout's stored width (or its default).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(`${PANEL_WIDTH_STORAGE_KEY}.${diffLayout}`);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    const fallback = GIT_PANEL_WIDTH_BY_LAYOUT[diffLayout] ?? 420;
    const next = Number.isFinite(parsed)
      ? Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed))
      : fallback;
    setPanelWidth(next);
  }, [diffLayout]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(widthStorageKey, String(panelWidth));
    }
  }, [panelWidth, widthStorageKey]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const next = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, startWidth + delta));
      setPanelWidth(next);
    };
    const teardown = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizeCleanupRef.current = null;
    };
    const onUp = () => {
      setResizing(false);
      teardown();
    };
    resizeCleanupRef.current = teardown;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelWidth]);
  const setDiffLayout = useCallback((v: DiffLayout) => {
    setDiffLayoutState(v);
    try {
      window.localStorage.setItem(DIFF_LAYOUT_STORAGE_KEY, v);
    } catch {
      /* ignore */
    }
    // Dropdown starts collapsed; scroll expands everything in the files effect.
    if (v === "dropdown") {
      setExpandedPaths(new Set());
    }
  }, []);

  const checkRepo = useCallback(async () => {
    if (!workDir || workDir === "/") return;
    setCheckingRepo(true);
    checkIsGitRepo(workDir)
      .then((result) => setIsGitRepo(result))
      .catch(() => setIsGitRepo(false))
      .finally(() => setCheckingRepo(false));
  }, [workDir]);

  // Defer repo detection until the panel is open — avoids git work on every
  // thread mount when the sidebar stays closed.
  useEffect(() => {
    if (!open) return;
    checkRepo();
  }, [checkRepo, open]);

  const fetchDiff = useCallback(async () => {
    if (!workDir || workDir === "/") return;
    setLoading(true);
    try {
      const diffFn =
        viewMode === "branch" ? getGitBranchDiff
        : viewMode === "staged" ? getGitStagedDiff
        : viewMode === "committed" ? getGitCommittedDiff
        : getGitUnstagedDiff;
      const [diffResult, gitInfo] = await Promise.all([
        diffFn(workDir),
        getGitInfo(workDir).catch(() => null),
      ]);
      setDiff(diffResult.diff);
      setHasChanges(diffResult.has_changes);
      if (gitInfo) {
        setBranch(gitInfo.branch);
        setHasUpstream(gitInfo.has_upstream);
        setAhead(gitInfo.ahead);
        setBehind(gitInfo.behind);
      }
    } catch (err) {
      console.error("Failed to get git diff:", err);
      setDiff("");
      setHasChanges(false);
    } finally {
      setLoading(false);
    }
  }, [workDir, viewMode]);

  // Only load diffs while open. Opening (or changing viewMode while open)
  // triggers a fresh fetch; closed panels do not pollute the main thread.
  useEffect(() => {
    if (!open) return;
    fetchDiff();
  }, [fetchDiff, open]);

  useEffect(() => {
    if (!threadId || !open) return;
    let unlisten: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const setup = async () => {
      unlisten = await listen<FileChangeEvent>(`file-change-${threadId}`, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => fetchDiff(), 500);
      });
    };
    setup();
    return () => {
      unlisten?.();
      clearTimeout(debounceTimer);
    };
  }, [threadId, open, fetchDiff]);

  const handleInitAndPublish = useCallback(async () => {
    if (!remoteUrl.trim() || publishing) return;
    const sshKeyPath = selectedAccountIndex >= 0 ? gitAccounts[selectedAccountIndex]?.sshKeyPath ?? null : null;
    setPublishing(true);
    setPublishResult(null);
    gitInitAndPublish(workDir, remoteUrl.trim(), defaultBranch.trim() || "master", sshKeyPath)
      .then((msg) => {
        setPublishResult({ success: true, message: msg });
        setIsGitRepo(true);
      })
      .catch((err) => setPublishResult({ success: false, message: String(err) }))
      .finally(() => setPublishing(false));
  }, [workDir, remoteUrl, defaultBranch, selectedAccountIndex, gitAccounts, publishing]);

  const handleCopyBranch = useCallback(async () => {
    if (!branch) return;
    try {
      await navigator.clipboard.writeText(branch);
      setCopiedBranch(true);
      setTimeout(() => setCopiedBranch(false), 1500);
    } catch {
      /* ignore */
    }
  }, [branch]);

  const handleGenerateMessage = useCallback(async () => {
    if (generatingMsg) return;
    setGeneratingMsg(true);
    setGenError(null);
    const include = viewMode === "unstaged" || includeUnstaged;
    const pref = useSettingsStore.getState().settings.commitMessageModel ?? "auto";
    const candidates = commitMessageCandidates(pref);
    const errors: string[] = [];
    try {
      for (const candidate of candidates) {
        try {
          const content = await generateCommitContent(
            workDir,
            include,
            candidate.model,
            candidate.provider,
          );
          const msg = content.body
            ? `${content.subject}\n\n${content.body}`
            : content.subject;
          setCommitMessage(msg);
          return;
        } catch (err) {
          errors.push(
            `${candidate.provider}/${candidate.model}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      setGenError(
        errors.length > 0
          ? `Generation failed:\n${errors.join("\n")}`
          : "Generation failed",
      );
    } finally {
      setGeneratingMsg(false);
    }
  }, [workDir, viewMode, includeUnstaged, generatingMsg]);

  const runCommitAction = useCallback(async () => {
    const msg = commitMessage.trim();
    if (!msg || committing) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      let result: string;
      if (commitAction === "commit") {
        result = await gitCommitOnly(workDir, msg, includeUnstaged);
      } else if (commitAction === "push") {
        result = await gitCommitAndPushV2(workDir, msg, includeUnstaged);
      } else {
        result = await gitCommitAndCreatePr(workDir, msg, includeUnstaged);
        if (onPrCreated) {
          const match = result.match(/https?:\/\/[^\s]*\/pull\/(\d+)/);
          const prUrl = match ? match[0] : result.trim();
          const prNumber = match ? parseInt(match[1], 10) : null;
          onPrCreated(prUrl, prNumber);
        }
      }
      setCommitResult({ success: true, message: result });
      setCommitMessage("");
      setShowConfirm(false);
      setTimeout(fetchDiff, 800);
    } catch (err) {
      setCommitResult({ success: false, message: String(err) });
      setShowConfirm(false);
    } finally {
      setCommitting(false);
    }
  }, [workDir, commitMessage, committing, commitAction, includeUnstaged, fetchDiff, onPrCreated]);

  // Dropdown defaults collapsed. expandedPaths is the source of truth for
  // which cards the user opened; refetches only prune paths that disappeared.
  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleDir = useCallback((dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  const handleStageFile = useCallback(
    async (filePath: string) => {
      try {
        await gitStageFile(workDir, filePath);
        fetchDiff();
      } catch (err) {
        console.error("Failed to stage file:", err);
      }
    },
    [workDir, fetchDiff],
  );

  const handleStageAll = useCallback(async () => {
    try {
      await gitStageAll(workDir);
      fetchDiff();
    } catch (err) {
      setCommitResult({ success: false, message: `Failed to stage all: ${String(err)}` });
    }
  }, [workDir, fetchDiff]);

  const [confirmRevert, setConfirmRevert] = useState(false);

  const handleRevertAll = useCallback(async () => {
    if (!confirmRevert) {
      setConfirmRevert(true);
      return;
    }
    setConfirmRevert(false);
    try {
      await gitDiscardAllLocalChanges(workDir, true);
      fetchDiff();
    } catch (err) {
      setCommitResult({ success: false, message: `Failed to revert: ${String(err)}` });
    }
  }, [workDir, fetchDiff, confirmRevert]);

  useEffect(() => {
    if (!confirmRevert) return;
    const timer = setTimeout(() => setConfirmRevert(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmRevert]);

  useEffect(() => {
    if (!commitResult) return;
    const timer = setTimeout(() => setCommitResult(null), 4000);
    return () => clearTimeout(timer);
  }, [commitResult]);

  useEffect(() => {
    if (!genError) return;
    const timer = setTimeout(() => setGenError(null), 4000);
    return () => clearTimeout(timer);
  }, [genError]);

  const allFiles = useMemo(() => parseDiffFiles(diff), [diff]);
  const totalAdditions = allFiles.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = allFiles.reduce((s, f) => s + f.deletions, 0);
  const allExpanded = allFiles.length > 0 && expandedPaths.size === allFiles.length;
  const grouped = useMemo(() => groupFilesByDir(allFiles), [allFiles]);
  const groupKeys = useMemo(
    () => Object.keys(grouped).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b))),
    [grouped],
  );

  const collapseAll = useCallback(() => setExpandedPaths(new Set()), []);
  const expandAll = useCallback(() => setExpandedPaths(new Set(allFiles.map((f) => f.path))), [allFiles]);

  useEffect(() => {
    if (diffLayout === "scroll" && allFiles.length > 0) {
      // Scroll layout = every diff open.
      setExpandedPaths(new Set(allFiles.map((f) => f.path)));
    } else if (diffLayout === "dropdown") {
      // Dropdown defaults collapsed. Keep only expansions that still exist
      // after a refetch (do not re-open every card).
      setExpandedPaths((prev) => {
        if (prev.size === 0) return prev;
        const valid = new Set(allFiles.map((f) => f.path));
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          if (valid.has(p)) next.add(p);
          else changed = true;
        }
        return changed ? next : prev;
      });
    }
  }, [diffLayout, allFiles]);

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
  }, []);

  const hasSuspicious = allFiles.some((f) => isSuspicious(f.path));

  // Active file for stacked / strip single-selection layouts.
  // Stacked: starts unselected; clicking toggles (list expands to fill when none selected).
  // Strip: always has a selection — auto-preselects the first file.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  useEffect(() => {
    if (activeFilePath && !allFiles.some((f) => f.path === activeFilePath)) {
      setActiveFilePath(null);
      return;
    }
    if (diffLayout === "strip" && !activeFilePath && allFiles.length > 0) {
      setActiveFilePath(allFiles[0].path);
    }
  }, [allFiles, activeFilePath, diffLayout]);
  const activeFile = useMemo(
    () => (activeFilePath ? allFiles.find((f) => f.path === activeFilePath) ?? null : null),
    [allFiles, activeFilePath],
  );
  const toggleActiveFile = useCallback((path: string) => {
    setActiveFilePath((prev) => (prev === path ? null : path));
  }, []);

  // Layout default is informational only; actual width is user-controlled via drag.
  void GIT_PANEL_WIDTH_BY_LAYOUT;

  // ── Render guards ──────────────────────────────────────────
  if (!mounted) return null;

  const panelWrapper = (inner: React.ReactNode) => (
    <div
      className="relative flex h-full overflow-hidden"
      style={{
        width: isOpen ? panelWidth : 0,
        opacity: isOpen ? 1 : 0,
        transition: resizing
          ? "opacity 200ms ease"
          : "width 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease",
        willChange: transitioning ? "width" : undefined,
      }}
    >
      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleResizeMouseDown}
          className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60"
          style={{ background: resizing ? "rgba(59,130,246,0.6)" : undefined }}
        />
      )}
      <div
        className="codex-glass flex h-full flex-col border-l"
        style={{ width: panelWidth, borderColor: "var(--glass-border)" }}
      >
        {inner}
      </div>
    </div>
  );

  if (checkingRepo || isGitRepo === null) {
    return panelWrapper(
      <>
        <div
          className="chrome-sheen hairline-b flex items-center gap-2 px-3 py-2.5"
          style={{ background: "var(--glass-header)" }}
        >
          <GitBranch size={13} className="text-zinc-500" />
          <span className="text-[13px] font-medium text-zinc-200">Changes</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            <span>Detecting repository...</span>
          </div>
        </div>
      </>,
    );
  }

  if (!isGitRepo) {
    return panelWrapper(
      <>
        <div
          className="chrome-sheen hairline-b flex items-center gap-2 px-3 py-2.5"
          style={{ background: "var(--glass-header)" }}
        >
          <GitBranch size={13} className="text-zinc-500" />
          <span className="text-[13px] font-medium text-zinc-200">Initialize Repository</span>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-4">
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            This directory is not a git repository. Initialize one and optionally publish to a remote.
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Git Account</label>
              <select
                value={selectedAccountIndex}
                onChange={(e) => setSelectedAccountIndex(Number(e.target.value))}
                className="w-full rounded-md bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-blue-500/40"
              >
                <option value={-1}>None (default SSH)</option>
                {gitAccounts.map((acc, i) => (
                  <option key={i} value={i}>
                    {acc.name} ({acc.gitUser})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Remote URL</label>
              <input
                type="text"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="git@github.com:user/repo.git"
                className="w-full rounded-md bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/40"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Default Branch</label>
              <input
                type="text"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="master"
                className="w-full rounded-md bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-blue-500/40"
              />
            </div>
          </div>
          <AnimatePresence>
            {publishResult && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className={`rounded-md px-3 py-2 text-[12px] ${
                  publishResult.success ? "bg-[var(--accent-dim)] text-[color:var(--accent)]" : "bg-red-500/10 text-red-400"
                }`}
              >
                {publishResult.message}
              </motion.div>
            )}
          </AnimatePresence>
          <button
            onClick={handleInitAndPublish}
            disabled={!remoteUrl.trim() || publishing}
            className="flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-[12px] font-medium text-[#14110a] hover:brightness-110 disabled:opacity-40 transition-colors"
          >
            {publishing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            <span>Initialize & Publish</span>
          </button>
        </div>
      </>,
    );
  }

  // ── Main panel ────────────────────────────────────────────
  return panelWrapper(
    <>
      {showConfirm && (
        <PushConfirmDialog
          action={commitAction}
          commitMessage={commitMessage}
          files={allFiles}
          onConfirm={runCommitAction}
          onCancel={() => setShowConfirm(false)}
          busy={committing}
          hasUpstream={hasUpstream}
        />
      )}

      {/* Title row */}
      <div className="hairline-b flex items-center gap-2 px-3 py-2.5">
        <Eyebrow>
          {viewMode === "branch" ? "Worktree" : viewMode === "staged" ? "Staged" : viewMode === "committed" ? "Committed" : "Changed"}
        </Eyebrow>
        <ViewModeDropdown value={viewMode} onChange={setViewMode} fileCount={allFiles.length} />
        <div className="flex-1" />
        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
            {totalAdditions > 0 && <span style={{ color: "var(--status-green)" }}>+{totalAdditions}</span>}
            {totalDeletions > 0 && <span style={{ color: "var(--status-red)" }}>-{totalDeletions}</span>}
            <DiffBar add={totalAdditions} del={totalDeletions} width={36} />
          </span>
        )}
        <button
          onClick={fetchDiff}
          disabled={loading}
          className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          onClick={() => (allExpanded ? collapseAll() : expandAll())}
          className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors"
          title={allExpanded ? "Collapse all" : "Expand all"}
        >
          {allExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {/* Layout switcher row */}
      <div className="hairline-b flex items-center gap-2 px-3 py-1.5">
        <span
          className="shrink-0 uppercase"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--text-muted)",
            letterSpacing: "0.2em",
          }}
        >
          Layout
        </span>
        <LayoutSwitcher value={diffLayout} onChange={setDiffLayout} />
      </div>

      {/* Branch row */}
      {branch && (
        <div className="px-3 py-2 hairline-b flex flex-col gap-1">
          <div className="flex items-center gap-2 min-w-0">
            <GitBranch size={12} className="shrink-0 text-amber-400/80" />
            <button
              onClick={handleCopyBranch}
              className="flex-1 min-w-0 truncate text-left font-mono text-[12px] text-zinc-300 hover:text-zinc-100 transition-colors"
              title={`Copy "${branch}"`}
            >
              {branch}
            </button>
            <button
              onClick={handleCopyBranch}
              className="shrink-0 p-0.5 rounded text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors"
              aria-label="Copy branch name"
            >
              {copiedBranch ? <Check size={11} className="text-[color:var(--accent)]" /> : <Copy size={11} />}
            </button>
            <BranchSwitcher workDir={workDir} current={branch} onSwitched={fetchDiff} />
          </div>
          {(ahead > 0 || behind > 0) && (
            <div className="flex items-center gap-1.5 pl-[18px]">
              {ahead > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-dim)] border border-[color:var(--accent-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--accent)]"
                  title={`${ahead} local commit${ahead === 1 ? "" : "s"} to push`}
                >
                  <ArrowUp size={9} />
                  {ahead}
                </span>
              )}
              {behind > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 border border-sky-500/30 px-1.5 py-0.5 font-mono text-[10px] text-sky-300"
                  title={`${behind} upstream commit${behind === 1 ? "" : "s"} to pull`}
                >
                  <ArrowDown size={9} />
                  {behind}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Suspicious banner */}
      {hasSuspicious && (
        <div className="mx-3 mt-2 mb-1 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span>Sensitive filenames detected in changes.</span>
        </div>
      )}

      {/* File list — per layout */}
      {allFiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 py-10 text-center">
          {loading ? (
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <Loader2 size={12} className="animate-spin" />
              <span>Loading changes...</span>
            </div>
          ) : (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] inner-ring">
                <Check size={14} className="text-zinc-500" />
              </div>
              <p className="text-[12px] text-zinc-500">Working tree clean</p>
            </>
          )}
        </div>
      ) : diffLayout === "dropdown" ? (
        <div className="flex-1 overflow-y-auto pt-1">
          {allFiles.map((file) => (
            <WarpFileCard
              key={file.path}
              file={file}
              expanded={expandedPaths.has(file.path)}
              onToggle={() => toggleExpanded(file.path)}
              onStage={viewMode === "unstaged" ? handleStageFile : undefined}
              onCopyPath={copyPath}
            />
          ))}
        </div>
      ) : diffLayout === "stacked" ? (
        <div className="flex flex-1 min-h-0 flex-col">
          {/* Tree — fills full panel when no file selected, caps at 40% when a diff is showing */}
          <div
            className="overflow-y-auto"
            style={
              activeFile
                ? { maxHeight: "40%", minHeight: 120 }
                : { flex: 1, minHeight: 0 }
            }
          >
            {groupKeys.map((dir) => {
              const files = grouped[dir];
              const collapsed = collapsedDirs.has(dir);
              const dirAdded = files.reduce((s, f) => s + f.additions, 0);
              const dirRemoved = files.reduce((s, f) => s + f.deletions, 0);
              return (
                <div key={dir}>
                  <button
                    onClick={() => toggleDir(dir)}
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.03] transition-colors"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {collapsed ? (
                      <ChevronRight size={11} className="text-zinc-600" />
                    ) : (
                      <ChevronDown size={11} className="text-zinc-600" />
                    )}
                    <FolderGit2 size={11} className="text-zinc-500" />
                    <span className="flex-1 min-w-0 truncate text-left">
                      {dir === "/" ? "(root)" : dir}
                    </span>
                    <span className="text-zinc-600">{files.length}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
                      {dirAdded > 0 && <span style={{ color: "var(--status-green)", opacity: 0.8 }}> +{dirAdded}</span>}
                      {dirRemoved > 0 && <span style={{ color: "var(--status-red)", opacity: 0.8 }}> −{dirRemoved}</span>}
                    </span>
                  </button>
                  {!collapsed &&
                    files.map((file) => {
                      const active = file.path === activeFilePath;
                      return (
                        <button
                          key={file.path}
                          onClick={() => toggleActiveFile(file.path)}
                          className="w-full flex items-center gap-2 pl-6 pr-2 py-1.5 text-left transition-colors"
                          style={{
                            background: active ? "var(--accent-dim)" : "transparent",
                            borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                          }}
                        >
                          <StatusMark status={file.status} size={13} />
                          <span className="min-w-0 flex-1 truncate" title={file.path}>
                            <PathCrumbs path={file.path.split("/").pop() ?? file.path} size={11.5} />
                          </span>
                          <span
                            className="shrink-0 tabular-nums"
                            style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
                          >
                            {file.additions > 0 && (
                              <span style={{ color: "var(--status-green)", opacity: 0.9 }}>+{file.additions}</span>
                            )}
                            {file.additions > 0 && file.deletions > 0 && (
                              <span className="text-zinc-600"> </span>
                            )}
                            {file.deletions > 0 && (
                              <span style={{ color: "var(--status-red)", opacity: 0.9 }}>−{file.deletions}</span>
                            )}
                            {file.additions === 0 && file.deletions === 0 && (
                              <span className="text-zinc-600">0</span>
                            )}
                          </span>
                          <DiffBar add={file.additions} del={file.deletions} width={22} />
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </div>
          {activeFile && (
            <>
              <div
                className="shrink-0"
                style={{ height: 1, background: "var(--glass-border)" }}
              />
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-2 px-3 py-2 bg-black/30 hairline-b">
                  <StatusMark status={activeFile.status} size={14} />
                  <span className="min-w-0 flex-1 truncate" title={activeFile.path}>
                    <PathCrumbs path={activeFile.path} size={12} />
                  </span>
                  <DiffStats additions={activeFile.additions} deletions={activeFile.deletions} />
                </div>
                <div className="flex-1 overflow-y-auto">
                  <DiffViewer rawDiff={activeFile.rawDiff} />
                </div>
              </div>
            </>
          )}
        </div>
      ) : diffLayout === "strip" ? (
        <div className="flex flex-1 min-h-0 flex-col">
          {/* Chip strip */}
          <div
            className="shrink-0 overflow-x-auto hairline-b"
            style={{ background: "rgba(0,0,0,0.15)" }}
          >
            <div className="flex items-center gap-1.5 px-3 py-2">
              {allFiles.map((file) => {
                const active = file.path === activeFilePath;
                return (
                  <button
                    key={file.path}
                    onClick={() => setActiveFilePath(file.path)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors"
                    style={{
                      background: active ? "var(--accent-dim)" : "rgba(255,255,255,0.02)",
                      border: `1px solid ${active ? "var(--accent-border)" : "var(--glass-border)"}`,
                    }}
                  >
                    <StatusMark status={file.status} size={12} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        color: active ? "var(--text-primary, #fff)" : "var(--text-secondary, #e4e4e7)",
                      }}
                    >
                      {file.path.split("/").pop()}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-green)" }}>
                      +{file.additions}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-red)" }}>
                      −{file.deletions}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {/* Selected diff */}
          <div className="flex min-h-0 flex-1 flex-col">
            {activeFile ? (
              <>
                <div className="flex items-center gap-2 px-3 py-2 bg-black/30 hairline-b">
                  <StatusMark status={activeFile.status} size={14} />
                  <span className="min-w-0 flex-1 truncate" title={activeFile.path}>
                    <PathCrumbs path={activeFile.path} size={12} />
                  </span>
                  <DiffStats additions={activeFile.additions} deletions={activeFile.deletions} />
                </div>
                <div className="flex-1 overflow-y-auto">
                  <DiffViewer rawDiff={activeFile.rawDiff} />
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        /* scroll: jump rail + always-open cards */
        <div className="flex flex-1 min-h-0">
          {/* Rail */}
          <div
            className="shrink-0 overflow-y-auto"
            style={{
              width: 148,
              borderRight: "1px solid var(--glass-border)",
              background: "rgba(0,0,0,0.20)",
            }}
          >
            <div
              className="px-3 py-2 uppercase"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--text-muted)",
                letterSpacing: "0.2em",
              }}
            >
              Jump to
            </div>
            {allFiles.map((file, i) => {
              const active = file.path === activeFilePath;
              return (
                <button
                  key={file.path}
                  onClick={() => {
                    const willDeselect = activeFilePath === file.path;
                    toggleActiveFile(file.path);
                    if (!willDeselect) {
                      document
                        .getElementById(`diff-card-${i}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                  style={{
                    background: active ? "var(--accent-dim)" : "transparent",
                    borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                  }}
                >
                  <span
                    className="shrink-0 text-right"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9.5,
                      color: "var(--text-muted)",
                      minWidth: 14,
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <StatusMark status={file.status} size={11} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: active ? "var(--text-primary, #fff)" : "var(--text-tertiary, #a1a1aa)",
                    }}
                  >
                    {file.path.split("/").pop()}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Cards */}
          <div className="flex-1 overflow-y-auto p-2" style={{ background: "rgba(0,0,0,0.10)" }}>
            {allFiles.map((file, i) => (
              <div
                key={file.path}
                id={`diff-card-${i}`}
                className="mb-2 overflow-hidden rounded-lg"
                style={{
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid var(--glass-border)",
                }}
              >
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ background: "rgba(0,0,0,0.25)" }}
                >
                  <ChevronDown size={12} className="text-zinc-500" />
                  <StatusMark status={file.status} size={14} />
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    <PathCrumbs path={file.path} size={12} />
                  </span>
                  <DiffStats additions={file.additions} deletions={file.deletions} />
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--text-muted)",
                      minWidth: 50,
                      textAlign: "right",
                    }}
                  >
                    {parseHunks(file.rawDiff).length} hunks
                  </span>
                </div>
                <div style={{ background: "var(--surface-code-panel)" }}>
                  <DiffViewer rawDiff={file.rawDiff} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom action bar */}
      {(allFiles.length > 0 || commitMessage.trim()) && (
        <div className="hairline-t px-3 py-2.5 space-y-2">
          {/* Commit message */}
          <div className="relative">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message..."
              rows={2}
              className="w-full bg-white/[0.04] rounded-md px-2.5 py-2 pr-8 text-[12px] text-zinc-100 placeholder:text-zinc-600 outline-none border border-white/[0.06] resize-none focus:border-blue-500/40 focus:bg-white/[0.06] transition-colors"
            />
            <button
              onClick={handleGenerateMessage}
              disabled={generatingMsg || !hasChanges}
              className="absolute top-1.5 right-1.5 rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-sky-400 transition-colors disabled:opacity-40"
              title="Generate commit message with AI"
            >
              {generatingMsg ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            </button>
          </div>

          {/* Options */}
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-zinc-300 transition-colors">
              <input
                type="checkbox"
                checked={includeUnstaged}
                onChange={(e) => setIncludeUnstaged(e.target.checked)}
                className="h-3 w-3 accent-[var(--accent)]"
              />
              <span>Include unstaged</span>
            </label>
            <span className="font-mono">
              {allFiles.length} file{allFiles.length !== 1 ? "s" : ""}
            </span>
          </div>

          <AnimatePresence>
            {(commitResult || genError) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className={`overflow-hidden rounded-md px-2.5 py-1.5 text-[11px] ${
                  genError
                    ? "bg-red-500/10 text-red-400"
                    : commitResult?.success
                      ? "bg-[var(--accent-dim)] text-[color:var(--accent)]"
                      : "bg-red-500/10 text-red-400"
                }`}
              >
                {genError ?? commitResult?.message}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Primary split button */}
          <CommitActionButton
            action={commitAction}
            onAction={() => {
              if (!commitMessage.trim() || committing || !hasChanges) return;
              setShowConfirm(true);
            }}
            onActionChange={setCommitAction}
            disabled={!commitMessage.trim() || committing || !hasChanges}
            busy={committing}
            label={commitActionLabel(commitAction, hasUpstream)}
            hasUpstream={hasUpstream}
          />

          {/* Secondary actions (only for unstaged view) */}
          {viewMode === "unstaged" && allFiles.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleStageAll}
                title="Stage all"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-zinc-400 hover:border-[color:var(--accent-border)] hover:bg-[var(--accent-dim)] hover:text-[color:var(--accent)] transition-all"
              >
                <Plus size={11} />
                <span>Stage all</span>
              </button>
              <button
                onClick={handleRevertAll}
                title={confirmRevert ? "Click again to confirm" : "Revert all unstaged"}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] transition-all ${
                  confirmRevert
                    ? "border-red-500/40 bg-red-500/15 text-red-400 animate-pulse"
                    : "border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                }`}
              >
                <RotateCcw size={11} />
                <span>{confirmRevert ? "Confirm" : "Revert all"}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </>,
  );
}
