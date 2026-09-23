/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerThreadTimelineScroll,
  scrollToThreadTurn,
  rebindChatTurnIds,
  registerPtyTurnLine,
  getPtyTurnLine,
  clearPtyTurnMap,
  cleanTimelinePrompt,
  resolveUserOrdinalForTurn,
  mapTurnIdsToUserKeys,
} from "../threadTimelineScroll";

describe("threadTimelineScroll", () => {
  beforeEach(() => {
    clearPtyTurnMap("t1");
  });

  it("strips Grok <user_query> wrappers from timeline prompts", () => {
    expect(
      cleanTimelinePrompt("<user_query>\nHow many colleges are on my list?\n</user_query>"),
    ).toBe("How many colleges are on my list?");
    expect(cleanTimelinePrompt("<user_query> Does the planner…")).toBe(
      "Does the planner…",
    );
    expect(cleanTimelinePrompt("plain prompt")).toBe("plain prompt");
  });

  it("invokes registered scroll handler", async () => {
    let hit: string | null = null;
    const unreg = registerThreadTimelineScroll("t1", (id) => {
      hit = id;
      return true;
    });
    const ok = await scrollToThreadTurn("t1", "turn-a");
    expect(ok).toBe(true);
    expect(hit).toBe("turn-a");
    unreg();
    expect(await scrollToThreadTurn("t1", "turn-a")).toBe(false);
  });

  it("rebinds data-turn-id by order", () => {
    // happy-dom / jsdom: build a minimal tree without relying on document.body
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-timeline-user-msg data-user-prompt="one"></div>
      <div data-timeline-user-msg data-user-prompt="two"></div>
    `;
    rebindChatTurnIds(root, [
      { id: "u1", promptText: "one", seq: 1 },
      { id: "u2", promptText: "two", seq: 2 },
    ]);
    const nodes = root.querySelectorAll("[data-timeline-user-msg]");
    expect(nodes[0].getAttribute("data-turn-id")).toBe("u1");
    expect(nodes[1].getAttribute("data-turn-id")).toBe("u2");
  });

  it("restores a still-mounted surface when a duplicate view closes", async () => {
    const removeFirst = registerThreadTimelineScroll("duplicate", () => true);
    const removeSecond = registerThreadTimelineScroll("duplicate", () => false);
    expect(await scrollToThreadTurn("duplicate", "turn")).toBe(false);
    removeSecond();
    expect(await scrollToThreadTurn("duplicate", "turn")).toBe(true);
    removeFirst();
  });

  it("stores pty turn lines", () => {
    registerPtyTurnLine("t1", "turn-x", 42);
    expect(getPtyTurnLine("t1", "turn-x")).toBe(42);
    clearPtyTurnMap("t1");
    expect(getPtyTurnLine("t1", "turn-x")).toBeUndefined();
  });

  it("resolves user ordinal end-aligned when counts differ", () => {
    const turns = [
      { id: "a", seq: 1 },
      { id: "b", seq: 2 },
      { id: "c", seq: 3 },
    ];
    // Only last two user bubbles still in the list
    expect(resolveUserOrdinalForTurn("b", turns, 2)).toBe(0);
    expect(resolveUserOrdinalForTurn("c", turns, 2)).toBe(1);
    expect(resolveUserOrdinalForTurn("a", turns, 2)).toBeNull();
  });

  it("matches prompts across partial history without assigning missing turns", () => {
    const turns = [{ id: "a", seq: 1, promptText: "first" }, { id: "b", seq: 2, promptText: "missing" }, { id: "c", seq: 3, promptText: "last" }];
    expect(resolveUserOrdinalForTurn("a", turns, 2, ["first", "last"])).toBe(0);
    expect(resolveUserOrdinalForTurn("b", turns, 2, ["first", "last"])).toBeNull();
    expect(mapTurnIdsToUserKeys(["u1", "u3"], turns, ["first", "last"])).toEqual({u1: "a", u3: "c"});
  });

  it("maps turn ids onto user keys", () => {
    const map = mapTurnIdsToUserKeys(
      ["u1", "u2", "u3"],
      [
        { id: "t1", seq: 1 },
        { id: "t2", seq: 2 },
        { id: "t3", seq: 3 },
      ],
    );
    expect(map).toEqual({ u1: "t1", u2: "t2", u3: "t3" });
  });
});
