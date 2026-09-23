export const DEFAULT_CURSOR_MODEL = "composer-2.5";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeModelId(value) {
  const id = String(value ?? "").trim();
  return id || DEFAULT_CURSOR_MODEL;
}

function normalizeParams(params, { sort = false } = {}) {
  let entries = [];

  if (Array.isArray(params)) {
    entries = params.map((param) => [param?.id ?? param?.key, param?.value]);
  } else if (isObject(params)) {
    entries = Object.entries(params);
  }

  const normalized = entries
    .map(([id, value]) => ({
      id: String(id ?? "").trim(),
      value: value == null ? "" : String(value),
    }))
    .filter((param) => param.id && param.value !== "");

  if (sort) {
    normalized.sort((a, b) => a.id.localeCompare(b.id));
  }

  return normalized;
}

export function parseCursorModelSlug(slug) {
  const raw = String(slug ?? "").trim();
  const withDefault = raw || DEFAULT_CURSOR_MODEL;
  const queryIndex = withDefault.indexOf("?");
  const id = normalizeModelId(
    queryIndex === -1 ? withDefault : withDefault.slice(0, queryIndex),
  );
  const query = queryIndex === -1 ? "" : withDefault.slice(queryIndex + 1);
  const params = [];

  for (const [paramId, value] of new URLSearchParams(query)) {
    const id = String(paramId ?? "").trim();
    if (!id || value === "") continue;
    params.push({ id, value });
  }

  return params.length > 0 ? { id, params } : { id };
}

export function serializeCursorModelSelection(model) {
  const normalized = normalizeCursorModel(model);
  const params = normalizeParams(normalized.params, { sort: true });
  if (params.length === 0) {
    return normalized.id;
  }

  const query = new URLSearchParams();
  for (const param of params) {
    query.append(param.id, param.value);
  }
  return `${normalized.id}?${query.toString()}`;
}

export function normalizeCursorModel(slugOrSelection) {
  if (!isObject(slugOrSelection)) {
    return parseCursorModelSlug(slugOrSelection);
  }

  const id = normalizeModelId(slugOrSelection.id);
  const params = normalizeParams(slugOrSelection.params, {
    sort: !Array.isArray(slugOrSelection.params),
  });

  return params.length > 0 ? { id, params } : { id };
}

export function buildCursorUserMessage(text, images = []) {
  const message = { text: text ?? "" };
  if (!Array.isArray(images) || images.length === 0) {
    return message;
  }

  const mappedImages = [];
  for (const image of images) {
    if (!isObject(image)) continue;

    const data = image.data ?? image.base64;
    const url = image.url;
    if (data == null && url == null) continue;

    const mapped = {};
    if (data != null) mapped.data = data;
    if (url != null) mapped.url = url;

    const mimeType = image.mimeType ?? image.mediaType;
    if (mimeType != null) mapped.mimeType = mimeType;

    if (image.dimension != null) {
      mapped.dimension = image.dimension;
    }

    mappedImages.push(mapped);
  }

  return mappedImages.length > 0 ? { ...message, images: mappedImages } : message;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return "";
}

function assistantContentBlocks(msg) {
  const content = msg?.message?.content ?? msg?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  const text = firstString(msg?.text);
  return text ? [{ type: "text", text }] : [];
}

function toolCallId(msg) {
  const id = msg?.call_id ?? msg?.callId ?? msg?.id ?? msg?.toolUseId;
  return String(id ?? "").trim();
}

function toolName(value) {
  return value?.name ?? value?.tool_name ?? value?.toolName ?? value?.tool ?? "unknown";
}

function serializeToolResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;

  try {
    const json = JSON.stringify(result);
    if (typeof json === "string") return json;
  } catch {
    // Fall through to String below.
  }

  try {
    return String(result);
  } catch {
    return "[unserializable]";
  }
}

function toolCallResultContent(msg, isError) {
  const content = serializeToolResult(msg?.result ?? msg?.output);
  if (content || !isError) return content;

  return serializeToolResult(msg?.error ?? msg?.message) || "Tool failed";
}

/**
 * Normalize Cursor tool args into shapes ToolUseBlock already understands.
 * Cursor uses public names (shell/read/edit/…) and varied arg keys.
 */
function normalizeToolInput(input, name) {
  const raw = isObject(input) ? { ...input } : {};
  const tool = String(name ?? "").toLowerCase();

  // Shell / terminal
  if (tool === "shell" || tool === "bash" || tool === "run_terminal_command") {
    if (!raw.command) {
      const cmd = firstString(raw.cmd, raw.shell_command, raw.script, raw.input);
      if (cmd) raw.command = cmd;
    }
    if (!raw.working_directory && raw.workingDirectory) {
      raw.working_directory = raw.workingDirectory;
    }
    if (!raw.cwd && raw.working_directory) raw.cwd = raw.working_directory;
  }

  // Read / write / edit paths
  if (!raw.file_path) {
    const path = firstString(
      raw.path,
      raw.filePath,
      raw.filename,
      raw.target_file,
      raw.targetFile,
    );
    if (path) raw.file_path = path;
  }
  if (!raw.path && raw.file_path) raw.path = raw.file_path;

  // Cursor write uses `fileText`; Claude/OpenCode use `content`.
  if (!raw.content) {
    const body = firstString(raw.fileText, raw.contents);
    if (body) raw.content = body;
  }

  // Cursor apply-patch variant.
  if (!raw.patch) {
    const patch = firstString(raw.patchContent, raw.diff);
    if (patch) raw.patch = patch;
  }

  // Edit old/new strings — Cursor uses oldText/newText.
  if (!raw.old_string) {
    const oldS = firstString(raw.oldString, raw.oldText, raw.old, raw.old_text);
    if (oldS) raw.old_string = oldS;
  }
  if (!raw.new_string) {
    const newS = firstString(
      raw.newString,
      raw.newText,
      raw.new,
      raw.new_text,
      raw.contents,
      raw.content,
    );
    if (newS) raw.new_string = newS;
  }

  if (Array.isArray(raw.edits)) {
    raw.edits = raw.edits.map((edit) => {
      if (!isObject(edit)) return edit;
      const next = { ...edit };
      if (!next.old_string) {
        const oldS = firstString(next.oldString, next.oldText, next.old);
        if (oldS) next.old_string = oldS;
      }
      if (!next.new_string) {
        const newS = firstString(next.newString, next.newText, next.new);
        if (newS) next.new_string = newS;
      }
      return next;
    });
  }

  // Grep / search
  if (!raw.pattern) {
    const pattern = firstString(raw.query, raw.regex, raw.search, raw.needle);
    if (pattern) raw.pattern = pattern;
  }

  return raw;
}

/** Map Cursor public tool names onto agmux renderer aliases where helpful. */
export function normalizeCursorToolName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "unknown";
  const key = raw.toLowerCase();
  const map = {
    shell: "shell",
    bash: "Bash",
    read: "read",
    edit: "edit",
    write: "write",
    delete: "delete",
    grep: "grep",
    glob: "glob",
    ls: "list_dir",
    task: "task",
    agent: "agent",
    mcp: "mcp",
    websearch: "web_search",
    webfetch: "web_fetch",
    semsearch: "semSearch",
    readlints: "readLints",
    updatetodos: "todo_write",
    readtodos: "todo_write",
    askquestion: "AskUserQuestion",
    generateimage: "generateImage",
    applyagentdiff: "apply_patch",
  };
  return map[key] ?? raw;
}

function pushToolStarted(events, seenToolStarts, { id, name, input }) {
  if (!id || seenToolStarts.has(id)) return false;

  const displayName = normalizeCursorToolName(name);
  seenToolStarts.add(id);
  events.push({
    type: "tool.started",
    toolUseId: id,
    name: displayName,
    input: normalizeToolInput(input, displayName),
  });
  return true;
}

function mapAssistantMessage(msg, seenToolStarts) {
  const events = [];

  for (const block of assistantContentBlocks(msg)) {
    if (block?.type === "text") {
      const text = firstString(block.text);
      if (text) {
        events.push({ type: "content.delta", contentType: "text", text });
      }
      continue;
    }

    if (block?.type === "thinking") {
      const text = firstString(block.text, block.thinking);
      if (text) {
        events.push({ type: "content.delta", contentType: "thinking", text });
      }
      continue;
    }

    if (block?.type === "tool_use") {
      pushToolStarted(events, seenToolStarts, {
        id: toolCallId(block),
        name: toolName(block),
        input: block.input ?? block.args,
      });
    }
  }

  return events;
}

function mapToolCall(msg, seenToolStarts) {
  const events = [];
  const id = toolCallId(msg);
  if (!id) return events;

  const status = String(msg?.status ?? "").toLowerCase();
  const name = normalizeCursorToolName(toolName(msg));
  const isTerminal =
    status === "completed" ||
    status === "complete" ||
    status === "finished" ||
    status === "error" ||
    status === "failed";

  if (!seenToolStarts.has(id)) {
    pushToolStarted(events, seenToolStarts, {
      id,
      name,
      input: msg?.args ?? msg?.input,
    });
  }

  if (isTerminal) {
    const isError = status === "error" || status === "failed" || msg?.is_error === true;
    events.push({
      type: "tool.completed",
      toolUseId: id,
      name,
      content: toolCallResultContent(msg, isError),
      isError,
    });
  }

  return events;
}

function normalizeTaskStatus(status) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "completed" || normalized === "complete" || normalized === "finished") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (normalized === "stopped" || normalized === "cancelled" || normalized === "canceled") {
    return "stopped";
  }
  return null;
}

function mapTaskMessage(msg) {
  return [
    {
      type: "task.notification",
      taskId: msg?.task_id ?? msg?.taskId ?? msg?.id ?? null,
      title: msg?.title ?? "Task",
      body: firstString(msg?.body, msg?.text, msg?.message),
      status: normalizeTaskStatus(msg?.status),
      summary: msg?.summary ?? null,
    },
  ];
}

function mapRequestMessage(msg) {
  const requestId = msg?.request_id ?? msg?.requestId ?? msg?.id ?? null;
  // Cursor SDK request frames are not interactive approvals (no respond API).
  // Surface as status so the chat doesn't look stuck waiting for a banner.
  return [
    {
      type: "status",
      status: "request",
      message:
        firstString(msg?.message, msg?.text) ||
        (requestId
          ? `Cursor is waiting on a request (${requestId}). Use Chat/Plan and permission mode (Supervised / Auto / Full) to control tool policy.`
          : "Cursor is waiting on a request. Use Chat/Plan and permission mode to control tool policy."),
      requestId,
    },
  ];
}

/**
 * Normalize Cursor TokenUsage (and Claude-like aliases) to the flat Claude SDK
 * usage shape the frontend ContextRing expects.
 *
 * Cursor uses cacheWriteTokens; Claude uses cacheCreationTokens. The chat top
 * bar only reads flat fields on `usage.update` / nested `usage` on
 * `turn.completed` — never a nested object under `usage.update`.
 */
export function normalizeCursorTokenUsage(usage) {
  const src = isObject(usage) ? usage : {};
  const inputTokens = Number(src.inputTokens ?? src.input_tokens ?? 0) || 0;
  const outputTokens = Number(src.outputTokens ?? src.output_tokens ?? 0) || 0;
  const cacheCreationTokens =
    Number(
      src.cacheCreationTokens ??
        src.cache_creation_input_tokens ??
        src.cacheWriteTokens ??
        src.cache_write_tokens ??
        0,
    ) || 0;
  const cacheReadTokens =
    Number(src.cacheReadTokens ?? src.cache_read_input_tokens ?? 0) || 0;
  const totalRaw = src.totalTokens ?? src.total_tokens;
  const totalTokens =
    totalRaw == null || totalRaw === ""
      ? null
      : Number(totalRaw) || 0;
  const totalCostUsd =
    Number(src.totalCostUsd ?? src.total_cost_usd ?? 0) || 0;
  const numTurns = Number(src.numTurns ?? src.num_turns ?? 1) || 1;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    totalCostUsd,
    numTurns,
  };
}

function mapUsageMessage(msg) {
  // Cursor may put TokenUsage on msg.usage or (less commonly) the message root.
  const normalized = normalizeCursorTokenUsage(msg?.usage ?? msg);
  if (
    !normalized.inputTokens &&
    !normalized.outputTokens &&
    !normalized.cacheCreationTokens &&
    !normalized.cacheReadTokens &&
    !normalized.totalTokens
  ) {
    return [];
  }
  // Flat Claude-shaped event — ClaudeSdkSessionView reads sdkEvent.inputTokens etc.
  return [
    {
      type: "usage.update",
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cacheCreationTokens: normalized.cacheCreationTokens,
      cacheReadTokens: normalized.cacheReadTokens,
      totalTokens: normalized.totalTokens,
    },
  ];
}

function mapSystemMessage(msg) {
  if (msg?.subtype && msg.subtype !== "init") return [];
  const slashCommands = Array.isArray(msg?.slash_commands)
    ? msg.slash_commands
    : Array.isArray(msg?.slashCommands)
      ? msg.slashCommands
      : [];
  return [
    {
      type: "session.init",
      sessionId: msg?.session_id ?? msg?.sessionId ?? null,
      slashCommands: slashCommands.filter((command) => typeof command === "string"),
    },
  ];
}

export function mapCursorMessageToEvents(msg, seenToolStarts = new Set()) {
  if (!isObject(msg)) return [];

  switch (msg.type) {
    case "assistant":
      return mapAssistantMessage(msg, seenToolStarts);

    case "thinking": {
      const text = firstString(msg.text, msg.thinking);
      return text ? [{ type: "content.delta", contentType: "thinking", text }] : [];
    }

    case "tool_call":
      return mapToolCall(msg, seenToolStarts);

    case "status": {
      // Only forward an explicit human message — never invent one from the
      // status code. Cursor often emits bare FINISHED / RUNNING / IDLE frames
      // that would otherwise appear as random italic system lines in chat.
      const explicit = firstString(msg.message, msg.status_message, msg.text, msg.body);
      return [
        {
          type: "status",
          status: msg.status ?? null,
          message: explicit,
        },
      ];
    }

    case "task":
      return mapTaskMessage(msg);

    case "request":
      return mapRequestMessage(msg);

    case "usage":
      return mapUsageMessage(msg);

    case "system":
      return mapSystemMessage(msg);

    default:
      return [];
  }
}
