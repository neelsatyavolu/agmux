import { describe, expect, it } from "vitest";
import {
  extractRoomMentions,
  parseRoomMentions,
  type RoomMentionMember,
} from "../roomMentions";

const members: RoomMentionMember[] = [
  { threadId: "t-claude", label: "Claude", name: "Refactor auth" },
  { threadId: "t-codex", label: "codex", name: "Codex session" },
  { threadId: "t-grok", label: null, name: "Grok" },
  { threadId: "t-dup", label: "Claude", name: "Other Claude" },
];

describe("extractRoomMentions", () => {
  it("returns empty when there are no @tokens", () => {
    expect(extractRoomMentions("hello world")).toEqual([]);
    expect(extractRoomMentions("")).toEqual([]);
  });

  it("extracts multiple tokens without the @", () => {
    expect(extractRoomMentions("hi @Claude and @codex please")).toEqual([
      "Claude",
      "codex",
    ]);
  });

  it("stops a token at whitespace", () => {
    expect(extractRoomMentions("@all fix this")).toEqual(["all"]);
  });
});

describe("parseRoomMentions", () => {
  it("broadcasts to all members when there is no @mention", () => {
    expect(parseRoomMentions("please review", members)).toEqual([
      "t-claude",
      "t-codex",
      "t-grok",
      "t-dup",
    ]);
  });

  it("broadcasts on @all (case-insensitive)", () => {
    expect(parseRoomMentions("@ALL ship it", members)).toEqual([
      "t-claude",
      "t-codex",
      "t-grok",
      "t-dup",
    ]);
    expect(parseRoomMentions("cc @all", members)).toHaveLength(4);
  });

  it("matches labels case-insensitively", () => {
    expect(parseRoomMentions("@CODEX do the thing", members)).toEqual([
      "t-codex",
    ]);
  });

  it("matches thread name when label is unset", () => {
    expect(parseRoomMentions("@Grok please", members)).toEqual(["t-grok"]);
  });

  it("matches name even when a label is set", () => {
    const withName: RoomMentionMember[] = [
      { threadId: "t1", label: "c", name: "alpha" },
    ];
    expect(parseRoomMentions("@alpha go", withName)).toEqual(["t1"]);
    expect(parseRoomMentions("@c go", withName)).toEqual(["t1"]);
  });

  it("matches every member sharing a label", () => {
    expect(parseRoomMentions("@Claude please", members)).toEqual([
      "t-claude",
      "t-dup",
    ]);
  });

  it("dedupes multiple mentions of the same member", () => {
    expect(parseRoomMentions("@codex and again @CODEX", members)).toEqual([
      "t-codex",
    ]);
  });

  it("collects unique targets from multiple different mentions", () => {
    expect(parseRoomMentions("@Claude @codex @Grok", members)).toEqual([
      "t-claude",
      "t-dup",
      "t-codex",
      "t-grok",
    ]);
  });

  it("returns empty when mentions match nobody", () => {
    expect(parseRoomMentions("@nobody home", members)).toEqual([]);
  });

  it("@all among other tokens still broadcasts", () => {
    expect(parseRoomMentions("@codex @all", members)).toEqual([
      "t-claude",
      "t-codex",
      "t-grok",
      "t-dup",
    ]);
  });

  it("handles empty member list", () => {
    expect(parseRoomMentions("@all hi", [])).toEqual([]);
    expect(parseRoomMentions("no mentions", [])).toEqual([]);
  });

  it("does not partial-match multi-word names (token is exact)", () => {
    const multi: RoomMentionMember[] = [
      { threadId: "t1", label: null, name: "Grok Review" },
    ];
    // `@Grok` is only the first word of the name — exact match required.
    expect(parseRoomMentions("@Grok Review please", multi)).toEqual([]);
  });
});
