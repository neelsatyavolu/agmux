/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AskUserQuestionDialog } from "../AskUserQuestionDialog";
import type { AskQuestion } from "../../../lib/types";

afterEach(() => cleanup());

const singleQuestion: AskQuestion[] = [
  {
    question: "Which approach?",
    header: "Approach",
    options: [
      { label: "Keep existing", description: "Do nothing" },
      { label: "Regenerate", description: "Start fresh" },
    ],
  },
];

describe("AskUserQuestionDialog", () => {
  it("renders the question, header, and options", () => {
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("Which approach?")).toBeTruthy();
    expect(screen.getByText("Approach")).toBeTruthy();
    expect(screen.getByText("Keep existing")).toBeTruthy();
    expect(screen.getByText("Regenerate")).toBeTruthy();
    expect(screen.getByText("Do nothing")).toBeTruthy();
  });

  it("uses the shared popover surface background", () => {
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const shell = screen.getByText("Question").closest("div")?.parentElement;
    expect(shell?.className).toContain("from-[var(--surface-popover-gradient-from)]");
    expect(shell?.className).toContain("to-[var(--surface-popover-gradient-to)]");
  });

  it("disables Submit until a question is answered", () => {
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Keep existing"));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits the selected option keyed by question text", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Regenerate"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ "Which approach?": "Regenerate" });
  });

  it("single-select replaces the previous choice", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Keep existing"));
    fireEvent.click(screen.getByText("Regenerate"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ "Which approach?": "Regenerate" });
  });

  it("comma-joins multiple selections for a multiSelect question", () => {
    const onSubmit = vi.fn();
    const questions: AskQuestion[] = [
      {
        question: "Which features?",
        multiSelect: true,
        options: [
          { label: "Auth", description: "" },
          { label: "Billing", description: "" },
          { label: "Search", description: "" },
        ],
      },
    ];
    render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Auth"));
    fireEvent.click(screen.getByText("Search"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ "Which features?": "Auth, Search" });
  });

  it("supports a free-text 'Other' answer", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Other…"));
    fireEvent.change(screen.getByPlaceholderText("Type your answer..."), {
      target: { value: "A third path" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ "Which approach?": "A third path" });
  });

  it("renders a plain text input for an option-less question", () => {
    const onSubmit = vi.fn();
    const questions: AskQuestion[] = [{ question: "What's your name?", options: [] }];
    render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Type your answer..."), {
      target: { value: "Ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ "What's your name?": "Ada" });
  });

  it("requires every question to be answered before submitting", () => {
    const onSubmit = vi.fn();
    const questions: AskQuestion[] = [
      { question: "Q1?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      { question: "Q2?", options: [{ label: "C", description: "" }, { label: "D", description: "" }] },
    ];
    render(
      <AskUserQuestionDialog questions={questions} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(screen.getByText("A"));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("D"));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ "Q1?": "A", "Q2?": "D" });
  });

  it("marks only the selected option with the gold data-active choice state (A1)", () => {
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const keepBtn = screen.getByText("Keep existing").closest("button")!;
    const regenBtn = screen.getByText("Regenerate").closest("button")!;
    const otherBtn = screen.getByText("Other…").closest("button")!;
    expect(keepBtn.className).toContain("ui-choice-item");
    expect(keepBtn.getAttribute("data-active")).toBeNull();
    expect(regenBtn.getAttribute("data-active")).toBeNull();
    fireEvent.click(keepBtn);
    expect(keepBtn.getAttribute("data-active")).toBe("true");
    expect(regenBtn.getAttribute("data-active")).toBeNull();
    expect(otherBtn.getAttribute("data-active")).toBeNull();
  });

  it("calls onCancel from the Cancel button", () => {
    const onCancel = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("submits on Enter once answered", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionDialog questions={singleQuestion} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Keep existing"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ "Which approach?": "Keep existing" });
  });
});
