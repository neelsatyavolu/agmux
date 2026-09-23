import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

const messages = {
  waiting_for_idle: "Usage limit reached. Waiting for this session to finish its current work before switching accounts.",
  model_unavailable: "Account switching paused: this session’s model could not be verified.",
  identity_unavailable: "Usage limit reached. Reopen this session to choose another account.",
  ready: "Account switched. Conversation is ready to continue.",
  resume_failed: "Account switched, but the conversation could not be reopened. Open the conversation to try again.",
  unavailable: "No replacement account is available. Check Accounts for sign-in and usage availability.",
};
type RuntimeStatus = keyof typeof messages;
export interface ProviderAccountNotification {
  key: string;
  provider: "claude" | "codex" | "grok";
  status: RuntimeStatus;
  message: string;
}

/** App-level notices use fixed copy only, never native error text or credential fields. */
export function useProviderAccountNotifications() {
  const [notifications, setNotifications] = useState<ProviderAccountNotification[]>([]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("provider-account-runtime", ({ payload }) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const { provider, sessionKey, status } = payload as Record<string, unknown>;
      if ((provider !== "claude" && provider !== "codex" && provider !== "grok") || typeof sessionKey !== "string" || !sessionKey
        || (status !== "ready" && status !== "resume_failed" && status !== "unavailable"
          && status !== "waiting_for_idle" && status !== "identity_unavailable" && status !== "model_unavailable")) return;
      const key = JSON.stringify([provider, sessionKey]);
      const notice: ProviderAccountNotification = { key, provider, status, message: messages[status] };
      setNotifications(current => {
        if (current.some(item => item.key === key && item.status === status)) return current;
        return [...current.filter(item => item.key !== key), notice].slice(-4);
      });
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {
      // Do not log the rejection: native errors may contain sensitive details.
      if (!disposed) console.warn("Account change notifications are unavailable.");
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const dismiss = useCallback((key: string) => {
    setNotifications(current => current.filter(item => item.key !== key));
  }, []);
  return { notifications, dismiss };
}
