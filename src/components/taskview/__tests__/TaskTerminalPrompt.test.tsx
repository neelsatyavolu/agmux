/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { render, cleanup, act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTerminalPrompt } from "../TaskTerminalPrompt";
import { SessionPanelsContext } from "../../thread/SessionPanelsContext";
import { useComposerDraftStore } from "../../../stores/composerDraftStore";
import { useThreadStore } from "../../../stores/threadStore";
import { sendPtyLine } from "../../../lib/commands";
import type { Provider } from "../../../lib/types";

vi.mock("../../../lib/commands", () => ({ sendPtyLine: vi.fn().mockResolvedValue(undefined) }));

const panels = { gitSidebarOpen: false, terminalOpen: false, onToggleGitSidebar: vi.fn(), onToggleTerminal: vi.fn() };
function seed(provider: Provider, interaction_mode = "pty") {
  useThreadStore.setState({ threads: { p: [{ id: "agent", provider, interaction_mode }] } } as never);
  useComposerDraftStore.getState().saveDraft("agent", "Build the feature\nKeep the tests passing", [], { autoSubmit: true });
}
function View({ ready = true }: { ready?: boolean }) {
  return <StrictMode><SessionPanelsContext.Provider value={panels}><TaskTerminalPrompt threadId="agent" ready={ready} /></SessionPanelsContext.Provider></StrictMode>;
}
beforeEach(() => {
  vi.mocked(sendPtyLine).mockReset().mockResolvedValue(undefined);
  useComposerDraftStore.setState({ drafts: {} });
});
afterEach(cleanup);

describe("task terminal first prompt", () => {
  it.each(["ClaudeCode", "Codex", "Droid", "Kimi", "Pi", "OpenCode", "Grok", "Cline", "Gemini", "Hermes"] as Provider[])("delivers %s only after readiness, once across remounts", async (provider) => {
    seed(provider);
    const { rerender, unmount } = render(<View ready={false} />);
    expect(sendPtyLine).not.toHaveBeenCalled();
    rerender(<View />);
    await waitFor(() => expect(sendPtyLine).toHaveBeenCalledExactlyOnceWith("agent", "Build the feature\nKeep the tests passing"));
    expect(useComposerDraftStore.getState().getDraft("agent")).toBeNull();
    unmount();
    render(<View />);
    expect(sendPtyLine).toHaveBeenCalledOnce();
  });

  it("leaves chat drafts for the chat composer", () => {
    seed("Codex", "sdk");
    render(<View />);
    expect(sendPtyLine).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraft("agent")?.autoSubmit).toBe(true);
  });

  it("does not consume regular agent-mode drafts", () => {
    seed("Pi");
    render(<TaskTerminalPrompt threadId="agent" ready />);
    expect(sendPtyLine).not.toHaveBeenCalled();
  });

  it("retains a failed prompt and requires an explicit retry", async () => {
    seed("Pi");
    vi.mocked(sendPtyLine).mockRejectedValueOnce(new Error("terminal unavailable"));
    render(<View />);
    expect((await screen.findByRole("alert")).textContent).toContain("terminal unavailable");
    expect(useComposerDraftStore.getState().getDraft("agent")?.autoSubmit).toBeUndefined();
    await act(async () => {});
    expect(sendPtyLine).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry prompt" }));
    await waitFor(() => expect(sendPtyLine).toHaveBeenCalledTimes(2));
  });
});
