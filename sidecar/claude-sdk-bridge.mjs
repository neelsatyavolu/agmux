/**
 * agmux Claude SDK Bridge — Node.js sidecar process
 *
 * Communicates with the Rust backend via stdin/stdout JSON-RPC.
 * Wraps @anthropic-ai/claude-agent-sdk to provide structured chat sessions.
 *
 * Protocol:
 *   Rust → Sidecar:  JSON-RPC requests, one per line on stdin
 *   Sidecar → Rust:  JSON-RPC responses + events, one per line on stdout
 *
 * Stderr is reserved for debug logging (not parsed by Rust).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { extractToolEventsFromBlocks } from "./subagent-tool-events.mjs";
import { SubagentConversations } from "./subagent-conversations.mjs";
import { systemMessageToEvents } from "./system-events.mjs";
import {
  classifyTool,
  summarizeToolInput,
  buildResumeOptions as buildResumeOptionsPure,
  ALLOWED_EFFORT,
} from "./protocol-helpers.mjs";
import {
  addToolToProjectSettings as addToolToProjectSettingsPure,
  loadProjectAllowedTools as loadProjectAllowedToolsPure,
} from "./project-settings.mjs";

// --- State ---

/** @type {import("@anthropic-ai/claude-agent-sdk").ClaudeQueryRuntime | null} */
let runtime = null;

/** Resolve function for the next message in the prompt async iterable */
let promptResolve = null;

/** Whether the prompt generator should terminate */
let promptTerminated = false;

/** Whether the query stream has ended (iterator exhausted) */
let streamEnded = false;

/** Start options plus acknowledged model/effort changes, for auto-restart */
let lastQueryOptions = null;

/** Last known session ID for resume */
let lastSessionId = null;

/** Whether at least one turn has completed successfully (session is established) */
let sessionEstablished = false;

/** Pending tool approval requests: requestId → { resolve } */
const pendingApprovals = new Map();

/** Tools allowed for this project (loaded from .claude/settings.local.json + runtime additions) */
const projectAllowedTools = new Set();

/**
 * Live permission mode for this session (`default` | `auto` | `bypassPermissions` | …).
 * Updated on startSession and setPermissionMode. canUseTool consults this so
 * Full access still auto-allows even if the CLI still forwards a prompt.
 */
let currentPermissionMode = "default";

/** Project working directory — set on startSession */
let projectCwd = null;

let subagentConversations = null;

/** Pending AskUserQuestion requests: requestId → { resolve } */
const pendingUserInputs = new Map();

/** Accumulated turn count */
let turnCount = 0;

/** Set of tool_use IDs already seen (dedup partial message re-emissions) */
const seenToolIds = new Set();

/** Whether stream_event text/thinking deltas have been emitted for the current
 *  assistant message. Tracked independently so that — for example — a CLI that
 *  streams text_delta but emits the thinking block only in the final `assistant`
 *  message (extended-thinking summary mode, certain effort levels) still has its
 *  thinking content forwarded to the frontend instead of being suppressed. */
let hasStreamedText = false;
let hasStreamedThinking = false;

/** Map of emitted tool IDs not yet completed: id → toolName */
const pendingToolIds = new Map();

/** Set of Agent/Task tool_use IDs currently executing */
const activeAgentToolIds = new Set();

/** Ordered list of user message UUIDs for file checkpointing rewind targets */
const userMessageUuids = [];

/** Whether a sendSlashCommand is currently executing (prevents concurrent races) */
let slashCommandInFlight = false;

/**
 * Build query options for a resume call. Wraps the pure helper in
 * protocol-helpers.mjs with the module-level `lastQueryOptions` so all
 * existing call sites keep their single-argument shape.
 */
function buildResumeOptions(resumeId) {
  return buildResumeOptionsPure(resumeId, lastQueryOptions);
}

// --- Project Settings Helpers ---
// Pure I/O helpers live in project-settings.mjs. The thin wrappers below add
// bridge-specific logging and mutate the module-level `projectAllowedTools`
// set so production behavior stays identical.

async function addToolToProjectSettings(cwd, toolName) {
  const { changed } = await addToolToProjectSettingsPure(cwd, toolName);
  if (changed) {
    log(`Added "${toolName}" to project allowedTools in ${cwd}/.claude/settings.local.json`);
  }
}

async function loadProjectAllowedTools(cwd) {
  const tools = await loadProjectAllowedToolsPure(cwd);
  for (const t of tools) projectAllowedTools.add(t);
  log(`Loaded ${projectAllowedTools.size} project allowedTools from ${cwd}/.claude/settings.local.json`);
}

// --- I/O Helpers ---

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
}

function respondError(id, message) {
  process.stdout.write(JSON.stringify({ id, error: { message } }) + "\n");
}

function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

// --- Prompt Generator ---

/**
 * Async generator that yields SDKUserMessage objects as they arrive
 * via sendMessage JSON-RPC calls from Rust.
 */
async function* promptGenerator() {
  while (!promptTerminated) {
    const msg = await new Promise((resolve) => {
      promptResolve = resolve;
    });
    promptResolve = null;
    if (msg === null) {
      // Terminate signal
      return;
    }
    yield msg;
  }
}

// --- Tool Classification ---
// classifyTool, summarizeToolInput, and LARGE_CONTENT_KEYS now live in
// protocol-helpers.mjs so they can be unit-tested without spinning up the
// full bridge. They are imported above; behavior is unchanged.

// --- Stream Consumer ---

async function consumeStream(queryRuntime) {
  log("consumeStream: starting to iterate runtime...");
  try {
    for await (const msg of queryRuntime) {
      log("consumeStream: received msg type:", msg.type, "subtype:", msg.subtype ?? "-",
        msg.hook_name ? `hook:${msg.hook_name}` : "",
        msg.outcome ? `outcome:${msg.outcome}` : "",
        msg.hook_event ? `event:${msg.hook_event}` : "",
        msg.exit_code != null ? `exit:${msg.exit_code}` : "");

      subagentConversations?.claude(msg);

      // Child session IDs must never replace the parent resume identity.
      if (!msg.parent_tool_use_id && msg.session_id && !queryRuntime._sessionEmitted) {
        queryRuntime._sessionEmitted = true;
        lastSessionId = msg.session_id;
        emit({ event: "session.started", sessionId: msg.session_id });
      }

      const isSubagentMessage = !!msg.parent_tool_use_id;
      const parentToolUseId = msg.parent_tool_use_id ?? null;

      if (msg.type === "stream_event") {
        // Real-time streaming deltas from the Anthropic API.
        // Emitted when includePartialMessages is true — each event carries
        // a single content_block_delta with incremental text or thinking.
        const ev = msg.event;
        const isSubagent = !!msg.parent_tool_use_id;

        if (!isSubagent && ev.type === "content_block_delta") {
          const delta = ev.delta;
          if (delta?.type === "text_delta" && delta.text) {
            hasStreamedText = true;
            emit({ event: "content.delta", contentType: "text", text: delta.text });
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            hasStreamedThinking = true;
            emit({ event: "content.delta", contentType: "thinking", text: delta.thinking });
          }
        }

        if (!isSubagentMessage && msg.session_id) {
          lastSessionId = msg.session_id;
        }
      } else if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          if (isSubagentMessage) {
            for (const event of extractToolEventsFromBlocks({
              blocks: content,
              parentToolUseId,
              seenToolIds,
              pendingToolIds,
              activeAgentToolIds,
            })) {
              emit(event);
            }
            continue;
          }

          for (const block of content) {
            if (block.type === "text") {
              // Only emit full text when it wasn't already streamed via
              // stream_event deltas (e.g. replayed messages on resume).
              if (!hasStreamedText) {
                emit({ event: "content.delta", contentType: "text", text: block.text });
              }
            } else if (block.type === "thinking") {
              if (!hasStreamedThinking) {
                emit({
                  event: "content.delta",
                  contentType: "thinking",
                  text: block.thinking,
                });
              }
            } else {
              for (const event of extractToolEventsFromBlocks({
                blocks: [block],
                parentToolUseId: null,
                seenToolIds,
                pendingToolIds,
                activeAgentToolIds,
              })) {
                emit(event);
              }
            }
          }
          // Reset flags — next assistant message needs its own stream_event
          // deltas before we suppress its text/thinking content.
          hasStreamedText = false;
          hasStreamedThinking = false;
        }
        // Emit live usage update if the assistant message has usage data
        const msgUsage = msg.message?.usage ?? msg.usage;
        if (msgUsage && (msgUsage.input_tokens || msgUsage.output_tokens)) {
          emit({
            event: "usage.update",
            inputTokens: msgUsage.input_tokens ?? 0,
            outputTokens: msgUsage.output_tokens ?? 0,
            cacheCreationTokens: msgUsage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: msgUsage.cache_read_input_tokens ?? 0,
            totalTokens: msgUsage.total_tokens ?? null,
          });
        }
        // Capture session ID if present (don't re-emit session.started — handled above)
        if (msg.session_id) {
          lastSessionId = msg.session_id;
        }
      } else if (msg.type === "user") {
        // Track user message UUIDs as rewind targets for file checkpointing
        if (!isSubagentMessage && msg.uuid) {
          userMessageUuids.push(msg.uuid);
        }
        // Tool results come back in user messages
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const event of extractToolEventsFromBlocks({
            blocks: content,
            parentToolUseId,
            seenToolIds,
            pendingToolIds,
            activeAgentToolIds,
          })) {
            emit(event);
          }
        }
      } else if (msg.type === "result") {
        // Subagent result messages are internal turn boundaries — they must NOT
        // trigger turn.completed or reset outer-session tracking state.  Without
        // this guard the frontend calls finalizePendingTools which marks the
        // still-running parent agent as completed.
        if (isSubagentMessage) {
          continue;
        }

        // Secondary guard: the primary `parent_tool_use_id` check above can
        // miss a subagent's internal result message when the CLI/SDK ships
        // it without `parent_tool_use_id` populated (observed with custom
        // subagent types like `explore`). Without this fallback the bridge
        // mistakes that mis-tagged result for the parent's turn end, fires
        // turn.completed, and the frontend clears its isWorking state while
        // the parent is still mid-turn — stranding the stop button with
        // tool events still streaming in. If any tool_use from this turn
        // hasn't received its tool_result yet, the parent cannot possibly
        // be done, so treat the result as a subagent internal boundary.
        if (pendingToolIds.size > 0) {
          log(
            "suppressing turn.completed: pending tools remain (",
            pendingToolIds.size,
            ") — treating as subagent internal boundary",
          );
          if (msg.session_id) {
            lastSessionId = msg.session_id;
          }
          continue;
        }

        turnCount++;
        // Only mark established on successful turns — error results (e.g.
        // "No conversation found") should not unlock slash command routing
        // since lastSessionId may be stale.
        if (msg.subtype === "success" || !msg.subtype) {
          sessionEstablished = true;
        }

        // Reset per-turn dedup state
        seenToolIds.clear();
        pendingToolIds.clear();
        activeAgentToolIds.clear();

        // Capture session ID from result
        if (msg.session_id) {
          lastSessionId = msg.session_id;
        }

        // Detect rate limit errors
        if (msg.subtype === "error_rate_limit" || msg.errors?.some(
          (e) => typeof e === "string" ? e.toLowerCase().includes("rate limit") : false
        )) {
          const retryAfter = msg.retry_after ?? null;
          emit({
            event: "rate.limit",
            message: `Rate limit reached${retryAfter ? `. Retry after ${retryAfter}s` : ""}`,
            retryAfterSeconds: retryAfter,
          });
        }

        // Emit error if the turn failed
        if (msg.subtype !== "success") {
          const errMsg = msg.errors?.length > 0
            ? (typeof msg.errors[0] === "string" ? msg.errors[0] : JSON.stringify(msg.errors[0]))
            : `Turn failed: ${msg.subtype ?? "unknown"}`;
          log("Turn error:", msg.subtype, "errors:", JSON.stringify(msg.errors));
          emit({ event: "error", message: errMsg });
        }

        emit({
          event: "turn.completed",
          ...(typeof msg.uuid === "string" && msg.uuid ? { completionId: msg.uuid } : {}),
          sessionId: msg.session_id ?? null,
          model: msg.model ?? null,
          modelUsage: msg.model_usage ?? null,
          userMessageUuid: userMessageUuids.length > 0 ? userMessageUuids[userMessageUuids.length - 1] : null,
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? 0,
            cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
            totalCostUsd: msg.total_cost_usd ?? 0,
            numTurns: turnCount,
          },
        });
      } else if (msg.type === "system") {
        for (const event of systemMessageToEvents(msg)) {
          emit(event);
        }
      } else if (msg.type === "tool_progress") {
        emit({
          event: "tool.progress",
          toolUseId: msg.tool_use_id ?? null,
          content: msg.content ?? "",
        });
      } else if (msg.type === "auth_status") {
        emit({
          event: "auth.status",
          status: msg.status ?? "unknown",
          message: msg.message ?? msg.body ?? "",
        });
      }
    }
    log("consumeStream: iterator exhausted, marking stream ended");
    // Don't emit session.ended — the sidecar stays alive for follow-up messages.
    // A new query will be started on the next sendMessage (with resume).
    // Only clean up if this is still the active runtime (a slash command may
    // have already replaced it with a new query).
    if (runtime === queryRuntime) {
      const wasIntentional = promptTerminated;
      streamEnded = true;
      runtime = null;
      promptResolve = null;
      // Only notify the frontend when the stream ended unexpectedly (likely
      // auto-compact or idle timeout). If we terminated it ourselves as part
      // of a slash-command intercept or shutdown, the next query is already
      // in flight and the status message would be misleading noise.
      if (!wasIntentional) {
        emit({
          event: "status",
          status: "stream_ended",
          message: "Session stream ended — will resume on next message",
        });
      }
    }
  } catch (err) {
    log("Stream error:", err.message);
    log("Stream error stack:", err.stack);
    const wasIntentional = promptTerminated;
    // The CLI emits an `[ede_diagnostic]` result whenever a turn is
    // interrupted mid tool_use. The SDK wraps it as an Error and throws
    // it on stream cleanup, but it's internal telemetry, not a real
    // failure — agmux already filters this marker in two other places
    // (messageFilters.ts, ClaudeSdkSessionView system notifications).
    const isDiagnostic =
      typeof err.message === "string" && err.message.includes("[ede_diagnostic]");
    if (runtime === queryRuntime) {
      streamEnded = true;
      runtime = null;
      promptResolve = null;
    }
    if (wasIntentional || isDiagnostic) {
      // Treat as a clean shutdown — the user stopped the agent (or the
      // CLI emitted an internal diagnostic) and the session is still
      // resumable on the next sendMessage via the streamEnded path.
      // Suppress all banners; sendMessage's resume branch will handle it.
    } else {
      emit({ event: "error", message: err.message });
      emit({ event: "session.ended", reason: "error" });
    }
  } finally {
    subagentConversations?.flush();
  }
}

// --- Request Handler ---

async function handleRequest({ id, method, params }) {
  try {
    switch (method) {
      case "startSession": {
        if (runtime) {
          respondError(id, "Session already started");
          return;
        }

        subagentConversations?.flush();
        subagentConversations = new SubagentConversations(params.threadId, { onError: (err) => log("Subagent capture:", err.message) });

        // Reset session state for fresh start
        sessionEstablished = false;
        currentPermissionMode = params.permissionMode || "default";

        // Store project cwd and load existing project-level allowed tools
        projectCwd = params.cwd || null;
        if (projectCwd) {
          await loadProjectAllowedTools(projectCwd);
        }

        const canUseTool = async (toolName, toolInput, { toolUseID, agentID }) => {
          // AskUserQuestion bypasses approval — surface to user
          if (toolName === "AskUserQuestion") {
            const question = toolInput.question ?? "";
            const questions = toolInput.questions ?? [{ text: question }];
            emit({
              event: "userInput.requested",
              requestId: toolUseID,
              questions,
            });

            subagentConversations?.waiting(toolUseID, agentID, true);
            const answers = await new Promise((resolve) => {
              pendingUserInputs.set(toolUseID, { resolve });
            });
            pendingUserInputs.delete(toolUseID);
            subagentConversations?.waiting(toolUseID, agentID, false);

            if (answers.error) {
              return { behavior: "deny", message: answers.error };
            }
            return { behavior: "allow", updatedInput: { ...toolInput, ...answers } };
          }

          // Full access: never block on the host UI. The CLI normally skips
          // canUseTool in bypassPermissions, but keep this as a safety net.
          if (currentPermissionMode === "bypassPermissions") {
            return { behavior: "allow", updatedInput: toolInput };
          }

          // Auto-approve tools previously allowed for this project
          if (projectAllowedTools.has(toolName)) {
            return { behavior: "allow", updatedInput: toolInput };
          }

          // Emit approval request and wait for decision from Rust.
          // In `auto` mode the CLI classifier handles most calls; we only get
          // here when the classifier (or default mode) wants a human decision.
          emit({
            event: "approval.requested",
            requestId: toolUseID,
            toolName,
            detail: summarizeToolInput(toolInput),
            requestType: classifyTool(toolName),
          });

          subagentConversations?.waiting(toolUseID, agentID, true);
          const result = await new Promise((resolve) => {
            pendingApprovals.set(toolUseID, { resolve, toolInput, toolName });
          });
          pendingApprovals.delete(toolUseID);
          subagentConversations?.waiting(toolUseID, agentID, false);

          return result;
        };

        // Ensure `<cwd>/.claude/settings.json` exists before spawning the
        // CLI. Task-mode worktrees typically don't include a `.claude/`
        // dir (the branch only has branch files). Two symptoms of the
        // missing dir:
        //   1. `claude --resume` crashes with "process exited with code 1"
        //      when `settingSources` requests "project"/"local".
        //   2. Resume silently drops prior conversation context because
        //      the CLI can't materialize a proper project scope.
        // Creating a minimal `{}` stub is low-impact (branches can gitignore
        // `.claude/`) and lets the CLI treat the worktree as a proper
        // project. Best-effort — if we can't create it (e.g. readonly fs),
        // fall back to the user-only settingSources that still works.
        if (params.cwd) {
          try {
            const claudeDir = join(params.cwd, ".claude");
            const settingsPath = join(claudeDir, "settings.json");
            if (!existsSync(settingsPath)) {
              await mkdir(claudeDir, { recursive: true });
              await writeFile(settingsPath, "{}\n", { flag: "wx" }).catch(() => {
                // EEXIST race — another process wrote it first. Fine.
              });
            }
          } catch (err) {
            log("[startSession] could not ensure .claude/settings.json stub:", err.message);
          }
        }

        // Compute `settingSources` dynamically. "user" is always safe
        // (lives under `~/.claude/`). Add "project"/"local" only when the
        // corresponding files exist — the stub above ensures "project"
        // applies when cwd is a worktree.
        const settingSources = ["user"];
        if (params.cwd) {
          if (existsSync(join(params.cwd, ".claude", "settings.json"))) {
            settingSources.push("project");
          }
          if (existsSync(join(params.cwd, ".claude", "settings.local.json"))) {
            settingSources.push("local");
          }
        }

        // Callers may override settingSources (e.g. cowork uses ["user"] only
        // so project CLAUDE.md coding conventions don't load).
        const resolvedSettingSources = Array.isArray(params.settingSources)
          ? params.settingSources
          : settingSources;

        const queryOptions = {
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.claudeBinaryPath
            ? { pathToClaudeCodeExecutable: params.claudeBinaryPath }
            : {}),
          settingSources: resolvedSettingSources,
          ...(params.effort ? { effort: params.effort } : {}),
          ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
          // Required for Full access / mid-session switch to bypassPermissions.
          allowDangerouslySkipPermissions: true,
          ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
          // Full system prompt replacement (string) for non-coding profiles.
          // Stored on lastQueryOptions so stream resume keeps the same identity.
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          // Positive tool catalog restriction (Agent SDK `tools` option).
          ...(params.tools ? { tools: params.tools } : {}),
          // Note: bare `allowedTools` auto-approves before permissionMode —
          // only pass project-persisted "always allow" entries, never the full catalog.
          ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
          ...(params.disallowedTools ? { disallowedTools: params.disallowedTools } : {}),
          // Cowork: local Desktop skill plugins + skills filter + bash sandbox.
          ...(params.plugins ? { plugins: params.plugins } : {}),
          ...(params.skills ? { skills: params.skills } : {}),
          ...(params.sandbox ? { sandbox: params.sandbox } : {}),
          ...(params.additionalDirectories
            ? { additionalDirectories: params.additionalDirectories }
            : {}),
          ...(params.maxTurns ? { maxTurns: params.maxTurns } : {}),
          canUseTool,
          env: process.env,
          includePartialMessages: true,
          forwardSubagentText: true,
          enableFileCheckpointing: true,
          // `--replay-user-messages` is experimental and is the other
          // plausible flag making `--resume` fail in worktrees; only pass
          // it on fresh spawns so existing transcripts can be re-hydrated
          // by the CLI without it rejecting the resume target.
          ...(params.resume ? {} : { extraArgs: { "replay-user-messages": null } }),
          // Capture the underlying claude CLI's stderr so crash reasons
          // surface in sidecar logs instead of being silently discarded.
          stderr: (chunk) => log("[claude-cli stderr]", String(chunk).trimEnd()),
          ...(params.resume ? { resume: params.resume } : {}),
        };

        log("startSession params:", JSON.stringify(params, null, 2));
        log("queryOptions:", JSON.stringify({ ...queryOptions, env: "(omitted)", canUseTool: "(fn)" }, null, 2));

        // Store options for potential restart on follow-up messages
        lastQueryOptions = queryOptions;
        streamEnded = false;

        runtime = query({
          prompt: promptGenerator(),
          options: queryOptions,
        });

        log("query() returned runtime successfully");

        // Start consuming the stream in the background
        consumeStream(runtime).catch((err) => {
          log("Fatal stream error:", err.message);
          emit({ event: "session.ended", reason: "error" });
        });

        respond(id, { ok: true });
        break;
      }

      case "sendSlashCommand": {
        // Dedicated handler for slash commands — the frontend explicitly
        // routes commands here instead of the sidecar guessing via regex.
        // Per SDK docs, slash commands are sent as `prompt` to query().
        const cmd = (params.text ?? "").trim();
        log("sendSlashCommand called, command:", cmd, "sessionEstablished:", sessionEstablished);

        if (!cmd.startsWith("/")) {
          respondError(id, "sendSlashCommand: text must start with /");
          return;
        }

        if (slashCommandInFlight) {
          respondError(id, "Another slash command is already in progress");
          return;
        }
        slashCommandInFlight = true;

        // Wait for session to be established before sending slash commands
        if (runtime && !sessionEstablished) {
          log("sendSlashCommand: waiting for session establishment...");
          for (let i = 0; i < 100; i++) {
            if (sessionEstablished && lastSessionId && lastQueryOptions) break;
            if (streamEnded) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          log("sendSlashCommand: done waiting, sessionEstablished:", sessionEstablished);
        }

        if (!lastSessionId || !lastQueryOptions || !sessionEstablished) {
          // Session not established yet (first message) — fall back to sending
          // through the prompt generator. The CLI recognizes slash commands in
          // user input too, and the first message MUST go through the generator
          // to kick off the session (there's no session to resume yet).
          slashCommandInFlight = false;
          log("sendSlashCommand: session not established, falling back to prompt generator");

          if (!promptResolve) {
            respondError(id, "No active session or session not ready for input");
            return;
          }
          promptResolve({
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: [{ type: "text", text: cmd }] },
          });
          respond(id, { ok: true });
          break;
        }

        // Terminate the current prompt generator so the old stream ends cleanly
        if (promptResolve) {
          promptTerminated = true;
          promptResolve(null);
          promptResolve = null;
        }

        // Wait for the old stream to fully terminate before starting the
        // slash command query, otherwise the SDK may not have the session
        // ready for resume.
        for (let i = 0; i < 20; i++) {
          if (streamEnded || !runtime) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        streamEnded = false;
        promptTerminated = false;

        try {
          // Per SDK docs: pass the slash command as `prompt` to query()
          runtime = query({
            prompt: cmd,
            options: buildResumeOptions(lastSessionId),
          });
          runtime._sessionEmitted = true;

          consumeStream(runtime).catch((err) => {
            log("Fatal stream error on slash command:", err.message);
            emit({ event: "error", message: `Slash command failed: ${err.message}` });
          }).finally(() => {
            slashCommandInFlight = false;
          });
        } catch (err) {
          slashCommandInFlight = false;
          log("sendSlashCommand: failed to start query:", err.message);
          respondError(id, `Slash command failed: ${err.message}`);
          break;
        }

        respond(id, { ok: true });
        break;
      }

      case "sendMessage": {
        log("sendMessage called, promptResolve:", !!promptResolve, "runtime:", !!runtime, "streamEnded:", streamEnded);

        // If the previous query stream ended (iterator exhausted), restart
        // with resume so the conversation continues in the same session.
        if (!promptResolve && streamEnded && lastSessionId && lastQueryOptions) {
          log("sendMessage: stream ended, restarting query with resume:", lastSessionId);
          streamEnded = false;
          promptTerminated = false;

          runtime = query({
            prompt: promptGenerator(),
            options: buildResumeOptions(lastSessionId),
          });
          runtime._sessionEmitted = true; // skip duplicate session.started

          consumeStream(runtime).catch((err) => {
            log("Fatal stream error on restart:", err.message);
            emit({ event: "session.ended", reason: "error" });
          });

          // Wait for the SDK to call .next() on the generator, which
          // sets promptResolve.  The old 200ms fixed delay was too short
          // when the SDK needs time to hydrate a resumed session (e.g.
          // after auto-compact).  Poll with back-off up to ~5 s.
          for (let _w = 0; _w < 50; _w++) {
            if (promptResolve) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          log("sendMessage: after restart, promptResolve:", !!promptResolve);
        }

        // If a turn is still in progress (runtime exists, stream hasn't
        // ended), wait for it to finish so promptResolve gets set.  This
        // happens when the frontend unmounts mid-turn (multiview close)
        // and remounts before the turn completes — the first sendMessage
        // arrives while the old turn is still running.
        if (!promptResolve && runtime && !streamEnded) {
          log("sendMessage: turn in progress, waiting for promptResolve...");
          for (let _w = 0; _w < 120; _w++) { // up to ~12 s (under Rust's 15 s timeout)
            if (promptResolve || streamEnded) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          log("sendMessage: after wait, promptResolve:", !!promptResolve, "streamEnded:", streamEnded);
          // If stream ended while waiting, restart it (same logic as above)
          if (!promptResolve && streamEnded && lastSessionId && lastQueryOptions) {
            log("sendMessage: stream ended during wait, restarting query");
            streamEnded = false;
            promptTerminated = false;
            runtime = query({
              prompt: promptGenerator(),
              options: buildResumeOptions(lastSessionId),
            });
            runtime._sessionEmitted = true;
            consumeStream(runtime).catch((err) => {
              log("Fatal stream error on restart:", err.message);
              emit({ event: "session.ended", reason: "error" });
            });
            for (let _w2 = 0; _w2 < 50; _w2++) {
              if (promptResolve) break;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }

        if (!promptResolve) {
          respondError(id, "No active session or session not ready for input");
          return;
        }
        const content = [];
        if (params.text) {
          content.push({ type: "text", text: params.text });
        }
        if (params.images && params.images.length > 0) {
          for (const img of params.images) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mediaType ?? "image/png",
                data: img.data,
              },
            });
          }
        }
        promptResolve({
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content },
        });
        respond(id, { ok: true });
        break;
      }

      case "respondApproval": {
        const pending = pendingApprovals.get(params.requestId);
        if (!pending) {
          respondError(id, `No pending approval for requestId: ${params.requestId}`);
          return;
        }
        if (params.decision === "deny") {
          pending.resolve({ behavior: "deny", message: params.message || "User denied" });
        } else {
          if (params.decision === "allowProject" && pending.toolName) {
            // Add to in-memory set for immediate auto-approval
            projectAllowedTools.add(pending.toolName);
            // Persist to project's .claude/settings.local.json
            const cwd = params.cwd || projectCwd;
            if (cwd) {
              addToolToProjectSettings(cwd, pending.toolName).catch((err) => {
                log(`Failed to persist allowedTool to project settings: ${err.message}`);
              });
            }
          }
          pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        }
        respond(id, { ok: true });
        break;
      }

      case "respondUserInput": {
        const pending = pendingUserInputs.get(params.requestId);
        if (!pending) {
          respondError(id, `No pending user input for requestId: ${params.requestId}`);
          return;
        }
        pending.resolve(params.answers);
        respond(id, { ok: true });
        break;
      }

      case "setModel": {
        if (!runtime) {
          respondError(id, "No active session");
          return;
        }
        await runtime.setModel(params.model);
        if (lastQueryOptions) lastQueryOptions.model = params.model;
        respond(id, { ok: true });
        break;
      }

      case "setPermissionMode": {
        if (!runtime) {
          respondError(id, "No active session");
          return;
        }
        if (typeof params.mode === "string" && params.mode.length > 0) {
          currentPermissionMode = params.mode;
          if (lastQueryOptions) {
            lastQueryOptions.permissionMode = params.mode;
            lastQueryOptions.allowDangerouslySkipPermissions = true;
          }
        }
        await runtime.setPermissionMode(params.mode);
        respond(id, { ok: true });
        break;
      }

      case "setEffort": {
        if (!runtime) {
          respondError(id, "No active session");
          return;
        }
        // Apply effort via flag settings (persists for remainder of session).
        // The Claude Agent SDK natively accepts "low" | "medium" | "high" | "xhigh" | "max"
        // on effort-capable models (Opus 4.7, Opus 4.6, Sonnet 4.6). Pass through
        // unchanged so "max" keeps its session-scoped uncapped-reasoning semantics
        // instead of being silently downgraded to "high".
        const effortVal = params.effort;
        if (!ALLOWED_EFFORT.has(effortVal)) {
          respondError(id, `Invalid effort: ${effortVal}. Must be one of: low, medium, high, xhigh, max.`);
          return;
        }
        await runtime.applyFlagSettings({ effortLevel: effortVal });
        if (lastQueryOptions) lastQueryOptions.effort = effortVal;
        respond(id, { ok: true });
        break;
      }

      case "interrupt": {
        if (!runtime) {
          respondError(id, "No active session");
          return;
        }
        // Mark the termination as intentional so consumeStream's catch
        // block can distinguish a user-initiated stop from a real crash
        // and suppress the "error" banner / session.ended event.
        promptTerminated = true;
        await runtime.interrupt();
        respond(id, { ok: true });
        break;
      }

      case "rewindFiles": {
        const userMessageId = params.userMessageId;
        if (!userMessageId) {
          respondError(id, "userMessageId is required");
          return;
        }
        if (!lastSessionId) {
          respondError(id, "No session ID available for rewind");
          return;
        }

        try {
          // rewindFiles requires a resumed session — if we have an active runtime,
          // call it directly; otherwise spin up a temporary resumed query
          let rewindRuntime = runtime;
          let tempRuntime = false;

          if (!rewindRuntime) {
            if (!lastQueryOptions) {
              respondError(id, "No session options available for rewind");
              return;
            }
            rewindRuntime = query({
              prompt: (async function* () {})(), // empty prompt — we just need the runtime
              options: buildResumeOptions(lastSessionId),
            });
            tempRuntime = true;
          }

          try {
            const result = await rewindRuntime.rewindFiles(userMessageId);
            log("rewindFiles result:", JSON.stringify(result));
            respond(id, { ok: true, canRewind: result?.canRewind ?? false, error: result?.error ?? null });
          } finally {
            if (tempRuntime) {
              rewindRuntime.close();
            }
          }
        } catch (err) {
          log("rewindFiles error:", err.message);
          respondError(id, err.message);
        }
        break;
      }

      case "stop": {
        if (runtime) {
          runtime.close();
          runtime = null;
        }
        promptTerminated = true;
        streamEnded = true;
        if (promptResolve) {
          promptResolve(null);
          promptResolve = null;
        }
        respond(id, { ok: true });
        // Give events time to flush, then exit
        setTimeout(() => process.exit(0), 200);
        break;
      }

      default:
        respondError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    log(`Error handling ${method}:`, err.message);
    log(`Error stack:`, err.stack);
    respondError(id, err.message);
  }
}

// --- stdin Reader ---

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    emit({ event: "error", message: `JSON parse error: ${err.message}` });
    return;
  }
  handleRequest(request).catch((err) => {
    log(`Unhandled error in handleRequest: ${err.message}`);
    emit({ event: "error", message: `Request handler error: ${err.message}` });
  });
});

rl.on("close", () => {
  subagentConversations?.flush();
  // stdin closed — parent process died, clean up
  if (runtime) {
    runtime.close();
  }
  process.exit(0);
});

// Handle uncaught errors gracefully
process.on("uncaughtException", (err) => {
  log("Uncaught exception:", err.message);
  log("Uncaught stack:", err.stack);
  emit({ event: "error", message: `Uncaught: ${err.message}` });
  emit({ event: "session.ended", reason: "error" });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("Unhandled rejection:", reason);
  if (reason instanceof Error) log("Rejection stack:", reason.stack);
  const msg = reason instanceof Error ? reason.message : String(reason);

  // Resolve pending approvals so the Rust backend isn't left waiting
  for (const [, { resolve }] of pendingApprovals) {
    resolve({ behavior: "deny", message: `Session error: ${msg}` });
  }
  pendingApprovals.clear();

  // Resolve pending user input requests
  for (const [, { resolve }] of pendingUserInputs) {
    resolve({ error: msg });
  }
  pendingUserInputs.clear();

  // ProcessTransport errors mean the Claude subprocess died — emit error but don't crash
  // so the frontend can show the error banner with a Restart button.
  emit({ event: "error", message: msg });
  // Mark stream as ended so sendMessage can restart the query
  streamEnded = true;
  runtime = null;
  promptResolve = null;
});

log("agmux Claude SDK Bridge started");
