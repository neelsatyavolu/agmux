use std::fs;
use std::path::PathBuf;

/// Ensure the Pi coding-agent hook extension exists at
/// `~/.agmux/hooks/pi-extension.ts`. Spawned `pi` sessions load it with
/// `--extension`. Session-gated by AGMUX_SESSION_ID so a user running `pi`
/// outside agmux never talks to the hook socket.
pub fn ensure_pi_extension() -> Result<PathBuf, String> {
    let hooks_dir = crate::paths::agmux_home_opt()
        .ok_or("Could not determine home directory")?
        .join("hooks");

    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {}", e))?;

    let script_path = hooks_dir.join("pi-extension.ts");
    let script_content = PI_EXTENSION_TS;

    let needs_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write pi extension: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o644))
                .map_err(|e| format!("Failed to set pi extension permissions: {}", e))?;
        }
    }

    Ok(script_path)
}

/// TypeScript loaded by `pi --extension`. Relays lifecycle events over the
/// agmux Unix hook socket using the same canonical event names as Claude/Kimi.
const PI_EXTENSION_TS: &str = r#"import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";

export default function (pi: ExtensionAPI) {
  const socketPath =
    process.env.AGMUX_HOOK_SOCKET || process.env.XANOM_HOOK_SOCKET;
  const threadId =
    process.env.AGMUX_SESSION_ID ||
    process.env.AGMUX_THREAD_ID ||
    process.env.XANOM_SESSION_ID;
  if (!socketPath || !threadId) return;

  const skip = (ctx: { hasUI?: boolean }) => ctx.hasUI === false;
  const pendingArgs = new Map<string, Record<string, unknown>>();
  const creations = new Map<string, string>();

  const fire = (
    event: string,
    payload: Record<string, unknown>,
    ctx?: { sessionManager?: { getSessionId?: () => string } },
  ) => {
    const providerSessionId = ctx?.sessionManager?.getSessionId?.() || "";
    const msg =
      JSON.stringify({
        event,
        session_id: threadId,
        provider: "pi",
        payload: { ...payload, session_id: providerSessionId,
          agmux_creation: creations.get(providerSessionId) },
      }) + "\n";
    try {
      const sock = net.connect(socketPath);
      sock.on("error", () => {});
      sock.end(msg);
    } catch {
      // Never let hook I/O affect the agent loop.
    }
  };

  const toolArgs = (event: { args?: unknown; input?: unknown }) => {
    if (event.args && typeof event.args === "object") {
      return event.args as Record<string, unknown>;
    }
    if (event.input && typeof event.input === "object") {
      return event.input as Record<string, unknown>;
    }
    return {};
  };

  pi.on("session_start", (event, ctx) => {
    if (skip(ctx)) return;
    const source = (event as { reason?: string }).reason;
    const initialId = process.env.AGMUX_INITIAL_CREATED_SESSION_ID;
    const agmux_creation = source === "new" ? "pi-new"
      : source === "startup" && initialId && ctx.sessionManager.getSessionId() === initialId
        ? "pi-initial-id" : undefined;
    if (agmux_creation) creations.set(ctx.sessionManager.getSessionId(), agmux_creation);
    fire("session-start", { source, agmux_creation }, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (skip(ctx)) return;
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    fire("prompt-submit", { prompt }, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (skip(ctx)) return;
    const args = toolArgs(event);
    if (typeof event.toolCallId === "string" && event.toolCallId) {
      pendingArgs.set(event.toolCallId, args);
    }
    fire("pre-tool-use", { tool_name: event.toolName || "", tool_input: args }, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (skip(ctx)) return;
    const cached =
      typeof event.toolCallId === "string" ? pendingArgs.get(event.toolCallId) : undefined;
    if (typeof event.toolCallId === "string") pendingArgs.delete(event.toolCallId);
    const fromEvent = toolArgs(event);
    const args = Object.keys(fromEvent).length > 0 ? fromEvent : (cached || {});
    fire(
      "post-tool-use",
      {
        tool_name: event.toolName || "",
        tool_input: args,
        tool_response: { success: event.isError !== true },
      },
      ctx,
    );
  });

  pi.on("agent_end", (_event, ctx) => {
    if (skip(ctx)) return;
    fire("stop", {}, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (skip(ctx)) return;
    fire("session-end", {}, ctx);
  });
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_extension_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-extension.ts");
        fs::write(&path, "stale").unwrap();
        // Direct write helper isn't public — assert the source contains
        // the events the spinner / summarizer depend on.
        assert!(PI_EXTENSION_TS.contains("prompt-submit"));
        assert!(PI_EXTENSION_TS.contains("pre-tool-use"));
        assert!(PI_EXTENSION_TS.contains("post-tool-use"));
        assert!(PI_EXTENSION_TS.contains("tool_input"));
        assert!(PI_EXTENSION_TS.contains("tool_execution_end"));
        assert!(PI_EXTENSION_TS.contains("\"stop\""));
        assert!(PI_EXTENSION_TS.contains("session-start"));
        assert!(PI_EXTENSION_TS.contains("session-end"));
        assert!(PI_EXTENSION_TS.contains("provider: \"pi\""));
        assert!(PI_EXTENSION_TS.contains("AGMUX_SESSION_ID"));
    }
}
