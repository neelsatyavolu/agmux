/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConsultToolRenderer } from "../ConsultToolRenderer";
import { getToolRenderer } from "..";

afterEach(() => cleanup());

const PANEL =
  "## codex\n\nLooks fine.\n\nagent: codex · session_id: s-1 · 12.0s\n\n## grok\n\nFailed: grok is not signed in\n\n---\nPass an advisor's session_id to ask_agent for a follow-up.";

describe("ConsultToolRenderer", () => {
  it("shows the question and each advisor's answer", () => {
    render(
      <ConsultToolRenderer
        input={{ agents: ["codex", "grok"], question: "Is the cache safe?" }}
        result={PANEL}
        isError={false}
        isPending={false}
      />,
    );
    expect(screen.getByTestId("consult-prompt").textContent).toBe("Is the cache safe?");
    expect(screen.getAllByTestId("consult-answer")).toHaveLength(2);
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Looks fine.")).toBeTruthy();
    expect(screen.getByText("grok is not signed in")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("falls back to the raw reply for non-answers and errors", () => {
    render(
      <ConsultToolRenderer
        input={{ session_id: "x", message: "I moved main" }}
        result="no session x in this project"
        isError
        isPending={false}
      />,
    );
    expect(screen.getByText("I moved main")).toBeTruthy();
    expect(screen.getByText("no session x in this project")).toBeTruthy();
    expect(screen.queryByTestId("consult-answer")).toBeNull();
  });

  it("says it is waiting while the advisor works", () => {
    render(<ConsultToolRenderer input={{ agent: "codex", question: "q" }} result={null} isError={false} isPending />);
    expect(screen.getByText("Waiting for the answer…")).toBeTruthy();
  });

  it("is registered for every name consult calls arrive under", () => {
    expect(getToolRenderer("mcp__consult__ask_agent")).toBe(ConsultToolRenderer);
    expect(getToolRenderer("consult__review_changes")).toBe(ConsultToolRenderer);
    expect(getToolRenderer("mcp__agmux-memory__memory_list")).toBeNull();
  });
});
