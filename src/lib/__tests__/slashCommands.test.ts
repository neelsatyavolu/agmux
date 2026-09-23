import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  buildCommandsFromSdk,
  filterCommands,
  getCommandsForProvider,
  isSlashQuery,
  mergeCommands,
  type SlashCommand,
} from "../slashCommands";

describe("getCommandsForProvider", () => {
  it("returns ClaudeCode commands including built-ins", () => {
    const cmds = getCommandsForProvider("ClaudeCode");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c.providers.includes("ClaudeCode"))).toBe(true);
    expect(cmds.find((c) => c.name === "/help")).toBeDefined();
  });

  it("returns Codex commands", () => {
    const cmds = getCommandsForProvider("Codex");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c.providers.includes("Codex"))).toBe(true);
    expect(cmds.find((c) => c.name === "/diff")).toBeDefined();
  });

  it("excludes commands not registered for the provider", () => {
    const cmds = getCommandsForProvider("Codex");
    // /vim is ClaudeCode-only
    expect(cmds.find((c) => c.name === "/vim")).toBeUndefined();
  });

  it("returns an empty array for providers with no commands", () => {
    expect(getCommandsForProvider("Kimi")).toEqual([]);
    expect(getCommandsForProvider("Pi")).toEqual([]);
    expect(getCommandsForProvider("OpenCode")).toEqual([]);
    expect(getCommandsForProvider("Cline")).toEqual([]);
    expect(getCommandsForProvider("Gemini")).toEqual([]);
    expect(getCommandsForProvider("Hermes")).toEqual([]);
  });
});

describe("mergeCommands", () => {
  it("appends dynamic commands not already in built-in set", () => {
    const builtIn: SlashCommand[] = [
      {
        name: "/help",
        description: "help",
        providers: ["ClaudeCode"],
        action: "passthrough",
        source: "built-in",
      },
    ];
    const dynamic = [
      { name: "/foo", description: "foo desc", source: "user" },
      { name: "/bar", description: "bar desc", source: "project" },
    ];
    const merged = mergeCommands(builtIn, dynamic);
    expect(merged).toHaveLength(3);
    expect(merged.map((c) => c.name).sort()).toEqual(["/bar", "/foo", "/help"]);
    const foo = merged.find((c) => c.name === "/foo");
    expect(foo?.source).toBe("user");
    expect(foo?.action).toBe("passthrough");
    expect(foo?.providers).toEqual(["ClaudeCode"]);
  });

  it("does not overwrite built-in entries with dynamic of same name", () => {
    const builtIn: SlashCommand[] = [
      {
        name: "/help",
        description: "original",
        providers: ["ClaudeCode"],
        action: "passthrough",
        source: "built-in",
      },
    ];
    const merged = mergeCommands(builtIn, [
      { name: "/help", description: "shadow", source: "user" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("original");
  });

  it("preserves built-in array first, dynamic appended after", () => {
    const builtIn: SlashCommand[] = SLASH_COMMANDS.slice(0, 2);
    const merged = mergeCommands(builtIn, [
      { name: "/zzz", description: "z", source: "user" },
    ]);
    expect(merged.slice(0, 2)).toEqual(builtIn);
    expect(merged[2].name).toBe("/zzz");
  });
});

describe("filterCommands", () => {
  const cmds: SlashCommand[] = [
    { name: "/help", description: "", providers: ["ClaudeCode"], action: "passthrough" },
    { name: "/clear", description: "", providers: ["ClaudeCode"], action: "passthrough" },
    { name: "/cost", description: "", providers: ["ClaudeCode"], action: "passthrough" },
    { name: "/global-tools:autopr", description: "", providers: ["ClaudeCode"], action: "passthrough" },
  ];

  it("returns all when query is empty or just '/'", () => {
    expect(filterCommands(cmds, "")).toEqual(cmds);
    expect(filterCommands(cmds, "/")).toEqual(cmds);
  });

  it("matches a substring case-insensitively", () => {
    const r = filterCommands(cmds, "cl");
    expect(r.map((c) => c.name)).toContain("/clear");
  });

  it("matches even when slash is omitted", () => {
    const r = filterCommands(cmds, "autopr");
    expect(r.map((c) => c.name)).toContain("/global-tools:autopr");
  });

  it("ranks prefix matches before contains matches", () => {
    const sample: SlashCommand[] = [
      { name: "/zzz-co", description: "", providers: ["ClaudeCode"], action: "passthrough" },
      { name: "/cost", description: "", providers: ["ClaudeCode"], action: "passthrough" },
    ];
    const r = filterCommands(sample, "co");
    expect(r[0].name).toBe("/cost");
    expect(r[1].name).toBe("/zzz-co");
  });

  it("returns empty array when nothing matches", () => {
    expect(filterCommands(cmds, "xyz_nothere")).toEqual([]);
  });
});

describe("isSlashQuery", () => {
  it.each([
    ["/help", true],
    ["/", true],
    ["/foo bar", false],
    ["foo", false],
    ["", false],
    [" /foo", false],
  ])("isSlashQuery(%j) === %s", (input, expected) => {
    expect(isSlashQuery(input)).toBe(expected);
  });
});

describe("buildCommandsFromSdk", () => {
  it("normalises names by adding leading '/'", () => {
    const result = buildCommandsFromSdk(["foo", "/bar"]);
    expect(result.map((c) => c.name)).toEqual(["/foo", "/bar"]);
  });

  it("uses known descriptions when name matches a built-in", () => {
    const result = buildCommandsFromSdk(["help"]);
    expect(result[0].description).toBe("Show available commands and usage");
  });

  it("labels unknown commands as Custom command with sdk source", () => {
    const result = buildCommandsFromSdk(["my-custom-cmd"]);
    expect(result[0]).toMatchObject({
      name: "/my-custom-cmd",
      description: "Custom command",
      source: "sdk",
      action: "passthrough",
    });
    expect(result[0].providers).toEqual(["ClaudeCode"]);
  });

  it("returns an empty array for empty input", () => {
    expect(buildCommandsFromSdk([])).toEqual([]);
  });
});
