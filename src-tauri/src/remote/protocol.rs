//! Wire protocol for mobile remote control (desktop ↔ relay ↔ phone).
//! Keep in sync with `remote-relay/src/protocol.ts`.

use serde::{Deserialize, Serialize};

/// One model row for the phone composer picker (OpenCode full catalog, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelOption {
    pub slug: String,
    pub name: String,
    /// False when the provider needs auth on the Mac (desktop picker "needs auth").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteThread {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub interaction_mode: String,
    pub surface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// For "New chat" targeting + grouping parity with the desktop sidebar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Task membership uses the desktop's project + saved branch association.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// Desktop sidebar orders projects by created_at DESC — phone mirrors it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_created_at: Option<String>,
    /// Index in the user's dragged project order (settings.projectOrder);
    /// i64::MAX when unordered — phone sorts ascending, then created_at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_sort_key: Option<i64>,
    /// Pinned in the desktop sidebar — floats to the top of its project.
    #[serde(default)]
    pub pinned: bool,
    pub processing: bool,
    /// Desktop sidebar "done / unread" green pulse — session finished while
    /// the user wasn't looking. Phone mirrors it; opening the session on
    /// either side clears the mark.
    #[serde(default)]
    pub unread: bool,
    pub needs_approval: bool,
    pub last_active: String,
    /// Model label for sidebar meta (e.g. grok-4.5, sonnet-4.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning effort for composer chips (low/medium/high/…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Codex fast mode flag for chat composer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
    /// Last permission mode set from the phone (default | auto | full).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Plan mode for chat composers (Claude / Grok / Gemini / Cursor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_mode: Option<bool>,
    /// Diff badge — same as desktop ThreadItem / ProjectGroup.
    #[serde(default)]
    pub lines_added: i64,
    #[serde(default)]
    pub lines_removed: i64,
    #[serde(default)]
    pub files_changed: i64,
    /// Idle | Running | Done | Error — phone status dot (processing overrides visual).
    #[serde(default)]
    pub status: String,
}

/// Base64 image attached to a phone `message.send` (Claude/Codex/OpenCode chat
/// shape; terminals convert to temp paths on the Mac).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImage {
    /// Raw base64 (no `data:` prefix).
    pub data: String,
    pub media_type: String,
}

/// Public paired-phone row for desktop Settings (no raw bearer token).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    /// First 8 chars of the token for human recognition only.
    pub token_prefix: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileTimelineEntry {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub ts: i64,
}

/// Messages the desktop or phone send into the relay (and may be forwarded).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WireMessage {
    #[serde(rename = "hello")]
    Hello {
        role: String,
        token: String,
        #[serde(default, rename = "desktopId", skip_serializing_if = "Option::is_none")]
        desktop_id: Option<String>,
        /// Friendly Mac name (e.g. "Neel's MacBook Pro") for the phone UI.
        #[serde(default, rename = "deviceName", skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        /// Desktop app version (semver) — phone may use for soft messaging.
        #[serde(default, rename = "appVersion", skip_serializing_if = "Option::is_none")]
        app_version: Option<String>,
        /// Feature flags this peer supports. Desktop advertises e.g. `["images"]`
        /// so the phone can hide attach UI when the Mac is too old.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<String>>,
    },
    #[serde(rename = "pair.submit")]
    PairSubmit { code: String },
    #[serde(rename = "pair.create")]
    PairCreate,
    #[serde(rename = "threads.snapshot")]
    // frames::encode adds snapshotId/chunkIndex/chunkCount only when the
    // catalog exceeds one frame; consumers stage that transport envelope.
    ThreadsSnapshot {
        threads: Vec<RemoteThread>,
        /// Desktop last-used draft defaults so the phone new-chat picker matches.
        #[serde(default, rename = "draftPrefs", skip_serializing_if = "Option::is_none")]
        draft_prefs: Option<super::draft_prefs::RemoteDraftPrefs>,
    },
    #[serde(rename = "threads.upsert")]
    ThreadsUpsert { thread: RemoteThread },
    #[serde(rename = "threads.list")]
    ThreadsList,
    #[serde(rename = "timeline.snapshot")]
    TimelineSnapshot {
        #[serde(rename = "threadId")]
        thread_id: String,
        entries: Vec<MobileTimelineEntry>,
        /// When entries is empty, optional human hint for the phone UI.
        #[serde(default, rename = "emptyHint", skip_serializing_if = "Option::is_none")]
        empty_hint: Option<String>,
    },
    #[serde(rename = "timeline.append")]
    TimelineAppend {
        #[serde(rename = "threadId")]
        thread_id: String,
        entries: Vec<MobileTimelineEntry>,
    },
    #[serde(rename = "timeline.patch")]
    TimelinePatch {
        #[serde(rename = "threadId")]
        thread_id: String,
        entry: MobileTimelineEntry,
    },
    #[serde(rename = "status")]
    Status {
        #[serde(rename = "threadId")]
        thread_id: String,
        processing: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "approval.requested")]
    ApprovalRequested {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        detail: String,
    },
    #[serde(rename = "approval.resolved")]
    ApprovalResolved {
        #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "approval.respond")]
    ApprovalRespond {
        #[serde(rename = "requestId")]
        request_id: String,
        decision: String,
        #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
    },
    #[serde(rename = "userInput.requested")]
    UserInputRequested {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        questions: serde_json::Value,
    },
    #[serde(rename = "userInput.respond")]
    UserInputRespond {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        answers: serde_json::Value,
    },
    #[serde(rename = "userInput.resolved")]
    UserInputResolved {
        #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "thread.subscribe")]
    ThreadSubscribe {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    /// Phone → desktop: user opened this session on the phone — clear the
    /// desktop sidebar green-pulse unread mark (same as selecting it on Mac).
    #[serde(rename = "thread.read")]
    ThreadRead {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "message.send")]
    MessageSend {
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(rename = "threadId")]
        thread_id: String,
        text: String,
        /// Optional base64 image attachments (phone → desktop). Chat surfaces
        /// pass them as multimodal content; terminals save to temp files and
        /// inject quoted paths (desktop InputBar parity).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<RemoteImage>>,
        /// Current composer permission (default | auto | full). Applied on
        /// follow-up turns so a chip change after the first send takes effect.
        #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        #[serde(default, rename = "planMode", skip_serializing_if = "Option::is_none")]
        plan_mode: Option<bool>,
    },
    /// Dispatch succeeded; some providers return before the turn finishes.
    #[serde(rename = "message.accepted")]
    MessageAccepted {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "turn.interrupt")]
    TurnInterrupt {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    /// Phone → desktop: create a new CHAT thread (never a terminal).
    #[serde(rename = "thread.create")]
    ThreadCreate {
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        provider: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        #[serde(default, rename = "fastMode", skip_serializing_if = "Option::is_none")]
        fast_mode: Option<bool>,
        #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        #[serde(default, rename = "planMode", skip_serializing_if = "Option::is_none")]
        plan_mode: Option<bool>,
    },
    /// Desktop → phone: a phone-initiated thread now exists — open it.
    #[serde(rename = "thread.created")]
    ThreadCreated {
        thread: RemoteThread,
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    /// Phone → desktop: change thread model / reasoning effort / fast mode.
    /// Chats apply live where the runtime allows; terminals apply on next resume.
    #[serde(rename = "thread.setConfig")]
    ThreadSetConfig {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        #[serde(default, rename = "fastMode", skip_serializing_if = "Option::is_none")]
        fast_mode: Option<bool>,
        #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        #[serde(default, rename = "planMode", skip_serializing_if = "Option::is_none")]
        plan_mode: Option<bool>,
    },
    /// Phone → desktop: fetch the live model catalog for a provider
    /// (OpenCode / Cursor). Desktop replies with `models.snapshot`.
    /// Curated static lists stay as fallback.
    #[serde(rename = "models.list")]
    ModelsList {
        provider: String,
        #[serde(default, rename = "projectId", skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    /// Desktop → phone: full model catalog for a provider.
    #[serde(rename = "models.snapshot")]
    ModelsSnapshot {
        provider: String,
        models: Vec<RemoteModelOption>,
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    /// Desktop → relay: revoke one paired phone by device id (not raw token).
    #[serde(rename = "devices.revoke")]
    DevicesRevoke {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    /// Desktop → relay: drop every paired phone (e.g. remote disabled).
    #[serde(rename = "devices.revokeAll")]
    DevicesRevokeAll,
    #[serde(rename = "devices.list")]
    DevicesList,
    #[serde(rename = "devices.snapshot")]
    DevicesSnapshot {
        devices: Vec<PairedDevice>,
        /// Phone sockets attached right now (not paired records). Absent from
        /// relays older than this field — treat `None` as "unknown".
        #[serde(default, rename = "phonesOnline", skip_serializing_if = "Option::is_none")]
        phones_online: Option<u32>,
    },
    /// Relay → client control messages
    #[serde(rename = "hello.ok")]
    HelloOk { role: String },
    #[serde(rename = "pair.created")]
    PairCreated {
        code: String,
        #[serde(rename = "expiresAt")]
        expires_at: i64,
    },
    #[serde(rename = "pair.ok")]
    PairOk {
        #[serde(rename = "phoneToken")]
        phone_token: String,
        #[serde(rename = "desktopId")]
        desktop_id: String,
        #[serde(default, rename = "deviceId", skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
    },
    #[serde(rename = "pair.fail")]
    PairFail { reason: String },
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
    },
    #[serde(rename = "desktop.offline")]
    DesktopOffline,
    #[serde(rename = "desktop.online")]
    DesktopOnline {
        /// Friendly Mac name for the phone footer (optional for older relays).
        #[serde(default, rename = "deviceName", skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        /// Desktop app version (from hello); optional for older desktops/relays.
        #[serde(default, rename = "appVersion", skip_serializing_if = "Option::is_none")]
        app_version: Option<String>,
        /// Desktop capabilities (from hello). Absent = treat as none (old Mac).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<String>>,
    },
    /// Client → hub liveness probe; hub replies `pong` without the peer.
    #[serde(rename = "ping")]
    Ping {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

/// Supported chats and existing provider terminals. Legacy MLX agent sessions
/// have no runtime; local models now run through Pi terminals.
/// Cursor is chat-only (`cursor-sdk`); callers still hide subagents.
pub fn is_remote_eligible_provider(provider: &str) -> bool {
    matches!(
        provider,
        "ClaudeCode" | "Codex" | "Grok" | "Gemini" | "OpenCode" | "Cursor" | "Kimi" | "Pi" | "Droid" | "Cline" | "Hermes"
    )
}

pub fn surface_for(provider: &str, interaction_mode: &str) -> &'static str {
    // Canonical mapping lives in the shared dispatch module.
    crate::dispatch::surface_for(provider, interaction_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_request_correlation_survives_wire_roundtrip() {
        for value in [
            serde_json::json!({"type": "thread.create", "provider": "Grok", "projectId": "p1", "requestId": "phone-a-1"}),
            serde_json::json!({"type": "error", "message": "create chat failed", "requestId": "phone-a-1"}),
        ] {
            let message: WireMessage = serde_json::from_value(value).unwrap();
            let output = serde_json::to_value(message).unwrap();
            assert_eq!(output["requestId"], "phone-a-1");
        }
    }

    #[test]
    fn serde_ping_pong() {
        let ping = WireMessage::Ping {
            id: Some("t1".into()),
        };
        let s = serde_json::to_string(&ping).unwrap();
        assert!(s.contains(r#""type":"ping""#));
        assert!(s.contains(r#""id":"t1""#));
        let back: WireMessage = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, WireMessage::Ping { .. }));

        let pong = WireMessage::Pong { id: None };
        let s = serde_json::to_string(&pong).unwrap();
        assert_eq!(s, r#"{"type":"pong"}"#);
        let back: WireMessage = serde_json::from_str(r#"{"type":"pong","id":"x"}"#).unwrap();
        assert!(matches!(back, WireMessage::Pong { id: Some(ref i) } if i == "x"));
    }

    #[test]
    fn serde_hello_roundtrip() {
        let msg = WireMessage::Hello {
            role: "desktop".into(),
            token: "secret".into(),
            desktop_id: Some("d1".into()),
            device_name: Some("Neel's MacBook Pro".into()),
            app_version: Some("3.1.4".into()),
            capabilities: Some(vec!["images".into()]),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"hello""#));
        assert!(json.contains(r#""desktopId":"d1""#));
        assert!(json.contains(r#""deviceName":"Neel's MacBook Pro""#));
        assert!(json.contains(r#""appVersion":"3.1.4""#));
        assert!(json.contains(r#""images""#));
        let back: WireMessage = serde_json::from_str(&json).unwrap();
        match back {
            WireMessage::Hello {
                role,
                token,
                desktop_id,
                device_name,
                app_version,
                capabilities,
            } => {
                assert_eq!(role, "desktop");
                assert_eq!(token, "secret");
                assert_eq!(desktop_id.as_deref(), Some("d1"));
                assert_eq!(device_name.as_deref(), Some("Neel's MacBook Pro"));
                assert_eq!(app_version.as_deref(), Some("3.1.4"));
                assert_eq!(capabilities.as_deref(), Some(&["images".to_string()][..]));
            }
            _ => panic!("wrong variant"),
        }
        // Older phones/desktops without the new fields still deserialize.
        let legacy: WireMessage = serde_json::from_str(
            r#"{"type":"hello","role":"desktop","token":"secret","desktopId":"d1"}"#,
        )
        .unwrap();
        assert!(matches!(
            legacy,
            WireMessage::Hello {
                app_version: None,
                capabilities: None,
                ..
            }
        ));
    }

    #[test]
    fn serde_models_list_snapshot() {
        let list = WireMessage::ModelsList {
            provider: "OpenCode".into(),
            project_id: Some("p1".into()),
            thread_id: None,
            request_id: None,
        };
        let json = serde_json::to_string(&list).unwrap();
        assert!(json.contains(r#""type":"models.list""#));
        assert!(json.contains(r#""projectId":"p1""#));
        let back: WireMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            back,
            WireMessage::ModelsList {
                ref provider,
                project_id: Some(ref pid),
                ..
            } if provider == "OpenCode" && pid == "p1"
        ));

        let snap = WireMessage::ModelsSnapshot {
            provider: "OpenCode".into(),
            request_id: None,
            models: vec![RemoteModelOption {
                slug: "anthropic/claude-sonnet-4-5".into(),
                name: "Anthropic · Claude Sonnet 4.5".into(),
                connected: Some(true),
                supported_reasoning_efforts: None,
                default_reasoning_effort: None,
            }],
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains(r#""type":"models.snapshot""#));
        assert!(json.contains(r#""connected":true"#));
        let _: WireMessage = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn model_catalog_context_survives_wire_roundtrip() {
        for input in [
            serde_json::json!({"type": "models.list", "provider": "OpenCode", "threadId": "task-agent", "requestId": "phone-1"}),
            serde_json::json!({"type": "models.snapshot", "provider": "OpenCode", "models": [], "requestId": "phone-1"}),
        ] {
            let parsed: WireMessage = serde_json::from_value(input.clone()).unwrap();
            let output = serde_json::to_value(parsed).unwrap();
            assert_eq!(output["requestId"], input["requestId"]);
            if input["type"] == "models.list" {
                assert_eq!(output["threadId"], "task-agent");
            }
        }
    }

    #[test]
    fn serde_threads_snapshot() {
        let msg = WireMessage::ThreadsSnapshot {
            threads: vec![RemoteThread {
                id: "t1".into(),
                title: "Fix bug".into(),
                provider: "ClaudeCode".into(),
                interaction_mode: "sdk".into(),
                surface: "chat".into(),
                project_name: Some("agmux".into()),
                project_id: Some("p1".into()),
                task_id: Some("task1".into()),
                task_name: Some("Fix bug".into()),
                worktree_branch: Some("fix/bug".into()),
                project_created_at: Some("2026-07-01 00:00:00".into()),
                project_sort_key: Some(0),
                pinned: false,
                processing: false,
                unread: false,
                needs_approval: false,
                last_active: "2026-07-13".into(),
                model: Some("claude-sonnet-4-5".into()),
                reasoning_effort: Some("high".into()),
                fast_mode: None,
                permission_mode: Some("auto".into()),
                plan_mode: Some(false),
                lines_added: 12,
                lines_removed: 3,
                files_changed: 2,
                status: "Idle".into(),
            }],
            draft_prefs: Some(crate::remote::draft_prefs::RemoteDraftPrefs {
                provider: "ClaudeCode".into(),
                model: "sonnet".into(),
                reasoning_effort: Some("high".into()),
                permission_mode: Some("auto".into()),
            }),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"threads.snapshot""#));
        assert!(json.contains(r#""interactionMode":"sdk""#));
        assert!(json.contains(r#""draftPrefs""#));
        assert!(json.contains(r#""permissionMode":"auto""#));
        let _: WireMessage = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn serde_set_config_permission_mode() {
        let json = r#"{"type":"thread.setConfig","threadId":"t1","permissionMode":"full"}"#;
        let msg: WireMessage = serde_json::from_str(json).unwrap();
        match msg {
            WireMessage::ThreadSetConfig {
                thread_id,
                permission_mode,
                ..
            } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(permission_mode.as_deref(), Some("full"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn serde_message_send_permission_mode_after_first_turn() {
        let json = r#"{"type":"message.send","threadId":"t1","text":"go","permissionMode":"full"}"#;
        let msg: WireMessage = serde_json::from_str(json).unwrap();
        match msg {
            WireMessage::MessageSend {
                thread_id,
                text,
                permission_mode,
                ..
            } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(text, "go");
                assert_eq!(permission_mode.as_deref(), Some("full"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn surface_for_modes() {
        assert_eq!(surface_for("ClaudeCode", "sdk"), "chat");
        assert_eq!(surface_for("ClaudeCode", "pty"), "terminal");
        assert_eq!(surface_for("Grok", "grok-sdk"), "chat");
        assert_eq!(surface_for("Grok", "pty"), "terminal");
        assert_eq!(surface_for("Gemini", "gemini-sdk"), "chat");
        assert_eq!(surface_for("Gemini", "pty"), "terminal");
        assert_eq!(surface_for("Codex", "pty"), "terminal");
    }

    #[test]
    fn gemini_is_remote_eligible() {
        assert!(is_remote_eligible_provider("Gemini"));
        assert!(is_remote_eligible_provider("Grok"));
        for provider in ["Cline", "Hermes", "Droid"] {
            assert!(is_remote_eligible_provider(provider), "missing {provider}");
            assert_eq!(surface_for(provider, "pty"), "terminal");
        }
        assert!(!is_remote_eligible_provider("MLX"), "retired MLX agent cannot accept messages");
    }
}
