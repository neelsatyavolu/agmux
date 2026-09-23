import { invoke } from "@tauri-apps/api/core";
import type { SdkChatLogEntry } from "./commands";

export interface CursorStartArgs {
  threadId: string;
  directory: string;
  model?: string | null;
  resumeAgentId?: string | null;
  mode?: CursorAgentMode;
  /** default = sandboxed, auto = classifier review, full = unrestricted */
  permissionMode?: "default" | "auto" | "full";
}

export interface CursorImage {
  data: string;
  mimeType: string;
}

export type CursorAgentMode = "agent" | "plan";

export interface CursorModelParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

export interface CursorModelVariant {
  slug: string;
  name: string;
  description?: string;
}

export interface CursorModel {
  slug: string;
  name: string;
  description?: string;
  variants?: CursorModelVariant[];
  parameters?: CursorModelParameter[];
}

export interface CursorSendOptions {
  mode?: CursorAgentMode;
  /** default = sandboxed, auto = classifier review, full = unrestricted */
  permissionMode?: "default" | "auto" | "full";
}

export type CursorPermissionUiMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "plan"
  | "agent"
  | "full"
  | "supervised";

export interface CursorAuthStatus {
  status: "logged-in" | "logged-out";
  email?: string | null;
  apiKeyExpiresAtMs?: number | null;
  source?: "sdk-login" | "env" | string | null;
}

export const cursorSdk = {
  checkAvailable: (): Promise<boolean> =>
    invoke("cursor_sdk_check_available"),

  bridgeLogTail: (lines?: number): Promise<string[]> =>
    invoke("cursor_bridge_log_tail", { lines }),

  startSession: (args: CursorStartArgs): Promise<string> =>
    invoke("cursor_sdk_start_session", { args }),

  sendMessage: (
    threadId: string,
    text: string,
    images?: CursorImage[],
    options?: CursorSendOptions,
  ): Promise<void> =>
    invoke("cursor_sdk_send_message", {
      threadId,
      text,
      images,
      mode: options?.mode,
    }),

  interrupt: (threadId: string): Promise<void> =>
    invoke("cursor_sdk_interrupt", { threadId }),

  setModel: (threadId: string, model: string): Promise<void> =>
    invoke("cursor_sdk_set_model", { threadId, model }),

  setPermissionMode: (
    threadId: string,
    mode: CursorPermissionUiMode,
  ): Promise<{ ok?: boolean; mode?: string; permissionMode?: string }> =>
    invoke("cursor_sdk_set_permission_mode", { threadId, mode }),

  stopSession: (threadId: string): Promise<void> =>
    invoke("cursor_sdk_stop_session", { threadId }),

  getHistory: (threadId: string): Promise<SdkChatLogEntry[]> =>
    invoke("cursor_sdk_get_history", { threadId }),

  listModels: (): Promise<{ models: CursorModel[] }> =>
    invoke("cursor_sdk_list_models"),

  authStatus: (): Promise<CursorAuthStatus> =>
    invoke("cursor_sdk_auth_status"),

  authLogin: (): Promise<CursorAuthStatus> =>
    invoke("cursor_sdk_auth_login"),

  authLogout: (): Promise<CursorAuthStatus> =>
    invoke("cursor_sdk_auth_logout"),

  shutdownBridge: (): Promise<void> =>
    invoke("cursor_sdk_shutdown_bridge"),
};
