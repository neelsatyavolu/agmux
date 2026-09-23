import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { installLocalStorage } from "./_localStorage";
import { extractCreatedClaudeSessionIds, syncCreatedClaudeSessionsToTeams } from "../teamsClaudeOwnership";
import { addCreatedClaudeSession } from "../createdSessions";
import { useUiStore } from "../../stores/uiStore";

const createdKey = "agmux-created-claude-sessions:p1";
const mapKey = "agmux-claude-session-map";

beforeEach(() => {
  installLocalStorage();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useUiStore.setState({ claudeSessionMap: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Teams Claude ownership", () => {
  it("includes explicit owners and their native IDs, deduplicated across projects", () => {
    expect(extractCreatedClaudeSessionIds([
      [createdKey, JSON.stringify(["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"])],
      ["agmux-created-claude-sessions:p2", JSON.stringify(["11111111-1111-4111-8111-111111111111"])],
      [mapKey, JSON.stringify({ "11111111-1111-4111-8111-111111111111": ["22222222-2222-4222-8222-222222222222", "22222222-2222-4222-8222-222222222222"], "33333333-3333-4333-8333-333333333333": ["44444444-4444-4444-8444-444444444444"] })],
      ["agmux-opened-claude-sessions:p1", JSON.stringify(["33333333-3333-4333-8333-333333333333"])],
    ])).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("does not transitively treat native IDs as created owners", () => {
    expect(extractCreatedClaudeSessionIds([
      [createdKey, '["11111111-1111-4111-8111-111111111111"]'],
      [mapKey, '{"11111111-1111-4111-8111-111111111111":["22222222-2222-4222-8222-222222222222"],"22222222-2222-4222-8222-222222222222":["33333333-3333-4333-8333-333333333333"]}'],
    ])).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it.each(["not-json", "null", "{}", '"11111111-1111-4111-8111-111111111111"', "42"])("ignores invalid created storage %s", (raw) => {
    expect(extractCreatedClaudeSessionIds([[createdKey, raw], [mapKey, '{"11111111-1111-4111-8111-111111111111":["33333333-3333-4333-8333-333333333333"]}']])).toEqual([]);
  });

  it.each(["not-json", "null", "[]", '"22222222-2222-4222-8222-222222222222"', '{"11111111-1111-4111-8111-111111111111":"22222222-2222-4222-8222-222222222222"}'])("ignores invalid mappings %s", (raw) => {
    expect(extractCreatedClaudeSessionIds([[createdKey, '["11111111-1111-4111-8111-111111111111",null,42,"", " "]'], [mapKey, raw]])).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("filters invalid native IDs", () => {
    expect(extractCreatedClaudeSessionIds([[createdKey, '["11111111-1111-4111-8111-111111111111"]'], [mapKey, '{"11111111-1111-4111-8111-111111111111":["22222222-2222-4222-8222-222222222222",null,42,""," "]}']])).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("ignores malformed IDs in a mixed batch without blocking valid history", async () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const native = "22222222-2222-4222-8222-222222222222";
    const invalid = ["not-a-uuid", "", " ", null, 42,
      "11111111-1111-1111-8111-111111111111",
      "11111111-1111-4111-7111-111111111111",
      `${owner}extra`, ` ${owner}`, `${owner}\n`];
    localStorage.setItem(createdKey, JSON.stringify([owner, ...invalid]));
    localStorage.setItem(mapKey, JSON.stringify({
      [owner]: [...invalid, native],
      "not-a-uuid": ["44444444-4444-4444-8444-444444444444"],
    }));
    await syncCreatedClaudeSessionsToTeams();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("teams_register_created_claude_sessions", {
      sessionIds: [owner, native],
    });
  });

  it("future UI creation and mapping updates do not register ownership", () => {
    addCreatedClaudeSession("p1", "11111111-1111-4111-8111-111111111111");
    useUiStore.getState().setClaudeRealId("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("freezes the initial legacy snapshot even across failed imports", async () => {
    localStorage.setItem(createdKey, '["11111111-1111-4111-8111-111111111111"]');
    vi.mocked(invoke).mockRejectedValueOnce(new Error("retry"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncCreatedClaudeSessionsToTeams();
    localStorage.setItem(mapKey, '{"11111111-1111-4111-8111-111111111111":["22222222-2222-4222-8222-222222222222"]}');
    addCreatedClaudeSession("p1", "33333333-3333-4333-8333-333333333333");
    await syncCreatedClaudeSessionsToTeams();
    expect(invoke).toHaveBeenLastCalledWith("teams_register_created_claude_sessions", {
      sessionIds: ["11111111-1111-4111-8111-111111111111"],
    });
  });

  it("does not register generic opened sessions or ownerless mappings", async () => {
    localStorage.setItem("agmux-claude-sessions", '["33333333-3333-4333-8333-333333333333"]');
    localStorage.setItem(mapKey, '{"33333333-3333-4333-8333-333333333333":["44444444-4444-4444-8444-444444444444"]}');
    await syncCreatedClaudeSessionsToTeams();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("teams_register_created_claude_sessions", { sessionIds: [] });
  });

  it("catches invoke failures and retries on the next sync", async () => {
    localStorage.setItem(createdKey, '["11111111-1111-4111-8111-111111111111"]');
    vi.mocked(invoke).mockRejectedValueOnce(new Error("unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(syncCreatedClaudeSessionsToTeams()).resolves.toBeUndefined();
    await syncCreatedClaudeSessionsToTeams();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("catches inaccessible storage", async () => {
    vi.spyOn(localStorage, "key").mockImplementation(() => { throw new Error("denied"); });
    localStorage.setItem(createdKey, '["11111111-1111-4111-8111-111111111111"]');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(syncCreatedClaudeSessionsToTeams()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
