import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CircleDot,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  countGithubOpenIssues,
  discoverProjectGithubRepos,
  formatIssueRelativeTime,
  formatOpenIssueCount,
  githubAuthStatus,
  listGithubIssues,
  loadExtraTrackedRepos,
  loadLastIssuesRepo,
  saveExtraTrackedRepos,
  saveLastIssuesRepo,
  splitRepoSlug,
  type GithubAuthStatus,
  type GithubIssue,
  type GithubIssueState,
  type ProjectGithubRepo,
} from "../../lib/githubCommands";
import {
  dispatchGithubIssue,
  ISSUES_DISPATCH_PROVIDERS,
  resolveIssuesDispatchProvider,
  type IssuesDispatchProvider,
} from "../../lib/dispatchGithubIssue";
import { ProviderModelDropdown } from "./ProviderModelDropdown";
import { EmptyState } from "../ui/panel";
import {
  mergeCodexModelOptions,
  prettifyCodexModelName,
  type CodexModelOption,
  type Provider,
} from "../../lib/types";

function LabelChip({ name, color }: { name: string; color?: string | null }) {
  const bg = color ? `#${color.replace(/^#/, "")}` : "rgba(255,255,255,0.08)";
  return (
    <span
      className="issues-label"
      style={{
        borderColor: color ? `${bg}66` : undefined,
        background: color ? `${bg}22` : undefined,
      }}
      title={name}
    >
      {name}
    </span>
  );
}

function RepoTabLabel({
  slug,
  openCount,
  projectName,
  /** When true, show owner as a compact `/owner` suffix (name collisions only). */
  showOwner = false,
}: {
  slug: string;
  openCount?: number | null;
  projectName?: string;
  showOwner?: boolean;
}) {
  const { owner, name } = splitRepoSlug(slug);
  const badge = formatOpenIssueCount(openCount);
  const pending = openCount === null || openCount === undefined;
  const title = [
    slug,
    projectName ? `Project: ${projectName}` : null,
    openCount != null ? `${openCount} open issue${openCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="issues-repo-tab-inner" title={title}>
      <span className="issues-repo-name">{name}</span>
      {showOwner && owner ? (
        <span className="issues-repo-owner">/{owner}</span>
      ) : null}
      {badge != null ? (
        <span className="issues-repo-count">{badge}</span>
      ) : pending ? (
        <span className="issues-repo-count issues-repo-count-pending" aria-hidden>
          ·
        </span>
      ) : null}
    </span>
  );
}

export function IssuesMainPanel() {
  const projects = useProjectStore((s) => s.projects);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const settings = useSettingsStore((s) => s.settings);
  const globalInstructions = settings.issuesDispatchInstructions ?? "";
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [auth, setAuth] = useState<GithubAuthStatus | null>(null);
  const [projectRepos, setProjectRepos] = useState<ProjectGithubRepo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [tracked, setTracked] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<GithubIssueState>("open");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GithubIssue | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [addRepoValue, setAddRepoValue] = useState("");
  /** One-off notes for the currently selected issue (cleared on issue change). */
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [showGlobalEditor, setShowGlobalEditor] = useState(false);
  /** Open issue counts keyed by owner/repo. null = loading/failed. */
  const [openCounts, setOpenCounts] = useState<Record<string, number | null>>({});
  /** Dispatch target: Claude / Codex / OpenCode / Grok only. */
  const [dispatchProvider, setDispatchProvider] = useState<IssuesDispatchProvider>(() =>
    resolveIssuesDispatchProvider(settings.defaultProvider),
  );
  const [dispatchModel, setDispatchModel] = useState<string | null>(
    () => settings.lastUsedModel?.trim() || "sonnet",
  );
  const [preferWorktree, setPreferWorktree] = useState(true);
  const [codexDynamicModels, setCodexDynamicModels] = useState<CodexModelOption[]>([]);
  const [opencodeModels, setOpencodeModels] = useState<
    { slug: string; name: string; connected?: boolean; variants?: string[] }[]
  >([]);

  useEffect(() => {
    if (projects.length === 0) void fetchProjects().catch(console.error);
  }, [projects.length, fetchProjects]);

  // Scan every agmux project for a linked GitHub remote → repo tabs.
  useEffect(() => {
    if (projects.length === 0) {
      setProjectRepos([]);
      setTracked([]);
      setActiveRepo(null);
      setOpenCounts({});
      return;
    }
    let cancelled = false;
    setScanning(true);
    const projectIds = projects.map((p) => p.id);
    const extras = loadExtraTrackedRepos(projectIds);
    setTracked(extras);
    const last = loadLastIssuesRepo();

    void discoverProjectGithubRepos(projects)
      .then((repos) => {
        if (cancelled) return;
        setProjectRepos(repos);
        setActiveRepo((prev) => {
          if (prev && (repos.some((r) => r.slug === prev) || extras.includes(prev))) {
            return prev;
          }
          // Prefer last picked tab, then UI-selected project remote, then first.
          if (last && (repos.some((r) => r.slug === last) || extras.includes(last))) {
            return last;
          }
          const preferred = repos.find((r) => r.projectId === selectedProjectId);
          return preferred?.slug ?? repos[0]?.slug ?? extras[0] ?? null;
        });
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });

    return () => {
      cancelled = true;
    };
    // selectedProjectId only seeds the initial active tab preference.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-scan when project list identity changes
  }, [projects]);

  // Persist last-picked repo so reopen lands on the same tab.
  useEffect(() => {
    if (activeRepo) saveLastIssuesRepo(activeRepo);
  }, [activeRepo]);

  // Fetch open-issue counts for every visible repo tab (parallel).
  useEffect(() => {
    const slugs = [
      ...projectRepos.map((r) => r.slug),
      ...tracked.filter((s) => !projectRepos.some((r) => r.slug === s)),
    ];
    if (slugs.length === 0) {
      setOpenCounts({});
      return;
    }
    let cancelled = false;
    // Mark pending for new slugs without wiping known counts.
    setOpenCounts((prev) => {
      const next = { ...prev };
      for (const s of slugs) {
        if (!(s in next)) next[s] = null;
      }
      return next;
    });

    void Promise.all(
      slugs.map(async (slug) => {
        const linked = projectRepos.find((r) => r.slug === slug);
        try {
          const n = await countGithubOpenIssues({
            repo: slug,
            repoPath: linked?.repoPath ?? null,
          });
          return [slug, n] as const;
        } catch {
          return [slug, null] as const;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setOpenCounts((prev) => {
        const next = { ...prev };
        for (const [slug, n] of rows) next[slug] = n;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [projectRepos, tracked]);

  const projectRepoBySlug = useMemo(() => {
    const m = new Map<string, ProjectGithubRepo>();
    for (const r of projectRepos) m.set(r.slug, r);
    return m;
  }, [projectRepos]);

  /** Repo names that appear under more than one owner — show `/owner` suffix on those tabs. */
  const ambiguousRepoNames = useMemo(() => {
    const counts = new Map<string, number>();
    const mark = (slug: string) => {
      const { name } = splitRepoSlug(slug);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    for (const r of projectRepos) mark(r.slug);
    for (const slug of tracked) {
      if (!projectRepoBySlug.has(slug)) mark(slug);
    }
    const amb = new Set<string>();
    for (const [name, n] of counts) {
      if (n > 1) amb.add(name);
    }
    return amb;
  }, [projectRepos, tracked, projectRepoBySlug]);

  /**
   * Dispatch requires a real linked project checkout for the active tab.
   * Extra tracked remotes without a local project are list-only.
   */
  const activeProjectContext = useMemo(() => {
    if (!activeRepo) return null;
    const linked = projectRepoBySlug.get(activeRepo);
    if (!linked) return null;
    return {
      projectId: linked.projectId,
      repoPath: linked.repoPath,
      slug: linked.slug,
      projectName: linked.projectName,
      isLinkedProject: true as const,
    };
  }, [activeRepo, projectRepoBySlug]);

  const canDispatch = !!activeProjectContext && !!selected;

  // Prefetch Codex / OpenCode model catalogs for the picker when a linked project is active.
  useEffect(() => {
    const repoPath = activeProjectContext?.repoPath;
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const { codexEnsureServer, codexListModels } = await import("../../lib/commands");
        await codexEnsureServer(repoPath);
        const resp = await codexListModels(repoPath);
        if (cancelled) return;
        const rec = resp as Record<string, unknown>;
        const items = Array.isArray(rec.data) ? rec.data : Array.isArray(rec) ? rec : [];
        const models: CodexModelOption[] = items
          .map((item: unknown) => {
            if (!item || typeof item !== "object") return null;
            const r = item as Record<string, unknown>;
            const slug = String(r.model ?? r.id ?? "");
            // Ignore server displayName — often "GPT-5.6-Sol"; prettify from slug.
            const name = prettifyCodexModelName(slug);
            return slug ? { slug, name } : null;
          })
          .filter((m): m is CodexModelOption => m !== null);
        setCodexDynamicModels(mergeCodexModelOptions(models));
      } catch {
        /* live list empty → curated fallback */
      }
    })();
    void (async () => {
      try {
        const { opencodeSdk } = await import("../../lib/opencodeSdkCommands");
        try {
          await opencodeSdk.initializeBridge({});
        } catch {
          /* retry next open */
        }
        if (cancelled) return;
        const result = await opencodeSdk.listModels(repoPath);
        if (cancelled) return;
        if (result?.models?.length) setOpencodeModels(result.models);
      } catch {
        /* curated list fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectContext?.repoPath]);

  const refreshAuth = useCallback(async () => {
    try {
      const s = await githubAuthStatus();
      setAuth(s);
    } catch (e) {
      setAuth({
        ok: false,
        loggedIn: false,
        message: String(e),
      });
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  const loadIssues = useCallback(async () => {
    if (!activeRepo) {
      setIssues([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const linked = projectRepoBySlug.get(activeRepo);
      let list: GithubIssue[];
      if (linked) {
        list = await listGithubIssues({
          repoPath: linked.repoPath,
          repo: linked.slug,
          state: stateFilter,
          limit: 50,
        });
      } else {
        // Extra tracked remote — list via gh --repo without a local cwd.
        list = await listGithubIssues({
          repo: activeRepo,
          state: stateFilter,
          limit: 50,
        });
      }
      list = list.map((i) => ({ ...i, repository: i.repository ?? activeRepo }));
      setIssues(list);
      if (stateFilter === "open") {
        void countGithubOpenIssues({
          repo: activeRepo,
          repoPath: linked?.repoPath ?? null,
        })
          .then((n) => {
            setOpenCounts((prev) => ({ ...prev, [activeRepo]: n }));
          })
          .catch(() => {
            /* keep prior badge */
          });
      }
    } catch (e) {
      setIssues([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeRepo, projectRepoBySlug, stateFilter]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  useEffect(() => {
    setSelected(null);
    setSpecialInstructions("");
    setDispatchError(null);
  }, [activeRepo]);

  const selectIssue = (issue: GithubIssue) => {
    setSelected(issue);
    setSpecialInstructions("");
    setDispatchError(null);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter((i) => {
      if (`#${i.number}`.includes(q)) return true;
      if (i.title.toLowerCase().includes(q)) return true;
      if (i.labels.some((l) => l.name.toLowerCase().includes(q))) return true;
      if (i.assignees.some((a) => a.login.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [issues, query]);

  const handleAddRepo = () => {
    const slug = addRepoValue
      .trim()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    if (!slug.includes("/") || slug.split("/").length !== 2) {
      setError("Repo must look like owner/repo");
      return;
    }
    if (projectRepoBySlug.has(slug) || tracked.includes(slug)) {
      setAddRepoOpen(false);
      setAddRepoValue("");
      selectRepo(slug);
      return;
    }
    const next = [...tracked, slug];
    setTracked(next);
    saveExtraTrackedRepos(next);
    setAddRepoOpen(false);
    setAddRepoValue("");
    selectRepo(slug);
  };

  const handleRemoveTracked = (slug: string) => {
    const next = tracked.filter((r) => r !== slug);
    setTracked(next);
    saveExtraTrackedRepos(next);
    if (activeRepo === slug) {
      setActiveRepo(projectRepos[0]?.slug ?? next[0] ?? null);
    }
  };

  const handleProviderSelect = useCallback(
    (p: Provider, m: string | null) => {
      const next = resolveIssuesDispatchProvider(p);
      setDispatchProvider(next);
      if (m) setDispatchModel(m);
      // Persist as last-used so chat and Issues stay aligned.
      if (m) {
        updateSettings({
          lastUsedModel: m,
          ...(next === "Codex" ? { codexModel: m } : {}),
          ...(next === "OpenCode"
            ? {
                opencodeRecentModels: [
                  m,
                  ...(settings.opencodeRecentModels ?? []).filter((s) => s !== m),
                ].slice(0, 10),
              }
            : {}),
        });
      }
    },
    [settings.opencodeRecentModels, updateSettings],
  );

  const handleDispatch = async (issue: GithubIssue) => {
    if (!activeProjectContext) {
      setDispatchError(
        "This repository is not linked to an agmux project folder. Add the project so the agent has a local checkout, then dispatch.",
      );
      return;
    }
    if (auth && !auth.loggedIn) {
      setDispatchError(
        `${auth.message || "GitHub CLI not authenticated."} Run \`gh auth login\` then refresh.`,
      );
      return;
    }
    setDispatching(true);
    setDispatchError(null);
    try {
      await dispatchGithubIssue({
        projectId: activeProjectContext.projectId,
        repoPath: activeProjectContext.repoPath,
        projectRepo: issue.repository ?? activeProjectContext.slug,
        issue,
        provider: dispatchProvider,
        model: dispatchModel,
        specialInstructions,
        preferWorktree,
      });
    } catch (e) {
      setDispatchError(String(e));
    } finally {
      setDispatching(false);
    }
  };

  const refreshRepos = () => {
    const projectIds = projects.map((p) => p.id);
    const extras = loadExtraTrackedRepos(projectIds);
    const last = loadLastIssuesRepo();
    setTracked(extras);
    setScanning(true);
    void discoverProjectGithubRepos(projects)
      .then((repos) => {
        setProjectRepos(repos);
        setActiveRepo((prev) => {
          if (prev && (repos.some((r) => r.slug === prev) || extras.includes(prev))) {
            return prev;
          }
          if (last && (repos.some((r) => r.slug === last) || extras.includes(last))) {
            return last;
          }
          return repos[0]?.slug ?? extras[0] ?? null;
        });
        // Force count refresh by clearing.
        setOpenCounts({});
      })
      .finally(() => {
        setScanning(false);
        void loadIssues();
      });
  };

  const selectRepo = (slug: string) => {
    setActiveRepo(slug);
    saveLastIssuesRepo(slug);
  };

  const shell = (body: ReactNode) => (
    <div
      className="issues-root relative flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="issues-main-panel"
    >
      <div className="codex-wall" aria-hidden />
      <div className="codex-glass relative z-[1] flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    </div>
  );

  if (projects.length === 0) {
    return shell(
      <>
        <header className="orch-header issues-header" data-tauri-drag-region>
          <div className="flex items-center gap-2 min-w-0">
            <span className="orch-mark">
              <CircleDot size={14} strokeWidth={2} />
            </span>
            <h1 className="text-sm font-semibold text-[var(--text-primary)]">Issues</h1>
          </div>
        </header>
        <EmptyState
          icon={FolderGit2}
          headline="No projects yet"
          body="Issues lists the GitHub repos linked to your agmux projects. Add a project to get started."
        />
      </>,
    );
  }

  return shell(
    <>
      <header className="orch-header issues-header" data-tauri-drag-region>
        <div className="flex items-center gap-2 min-w-0">
          <span className="orch-mark">
            <CircleDot size={14} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-[var(--text-primary)]">Issues</h1>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {auth?.loggedIn && auth.login
                ? auth.login
                : scanning
                  ? "Scanning…"
                  : "GitHub"}
              {activeRepo ? ` · ${activeRepo}` : ""}
            </p>
          </div>
          {scanning && (
            <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1 ml-1">
              <Loader2 size={11} className="animate-spin" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="mem-refresh"
            onClick={() => refreshRepos()}
            disabled={loading || scanning}
            title="Refresh"
            aria-label="Refresh issues"
          >
            <RefreshCw size={13} className={loading || scanning ? "animate-spin" : undefined} />
          </button>
        </div>
      </header>

      <div className="issues-toolbar">
        <div className="issues-repo-tabs" role="tablist" aria-label="Repositories">
          {projectRepos.map((r) => (
            <button
              key={r.slug}
              type="button"
              role="tab"
              aria-selected={activeRepo === r.slug}
              data-active={activeRepo === r.slug ? "true" : "false"}
              className="issues-repo-tab"
              onClick={() => selectRepo(r.slug)}
            >
              <RepoTabLabel
                slug={r.slug}
                projectName={r.projectName}
                openCount={openCounts[r.slug]}
                showOwner={ambiguousRepoNames.has(splitRepoSlug(r.slug).name)}
              />
            </button>
          ))}
          {tracked
            .filter((slug) => !projectRepoBySlug.has(slug))
            .map((slug) => (
              <button
                key={slug}
                type="button"
                role="tab"
                aria-selected={activeRepo === slug}
                data-active={activeRepo === slug ? "true" : "false"}
                className="issues-repo-tab group"
                onClick={() => selectRepo(slug)}
              >
                <RepoTabLabel
                  slug={slug}
                  openCount={openCounts[slug]}
                  showOwner={ambiguousRepoNames.has(splitRepoSlug(slug).name)}
                />
                <span
                  role="button"
                  tabIndex={0}
                  className="issues-repo-remove"
                  title="Stop tracking"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveTracked(slug);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      handleRemoveTracked(slug);
                    }
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
          {addRepoOpen ? (
            <form
              className="issues-add-repo"
              onSubmit={(e) => {
                e.preventDefault();
                handleAddRepo();
              }}
            >
              <input
                autoFocus
                className="issues-input"
                placeholder="owner/repo"
                value={addRepoValue}
                onChange={(e) => setAddRepoValue(e.target.value)}
                onBlur={() => {
                  if (!addRepoValue.trim()) setAddRepoOpen(false);
                }}
              />
              <button
                type="submit"
                className="accent-bg accent-text accent-border shrink-0 cursor-default rounded-md border
                  px-2 py-0.5 transition-colors duration-150"
                style={{ fontSize: "var(--text-meta)" }}
              >
                Add
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="issues-repo-tab issues-repo-add"
              onClick={() => setAddRepoOpen(true)}
              title="Track another repo"
            >
              <Plus size={12} />
              Repo
            </button>
          )}
        </div>

        <div className="issues-filters">
          <div className="issues-search">
            <Search size={13} className="text-[var(--text-tertiary)]" />
            <input
              className="issues-input flex-1"
              placeholder="Filter issues…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="issues-select"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as GithubIssueState)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {auth && !auth.loggedIn && (
        <div className="issues-banner">
          <AlertCircle size={14} />
          <span>
            {auth.message || "GitHub CLI not authenticated."} Run{" "}
            <code className="font-mono text-[11px]">gh auth login</code> then refresh.
          </span>
        </div>
      )}

      {error && (
        <div className="issues-banner issues-banner-error">
          <AlertCircle size={14} />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {!scanning && projectRepos.length === 0 && tracked.length === 0 && (
        <div className="issues-banner">
          <AlertCircle size={14} />
          <span>
            No GitHub remotes found on your agmux projects. Open a project with a GitHub remote, or
            add a repo with + Repo.
          </span>
        </div>
      )}

      <div className="issues-body">
        <div className="issues-table-wrap">
          {loading && issues.length === 0 ? (
            <div className="orch-empty">
              <Loader2 size={20} className="animate-spin text-[var(--text-tertiary)]" />
              <p className="text-sm text-[var(--text-secondary)] mt-2">Loading issues…</p>
            </div>
          ) : !activeRepo ? (
            <EmptyState
              icon={FolderGit2}
              headline={scanning ? "Scanning for repositories…" : "No repository selected"}
              body={
                scanning
                  ? "Checking each project for a linked GitHub remote."
                  : "Pick a repository tab above, or track one by name."
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={error ? AlertCircle : CircleDot}
              headline={error ? "Could not load issues" : "No issues match"}
              body={
                error
                  ? "Check your GitHub sign-in and the repository name, then refresh."
                  : "Try a different search term or switch the open/closed filter."
              }
            />
          ) : (
            <table className="issues-table">
              <thead>
                <tr>
                  <th className="w-14">#</th>
                  <th>Title</th>
                  <th className="w-36">Labels</th>
                  <th className="w-28">Assignees</th>
                  <th className="w-20 text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((issue) => {
                  const isSel =
                    selected?.number === issue.number &&
                    (selected.repository ?? "") === (issue.repository ?? "");
                  return (
                    <tr
                      key={`${issue.repository ?? ""}#${issue.number}`}
                      data-selected={isSel ? "true" : "false"}
                      onClick={() => selectIssue(issue)}
                      onDoubleClick={() => {
                        // Only auto-dispatch when this repo is a linked project.
                        selectIssue(issue);
                        if (activeProjectContext) void handleDispatch(issue);
                      }}
                    >
                      <td className="issues-num font-mono text-[12px] text-[var(--text-tertiary)]">
                        {issue.number}
                      </td>
                      <td>
                        <div className="issues-title-cell">
                          <span className="issues-title-text">{issue.title}</span>
                          {issue.state?.toLowerCase() === "closed" && (
                            <span className="issues-state-closed">Closed</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="issues-labels">
                          {issue.labels.slice(0, 3).map((l) => (
                            <LabelChip key={l.name} name={l.name} color={l.color} />
                          ))}
                          {issue.labels.length > 3 && (
                            <span className="text-[10px] text-[var(--text-tertiary)]">
                              +{issue.labels.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-[12px] text-[var(--text-secondary)] truncate">
                        {issue.assignees.map((a) => a.login).join(", ") || "—"}
                      </td>
                      <td className="text-right text-[11px] tabular-nums text-[var(--text-tertiary)]">
                        {formatIssueRelativeTime(issue.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {selected && (
          <aside className="issues-detail">
            <div className="issues-detail-top">
              <div className="min-w-0">
                <div className="text-[11px] font-mono text-[var(--text-tertiary)]">
                  #{selected.number}
                  {selected.repository ? ` · ${selected.repository}` : ""}
                </div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)] mt-0.5 leading-snug">
                  {selected.title}
                </h2>
              </div>
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="mem-refresh shrink-0"
                title="Open on GitHub"
              >
                <ExternalLink size={13} />
              </a>
            </div>

            <div className="issues-labels mt-2">
              {selected.labels.map((l) => (
                <LabelChip key={l.name} name={l.name} color={l.color} />
              ))}
            </div>

            {selected.assignees.length > 0 && (
              <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
                Assignees: {selected.assignees.map((a) => a.login).join(", ")}
              </p>
            )}

            {(selected.body ?? "").trim() ? (
              <p className="issues-detail-body mt-3">
                {(selected.body ?? "").trim().slice(0, 480)}
                {(selected.body ?? "").trim().length > 480 ? "…" : ""}
              </p>
            ) : (
              <p className="issues-detail-body mt-3 text-[var(--text-tertiary)]">
                No description on the list row — full body is fetched from GitHub on dispatch.
              </p>
            )}

            {!activeProjectContext && (
              <div className="issues-banner issues-banner-error mt-3 !mx-0">
                <AlertCircle size={14} />
                <span className="min-w-0 break-words">
                  This remote isn&apos;t linked to an agmux project folder. You can browse issues,
                  but dispatch needs a local checkout — add the project first.
                </span>
              </div>
            )}

            {activeProjectContext && (
              <>
                <label className="issues-field-label mt-4">
                  Agent
                  <span className="issues-field-hint">model &amp; provider</span>
                </label>
                <div className="issues-dispatch-chrome">
                  <ProviderModelDropdown
                    provider={dispatchProvider}
                    model={dispatchModel}
                    onSelect={handleProviderSelect}
                    allowedProviders={ISSUES_DISPATCH_PROVIDERS}
                    codexModels={
                      codexDynamicModels.length > 0 ? codexDynamicModels : undefined
                    }
                    opencodeModels={opencodeModels.length > 0 ? opencodeModels : undefined}
                    opencodeRecents={settings.opencodeRecentModels}
                    collapsibleSections
                  />
                  <button
                    type="button"
                    className="issues-worktree-btn"
                    data-active={preferWorktree ? "true" : "false"}
                    onClick={() => setPreferWorktree((v) => !v)}
                    title={
                      preferWorktree
                        ? "Worktree isolation on — click for main checkout"
                        : "Working in main checkout — click for worktree"
                    }
                  >
                    {preferWorktree ? <GitBranch size={13} /> : <FolderGit2 size={13} />}
                    <span>{preferWorktree ? "Worktree" : "Local"}</span>
                  </button>
                </div>
                <p className="mt-1.5 text-[10.5px] text-[var(--text-tertiary)] leading-snug">
                  {activeProjectContext.projectName} ·{" "}
                  <span className="font-mono">{activeProjectContext.repoPath}</span>
                </p>

                <label className="issues-field-label mt-4">
                  Special instructions
                  <span className="issues-field-hint">this dispatch only</span>
                </label>
                <textarea
                  className="issues-textarea"
                  placeholder="e.g. Focus on the spinner path; don’t refactor unrelated modules."
                  value={specialInstructions}
                  onChange={(e) => setSpecialInstructions(e.target.value)}
                  rows={3}
                />

                <div className="mt-3 flex items-center justify-between gap-2">
                  <label className="issues-field-label m-0">
                    Default instructions
                    <span className="issues-field-hint">every dispatch</span>
                  </label>
                  <button
                    type="button"
                    className="issues-link-btn"
                    onClick={() => setShowGlobalEditor((v) => !v)}
                  >
                    {showGlobalEditor ? "Hide" : globalInstructions.trim() ? "Edit" : "Add"}
                  </button>
                </div>
                {!showGlobalEditor && globalInstructions.trim() ? (
                  <p className="issues-global-preview" title={globalInstructions}>
                    {globalInstructions.trim().slice(0, 140)}
                    {globalInstructions.trim().length > 140 ? "…" : ""}
                  </p>
                ) : null}
                {showGlobalEditor && (
                  <textarea
                    className="issues-textarea mt-1.5"
                    placeholder="Standing notes for all Issues dispatches (also in Settings → Issues)."
                    value={globalInstructions}
                    onChange={(e) =>
                      updateSettings({ issuesDispatchInstructions: e.target.value })
                    }
                    rows={3}
                  />
                )}

                <p className="mt-3 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                  Opens a new{" "}
                  <span className="text-[var(--text-secondary)]">{dispatchProvider}</span>{" "}
                  session with a structured issue brief
                  {preferWorktree ? " in a git worktree" : " on the main checkout"}. Double-click a
                  row to dispatch with these settings.
                </p>
              </>
            )}

            {dispatchError && (
              <div className="issues-banner issues-banner-error mt-3 !mx-0">
                <AlertCircle size={14} />
                <span className="min-w-0 break-words">{dispatchError}</span>
              </div>
            )}

            <button
              type="button"
              className="issues-dispatch-btn"
              disabled={dispatching || !canDispatch}
              onClick={() => void handleDispatch(selected)}
              title={
                !activeProjectContext
                  ? "Add this repo as an agmux project first"
                  : "Dispatch to agent"
              }
            >
              {dispatching ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {dispatching ? "Dispatching…" : "Dispatch to agent"}
            </button>
          </aside>
        )}
      </div>
    </>,
  );
}
