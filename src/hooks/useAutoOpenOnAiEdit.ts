import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditorStore } from "../stores/editorStore";
import type { SdkEvent, SdkToolStarted } from "../lib/types";

/** Tools that mutate files on disk. */
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "NotebookEdit"]);

/** Tools that only read files (open tab but no AI badge). */
const FILE_READING_TOOLS = new Set(["Read"]);

/** How long the AI-edited badge stays visible (ms). */
const AI_BADGE_DURATION_MS = 5_000;

/**
 * Extract the file path from a tool's input object.
 * Different tools store the path under different keys.
 */
function extractFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === "string" && input.file_path) return input.file_path;
  if (typeof input.path === "string" && input.path) return input.path;
  if (typeof input.filePath === "string" && input.filePath) return input.filePath;
  return null;
}

/**
 * Listens to SDK tool events for the given thread and auto-opens files in the
 * editor when the AI reads or edits them. Mutating edits also get a temporary
 * "AI" badge on the tab.
 */
export function useAutoOpenOnAiEdit(threadId: string | null): void {
  // Map toolUseId -> partial start info so we can correlate completions.
  const pendingToolsRef = useRef<Map<string, { name: string; filePath: string | null }>>(new Map());
  const badgeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!threadId) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    const channel = `sdk-event-${threadId}`;

    async function subscribe() {
      unlisten = await listen<SdkEvent>(channel, (event) => {
        if (cancelled) return;
        const sdkEvent = event.payload;

        if (sdkEvent.type === "tool.started") {
          const started = sdkEvent as SdkToolStarted;
          const filePath = extractFilePath(started.input);
          pendingToolsRef.current.set(started.toolUseId, {
            name: started.name,
            filePath,
          });

          // For read-only tools, open the tab immediately on start
          if (filePath && FILE_READING_TOOLS.has(started.name)) {
            useEditorStore.getState().openTab(filePath);
          }
        }

        if (sdkEvent.type === "tool.completed") {
          const pending = pendingToolsRef.current.get(sdkEvent.toolUseId);
          pendingToolsRef.current.delete(sdkEvent.toolUseId);

          if (!pending?.filePath) return;
          if (sdkEvent.isError) return;

          const { name, filePath } = pending;

          if (FILE_MUTATING_TOOLS.has(name)) {
            const store = useEditorStore.getState();
            store.refreshFileFromDisk(filePath);
            store.openTab(filePath);
            store.markAiEdited(filePath);

            // Clear the previous timer for this path if re-edited quickly
            const prev = badgeTimersRef.current.get(filePath);
            if (prev) clearTimeout(prev);

            const timer = setTimeout(() => {
              useEditorStore.getState().clearAiEdited(filePath);
              badgeTimersRef.current.delete(filePath);
            }, AI_BADGE_DURATION_MS);
            badgeTimersRef.current.set(filePath, timer);
          }
        }
      });
    }

    subscribe();

    return () => {
      cancelled = true;
      unlisten?.();
      // Clean up all pending badge timers
      for (const timer of badgeTimersRef.current.values()) {
        clearTimeout(timer);
      }
      badgeTimersRef.current.clear();
      pendingToolsRef.current.clear();
    };
  }, [threadId]);
}
