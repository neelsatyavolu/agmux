/**
 * Launch an agent-mode thread against a GitHub issue (worktree when supported).
 * Issues dispatch supports Claude / Codex / OpenCode / Grok only — no Kimi/MLX/Cursor.
 */
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { Provider } from "./types";
import {
  buildIssueDispatchPrompt,
  getGithubIssue,
  issueThreadName,
  type GithubIssue,
} from "./githubCommands";
import { codexAccessModeForPermission } from "./providers/initialPermissions";

/** Providers allowed from the Issues dispatch UI. */
export const ISSUES_DISPATCH_PROVIDERS = [
  "ClaudeCode",
  "Codex",
  "OpenCode",
  "Grok",
] as const satisfies readonly Provider[];

export type IssuesDispatchProvider = (typeof ISSUES_DISPATCH_PROVIDERS)[number];

export function isIssuesDispatchProvider(p: string): p is IssuesDispatchProvider {
  return (ISSUES_DISPATCH_PROVIDERS as readonly string[]).includes(p);
}

/** Map settings defaultProvider into the Issues allow-list. */
export function resolveIssuesDispatchProvider(
  preferred?: Provider | string | null,
): IssuesDispatchProvider {
  if (preferred && isIssuesDispatchProvider(preferred)) return preferred;
  return "ClaudeCode";
}

export interface DispatchGithubIssueArgs {
  projectId: string;
  /** Absolute path to the local checkout that owns this remote. Required. */
  repoPath: string;
  /** Project remote label (owner/repo) for prompt context. */
  projectRepo?: string | null;
  issue: GithubIssue;
  provider?: IssuesDispatchProvider | Provider;
  model?: string | null;
  /** Reasoning effort for Claude / Grok when applicable. */
  effort?: string | null;
  /** One-off instructions for this dispatch. */
  specialInstructions?: string | null;
  /**
   * Prefer an isolated worktree when the provider supports it.
   * Default true. OpenCode/Grok get a real git worktree; Claude uses Worktree mode
   * (SDK/CLI owns branch isolation); Codex always uses Worktree.
   */
  preferWorktree?: boolean;
}

export interface DispatchGithubIssueResult {
  sessionId: string;
  provider: IssuesDispatchProvider;
  workDir: string;
}

export async function dispatchGithubIssue(
  args: DispatchGithubIssueArgs,
): Promise<DispatchGithubIssueResult> {
  const settings = useSettingsStore.getState().settings;
  const provider = resolveIssuesDispatchProvider(args.provider ?? settings.defaultProvider);
  const worktreeRoot = settings.worktreeRoot || undefined;
  const preferWorktree = args.preferWorktree !== false;

  if (!args.repoPath?.trim()) {
    throw new Error(
      "No local project folder for this repository. Add the repo as an agmux project first.",
    );
  }

  // Refresh body for dispatch context — hard-fail if we have no usable description.
  let issue = args.issue;
  let bodyFetchNote: string | null = null;
  try {
    issue = await getGithubIssue({
      number: args.issue.number,
      repoPath: args.repoPath,
      repo: args.issue.repository ?? args.projectRepo ?? null,
    });
  } catch (e) {
    const hasBody = !!(args.issue.body ?? "").trim();
    if (!hasBody) {
      throw new Error(
        `Could not load issue #${args.issue.number} from GitHub (${String(e)}). ` +
          "Check `gh auth login`, then try again.",
      );
    }
    bodyFetchNote =
      `Could not refresh the full issue from GitHub (${String(e)}). ` +
      "Using the list summary — description may be incomplete.";
  }

  const specialParts = [args.specialInstructions, bodyFetchNote].filter(
    (s): s is string => !!(s && s.trim()),
  );
  const prompt = buildIssueDispatchPrompt(issue, {
    repoLabel: args.projectRepo ?? issue.repository,
    globalInstructions: settings.issuesDispatchInstructions ?? "",
    specialInstructions: specialParts.join("\n\n") || null,
  });
  const name = issueThreadName(issue);
  const addThread = useThreadStore.getState().addThread;
  const selectThread = useUiStore.getState().selectThread;
  const selectClaudeSession = useUiStore.getState().selectClaudeSession;
  const selectCodexSession = useUiStore.getState().selectCodexSession;

  const modelArg = args.model?.trim() || null;
  const effortArg = args.effort?.trim() || null;

  // ── Claude (SDK chat) ─────────────────────────────────────────
  if (provider === "ClaudeCode") {
    const model =
      modelArg ||
      settings.lastUsedModel?.trim() ||
      "sonnet";
    const thread = await addThread({
      projectId: args.projectId,
      name,
      provider: "ClaudeCode",
      model,
      reasoningEffort: effortArg || settings.lastUsedEffort || undefined,
      workMode: preferWorktree ? "Worktree" : "DirectRepo",
      worktreeRoot,
      interactionMode: "sdk",
    });
    useUiStore.getState().setPendingFirstMessage(thread.id, prompt);
    useUiStore.getState().setPendingSdkPermissionMode(
      thread.id,
      settings.sdkPermissionMode === "full"
        ? "bypassPermissions"
        : settings.sdkPermissionMode === "auto"
          ? "auto"
          : "default",
    );
    const workDir = thread.work_dir || args.repoPath;
    selectClaudeSession(thread.id, workDir, true, name);
    return { sessionId: thread.id, provider, workDir };
  }

  // ── Codex (app-server chat; always worktree for isolation) ────
  if (provider === "Codex") {
    const codexModel =
      modelArg || settings.codexModel?.trim() || settings.lastUsedModel?.trim() || null;
    const thread = await addThread({
      projectId: args.projectId,
      name,
      provider: "Codex",
      model: codexModel || undefined,
      workMode: "Worktree",
      worktreeRoot,
    });
    const cwd = thread.work_dir || args.repoPath;
    const { codexEnsureServer, codexStartThread, codexSendMessage } = await import("./commands");
    await codexEnsureServer(cwd);
    const result = (await codexStartThread(cwd, codexModel)) as {
      thread?: { id?: string };
    };
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("Failed to create Codex thread");

    const { setCodexSessionMode } = await import("./codexSessionMode");
    setCodexSessionMode(threadId, "chat");
    useUiStore.getState().registerOptimisticCodexSession(threadId, cwd);
    if (codexModel) {
      useUiStore.getState().setCodexThreadModel(threadId, codexModel);
    }
    // Pending message hydrates the chat UI + title; actual send is codexSendMessage.
    useUiStore.getState().setPendingFirstMessage(threadId, prompt);
    useUiStore.getState().recordPromptSent(threadId);
    useUiStore.getState().setPendingCodexFastMode(threadId, settings.codexFastMode);
    useUiStore.getState().setPendingCodexPermissionMode(
      threadId,
      settings.codexPermissionMode,
    );
    selectCodexSession(threadId, cwd, name);

    const accessMode = codexAccessModeForPermission(settings.codexPermissionMode);
    setTimeout(() => {
      codexSendMessage(
        cwd,
        threadId,
        prompt,
        codexModel,
        effortArg || settings.codexEffort || null,
        accessMode,
        null,
        null,
        settings.codexFastMode || null,
      ).catch(console.error);
    }, 500);

    return { sessionId: threadId, provider, workDir: cwd };
  }

  // ── OpenCode SDK ──────────────────────────────────────────────
  if (provider === "OpenCode") {
    const opencodeModel =
      modelArg && modelArg.includes("/")
        ? modelArg
        : "anthropic/claude-sonnet-4-5";
    const thread = await addThread({
      projectId: args.projectId,
      name,
      provider: "OpenCode",
      model: opencodeModel,
      interactionMode: "opencode-sdk",
      workMode: preferWorktree ? "Worktree" : "DirectRepo",
      worktreeRoot,
    });
    const workDir = thread.work_dir || args.repoPath;
    useUiStore.getState().setPendingFirstMessage(thread.id, prompt);
    useUiStore.getState().selectOpencodeSdkSession(thread.id, workDir, true, name);
    return { sessionId: thread.id, provider, workDir };
  }

  // ── Grok SDK ──────────────────────────────────────────────────
  // (provider is Grok — only remaining allow-listed option)
  {
    const grokModel = modelArg || settings.lastUsedModel?.trim() || "grok-4.7";
    const rawEffort = (effortArg || settings.lastUsedEffort || "high").toLowerCase();
    const grokEffort = (
      ["low", "medium", "high", "xhigh", "max"].includes(rawEffort)
        ? rawEffort
        : "high"
    ) as "low" | "medium" | "high" | "xhigh" | "max";
    const permMode =
      settings.sdkPermissionMode === "full"
        ? "bypassPermissions"
        : settings.sdkPermissionMode === "auto"
          ? "auto"
          : "default";
    const thread = await addThread({
      projectId: args.projectId,
      name,
      provider: "Grok",
      model: grokModel,
      reasoningEffort: grokEffort,
      interactionMode: "grok-sdk",
      workMode: preferWorktree ? "Worktree" : "DirectRepo",
      worktreeRoot,
    });
    const workDir = thread.work_dir || args.repoPath;
    useUiStore.getState().setPendingGrokConfig(thread.id, {
      permissionMode: permMode,
      effort: grokEffort,
      model: grokModel,
      planMode: false,
    });
    useUiStore.getState().setPendingSdkPermissionMode(thread.id, permMode);
    useUiStore.getState().setPendingFirstMessage(thread.id, prompt);
    selectThread(thread.id, name);
    return { sessionId: thread.id, provider: "Grok", workDir };
  }
}
