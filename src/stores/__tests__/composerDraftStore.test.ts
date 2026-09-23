import { beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import { clearLocalStorage } from "./setup";

describe("composerDraftStore", () => {
  beforeEach(() => {
    clearLocalStorage();
    useComposerDraftStore.setState({ drafts: {} }, false);
  });

  it("getDraft returns null for an unknown thread", () => {
    expect(useComposerDraftStore.getState().getDraft("missing")).toBeNull();
  });

  it("saveDraft stores a draft with text", () => {
    useComposerDraftStore.getState().saveDraft("t1", "hello");
    const draft = useComposerDraftStore.getState().getDraft("t1");
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe("hello");
    expect(draft!.imageDataUrls).toEqual([]);
    expect(typeof draft!.savedAt).toBe("number");
  });

  it("saveDraft persists images alongside text", () => {
    useComposerDraftStore.getState().saveDraft("t1", "with-img", ["data:img1"]);
    const draft = useComposerDraftStore.getState().getDraft("t1");
    expect(draft!.imageDataUrls).toEqual(["data:img1"]);
  });

  it("saveDraft with empty text and no images clears the draft", () => {
    useComposerDraftStore.getState().saveDraft("t1", "first");
    useComposerDraftStore.getState().saveDraft("t1", "");
    expect(useComposerDraftStore.getState().getDraft("t1")).toBeNull();
  });

  it("saveDraft with empty text but images keeps the draft", () => {
    useComposerDraftStore.getState().saveDraft("t1", "", ["data:x"]);
    expect(useComposerDraftStore.getState().getDraft("t1")).not.toBeNull();
  });

  it("clearDraft removes the draft for the given thread only", () => {
    useComposerDraftStore.getState().saveDraft("t1", "a");
    useComposerDraftStore.getState().saveDraft("t2", "b");
    useComposerDraftStore.getState().clearDraft("t1");
    expect(useComposerDraftStore.getState().getDraft("t1")).toBeNull();
    expect(useComposerDraftStore.getState().getDraft("t2")?.text).toBe("b");
  });

  it("saveDraft creates a new drafts object reference (immutability)", () => {
    const before = useComposerDraftStore.getState().drafts;
    useComposerDraftStore.getState().saveDraft("t1", "x");
    const after = useComposerDraftStore.getState().drafts;
    expect(after).not.toBe(before);
  });
});
