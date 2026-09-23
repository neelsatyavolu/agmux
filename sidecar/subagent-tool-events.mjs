function getToolName(block) {
  return block.name ?? block.server_tool_name ?? "unknown";
}

function serializeToolContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => (entry?.type === "text" ? entry.text : JSON.stringify(entry)))
      .join("\n");
  }

  return JSON.stringify(content);
}

export function extractToolEventsFromBlocks({
  blocks,
  parentToolUseId = null,
  seenToolIds,
  pendingToolIds,
  activeAgentToolIds,
}) {
  const events = [];

  for (const block of blocks) {
    const isToolUse =
      block.type === "tool_use" ||
      block.type === "server_tool_use" ||
      block.type === "mcp_tool_use";

    if (isToolUse) {
      if (seenToolIds.has(block.id)) {
        continue;
      }

      const toolName = getToolName(block);
      seenToolIds.add(block.id);
      pendingToolIds.set(block.id, toolName);

      const loweredName = toolName.toLowerCase();
      if (loweredName === "agent" || loweredName === "task" || loweredName === "dispatch_agent") {
        activeAgentToolIds.add(block.id);
      }

      events.push({
        event: "tool.started",
        toolUseId: block.id,
        parentToolUseId,
        name: toolName,
        input: block.input ?? {},
      });
      continue;
    }

    if (block.type === "tool_result" && pendingToolIds.has(block.tool_use_id)) {
      events.push({
        event: "tool.completed",
        toolUseId: block.tool_use_id,
        parentToolUseId,
        content: serializeToolContent(block.content),
        isError: block.is_error ?? false,
      });
      pendingToolIds.delete(block.tool_use_id);
    }
  }

  return events;
}
