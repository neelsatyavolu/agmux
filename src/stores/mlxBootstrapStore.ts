import { create } from "zustand";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { MlxBootstrapState, mlxBootstrapStatus } from "../lib/mlx";

interface MlxBootstrapStore {
  state: MlxBootstrapState;
  initialized: boolean;
  init: () => Promise<void>;
  destroy: () => void;
  _unlisten?: UnlistenFn;
}

export const useMlxBootstrapStore = create<MlxBootstrapStore>((set, get) => ({
  state: { state: "idle" },
  initialized: false,

  // Reads the current state and subscribes to progress. Deliberately does NOT
  // start a bootstrap: installing the venv + mlx-lm is a multi-hundred-MB
  // download and the caller (Settings → Local Models) offers it as an explicit
  // action instead of firing it just because a panel mounted.
  async init() {
    if (get().initialized || get()._unlisten) return;
    set({ initialized: true });

    try {
      const initial = await mlxBootstrapStatus();
      set({ state: initial });

      const unlisten = await listen<MlxBootstrapState>(
        "mlx-bootstrap-progress",
        (event) => {
          set({ state: event.payload });
        },
      );
      set({ _unlisten: unlisten });
    } catch (e) {
      // Leaving `initialized` true would wedge the store permanently — the
      // next mount could never retry.
      console.error("[mlx][bootstrap] init failed:", e);
      set({ initialized: false });
    }
  },

  destroy() {
    const u = get()._unlisten;
    if (u) u();
    set({ _unlisten: undefined, initialized: false, state: { state: "idle" } });
  },
}));
