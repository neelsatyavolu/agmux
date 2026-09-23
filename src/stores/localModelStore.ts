import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  localModelStatus,
  downloadLocalModel,
  deleteLocalModel,
  setActiveLocalModel,
  ensureLocalLlmServer,
  stopLocalLlmServer,
  type LocalModelStatus,
  type LocalModelVariant,
} from "../lib/commands";

export interface DownloadProgress {
  stage: string;
  variant: LocalModelVariant | null;
  bytes_downloaded: number;
  total_bytes: number | null;
  complete: boolean;
  error: string | null;
}

interface LocalModelState {
  status: LocalModelStatus | null;
  downloading: boolean;
  downloadProgress: DownloadProgress | null;
  error: string | null;

  /**
   * Legacy flag from when setup was skippable. Download is now required on
   * startup (`LocalModelSetupDialog` keys off `model_downloaded` only).
   * Kept so older clients/tests don't break.
   */
  hasSeenSetupPrompt: boolean;
  dismissSetupPrompt: () => void;

  fetchStatus: () => Promise<void>;
  /** Download a specific variant, defaulting to the active one. */
  startDownload: (variant?: LocalModelVariant) => Promise<void>;
  /** Remove a specific variant, or everything when omitted. */
  removeModel: (variant?: LocalModelVariant) => Promise<void>;
  /** Switch which variant the server uses (stops server so it respawns). */
  setActive: (variant: LocalModelVariant) => Promise<void>;
  ensureServer: () => Promise<number>;
  stopServer: () => Promise<void>;
}

const SETUP_PROMPT_KEY = "agmux-local-model-setup-seen";

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  status: null,
  downloading: false,
  downloadProgress: null,
  error: null,
  hasSeenSetupPrompt: localStorage.getItem(SETUP_PROMPT_KEY) === "true",

  dismissSetupPrompt: () => {
    localStorage.setItem(SETUP_PROMPT_KEY, "true");
    set({ hasSeenSetupPrompt: true });
  },

  fetchStatus: async () => {
    try {
      const s = await localModelStatus();
      set({ status: s, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  startDownload: async (variant) => {
    set({ downloading: true, error: null, downloadProgress: null });

    const unlisten = await listen<DownloadProgress>(
      "local-model-download-progress",
      (event) => {
        set({ downloadProgress: event.payload });
      },
    );

    try {
      await downloadLocalModel(variant);
      await get().fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ downloading: false });
      unlisten();
    }
  },

  removeModel: async (variant) => {
    try {
      await deleteLocalModel(variant);
      await get().fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setActive: async (variant) => {
    try {
      await setActiveLocalModel(variant);
      await get().fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  ensureServer: async () => {
    try {
      const port = await ensureLocalLlmServer();
      await get().fetchStatus();
      return port;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    }
  },

  stopServer: async () => {
    try {
      await stopLocalLlmServer();
      await get().fetchStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
