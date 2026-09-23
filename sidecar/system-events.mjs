export function systemMessageToEvents(msg) {
  if (msg?.type !== "system") {
    return [];
  }

  if (msg.subtype === "task_notification") {
    return [
      {
        event: "task.notification",
        taskId: msg.task_id ?? null,
        title: msg.title ?? "Notification",
        body: msg.body ?? "",
        status: msg.status ?? null,
        summary: msg.summary ?? null,
      },
    ];
  }

  if (msg.subtype === "init") {
    const cmds = msg.slash_commands ?? [];
    process.stderr.write(`[system-events] session.init: ${cmds.length} slash commands: ${cmds.join(", ")}\n`);
    return [
      {
        event: "session.init",
        sessionId: msg.session_id ?? null,
        slashCommands: cmds,
      },
    ];
  }

  if (msg.subtype === "compact_boundary") {
    return [
      {
        event: "compact.boundary",
        preTokens: msg.compact_metadata?.pre_tokens ?? null,
        trigger: msg.compact_metadata?.trigger ?? null,
      },
    ];
  }

  if (msg.subtype === "status") {
    return [
      {
        event: "status",
        status: msg.status ?? null,
        message: msg.status_message ?? msg.body ?? "",
      },
    ];
  }

  if (msg.subtype === "hook_started") {
    return [
      {
        event: "hook.started",
        ...(typeof msg.hook_id === "string" && msg.hook_id ? { hookId: msg.hook_id } : {}),
        hookName: msg.hook_name ?? "unknown",
        hookEvent: msg.hook_event ?? "",
      },
    ];
  }

  if (msg.subtype === "hook_response") {
    return [
      {
        event: "hook.response",
        ...(typeof msg.hook_id === "string" && msg.hook_id ? { hookId: msg.hook_id } : {}),
        hookName: msg.hook_name ?? "unknown",
        hookEvent: msg.hook_event ?? "",
        outcome: msg.outcome ?? "unknown",
        exitCode: msg.exit_code ?? null,
      },
    ];
  }

  if (msg.subtype === "task_started") {
    return [
      {
        event: "task.started",
        taskId: msg.task_id ?? null,
        description: msg.task_description ?? msg.body ?? "",
      },
    ];
  }

  if (msg.subtype === "task_progress") {
    return [
      {
        event: "task.progress",
        taskId: msg.task_id ?? null,
        status: msg.status ?? msg.body ?? "",
        lastToolName: msg.last_tool_name ?? null,
        usage: msg.usage
          ? {
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
              cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
              totalTokens: msg.usage.total_tokens ?? null,
              toolUses: msg.usage.tool_uses ?? 0,
              durationMs: msg.usage.duration_ms ?? 0,
            }
          : null,
      },
    ];
  }

  if (msg.subtype === "local_command_output") {
    return [
      {
        event: "command.output",
        command: msg.command ?? "",
        output: msg.output ?? msg.body ?? "",
      },
    ];
  }

  if (msg.subtype === "files_persisted") {
    return [
      {
        event: "files.persisted",
        files: Array.isArray(msg.files)
          ? msg.files.filter(Boolean).map((f) => ({ filename: f.filename ?? "", fileId: f.file_id ?? "" }))
          : [],
        failed: Array.isArray(msg.failed)
          ? msg.failed.filter(Boolean).map((f) => ({ filename: f.filename ?? "", error: f.error ?? "" }))
          : [],
        uuid: msg.uuid ?? null,
        sessionId: msg.session_id ?? null,
      },
    ];
  }

  return [];
}
