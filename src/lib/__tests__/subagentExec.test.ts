import { describe, expect, it } from "vitest";
import { expandExecCalls, expandSubagentExec } from "../subagentExec";
const shell = (output: string, exit_code = 0) => ({ type: "input_text", text: JSON.stringify({ chunk_id: "chunk", exit_code, output }) });
const wrapped = (input: string, output: unknown[]) => ({ id: "exec1", type: "tool" as const, text: "", toolName: "exec", toolInput: { input }, toolResult: JSON.stringify(output), pending: false });
describe("child code-mode tool display", () => {
  it("recovers actual commands and outputs from the saved wrapper", () => {
    const rows = expandSubagentExec(wrapped('text(await tools.exec_command({cmd:"rg cache src", max_output_tokens:2000}));', [{ type: "input_text", text: "Script completed\nOutput:\n" }, shell("src/cache.ts")]));
    expect(rows).toMatchObject([{ toolName: "exec_command", toolInput: { cmd: "rg cache src" }, toolResult: "src/cache.ts", pending: false }]);
  });
  it("pairs mixed MCP and shell results by print position", () => {
    const rows = expandSubagentExec(wrapped('text(await tools.mcp__docs__search({query:"cache"})); text(await tools.exec_command({cmd:"npm test"}));', [
      { type: "input_text", text: JSON.stringify({ content: [{ type: "text", text: "Docs" }] }) }, shell("failed", 1),
    ]));
    expect(rows).toMatchObject([{ toolName: "mcp__docs__search", toolResult: "Docs" }, { toolName: "exec_command", toolResult: "failed", isError: true }]);
    expect(rows[0].id).not.toBe(rows[1].id);
  });
  it("never evaluates dynamic JS, strings, comments or conditionally executed calls", () => {
    for (const input of ['text(await tools.exec_command({cmd: getCommand()}));', 'if (false) text(await tools.exec_command({cmd:"rm file"}));', '// tools.exec_command({cmd:"fake"})\ntext("done")', 'text("tools.exec_command({cmd:1})")']) {
      const rows = expandSubagentExec(wrapped(input, [shell("output")]));
      expect(rows).toMatchObject([{ toolName: "Code execution" }]);
    }
  });
  it("keeps full output when result pairing is ambiguous", () => {
    const row = wrapped('text(await tools.exec_command({cmd:"npm test"}));', [shell("one"), shell("two")]);
    expect(expandSubagentExec(row)).toMatchObject([{ toolName: "Code execution", toolResult: row.toolResult }]);
  });
});

describe("parent chat code-mode expansion", () => {
  it("expands printed shell and MCP calls into separate rows", () => {
    const rows = expandExecCalls({
      id: "call_1",
      toolName: "exec",
      source: 'text(await tools.mcp__docs__search({query:"cache"})); text(await tools.exec_command({cmd:"rg cache src"}));',
      result: [
          { type: "input_text", text: JSON.stringify({ content: [{ type: "text", text: "Docs" }] }) },
        shell("src/cache.ts"),
      ],
    });
    expect(rows).toMatchObject([
      { id: "call_1:0", name: "mcp__docs__search", result: "Docs" },
      { id: "call_1:1", name: "exec_command", input: { cmd: "rg cache src" }, result: "src/cache.ts" },
    ]);
  });

  it("keeps raw source and output when result pairing fails", () => {
    const rows = expandExecCalls({
      id: "call_2",
      source: { input: 'text(await tools.exec_command({cmd:"cat > /tmp/build.py <<\'PY\'\\nprint(1)\\nPY"}));' },
      result: "Created docs/designs/out.html 440514 characters",
    });
    expect(rows).toMatchObject([{ name: "Code execution", result: "Created docs/designs/out.html 440514 characters" }]);
    expect(String(rows[0].input.input)).toContain("cat > /tmp/build.py");
  });

  it("treats a yielded session_id snapshot as finished, not still running", () => {
    const rows = expandExecCalls({
      id: "call_tsc",
      source: 'text(await tools.exec_command({cmd:"npx tsc --noEmit"}));',
      result: [
        { type: "input_text", text: JSON.stringify({ session_id: 77949, output: "" }) },
      ],
    });
    expect(rows).toMatchObject([{ name: "exec_command", pending: false, exitCode: undefined }]);
  });

  it("keeps wrappers that are not printed tool calls", () => {
    expect(expandExecCalls({
      id: "call_3",
      source: "tools.exec_command(...)",
      result: "failed to spawn code-mode host",
    })).toMatchObject([{ name: "Code execution", result: "failed to spawn code-mode host" }]);
  });
});

describe("conservative corpus wrapper replay", () => {
  const source = 'await Promise.allSettled([tools.exec_command({cmd:"npm run typecheck"}), tools.exec_command({cmd:"npm run lint"})]).then(r=>r.forEach(text));';
  it("pairs then-printed settled results in input order, including rejection", () => {
    const rows = expandExecCalls({ id: "parallel", source, result: [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ status: "fulfilled", value: { output: "checked", exit_code: 0 } }) },
      { type: "input_text", text: JSON.stringify({ status: "rejected", reason: "permission denied" }) },
    ] });
    expect(rows).toMatchObject([
      { name: "exec_command", input: { cmd: "npm run typecheck" }, result: "checked", exitCode: 0 },
      { name: "exec_command", input: { cmd: "npm run lint" }, result: "permission denied", isError: true },
    ]);
    expect(rows[1].exitCode).toBeUndefined();
  });
  it("pairs a bound parallel batch printed as one array", () => {
    const rows = expandExecCalls({ id: "batch", source: 'const r=await Promise.all([tools.exec_command({cmd:"first"}),tools.exec_command({cmd:"second"})]);text(r);', result: [{ type: "input_text", text: JSON.stringify([{ output: "one", exit_code: 0 }, { output: "two", exit_code: 1 }]) }] });
    expect(rows).toMatchObject([{ input: { cmd: "first" }, result: "one" }, { input: { cmd: "second" }, result: "two", isError: true }]);
  });
  it("never partially pairs calls across unknown statements or prints", () => {
    for (const source of [
      'if (maybe) text(await tools.exec_command({cmd:"conditional"})); text(await tools.exec_command({cmd:"last"}));',
      'const text = () => {}; text(await tools.exec_command({cmd:"not printed"}));',
      'text(await tools.exec_command({cmd:"first"}));text(await tools.exec_command({cmd:dynamic()}));',
      'text(await tools.exec_command({cmd:"first"}));throw Error("stop");text(await tools.exec_command({cmd:"never"}));',
      'await Promise.all([tools.exec_command({cmd:"first"}).then(text),tools.exec_command({cmd:"second"}).then(text)]);',
    ]) {
      const result = [shell("only observed result")];
      expect(expandExecCalls({ id: "raw", source, result })).toMatchObject([{ name: "Code execution", input: { input: source } }]);
    }
  });
  it("preserves all output when multiple commands cannot be paired", () => {
    const source = 'text(await tools.exec_command({cmd:"first"}));text(await tools.exec_command({cmd:"second"}));';
    const rows = expandExecCalls({ id: "partial", source, result: [shell("first output"), { type: "input_text", text: "Error: second call failed" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Code execution");
    expect(rows[0].result).toContain("first output");
    expect(rows[0].result).toContain("second call failed");
  });
  it("retains missing and yielded wrapper output without inventing a command result", () => {
    for (const result of [undefined, [{ type: "input_text", text: "Script running with cell ID 42" }]]) {
      const rows = expandExecCalls({ id: "waiting", source: 'text(await tools.exec_command({cmd:"npm test"}));', result });
      expect(rows).toMatchObject([{ name: "Code execution" }]);
      expect(rows[0].exitCode).toBeUndefined();
    }
  });
  it("does not invent exit zero for a yielded shell snapshot", () => {
    const rows = expandExecCalls({ id: "yielded", source: 'text(await tools.exec_command({cmd:"npm test"}));', result: [{ type: "input_text", text: JSON.stringify({ output: "started", session_id: 123 }) }] });
    expect(rows).toMatchObject([{ name: "exec_command", pending: false, isError: false }]);
    expect(rows[0].exitCode).toBeUndefined();
  });
  it("preserves escaped strings and text truncation markers exactly", () => {
    const output = 'Warning: truncated output\n<script>never run</script> literal \\n and C:\\tmp\\file';
    const rows = expandExecCalls({ id: "escaped", source: 'text(await tools.exec_command({cmd:"cat log"}));', result: [shell(output)] });
    expect(rows[0].result).toBe(output);
  });
});

it("keeps an explicit media fallback without printing encoded image/audio/resource payloads", () => {
  const rows = expandExecCalls({ id: "media", source: 'image((await tools.view_image({path:"image.png"})).image_url);', result: [
    { type: "input_text", text: "Image loaded" },
    { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(1000000) },
  ] });
  expect(rows[0].result).toContain("Image loaded");
  expect(rows[0].result).toContain("input_image output");
  expect(rows[0].result).toContain("retained in transcript");
  expect(rows[0].result.length).toBeLessThan(500);
  expect(rows[0].result).not.toContain("base64");
});

describe("media payload field filtering", () => {
  const expand = (value: unknown) => expandExecCalls({ id: "resource", source: 'text(await tools.mcp__docs__read({}));', result: [{ type: "input_text", text: JSON.stringify(value) }] })[0].result;
  it("retains MCP text resource content and metadata", () => {
    const resource = { type: "resource", resource: { uri: "docs://guide", mimeType: "text/plain", text: "The actual resource content\nincluding a second line" }, annotations: { audience: ["user"] } };
    expect(JSON.parse(expand({ content: [resource] }))).toEqual({ content: [resource] });
  });
  it("retains arbitrary business objects whose type happens to be image", () => {
    const value = { type: "image", text: "A business label", data: "draft", id: "image-7" };
    expect(JSON.parse(expand(value))).toEqual(value);
    const [raw] = expandExecCalls({ id: "business", source: "text(computed);", result: [value] });
    expect(JSON.parse(raw.result)).toEqual(value);
  });
  it("omits only encoded media fields and preserves sibling text and metadata", () => {
    const value = { content: [
      { type: "resource", resource: { uri: "docs://archive", mimeType: "application/octet-stream", text: "Keep this description", blob: "A".repeat(100000) } },
      { type: "image", mimeType: "image/png", data: "B".repeat(100000), text: "Image caption", name: "preview" },
      { type: "audio", mimeType: "audio/wav", data: "C".repeat(100000), text: "Audio transcript" },
    ] };
    const parsed = JSON.parse(expand(value));
    expect(parsed.content[0].resource).toMatchObject({ uri: "docs://archive", mimeType: "application/octet-stream", text: "Keep this description" });
    expect(parsed.content[1]).toMatchObject({ type: "image", mimeType: "image/png", text: "Image caption", name: "preview" });
    expect(parsed.content[2].text).toBe("Audio transcript");
    for (const payload of [parsed.content[0].resource.blob, parsed.content[1].data, parsed.content[2].data]) expect(payload).toContain("retained in transcript");
    expect(expand(value).length).toBeLessThan(1000);
  });
  it("preserves raw fallback resource metadata while eliding a data URL field", () => {
    const resource = { type: "resource", resource: { uri: "docs://text", mimeType: "text/plain", text: "Keep raw resource text" } };
    const [raw] = expandExecCalls({ id: "raw-media", source: "text(computed);", result: [resource, { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(100000), detail: "high", text: "Keep image context" }] });
    expect(raw.result).toContain("docs://text");
    expect(raw.result).toContain("Keep raw resource text");
    expect(raw.result).toContain("Keep image context");
    expect(raw.result).toContain('"detail":"high"');
    expect(raw.result).not.toContain("base64");
    expect(raw.result.length).toBeLessThan(500);
  });
});
