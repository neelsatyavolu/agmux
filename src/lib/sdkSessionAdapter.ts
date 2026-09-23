/**
 * Maps SDK Tauri events → sessionStateMachine inputs.
 * Called from ClaudeSdkSessionView's event listeners to drive
 * the same uiStore.transitionSession() that PTY mode uses.
 */

import type { SessionEvent } from "./sessionStateMachine";
import type { SdkEvent } from "./types";

export function mapSdkEventToSessionEvent(sdkEvent: SdkEvent): SessionEvent | null {
  switch (sdkEvent.type) {
    case "session.started":
      return { type: "session_start" };

    case "content.delta":
      // Only map the first delta per burst to avoid excessive state transitions.
      // The state machine only needs to know we're "processing", not every chunk.
      return {
        type: "pre_tool_use",
        toolName: "generating",
        toolStatus: null,
        question: null,
      };

    case "tool.started":
      // Use a generic name so the state machine doesn't flag agent/task tools
      // for speculative approval polling — SDK has explicit approval.requested
      // events, so the PTY-era "preliminary approval" heuristic is wrong here.
      return {
        type: "pre_tool_use",
        toolName: "tool",
        toolStatus: sdkEvent.name,
        question: null,
      };

    case "approval.requested":
      return {
        type: "notification",
        category: "permission" as const,
        subtitle: sdkEvent.toolName,
        body: sdkEvent.detail,
      };

    case "turn.completed":
      return { type: "stop" };

    case "session.ended":
      return { type: "session_end" };

    case "error":
      // Errors must clear the processing indicator. Map to session_end so the
      // state machine resets processing/approval/tool status. Without this,
      // claudeProcessingById stays true forever after an error.
      return { type: "session_end" };

    case "status": {
      // Cursor (and some bridges) emit lifecycle status frames before the
      // first content.delta. RUNNING must arm the sidebar spinner; finished
      // / idle clear via turn.completed or session.ended, not here, so we
      // don't race a premature stop while the run is still wrapping up.
      const raw = String(sdkEvent.status ?? "").trim().toLowerCase();
      if (
        raw === "running" ||
        raw === "started" ||
        raw === "in_progress" ||
        raw === "in-progress"
      ) {
        return {
          type: "pre_tool_use",
          toolName: "generating",
          toolStatus: null,
          question: null,
        };
      }
      return null;
    }

    default:
      return null;
  }
}
