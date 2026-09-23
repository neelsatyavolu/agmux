import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FileChangeEvent } from "../lib/types";

export function useFileWatcher(
  threadId: string | null,
  onChange: (paths: string[], kind: string) => void
) {
  useEffect(() => {
    if (!threadId) return;

    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<FileChangeEvent>(
        `file-change-${threadId}`,
        (event) => {
          onChange(event.payload.paths, event.payload.kind);
        }
      );
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [threadId, onChange]);
}
