// Module-level state container for in-flight commit-dialog operations,
// keyed by workDir. Lives outside the React tree so an in-flight commit
// (generation, push, or PR creation) survives the dialog being closed
// and reopened — reopening hydrates from this store instead of resetting.

import {
  gitStageOnly,
  gitCommitOnly,
  gitPushOnly,
  gitCommitAndPushV2,
  gitCommitAndCreatePr,
  generateCommitContent,
  getGitHeadAndRemote,
} from "../../lib/commands";
import { buildGithubCommitUrl } from "../../lib/gitUrls";
import type { ChangedFile } from "../../lib/types";
import {
  commitMessageCandidates,
  useSettingsStore,
} from "../../stores/settingsStore";

export type Action = "commit" | "push" | "commit-push" | "commit-pr";
export type DialogPhase = "form" | "progress" | "success" | "error";

export interface StepStatus {
  label: string;
  state: "pending" | "running" | "done";
}

export interface CommitOpState {
  isGenerating: boolean;
  generateError: string | null;
  phase: DialogPhase;
  action: Action;
  steps: StepStatus[];
  errorMessage: string;
  subject: string;
  body: string;
  // Stats captured at run() time so the success view can render correctly
  // even if the user closed and reopened the dialog mid-operation.
  stagedCount: number;
  totals: { add: number; del: number };
  /** GitHub commit URL for the success view "View commit" button, if resolvable. */
  commitUrl: string | null;
}

const DEFAULT: CommitOpState = {
  isGenerating: false,
  generateError: null,
  phase: "form",
  action: "commit",
  steps: [],
  errorMessage: "",
  subject: "",
  body: "",
  stagedCount: 0,
  totals: { add: 0, del: 0 },
  commitUrl: null,
};

const states = new Map<string, CommitOpState>();
const listeners = new Map<string, Set<() => void>>();

function emit(workDir: string) {
  const set = listeners.get(workDir);
  if (!set) return;
  for (const cb of set) cb();
}

export function getCommitOpState(workDir: string): CommitOpState {
  return states.get(workDir) ?? DEFAULT;
}

export function hasActiveCommitOp(workDir: string): boolean {
  const s = states.get(workDir);
  if (!s) return false;
  return (
    s.isGenerating ||
    s.phase === "progress" ||
    s.phase === "success" ||
    s.phase === "error"
  );
}

export function subscribeCommitOp(workDir: string, cb: () => void): () => void {
  let set = listeners.get(workDir);
  if (!set) {
    set = new Set();
    listeners.set(workDir, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

function patch(workDir: string, p: Partial<CommitOpState>) {
  const cur = states.get(workDir) ?? DEFAULT;
  states.set(workDir, { ...cur, ...p });
  emit(workDir);
}

export function resetCommitOp(workDir: string) {
  states.set(workDir, { ...DEFAULT });
  emit(workDir);
}

export function setCommitSubject(workDir: string, subject: string) {
  patch(workDir, { subject, generateError: null });
}

export function setCommitBody(workDir: string, body: string) {
  patch(workDir, { body, generateError: null });
}

export function setPhase(workDir: string, phase: DialogPhase) {
  patch(workDir, { phase });
}

function buildSteps(action: Action, branch: string): StepStatus[] {
  if (action === "push") {
    return [{ label: `Pushing to ${branch}`, state: "pending" }];
  }

  const result: StepStatus[] = [{ label: "Committing changes", state: "pending" }];
  if (action === "commit-push") {
    result.push({ label: `Pushing to ${branch}`, state: "pending" });
  } else if (action === "commit-pr") {
    result.push({ label: `Pushing to ${branch}`, state: "pending" });
    result.push({ label: "Creating pull request", state: "pending" });
  }
  return result;
}

function advanceStep(stepsList: StepStatus[], index: number): StepStatus[] {
  return stepsList.map((s, i) => {
    if (i < index) return { ...s, state: "done" };
    if (i === index) return { ...s, state: "running" };
    return { ...s, state: "pending" };
  });
}

function completeAllSteps(stepsList: StepStatus[]): StepStatus[] {
  return stepsList.map((s) => ({ ...s, state: "done" }));
}

/**
 * Generate a commit message via the user's preferred model cascade:
 * Codex GPT-5.3 Spark → Grok 4.5 → Claude Haiku (or a single pinned model).
 * No Groq fallback. Updates module state so the "Generating…" indicator and
 * any error are observable even if the dialog is unmounted mid-flight.
 */
export async function runCommitGenerate(
  workDir: string,
): Promise<{ subject: string; body: string } | null> {
  patch(workDir, { isGenerating: true, generateError: null });
  // Yield to the event loop so React paints the "Generating…" state before
  // we block on the (often fast-failing) CLI spawn.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const pref = useSettingsStore.getState().settings.commitMessageModel ?? "auto";
  const candidates = commitMessageCandidates(pref);
  const errors: string[] = [];

  try {
    for (const candidate of candidates) {
      try {
        const content = await generateCommitContent(
          workDir,
          true,
          candidate.model,
          candidate.provider,
        );
        patch(workDir, { subject: content.subject, body: content.body });
        return content;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate.provider}/${candidate.model}: ${msg}`);
        console.warn(
          `[CommitDialog] generateCommitContent failed for ${candidate.provider}/${candidate.model}:`,
          err,
        );
      }
    }
    patch(workDir, {
      generateError:
        errors.length > 0
          ? `Generation failed:\n${errors.join("\n")}`
          : "Generation failed: no providers configured.",
    });
    return null;
  } finally {
    patch(workDir, { isGenerating: false });
  }
}

export interface RunCommitInput {
  workDir: string;
  action: Action;
  branch: string;
  files: ChangedFile[];
  stagedIds: Set<string>;
}

/**
 * Run the full commit (and optionally push / PR) flow. Drives module state
 * through the form → progress → success/error transitions. The async work
 * keeps running and updating state even if the dialog component unmounts —
 * reopening the dialog will hydrate from the latest state.
 */
export async function runCommit(input: RunCommitInput): Promise<void> {
  const { workDir, action, branch, files, stagedIds } = input;
  const stagedCount = stagedIds.size;
  if (stagedCount === 0 && action !== "push") return;

  const cur = states.get(workDir) ?? DEFAULT;
  let subj = cur.subject.trim();
  let bod = cur.body.trim();

  if (action !== "push" && !subj) {
    const gen = await runCommitGenerate(workDir);
    if (gen) {
      subj = gen.subject.trim();
      bod = gen.body.trim();
    }
    if (!subj) subj = "chore: update files";
  }
  const message = bod ? `${subj}\n\n${bod}` : subj;

  // Capture stats for the success view.
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (!stagedIds.has(f.path)) continue;
    add += f.added;
    del += f.removed;
  }

  const initialSteps = buildSteps(action, branch);
  patch(workDir, {
    action,
    steps: advanceStep(initialSteps, 0),
    phase: "progress",
    errorMessage: "",
    stagedCount,
    totals: { add, del },
    commitUrl: null,
  });

  try {
    if (action === "push") {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await gitPushOnly(workDir);
    } else {
      const stagedPaths = files.filter((f) => stagedIds.has(f.path)).map((f) => f.path);
      await gitStageOnly(workDir, stagedPaths);

      if (action === "commit") {
        await gitCommitOnly(workDir, message, false);
      } else if (action === "commit-push") {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await gitCommitAndPushV2(workDir, message, false);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await gitCommitAndCreatePr(workDir, message, false);
      }
    }

    const after = states.get(workDir) ?? DEFAULT;
    patch(workDir, { steps: completeAllSteps(after.steps) });

    // Resolve a GitHub commit URL for the success footer (best-effort).
    let commitUrl: string | null = null;
    try {
      const head = await getGitHeadAndRemote(workDir);
      commitUrl = buildGithubCommitUrl(head.remote_url, head.sha);
    } catch (err) {
      console.warn("[CommitDialog] getGitHeadAndRemote failed:", err);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    patch(workDir, { phase: "success", commitUrl });
  } catch (e: unknown) {
    patch(workDir, { errorMessage: String(e), phase: "error" });
  }
}
