import { useEffect, useMemo, useRef, useState } from "react";
import { ClaudeSdkSessionView, type ChatTransport } from "./ClaudeSdkSessionView";
import { OpenCodeThinkingIndicator } from "./OpenCodeThinkingIndicator";
import {
  cursorSdk,
  type CursorAgentMode,
  type CursorImage,
} from "../../lib/cursorSdkCommands";
import { recordThreadLineDelta } from "../../lib/commands";
import { toolDiffStats } from "../../lib/toolDiffStats";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import type { ClaudeChatItem } from "../../lib/types";
import { restoreLogsToItems } from "./restoreLogsToItems";

/** Old Cursor chats stored 0/0 because we didn't record diffs. Fill once from history. */
function backfillCursorDiffStats(threadId: string, items: ClaudeChatItem[]): void {
  const thread = Object.values(useThreadStore.getState().threads)
    .flat()
    .find((t) => t.id === threadId);
  if (!thread) return;
  if (thread.lines_added > 0 || thread.lines_removed > 0 || thread.files_changed > 0) return;

  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const item of items) {
    if (item.itemType !== "ToolUse" || !item.result || item.result.isError) continue;
    const stats = toolDiffStats(item.name, item.input, item.result);
    if (!stats) continue;
    added += stats.added;
    removed += stats.removed;
    if (stats.path) files.add(stats.path);
  }
  if (added === 0 && removed === 0) return;
  recordThreadLineDelta(threadId, added, removed, files.size, true).catch((err) => {
    console.warn("Failed to backfill Cursor diff stats:", err);
  });
}

function mapPendingPermission(
  pending: "default" | "bypassPermissions" | "auto" | null,
  fallback: "default" | "auto" | "full",
): "default" | "auto" | "full" {
  if (pending === "auto") return "auto";
  if (pending === "default") return "default";
  if (pending === "bypassPermissions") return "full";
  return fallback;
}

function settingsPermissionMode(): "default" | "auto" | "full" {
  const saved = useSettingsStore.getState().settings.sdkPermissionMode;
  if (saved === "auto") return "auto";
  if (saved === "default") return "default";
  return "full";
}

/**
 * Read draft-handoff plan/permission once (parent render, before ClaudeSdk
 * child consumes the same permission slot).
 */
function readDraftHandoff(sessionId: string): {
  agentMode: CursorAgentMode;
  permissionMode: "default" | "auto" | "full";
  initialPermissionUi: "default" | "full" | "auto";
  initialPlanMode: boolean;
} {
  const ui = useUiStore.getState();
  const pendingPlan = ui.consumePendingCursorPlanMode(sessionId);
  const pendingPerm = ui.consumePendingSdkPermissionMode(sessionId);
  const permissionMode = mapPendingPermission(pendingPerm, settingsPermissionMode());
  const planMode = pendingPlan === true;
  return {
    agentMode: planMode ? "plan" : "agent",
    permissionMode,
    initialPermissionUi: permissionMode,
    initialPlanMode: planMode,
  };
}

interface Props {
  sessionId: string;
  cwd: string;
  model: string;
  isNew?: boolean;
  compact?: boolean;
  hideTopBar?: boolean;
}

interface AgmuxImage {
  data: string;
  mediaType?: string;
  mimeType?: string;
}

function toCursorImages(images?: AgmuxImage[]): CursorImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((img) => ({
    data: img.data,
    mimeType: img.mimeType ?? img.mediaType ?? "image/png",
  }));
}

/** Map shared chat permission pill → Cursor agent mode + local policy. */
function parseCursorPermissionUi(
  nextMode: string,
  currentPermission: "default" | "auto" | "full",
): { agentMode: CursorAgentMode; permissionMode: "default" | "auto" | "full" } {
  if (nextMode === "plan") {
    // Keep current tool policy while planning.
    return { agentMode: "plan", permissionMode: currentPermission };
  }
  if (nextMode === "auto") {
    return { agentMode: "agent", permissionMode: "auto" };
  }
  if (nextMode === "default" || nextMode === "acceptEdits" || nextMode === "supervised") {
    return { agentMode: "agent", permissionMode: "default" };
  }
  // bypassPermissions / full / agent
  return { agentMode: "agent", permissionMode: "full" };
}

export function CursorSdkSessionView({ sessionId, cwd, model, isNew, compact, hideTopBar }: Props) {
  const handoffRef = useRef(readDraftHandoff(sessionId));
  const handoff = handoffRef.current;

  const [sessionReady, setSessionReady] = useState(() => {
    const thread = Object.values(useThreadStore.getState().threads ?? {})
      .flat()
      .find((t) => t.id === sessionId);
    return !!thread?.sdk_session_id?.trim();
  });
  const [error, setError] = useState<string | null>(null);
  const [bypassActive, setBypassActive] = useState(
    () => handoff.permissionMode === "full" && handoff.agentMode === "agent",
  );
  const startedRef = useRef(false);
  const turnStartMsRef = useRef(Date.now());
  const modeRef = useRef<CursorAgentMode>(handoff.agentMode);
  const permissionModeRef = useRef<"default" | "auto" | "full">(handoff.permissionMode);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    cursorSdk
      .startSession({
        threadId: sessionId,
        directory: cwd,
        model,
        mode: modeRef.current,
        permissionMode: permissionModeRef.current,
        resumeAgentId: isNew ? null : undefined,
      })
      .then(() => setSessionReady(true))
      .catch((err) => {
        setError(String(err));
        startedRef.current = false;
      });
  }, [sessionId, cwd, model, isNew]);

  const transport = useMemo<ChatTransport>(
    () => ({
      send: async (threadId, text, images) => {
        turnStartMsRef.current = Date.now();
        await cursorSdk.sendMessage(
          threadId,
          text,
          toCursorImages(images as AgmuxImage[] | undefined),
          {
            mode: modeRef.current,
            permissionMode: permissionModeRef.current,
          },
        );
      },
      respondApproval: async (_threadId, _requestId, decision) => {
        // Cursor local SDK has no interactive tool-approval channel.
        // Deny → interrupt the run; allow/project are no-ops (policy is
        // sandbox / Auto-review via setPermissionMode).
        if (decision === "deny") {
          await cursorSdk.interrupt(sessionId);
        }
      },
      interrupt: (threadId) => cursorSdk.interrupt(threadId),
      setModel: (threadId, nextModel) => cursorSdk.setModel(threadId, nextModel),
      setPermissionMode: async (threadId, nextMode) => {
        const mapped = parseCursorPermissionUi(nextMode, permissionModeRef.current);
        modeRef.current = mapped.agentMode;
        permissionModeRef.current = mapped.permissionMode;
        setBypassActive(mapped.permissionMode === "full" && mapped.agentMode === "agent");
        await cursorSdk.setPermissionMode(threadId, nextMode);
      },
      loadHistory: async (threadId) => {
        const items = restoreLogsToItems(await cursorSdk.getHistory(threadId));
        backfillCursorDiffStats(threadId, items);
        return items;
      },
    }),
    [sessionId],
  );

  if (error) {
    const needsLogin =
      /not signed in|CURSOR_API_KEY|unauthenticated|api key/i.test(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-zinc-400">
        <div className="text-sm font-medium text-red-400">Cursor failed to start</div>
        <div className="max-w-md text-xs">{error}</div>
        <div className="mt-2 max-w-sm text-xs text-zinc-500">
          {needsLogin ? (
            <>
              Open <span className="text-zinc-300">Settings → Accounts</span> and click{" "}
              <span className="text-zinc-300">Sign in with Cursor</span>, then reopen this chat.
            </>
          ) : (
            "Check Settings → Accounts for Cursor sign-in, then try again."
          )}
        </div>
      </div>
    );
  }

  return (
    <ClaudeSdkSessionView
      sessionId={sessionId}
      cwd={cwd}
      isNew={isNew}
      compact={compact}
      hideTopBar={hideTopBar}
      transport={transport}
      externalSessionReady={sessionReady}
      providerOverride="Cursor"
      bypassActive={bypassActive}
      initialPermissionMode={handoff.initialPermissionUi}
      initialPlanMode={handoff.initialPlanMode}
      renderThinkingIndicator={() => (
        <OpenCodeThinkingIndicator startMs={turnStartMsRef.current} phase="generating" />
      )}
    />
  );
}
