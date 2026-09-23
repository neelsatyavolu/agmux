/** Wire protocol — keep in sync with src-tauri/src/remote/protocol.rs */

export type ClientRole = "desktop" | "phone";

export interface RemoteThread {
  id: string;
  title: string;
  provider: "ClaudeCode" | "Codex" | "Grok" | string;
  interactionMode: string;
  surface: "chat" | "terminal" | string;
  projectName?: string;
  projectId?: string;
  /** Desktop task membership (project + saved branch); absent for ordinary sessions. */
  taskId?: string;
  taskName?: string;
  worktreeBranch?: string;
  /** Desktop sidebar orders projects by created_at DESC. */
  projectCreatedAt?: string;
  /** Index in the user's dragged project order; absent when unordered. */
  projectSortKey?: number;
  /** Pinned in the desktop sidebar — floats to the top of its project. */
  pinned?: boolean;
  processing: boolean;
  /** Desktop done/unread green pulse — completed while user wasn't looking. */
  unread?: boolean;
  needsApproval: boolean;
  lastActive: string;
  /** Model short label for meta line (desktop sidebar parity). */
  model?: string;
  /** Reasoning effort for composer chips (desktop InputBar parity). */
  reasoningEffort?: string;
  /** Codex fast mode — chat composer only. */
  fastMode?: boolean;
  /** Last permission mode (default | auto | full). */
  permissionMode?: string;
  /** Plan mode for chat composers. */
  planMode?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  /** Idle | Running | Done | Error */
  status?: string;
}

export interface MobileTimelineEntry {
  id: string;
  kind: string;
  text?: string;
  streaming?: boolean;
  lead?: string;
  subject?: string;
  detail?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  body?: string;
  requestId?: string;
  toolName?: string;
  state?: string;
  message?: string;
  ts: number;
}

/** Public device row for desktop Settings (no raw token). */
export interface PairedDevice {
  id: string;
  /** First 8 chars of the token for human recognition only. */
  tokenPrefix: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string;
}

export type WireMessage =
  | {
      type: "hello";
      role: ClientRole;
      token: string;
      desktopId?: string;
      /** Friendly Mac name (e.g. "Neel's MacBook Pro") from desktop hello. */
      deviceName?: string;
      /** Desktop app semver (phone soft messaging). */
      appVersion?: string;
      /** Feature flags; desktop advertises e.g. `["images"]` for attach UI. */
      capabilities?: string[];
    }
  | { type: "pair.submit"; code: string }
  | { type: "pair.create" }
  | {
      type: "threads.snapshot";
      threads: RemoteThread[];
      /** Oversized catalogs are staged until every ordered chunk arrives. */
      snapshotId?: string;
      chunkIndex?: number;
      chunkCount?: number;
      /** Desktop DraftChatView last-used seed for phone new-chat picker. */
      draftPrefs?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
        permissionMode?: string;
      };
    }
  | { type: "threads.upsert"; thread: RemoteThread }
  | { type: "threads.list" }
  | {
      type: "timeline.snapshot";
      threadId: string;
      entries: MobileTimelineEntry[];
      emptyHint?: string;
    }
  | { type: "timeline.append"; threadId: string; entries: MobileTimelineEntry[] }
  | { type: "timeline.patch"; threadId: string; entry: MobileTimelineEntry }
  | { type: "status"; threadId: string; processing: boolean; label?: string }
  | {
      type: "approval.requested";
      threadId: string;
      requestId: string;
      toolName: string;
      detail: string;
    }
  | { type: "approval.resolved"; threadId?: string; requestId: string }
  | {
      type: "approval.respond";
      requestId: string;
      decision: string;
      threadId?: string;
    }
  | {
      type: "userInput.requested";
      threadId: string;
      requestId: string;
      questions: unknown;
    }
  | {
      type: "userInput.respond";
      threadId: string;
      requestId: string;
      answers: unknown;
    }
  | { type: "userInput.resolved"; threadId?: string; requestId: string }
  | { type: "thread.subscribe"; threadId: string }
  /** Phone opened this session — clear desktop unread green pulse. */
  | { type: "thread.read"; threadId: string }
  | {
      type: "message.send";
      requestId?: string;
      threadId: string;
      text: string;
      /** Optional base64 images — chat multimodal; terminals → temp paths on Mac. */
      images?: Array<{ data: string; mediaType: string }>;
      /** Composer permission on follow-up turns (default | auto | full). */
      permissionMode?: string;
      planMode?: boolean;
    }
  | { type: "turn.interrupt"; threadId: string }
  | {
      type: "thread.create";
      requestId?: string;
      provider: string;
      projectId: string;
      model?: string;
      reasoningEffort?: string;
      fastMode?: boolean;
      permissionMode?: string;
      planMode?: boolean;
    }
  | { type: "thread.created"; thread: RemoteThread; requestId?: string }
  | { type: "message.accepted"; threadId: string; requestId: string }
  | {
      type: "thread.setConfig";
      threadId: string;
      model?: string;
      reasoningEffort?: string;
      fastMode?: boolean;
      permissionMode?: string;
      planMode?: boolean;
    }
  /** Phone → desktop: fetch live model catalog (OpenCode / Cursor full list). */
  | { type: "models.list"; provider: string; projectId?: string; threadId?: string; requestId?: string }
  /** Desktop → phone: full model catalog for a provider. */
  | {
      type: "models.snapshot";
      provider: string;
      requestId?: string;
      models: Array<{ slug: string; name: string; connected?: boolean; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string }>;
    }
  | { type: "devices.list" }
  /** Desktop → relay: revoke one paired phone by device id (not raw token). */
  | { type: "devices.revoke"; deviceId: string }
  /** Desktop → relay: drop every paired phone (e.g. remote disabled). */
  | { type: "devices.revokeAll" }
  // `phonesOnline` counts phone sockets attached right now (not paired
  // records). The desktop uses it to skip background work nobody is watching.
  | { type: "devices.snapshot"; devices: PairedDevice[]; phonesOnline?: number }
  | { type: "hello.ok"; role: ClientRole }
  | { type: "pair.created"; code: string; expiresAt: number }
  | { type: "pair.ok"; phoneToken: string; desktopId: string; deviceId: string }
  | { type: "pair.fail"; reason: string }
  | { type: "error"; message: string; requestId?: string; threadId?: string }
  | { type: "desktop.offline" }
  | {
      type: "desktop.online";
      deviceName?: string;
      appVersion?: string;
      /** From desktop hello; absent means old Mac — no gated features. */
      capabilities?: string[];
    }
  /** Client → hub liveness; hub replies `pong` without involving the peer. */
  | { type: "ping"; id?: string }
  | { type: "pong"; id?: string };
