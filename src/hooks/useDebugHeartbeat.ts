import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDebugStatus, type DebugStatus } from "../lib/debugMode";
import { subscribeAppVisibility } from "../lib/appVisibility";

/** One heartbeat for the app, including when Settings is closed. No timer while off. */
export function useDebugHeartbeat() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unlisten: (() => void) | undefined;
    let visible = document.hidden !== true;
    let focused = document.hasFocus();
    let previous = performance.now();
    let inFlight = false;
    let revision = 0;
    const unsubscribe = subscribeAppVisibility(state => { visible = state.visible; focused = state.focused; });
    const update = (status: DebugStatus) => {
      clearInterval(timer);
      timer = undefined;
      if (cancelled || !status.enabled) return;
      previous = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        const lagMs = Math.min(86_400_000, Math.max(0, now - previous - 1000));
        previous = now;
        if (inFlight) return;
        inFlight = true;
        invoke("debug_heartbeat", { lagMs, visible, focused })
          .catch(err => console.error("[debug] heartbeat failed", err))
          .finally(() => { inFlight = false; });
      }, 1000);
    };
    void (async () => {
      try {
        const stop = await listen<DebugStatus>("debug-mode-changed", event => { revision++; update(event.payload); });
        if (cancelled) { stop(); return; }
        unlisten = stop;
        const initialRevision = revision;
        const status = await getDebugStatus();
        if (revision === initialRevision) update(status);
      } catch (err) { console.error("[debug] status unavailable", err); }
    })();
    return () => { cancelled = true; clearInterval(timer); unlisten?.(); unsubscribe(); };
  }, []);
}
