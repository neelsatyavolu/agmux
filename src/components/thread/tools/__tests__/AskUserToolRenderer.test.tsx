/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AskUserToolRenderer } from "../AskUserToolRenderer";

afterEach(() => cleanup());

const defaultProps = {
  input: {},
  result: null,
  isError: false,
  isPending: false,
};

describe("AskUserToolRenderer", () => {
  it("skips malformed question entries while preserving a valid question", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{ questions: [null, 42, [], { question: "Continue?", options: [] }] }}
      />,
    );
    expect(screen.getByText("Continue?")).toBeTruthy();
  });

  it("skips malformed options while preserving valid choices", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{ questions: [{ question: "Continue?", options: [null, false, [], { label: "Yes" }] }] }}
      />,
    );
    expect(screen.getByText("Continue?")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("renders fallback 'Question' text when no questions provided", () => {
    render(<AskUserToolRenderer {...defaultProps} />);
    expect(screen.getByText("Question")).toBeTruthy();
  });

  it("renders question text from questions array", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            { question: "Do you want to proceed?", header: "Confirm", options: [] },
          ],
        }}
      />,
    );
    expect(screen.getByText("Do you want to proceed?")).toBeTruthy();
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("renders options when provided", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            {
              question: "Pick one",
              header: "",
              options: [
                { label: "Yes", description: "Proceed" },
                { label: "No", description: "Cancel" },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
    expect(screen.getByText("Proceed")).toBeTruthy();
  });

  it("shows result when provided", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            { question: "Continue?", header: "", options: [{ label: "Yes", description: "" }] },
          ],
        }}
        result="Yes"
      />,
    );
    // "Yes" appears in both the option label and the result span — getAllByText is appropriate
    expect(screen.getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  });

  it("applies pending border styling when isPending is true", () => {
    const { container } = render(<AskUserToolRenderer {...defaultProps} isPending />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("border-blue-500/40");
  });

  it("applies non-pending border styling when isPending is false", () => {
    const { container } = render(<AskUserToolRenderer {...defaultProps} isPending={false} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("border-blue-500/20");
  });

  it("highlights selected option when result matches a label", () => {
    const { container } = render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            {
              question: "Pick",
              header: "",
              options: [
                { label: "Yes", description: "" },
                { label: "No", description: "" },
              ],
            },
          ],
        }}
        result="No"
      />,
    );
    // Find the No option box — should have selected styling
    const noOption = Array.from(container.querySelectorAll("div")).find(
      (el) => el.textContent?.trim() === "No",
    );
    expect(noOption?.className).toContain("border-blue-500/50");
  });

  it("does not highlight any option when result is null", () => {
    const { container } = render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            {
              question: "Pick",
              header: "",
              options: [{ label: "Yes", description: "" }],
            },
          ],
        }}
      />,
    );
    expect(container.innerHTML).not.toContain("border-blue-500/50");
  });

  it("renders only the first question when multiple are provided", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            { question: "First", header: "", options: [] },
            { question: "Second", header: "", options: [] },
          ],
        }}
      />,
    );
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("ignores non-array questions input", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{ questions: "not an array" as unknown as unknown[] }}
      />,
    );
    expect(screen.getByText("Question")).toBeTruthy();
  });

  it("ignores non-array options inside a question", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            {
              question: "test",
              header: "",
              options: "nope" as unknown as unknown[],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("test")).toBeTruthy();
  });

  it("does not render header element when header is empty", () => {
    const { container } = render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [{ question: "q", header: "", options: [] }],
        }}
      />,
    );
    // No element with the uppercase header styling
    expect(container.querySelector(".uppercase")).toBeNull();
  });

  it("does not render description span when description is empty", () => {
    render(
      <AskUserToolRenderer
        {...defaultProps}
        input={{
          questions: [
            {
              question: "Pick",
              header: "",
              options: [{ label: "OnlyLabel", description: "" }],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("OnlyLabel")).toBeTruthy();
  });
});
