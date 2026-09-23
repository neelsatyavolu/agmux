import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const text = value => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const clip = value => text(value).slice(0, 64000);
const agentTool = name => /^(agent|task|dispatch_agent)$/i.test(name ?? "");
const contentText = value => Array.isArray(value) ? value.map(contentText).join("\n") : text(value?.text ?? value?.message ?? value);

function cursorStep(step, index) {
  const id = `step-${index}`;
  for (const [key, type] of [["assistantMessage", "assistant"], ["thinkingMessage", "thinking"], ["userMessage", "user"]]) {
    if (step?.[key]) return { id, type, text: contentText(step[key]) };
  }
  const call = step?.toolCall;
  if (!call || typeof call !== "object") return null;
  const [key, data] = Object.entries(call).find(([key]) => key.endsWith("ToolCall")) ?? [call.type ?? "Tool", call];
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = data.result;
  const failureLabels = { error: "Tool failed", rejected: "Rejected", fileNotFound: "File not found", permissionDenied: "Permission denied", invalidFile: "Invalid file" };
  const failureKind = result && Object.keys(failureLabels).find(kind => result[kind] != null);
  const failure = failureKind ? result[failureKind] : null;
  const failureText = typeof failure === "string" ? failure : failure?.message ?? failure?.error ?? failure?.reason
    ?? (failureKind ? `${failureLabels[failureKind]}${failure?.path ? `: ${failure.path}` : ""}` : null);
  return {
    id: call.id ?? id, type: "tool", text: "", toolName: key.replace(/ToolCall$/, ""), toolInput: data.args ?? {},
    ...(result ? { toolResult: text(failureText ?? result.value ?? result.success ?? result), isError: result.status === "error" || !!failureKind } : {}),
    pending: !result,
  };
}

// Read-only inspector snapshots: never send provider messages or emit parent events.
// Bounded, coalesced writes keep token-rate updates off the filesystem hot path.
export class SubagentConversations {
  constructor(threadId, { root = join(homedir(), ".agmux", "threads"), onError = () => {} } = {}) {
    this.directory = safeId(threadId) ? join(root, threadId, "subagent-conversations") : null;
    this.records = new Map();
    this.streams = new Map();
    this.dirty = new Set();
    this.timer = null;
    this.onError = onError;
  }

  get(id) {
    if (!this.directory || !safeId(id)) return null;
    let record = this.records.get(id);
    if (!record) {
      if (this.records.size >= 64) {
        this.flush();
        const oldest = this.records.keys().next().value;
        this.records.delete(oldest);
        this.streams.delete(oldest);
      }
      try {
        const saved = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8"));
        if (saved.toolUseId === id && Array.isArray(saved.items)) record = saved;
      } catch { /* New children have no snapshot yet. */ }
      record ??= { childId: null, toolUseId: id, status: "running", items: [] };
      this.records.set(id, record);
    }
    return record;
  }

  changed(record) {
    if (!record) return;
    if (record.items.length > 500) {
      record.items.splice(1, record.items.length - 500);
      record.unavailableReason = "Earlier activity was trimmed from the live capture.";
    }
    this.dirty.add(record.toolUseId);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 200);
      this.timer.unref();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const record = this.records.get(id);
        let serialized = JSON.stringify(record);
        if (serialized.length > 4 * 1024 * 1024 && record.items.length > 1) {
          record.unavailableReason = "Earlier activity was trimmed from the live capture.";
          let size = JSON.stringify(record).length;
          let remove = 0;
          // Account for each removed item and its comma, then serialize once.
          // Rewriting the full snapshot for every item stalls the event loop.
          while (size > 4 * 1024 * 1024 && remove < record.items.length - 1) {
            size -= JSON.stringify(record.items[1 + remove]).length + 1;
            remove++;
          }
          record.items.splice(1, remove);
          serialized = JSON.stringify(record);
        }
        const destination = join(this.directory, `${id}.json`);
        const temporary = `${destination}.${process.pid}.tmp`;
        writeFileSync(temporary, serialized, { mode: 0o600 });
        renameSync(temporary, destination);
      } catch (error) { this.onError(error); }
    }
    this.dirty.clear();
  }

  item(record, item) {
    const existing = record.items.find(value => value.id === item.id);
    if ([item.text, item.toolResult, item.toolInput].some(value => text(value).length > 64000)) {
      record.unavailableReason = "Long message or tool content was trimmed from the live capture.";
    }
    const bounded = { ...item, text: clip(item.text) };
    if (item.toolResult != null) bounded.toolResult = clip(item.toolResult);
    if (item.toolInput && text(item.toolInput).length > 64000) bounded.toolInput = { preview: clip(item.toolInput) };
    if (existing) Object.assign(existing, bounded);
    else record.items.push(bounded);
    this.changed(record);
  }

  assignment(record, prompt) {
    if (prompt && !record.items.some(item => item.id === "assignment")) {
      this.item(record, { id: "assignment", type: "user", text: clip(prompt) });
    }
  }

  terminalText(record, content) {
    const value = contentText(content);
    if (value && !record.items.some(item => item.type === "assistant" && item.text === clip(value))) {
      this.item(record, { id: "terminal-result", type: "assistant", text: value });
    }
  }

  waiting(toolId, agentId, waiting) {
    const record = [...this.records.values()].find(value =>
      (agentId && value.childId === agentId) || value.items.some(item => item.id === toolId));
    if (record && ["running", "waiting"].includes(record.status)) {
      record.status = waiting ? "waiting" : "running";
      this.changed(record);
    }
  }

  claude(msg) {
    const parentId = msg.parent_tool_use_id;
    const record = parentId ? this.get(parentId) : null;
    if (parentId && !record) return;
    if (msg.type === "system" && msg.subtype?.startsWith("task_")) {
      const task = msg.tool_use_id ? this.get(msg.tool_use_id) : [...this.records.values()].find(value => value.childId === msg.task_id);
      if (!task) return;
      if (msg.task_id) task.childId = msg.task_id;
      this.assignment(task, msg.prompt);
      const status = msg.patch?.status ?? msg.status;
      if (status) task.status = status === "completed" ? "completed" : ["failed", "killed", "stopped"].includes(status) ? "failed" : ["paused", "pending"].includes(status) ? "waiting" : "running";
      if (msg.subtype === "task_notification") this.terminalText(task, msg.summary);
      this.changed(task);
      return;
    }
    if (record && msg.type === "stream_event") {
      const event = msg.event;
      if (event.type === "message_start") this.streams.set(parentId, { messageId: event.message?.id ?? msg.uuid, sequence: 0 });
      const stream = this.streams.get(parentId);
      if (stream && event.type === "content_block_delta") {
        const delta = event.delta;
        const type = delta?.type === "text_delta" ? "assistant" : delta?.type === "thinking_delta" ? "thinking" : null;
        if (type) {
          const id = `${stream.messageId}:${event.index}`;
          const existing = record.items.find(item => item.id === id);
          this.item(record, { id, type, text: (existing?.text ?? "") + (delta.text ?? delta.thinking ?? "") });
        }
      }
      return;
    }
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      const messageId = msg.message?.id ?? msg.uuid ?? `${msg.type}-${record?.items.length ?? 0}`;
      for (const [index, block] of content.entries()) {
        if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(block.type)) {
          if (agentTool(block.name)) {
            const child = this.get(block.id);
            if (child) { this.assignment(child, block.input?.prompt ?? block.input?.description); this.changed(child); }
          }
          if (record) this.item(record, { id: block.id, type: "tool", text: "", toolName: block.name ?? block.server_tool_name ?? "Tool", toolInput: block.input ?? {}, pending: true });
        } else if (block.type === "tool_result") {
          if (record) this.item(record, { id: block.tool_use_id, type: "tool", text: "", toolResult: text(block.content), isError: !!block.is_error, pending: false });
          const child = this.records.get(block.tool_use_id);
          if (child) {
            // Background launches return before their child finishes; task notifications own status.
            const result = text(block.content);
            const background = /launched asynchronously|running in the background|isBackground.*true/i.test(result);
            if (block.is_error) child.status = "failed";
            else if (!background) child.status = "completed";
            if (block.is_error || !background) this.terminalText(child, block.content);
            const agentId = result.match(/agentId:\s*([A-Za-z0-9_-]+)/)?.[1];
            if (agentId) child.childId = agentId;
            this.changed(child);
          }
        } else if (record && ["text", "thinking"].includes(block.type)) {
          this.item(record, { id: `${messageId}:${index}`, type: block.type === "thinking" ? "thinking" : msg.type === "user" ? "user" : "assistant", text: block.text ?? block.thinking ?? "" });
        }
      }
    } else if (record && typeof content === "string") {
      this.item(record, { id: msg.uuid ?? `${msg.type}-${record.items.length}`, type: msg.type === "user" ? "user" : "assistant", text: content });
    }
    if (record && msg.type === "result") {
      record.status = msg.is_error ? "failed" : "completed";
      this.terminalText(record, msg.result ?? msg.errors);
      this.changed(record);
    }
  }

  cursor(update) {
    if (!update) return;
    const tool = update.toolCall;
    if (tool?.type === "task" && update.callId) {
      const record = this.get(update.callId);
      if (!record) return;
      this.assignment(record, tool.args?.prompt ?? tool.args?.description);
      const value = tool.result?.value;
      record.childId = value?.agentId ?? tool.args?.agentId ?? record.childId;
      if (update.type === "tool-call-completed") {
        record.status = tool.result?.status === "error" ? "failed" : value?.isBackground ? "running" : "completed";
        // The SDK returns protobuf JSON steps as the completed conversation.
        // Replace partial streaming rows only when this result retains all activity.
        const steps = Array.isArray(value?.conversationSteps) ? value.conversationSteps.map(cursorStep).filter(Boolean) : [];
        if (steps.length && steps.length >= record.items.filter(item => item.id !== "assignment" && item.id !== "terminal-result").length) {
          record.items = record.items.filter(item => item.id === "assignment");
          this.streams.delete(update.callId);
          for (const item of steps) this.item(record, item);
        }
        if (tool.result?.status === "error") this.terminalText(record, tool.result.error);
        else if (!value?.isBackground) this.terminalText(record, value?.resultSuffix);
      }
      this.changed(record);
    }
    if (update.type !== "tool-call-delta" || !update.taskUpdate) return;
    const record = this.get(update.callId);
    if (!record) return;
    const child = update.taskUpdate;
    let stream = this.streams.get(update.callId);
    if (!stream) { stream = { sequence: record.items.length, activeId: null, activeType: null }; this.streams.set(update.callId, stream); }
    if (["text-delta", "thinking-delta"].includes(child.type)) {
      const type = child.type === "text-delta" ? "assistant" : "thinking";
      if (!stream.activeId || stream.activeType !== type) { stream.activeId = `delta-${++stream.sequence}`; stream.activeType = type; }
      const existing = record.items.find(item => item.id === stream.activeId);
      this.item(record, { id: stream.activeId, type, text: (existing?.text ?? "") + child.text });
    } else {
      stream.activeId = null;
      if (["tool-call-started", "tool-call-completed", "partial-tool-call"].includes(child.type) && child.toolCall) {
        const tool = child.toolCall;
        if (tool.type === "askQuestion") record.status = child.type === "tool-call-completed" ? "running" : "waiting";
        this.item(record, { id: child.callId, type: "tool", text: "", toolName: tool.type, toolInput: tool.args ?? {}, ...(tool.result ? { toolResult: text(tool.result.value ?? tool.result.error), isError: tool.result.status === "error" } : {}), pending: child.type !== "tool-call-completed" });
      }
    }
  }
}
