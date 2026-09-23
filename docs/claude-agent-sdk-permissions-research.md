# Claude Agent SDK: Permission / Approval System Research

## 1. Does "allow for session" persist to settings.json?

**No.** The SDK's `canUseTool` callback is purely a runtime mechanism. When Claude requests a tool that isn't pre-approved, your callback fires and you return allow or deny. There is no built-in "allow for session" that writes to `settings.json`.

However, the SDK does provide a **`PermissionUpdate`** mechanism via the `context.suggestions` field in the `canUseTool` callback. The `PermissionUpdate` dataclass has a `destination` field with these options:

- `"userSettings"` — persist to user-level settings
- `"projectSettings"` — persist to `.claude/settings.json`
- `"localSettings"` — persist to local settings
- `"session"` — persist only for the current session (in-memory)

These are **suggestions from the CLI** to the SDK consumer. Your application must choose whether to apply them. The SDK itself does not automatically write to any settings file.

## 2. Permission Persistence Mechanisms

The SDK supports these layers for persisting permissions:

### A. Declarative rules in `.claude/settings.json`
You can configure `allow`, `deny`, and `ask` rules in `.claude/settings.json`. The SDK does **not** load these by default — you must set:
```typescript
{ settingSources: ["project"] }  // TypeScript
{ setting_sources: ["project"] } // Python
```

### B. `allowedTools` / `disallowedTools` at query time
```typescript
const options = {
  allowedTools: ["Read", "Glob", "Grep"],   // auto-approved
  disallowedTools: ["Bash"],                 // always denied
};
```
These are in-memory, per-query. Not persisted anywhere.

### C. Permission modes (per-query)
| Mode | Behavior |
|------|----------|
| `default` | No auto-approvals; unmatched tools trigger `canUseTool` |
| `dontAsk` (TS only) | Deny if not pre-approved; `canUseTool` never called |
| `acceptEdits` | Auto-approve file edits (Edit, Write, mkdir, rm, mv, cp) |
| `bypassPermissions` | All tools approved (deny rules and hooks still apply) |
| `plan` | No tool execution at all |

### D. `PermissionUpdate` suggestions
The `canUseTool` callback receives `context.suggestions: list[PermissionUpdate]` from the CLI. Each `PermissionUpdate` can specify:
- `type`: `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, `removeDirectories`
- `destination`: `userSettings`, `projectSettings`, `localSettings`, or `session`
- `rules`, `behavior`, `mode`, `directories` as applicable

Your app decides whether to apply these suggestions. The SDK does not auto-persist them.

### E. Hooks (PreToolUse)
Hooks run before `canUseTool` and can allow, deny, or continue. They are configured either in code or in settings.json.

## 3. Auto-Approving Tools

### Option A: `allowedTools` + `permissionMode`
```typescript
// Locked-down: only these tools, everything else denied
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk"
};
```

### Option B: `permissionMode: "acceptEdits"`
Auto-approves file operations (Edit, Write, filesystem commands). Other tools still require approval.

### Option C: `permissionMode: "bypassPermissions"`
Auto-approves everything. `disallowedTools` and hooks can still block.

### Option D: Glob patterns for MCP tools
```typescript
{ allowedTools: ["mcp__servername__*"] }
```

### Option E: Declarative rules in settings.json
Configure allow/deny/ask rules in `.claude/settings.json` and set `settingSources: ["project"]`.

## Permission Evaluation Order

1. **Hooks** (PreToolUse) — can allow, deny, or pass through
2. **Deny rules** (`disallowedTools` + settings.json deny rules) — blocks even in bypassPermissions
3. **Permission mode** — bypassPermissions approves all; acceptEdits approves file ops
4. **Allow rules** (`allowedTools` + settings.json allow rules)
5. **`canUseTool` callback** — runtime decision (skipped in `dontAsk` mode)

## Sources

- https://platform.claude.com/docs/en/agent-sdk/permissions
- https://platform.claude.com/docs/en/agent-sdk/user-input
- https://docs.claude.com/en/api/agent-sdk/python (PermissionUpdate, ToolPermissionContext)
- https://platform.claude.com/docs/en/agent-sdk/mcp
- https://github.com/anthropics/claude-agent-sdk-typescript/issues/19
