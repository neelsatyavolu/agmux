import { mergeAssistantText } from './opencode-text-merge.mjs';
import { randomUUID } from 'node:crypto';

const PERMISSION_KIND = {
  bash: 'command_execution_approval',
  read: 'file_read_approval',
  edit: 'file_change_approval',
  webfetch: 'web_fetch_approval',
  websearch: 'web_search_approval',
};

export function createMapper() {
  const textByPartId = new Map();
  const seenToolStart = new Set();
  // Last emitted token snapshot per assistant messageID — lets us suppress
  // duplicate usage_update events when message.updated fires without any
  // token change (e.g. finish/metadata-only updates).
  const lastMessageUsage = new Map();

  // Emit a `usage_update` event when an assistant message update carries
  // token data. OpenCode's `AssistantMessage.tokens` is cumulative for the
  // message and is updated live during streaming, so firing on every change
  // makes the context ring appear as soon as the first token arrives —
  // matching Claude SDK's mid-turn `usage.update` behavior.
  function mapMessageUpdate(event) {
    const info = event?.info;
    if (!info || info.role !== 'assistant') return [];
    const tokens = info.tokens;
    if (!tokens) return [];
    const input = tokens.input ?? 0;
    const output = tokens.output ?? 0;
    const reasoning = tokens.reasoning ?? 0;
    const cacheRead = tokens.cache?.read ?? 0;
    const cacheWrite = tokens.cache?.write ?? 0;
    // Skip if this message hasn't received any usage numbers yet — the
    // ring has nothing meaningful to show and we'd emit identical zero
    // events for every metadata-only update.
    if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) {
      return [];
    }
    const prev = lastMessageUsage.get(info.id);
    if (
      prev &&
      prev.input === input &&
      prev.output === output &&
      prev.reasoning === reasoning &&
      prev.cacheRead === cacheRead &&
      prev.cacheWrite === cacheWrite
    ) {
      return [];
    }
    lastMessageUsage.set(info.id, { input, output, reasoning, cacheRead, cacheWrite });
    return [{
      eventId: randomUUID(),
      messageId: info.id,
      timestamp: new Date().toISOString(),
      type: 'usage_update',
      cost: typeof info.cost === 'number' ? info.cost : 0,
      tokens: {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite,
      },
    }];
  }

  function mapPartUpdate(event) {
    const part = event.part;
    if (!part) return [];
    const role = event.role;
    const baseEvent = {
      eventId: randomUUID(),
      messageId: event.messageID,
      partId: part.id,
      timestamp: new Date().toISOString(),
    };

    if (part.type === 'text') {
      // The user's own prompt is stored as a `text` part on a user-role
      // message. Rendering it as `assistant_text` would echo the prompt below
      // the user bubble. The user bubble is synthesized from the send path,
      // so we drop user-role text parts entirely here.
      if (role === 'user') return [];
      const previous = textByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeAssistantText(previous, part.text ?? '');
      textByPartId.set(part.id, latestText);
      if (!deltaToEmit) return [];
      return [{ ...baseEvent, type: 'assistant_text', delta: deltaToEmit, fullText: latestText }];
    }

    if (part.type === 'reasoning') {
      if (role === 'user') return [];
      const previous = textByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeAssistantText(previous, part.text ?? '');
      textByPartId.set(part.id, latestText);
      if (!deltaToEmit) return [];
      return [{ ...baseEvent, type: 'thinking', delta: deltaToEmit, fullText: latestText }];
    }

    if (part.type === 'tool') {
      const status = part.state?.status;
      const input = part.state?.input ?? {};
      const hasInput = input && typeof input === 'object' && Object.keys(input).length > 0;
      const isTerminal = status === 'completed' || status === 'error';
      const out = [];
      // Suppress tool_use until we actually have something renderable —
      // either the input arguments or a terminal state. Early sightings
      // (status=pending/running) often arrive with `state.input = {}`
      // before the model finishes producing the tool call's arguments;
      // emitting tool_use at that point would flash "unknown" in the UI
      // for one poll tick (~700ms) before the real input arrives. Waiting
      // until `hasInput || isTerminal` keeps the block hidden until it has
      // meaningful data. Terminal-with-empty-input (malformed tool call)
      // still emits so the error is visible.
      if (!seenToolStart.has(part.id) && (hasInput || isTerminal)) {
        seenToolStart.add(part.id);
        out.push({
          ...baseEvent,
          type: 'tool_use',
          toolName: part.tool,
          input,
        });
      }
      if (isTerminal) {
        out.push({
          ...baseEvent,
          type: 'tool_result',
          toolName: part.tool,
          output: part.state?.output ?? '',
          isError: status === 'error',
        });
      }
      return out;
    }

    // Subtask invocation — subagent runs in its own session id, so we can't
    // nest child tool events. Surface it as a distinct block showing the
    // agent + prompt + description.
    if (part.type === 'subtask') {
      return [{
        ...baseEvent,
        type: 'subtask',
        agent: part.agent ?? 'subagent',
        prompt: part.prompt ?? '',
        description: part.description ?? '',
        subtaskModel: part.model ? `${part.model.providerID}/${part.model.modelID}` : undefined,
      }];
    }

    // Step boundary — carries cumulative cost + token snapshot for the turn.
    if (part.type === 'step-finish') {
      const tokens = part.tokens ?? {};
      return [{
        ...baseEvent,
        type: 'usage_update',
        cost: typeof part.cost === 'number' ? part.cost : 0,
        tokens: {
          input: tokens.input ?? 0,
          output: tokens.output ?? 0,
          reasoning: tokens.reasoning ?? 0,
          cacheRead: tokens.cache?.read ?? 0,
          cacheWrite: tokens.cache?.write ?? 0,
          total: tokens.total,
        },
      }];
    }

    // Multi-file patch — OpenCode emits this when a tool applies a batch of
    // edits across multiple files. Surface as a distinct block so the user
    // sees what changed even if individual tool calls were collapsed.
    if (part.type === 'patch') {
      return [{
        ...baseEvent,
        type: 'patch',
        files: Array.isArray(part.files) ? part.files : [],
        hash: part.hash ?? '',
      }];
    }

    // Retry — OpenCode retried the LLM call due to an error. Surface to the
    // user so they know why a turn took longer than expected instead of
    // appearing to silently hang.
    if (part.type === 'retry') {
      const errMsg = part.error?.data?.message ?? part.error?.message ?? 'unknown error';
      return [{
        ...baseEvent,
        type: 'retry',
        attempt: part.attempt ?? 1,
        error: String(errMsg),
      }];
    }

    // Compaction — context auto-summarized/dropped. Surface as a subtle
    // marker so the user understands that older turns were summarized.
    if (part.type === 'compaction') {
      return [{
        ...baseEvent,
        type: 'compaction',
        auto: !!part.auto,
      }];
    }

    // User-attached file (image/text) — emitted as part of the user's own
    // message. Surface so the user's attachment chips render alongside their
    // prompt text rather than silently disappearing.
    if (part.type === 'file') {
      return [{
        ...baseEvent,
        type: 'user_file',
        mime: part.mime ?? 'application/octet-stream',
        filename: part.filename ?? '',
        url: part.url ?? '',
      }];
    }

    return [];
  }

  function mapPermissionRequest(req) {
    const legacyPattern = typeof req.pattern === 'string' ? req.pattern : undefined;
    const patterns = Array.isArray(req.patterns)
      ? req.patterns.filter((pattern) => typeof pattern === 'string')
      : legacyPattern ? [legacyPattern] : [];
    const always = Array.isArray(req.always)
      ? req.always.filter((pattern) => typeof pattern === 'string')
      : [];
    return [{
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'permission_request',
      permissionId: req.id,
      kind: PERMISSION_KIND[req.permission] ?? 'unknown',
      permission: req.permission,
      pattern: legacyPattern ?? patterns[0],
      patterns,
      always,
      metadata: req.metadata ?? {},
    }];
  }

  function mapQuestionRequest(req) {
    return [{
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'user_input_request',
      questionId: req.id,
      questions: req.questions ?? [],
    }];
  }

  return { mapPartUpdate, mapMessageUpdate, mapPermissionRequest, mapQuestionRequest };
}
