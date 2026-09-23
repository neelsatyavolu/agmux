import { parse } from "acorn";
import type { SubagentConversationItem } from "./subagentConversations";

type Syntax = { type: string; [key: string]: unknown };
type Call = { name: string; input: Record<string, unknown> };
const UNRESOLVED = Symbol("unresolved");

// Parse literal arguments only. Never evaluate provider JavaScript or resolve
// functions, property access, spreads, interpolations or runtime variables.
function literal(node: Syntax): unknown {
  if (node.type === "Literal" && !node.regex && !node.bigint) return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    return ((node.quasis as Syntax[])[0].value as { cooked: string }).cooked;
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const value = literal(node.argument as Syntax);
    return typeof value === "number" ? -value : UNRESOLVED;
  }
  if (node.type === "ArrayExpression") {
    const values = (node.elements as (Syntax | null)[]).map((entry) => entry ? literal(entry) : UNRESOLVED);
    return values.includes(UNRESOLVED) ? UNRESOLVED : values;
  }
  if (node.type === "ObjectExpression") {
    const entries: [string, unknown][] = [];
    for (const property of node.properties as Syntax[]) {
      if (property.type !== "Property" || property.kind !== "init" || property.computed || property.method) return UNRESOLVED;
      const key = property.key as Syntax;
      const name = key.type === "Identifier" ? key.name : key.value;
      const value = literal(property.value as Syntax);
      if (typeof name !== "string" || value === UNRESOLVED) return UNRESOLVED;
      entries.push([name, value]);
    }
    return Object.fromEntries(entries);
  }
  return UNRESOLVED;
}

interface PrintedGroup {
  calls: Call[];
  settled: boolean;
  array: boolean;
}

function member(node: Syntax, object: string, property: string): boolean {
  return node.type === "MemberExpression" && !node.computed && !node.optional
    && (node.object as Syntax).type === "Identifier" && (node.object as Syntax).name === object
    && (node.property as Syntax).name === property;
}

function toolCall(node: Syntax): Call {
  if (node.type !== "CallExpression" || node.optional) throw new Error("Unknown call");
  const callee = node.callee as Syntax;
  const name = (callee.property as Syntax | undefined)?.name;
  const args = node.arguments as Syntax[];
  if (typeof name !== "string" || !member(callee, "tools", name) || args.length !== 1) throw new Error("Unknown tool");
  const value = literal(args[0]);
  if (value === UNRESOLVED || value === null || Array.isArray(value)) throw new Error("Unknown arguments");
  if (typeof value !== "object" && typeof value !== "string") throw new Error("Unknown arguments");
  return { name, input: typeof value === "string" ? { input: value } : value as Record<string, unknown> };
}

function awaitedGroup(node: Syntax): PrintedGroup {
  if (node.type !== "AwaitExpression") throw new Error("Not awaited");
  const call = node.argument as Syntax;
  if (call.type !== "CallExpression" || call.optional) throw new Error("Not a call");
  const callee = call.callee as Syntax;
  const settled = member(callee, "Promise", "allSettled");
  if (settled || member(callee, "Promise", "all")) {
    const args = call.arguments as Syntax[];
    if (args.length !== 1 || args[0].type !== "ArrayExpression") throw new Error("Unknown batch");
    const elements = args[0].elements as (Syntax | null)[];
    if (!elements.length || elements.some((entry) => !entry)) throw new Error("Empty batch");
    return { calls: elements.map((entry) => toolCall(entry!)), settled, array: true };
  }
  return { calls: [toolCall(call)], settled: false, array: false };
}

function isPrint(node: Syntax, name: string): boolean {
  const args = node.arguments as Syntax[] | undefined;
  return node.type === "CallExpression" && !node.optional && (node.callee as Syntax).type === "Identifier"
    && (node.callee as Syntax).name === "text" && args?.length === 1
    && args[0].type === "Identifier" && args[0].name === name;
}

function isForEachPrint(node: Syntax, name: string): boolean {
  if (node.type !== "CallExpression" || node.optional || !member(node.callee as Syntax, name, "forEach")) return false;
  const args = node.arguments as Syntax[];
  if (args.length !== 1) return false;
  if (args[0].type === "Identifier" && args[0].name === "text") return true;
  const callback = args[0];
  const params = callback.params as Syntax[] | undefined;
  return callback.type === "ArrowFunctionExpression" && !callback.async && params?.length === 1
    && params[0].type === "Identifier" && !["tools", "text", "Promise"].includes(String(params[0].name))
    && isPrint(callback.body as Syntax, String(params[0].name));
}

// Accept whole, ordered print plans only. Unknown statements, shadowing, or
// concurrent callbacks can change execution/order, so retain the raw wrapper.
function printedGroups(source: string): PrintedGroup[] {
  if (source.length > 256000) throw new Error("Wrapper too large");
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
  const statements = program.body as unknown as Syntax[];
  const groups: PrintedGroup[] = [];
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration" && statement.kind === "const") {
      const declarations = statement.declarations as Syntax[];
      if (declarations.length !== 1) throw new Error("Unknown bindings");
      const id = declarations[0].id as Syntax;
      if (id.type !== "Identifier" || ["tools", "text", "Promise"].includes(String(id.name))) throw new Error("Shadowed binding");
      const group = awaitedGroup(declarations[0].init as Syntax);
      const next = statements[++i];
      if (next?.type !== "ExpressionStatement") throw new Error("Unprinted binding");
      const print = next.expression as Syntax;
      if (group.array && isForEachPrint(print, String(id.name))) group.array = false;
      else if (!isPrint(print, String(id.name))) throw new Error("Unknown print");
      groups.push(group);
      continue;
    }
    if (statement.type !== "ExpressionStatement") throw new Error("Unknown statement");
    const expression = statement.expression as Syntax;
    if (expression.type === "CallExpression" && !expression.optional && (expression.callee as Syntax).type === "Identifier" && (expression.callee as Syntax).name === "text") {
      const args = expression.arguments as Syntax[];
      if (args.length !== 1) throw new Error("Unknown print");
      groups.push(awaitedGroup(args[0]));
      continue;
    }
    if (expression.type === "AwaitExpression") {
      const call = expression.argument as Syntax;
      const callee = call.callee as Syntax | undefined;
      const args = call.arguments as Syntax[] | undefined;
      if (call.type === "CallExpression" && !call.optional && callee?.type === "MemberExpression" && !callee.computed && !callee.optional && (callee.property as Syntax).name === "then" && args?.length === 1) {
        const callback = args[0];
        const params = callback.params as Syntax[] | undefined;
        if (callback.type === "ArrowFunctionExpression" && !callback.async && params?.length === 1 && params[0].type === "Identifier"
          && !["tools", "text", "Promise"].includes(String(params[0].name)) && isForEachPrint(callback.body as Syntax, String(params[0].name))) {
          const group = awaitedGroup({ type: "AwaitExpression", argument: callee.object });
          if (!group.array) throw new Error("Not a batch");
          groups.push({ ...group, array: false });
          continue;
        }
      }
    }
    throw new Error("Unknown print plan");
  }
  return groups;
}

export function isExecToolName(name?: string | null): boolean {
  return /^(?:functions\.)?exec$/.test(name ?? "");
}

export interface ExpandedExecCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  pending: boolean;
  exitCode?: number;
}

function execSource(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof (input as { input?: unknown }).input === "string") {
    return (input as { input: string }).input;
  }
  return "";
}

function parseResultBlocks(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result;
  if (typeof result !== "string" || !result.trim()) return null;
  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mediaNotice(type: string): string {
  return `[${type} output: preview unavailable here; original media retained in transcript]`;
}

function resultJson(value: unknown): string {
  return JSON.stringify(value, function (key, entry) {
    if (typeof entry !== "string") return entry;
    // Keep complete objects, captions and resource metadata. Only the native
    // encoded payload fields warrant a placeholder, never a `type` label alone.
    const binaryData = key === "data" && ["image", "audio"].includes(this.type)
      && typeof this.mimeType === "string" && /^(?:image|audio)\//.test(this.mimeType);
    const resourceBlob = key === "blob" && typeof this.uri === "string";
    const dataUrl = ["image_url", "audio_url", "url"].includes(key) && /^data:[^,]*,/.test(entry);
    if (binaryData || resourceBlob || dataUrl) return mediaNotice(typeof this.type === "string" ? this.type : key);
    return entry;
  });
}

function resultText(text: string): string {
  // Preserve ordinary JSON formatting/escaping exactly unless it carries media.
  if (!/"(?:image_url|audio_url|url|data|blob)"/.test(text)) return text;
  try {
    const parsed = JSON.parse(text);
    const formatted = resultJson(parsed);
    return formatted.includes("original media retained in transcript") ? formatted : text;
  } catch { return text; }
}

function flattenExecResult(result: unknown): string {
  if (typeof result === "string") {
    const blocks = parseResultBlocks(result);
    return blocks ? flattenExecResult(blocks) : resultText(result);
  }
  if (!Array.isArray(result)) return result == null ? "" : resultJson(result);
  return result.map((block) => block && typeof block === "object" && ["text", "input_text"].includes(block.type) && typeof block.text === "string"
    ? resultText(block.text) : resultJson(block)).join("\n");
}

function expandedFromPair(id: string, call: Call, value: unknown, settled: boolean): ExpandedExecCall {
  if (settled) {
    const result = value as { status?: string; value?: unknown; reason?: unknown } | null;
    if (result?.status === "rejected") {
      return { id, name: call.name, input: call.input, result: typeof result.reason === "string" ? result.reason : JSON.stringify(result.reason ?? result), isError: true, pending: false };
    }
    if (result?.status !== "fulfilled") throw new Error("Unknown settled result");
    value = result.value;
  }
  const result = value as Record<string, unknown> | null;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Unknown result");
  const shell = call.name === "exec_command" || call.name === "shell_command";
  if (shell && typeof result.output !== "string") throw new Error("Ambiguous shell result");
  const content = result.content;
  const text = shell ? result.output as string
    : Array.isArray(content) && content.every((block) => block?.type === "text" && typeof block.text === "string")
      ? content.map((block) => block.text).join("\n") : resultJson(result);
  // A finished exec wrapper can contain a still-running shell snapshot. No
  // exit status was observed; neither success nor a live spinner is justified.
  const exitCode = typeof result.exit_code === "number" ? result.exit_code : undefined;
  return { id, name: call.name, input: call.input, result: text,
    isError: result.isError === true || (shell && exitCode !== undefined && exitCode !== 0), pending: false, exitCode };
}

/** Expand only completely paired print plans; retain raw input/output otherwise. */
export function expandExecCalls(opts: {
  id: string;
  toolName?: string | null;
  source?: unknown;
  result?: unknown;
}): ExpandedExecCall[] {
  if (!isExecToolName(opts.toolName ?? "exec")) return [];
  const source = execSource(opts.source);
  const fallback: ExpandedExecCall[] = [{ id: opts.id, name: "Code execution", input: { input: source },
    result: flattenExecResult(opts.result), isError: false, pending: false }];
  if (!source) return fallback;
  try {
    const groups = printedGroups(source);
    const blocks = parseResultBlocks(opts.result);
    if (!groups.length || !blocks) return fallback;
    const printed = [...blocks];
    // The transport status is not a user print. Yielded/failed/truncated
    // wrappers cannot certify that every planned call completed.
    const header = printed[0] as { text?: unknown } | undefined;
    if (typeof header?.text === "string" && (header.text === "Script completed" || (/^Script completed\n/.test(header.text) && /Output:\s*$/.test(header.text)))) printed.shift();
    let index = 0;
    const rows: ExpandedExecCall[] = [];
    const read = () => {
      const block = printed[index++] as { text?: unknown } | undefined;
      if (typeof block?.text !== "string") throw new Error("Missing result");
      return JSON.parse(block.text) as unknown;
    };
    for (const group of groups) {
      const values = group.array ? read() : group.calls.map(() => read());
      if (!Array.isArray(values) || values.length !== group.calls.length) return fallback;
      for (let i = 0; i < group.calls.length; i++) rows.push(expandedFromPair(`${opts.id}:${rows.length}`, group.calls[i], values[i], group.settled));
    }
    return index === printed.length ? rows : fallback;
  } catch { return fallback; }
}

/** Child and parent use the same conservative pairing rules. */
export function expandSubagentExec(item: SubagentConversationItem): SubagentConversationItem[] {
  if (item.type !== "tool" || !isExecToolName(item.toolName)) return [item];
  const rows = expandExecCalls({ id: item.id, source: item.toolInput, result: item.toolResult });
  if (rows[0]?.name === "Code execution") return [{ ...item, toolName: "Code execution", toolResult: item.toolResult ? resultText(item.toolResult) : item.toolResult }];
  return rows.map((row) => ({ ...item, id: row.id, toolName: row.name, toolInput: row.input,
    toolResult: row.result, isError: row.isError, pending: row.pending }));
}
