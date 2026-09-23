import { invoke } from "@tauri-apps/api/core";

export interface OpenCodeInitArgs {
  binaryPath?: string;
  serverUrl?: string;
  serverPassword?: string;
}

export interface OpenCodeStartArgs {
  threadId: string;
  directory: string;
  model: string;
  agent?: string;
  permissionMode?: "normal" | "auto" | "full-access" | "bypassPermissions";
  resumeSessionId?: string;
}

export interface OpenCodeModel {
  slug: string;
  name: string;
  variants: string[];
  /** True when the provider this model belongs to is authenticated. */
  connected?: boolean;
  providerID?: string;
  providerName?: string;
  modelID?: string;
}

export interface OpenCodeAgent {
  name: string;
  description?: string;
  mode: string;
}

export interface OpenCodeListModelsResult {
  models: OpenCodeModel[];
  agents: OpenCodeAgent[];
  directory: string;
}

export type OpenCodeApprovalDecision = "accept" | "acceptForSession" | "decline";

export interface OpenCodeAuthMethod {
  type: "apiKey" | "oauth" | "wellKnown" | string;
  label?: string;
  inputs?: Array<{ name: string; label?: string; type?: string; placeholder?: string }>;
}

export interface OpenCodeProviderAuth {
  providerID: string;
  name: string;
  isConnected: boolean;
  /** Env vars OpenCode expects for this provider (from models.dev). When the
   *  provider stays disconnected after an apiKey save, one of these is usually
   *  the missing piece (e.g. OLLAMA_HOST for the `ollama` provider). */
  envVars?: string[];
  methods: OpenCodeAuthMethod[];
}

export interface OpenCodeSetApiKeyResult {
  ok: boolean;
  connected: boolean;
  envVars: string[];
}

export interface OpenCodeOAuthAuthorizeResult {
  url?: string;
  [key: string]: unknown;
}

export const opencodeSdk = {
  checkAvailable: (binaryPath: string): Promise<boolean> =>
    invoke("opencode_sdk_check_available", { binaryPath }),

  /** Auto-detect the opencode binary on the augmented PATH. Returns null if
   *  not found. Used to pre-fill the Settings binary path field. */
  autoDetectBinary: (): Promise<string | null> =>
    invoke("opencode_sdk_auto_detect_binary"),

  /** Retrieve the last N lines of bridge stderr (rolling buffer kept by Rust).
   *  Useful for debugging hangs where the live `opencode-bridge-log` listener
   *  wasn't attached in time to catch early initialization logs. */
  bridgeLogTail: (lines?: number): Promise<string[]> =>
    invoke("opencode_bridge_log_tail", { lines }),

  initializeBridge: (args: OpenCodeInitArgs): Promise<{ serverUrl: string }> =>
    invoke("opencode_sdk_initialize_bridge", { args }),

  startSession: (args: OpenCodeStartArgs): Promise<string> =>
    invoke("opencode_sdk_start_session", { args }),

  sendMessage: (threadId: string, text: string, attachments?: unknown[]): Promise<void> =>
    invoke("opencode_sdk_send_message", { threadId, text, attachments }),

  respondPermission: (
    threadId: string,
    permissionId: string,
    decision: OpenCodeApprovalDecision
  ): Promise<void> =>
    invoke("opencode_sdk_respond_permission", { threadId, permissionId, decision }),

  respondQuestion: (
    threadId: string,
    questionId: string,
    answers: string[][]
  ): Promise<void> =>
    invoke("opencode_sdk_respond_question", { threadId, questionId, answers }),

  interrupt: (threadId: string): Promise<void> =>
    invoke("opencode_sdk_interrupt", { threadId }),

  setModel: (threadId: string, model: string): Promise<void> =>
    invoke("opencode_sdk_set_model", { threadId, model }),

  /** Update the active agent (e.g. "build", "plan", "general"). The next
   *  user turn will be routed to the new agent without resetting history. */
  setAgent: (threadId: string, agent: string | null): Promise<void> =>
    invoke("opencode_sdk_set_agent", { threadId, agent }),

  setPermissionMode: (
    threadId: string,
    mode: "normal" | "auto" | "full-access" | "bypassPermissions",
  ): Promise<void> =>
    invoke("opencode_sdk_set_permission_mode", { threadId, mode }),

  stopSession: (threadId: string): Promise<void> =>
    invoke("opencode_sdk_stop_session", { threadId }),

  getHistory: (threadId: string): Promise<{ messages: unknown[] }> =>
    invoke("opencode_sdk_get_history", { threadId }),

  listModels: (directory: string): Promise<OpenCodeListModelsResult> =>
    invoke("opencode_sdk_list_models", { directory }),

  listAgents: (directory: string): Promise<OpenCodeAgent[]> =>
    invoke("opencode_sdk_list_agents", { directory }),

  shutdownBridge: (): Promise<void> =>
    invoke("opencode_sdk_shutdown_bridge"),

  listAuthMethods: (directory: string): Promise<OpenCodeProviderAuth[]> =>
    invoke("opencode_sdk_list_auth_methods", { directory }),

  setApiKey: (providerId: string, apiKey: string): Promise<OpenCodeSetApiKeyResult | void> =>
    invoke("opencode_sdk_set_api_key", { providerId, apiKey }),

  removeAuth: (providerId: string): Promise<void> =>
    invoke("opencode_sdk_remove_auth", { providerId }),

  oauthAuthorize: (providerId: string, method?: number, inputs?: Record<string, string>): Promise<OpenCodeOAuthAuthorizeResult> =>
    invoke("opencode_sdk_oauth_authorize", { providerId, method, inputs }),

  oauthCallback: (providerId: string, method: number | undefined, code: string): Promise<unknown> =>
    invoke("opencode_sdk_oauth_callback", { providerId, method, code }),
};
