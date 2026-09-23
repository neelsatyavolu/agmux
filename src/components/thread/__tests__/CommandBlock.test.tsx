/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CommandBlock } from "../CommandBlock";

afterEach(() => cleanup());

describe("CommandBlock", () => {
  it("renders Bash header label and command name", () => {
    render(
      <CommandBlock commandName="ls -la" output="file.ts" exitCode={0} />,
    );
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("shows Done badge when exitCode is 0", () => {
    render(<CommandBlock commandName="ls" output="" exitCode={0} />);
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows Error badge when exitCode is non-zero", () => {
    render(<CommandBlock commandName="bad" output="oops" exitCode={1} />);
    expect(screen.getByText("Error")).toBeTruthy();
  });

  it("shows running pill and 'Running…' fallback while pending", () => {
    render(<CommandBlock commandName="" output="" />);
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText(/Running…/)).toBeTruthy();
  });

  it("expands output body when header clicked", () => {
    const { container } = render(
      <CommandBlock commandName="echo hi" output="hi" exitCode={0} />,
    );
    const header = container.querySelector("[role='button']")!;
    fireEvent.click(header);
    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("collapses output body again on second click", () => {
    const { container } = render(
      <CommandBlock commandName="echo hi" output="hi" exitCode={0} />,
    );
    const header = container.querySelector("[role='button']")!;
    fireEvent.click(header);
    expect(screen.getByText("hi")).toBeTruthy();
    fireEvent.click(header);
    // After collapse, output text should not be visible (only the header label remains)
    const pres = container.querySelectorAll("pre");
    expect(pres.length).toBe(0);
  });

  it("does not render output body initially even when exit code is set", () => {
    const { container } = render(
      <CommandBlock commandName="echo hi" output="hi" exitCode={0} />,
    );
    expect(container.querySelectorAll("pre").length).toBe(0);
  });

  it("does not render chevron / role=button when there is no output", () => {
    const { container } = render(
      <CommandBlock commandName="ls" output="" exitCode={0} />,
    );
    expect(container.querySelector("[role='button']")).toBeNull();
  });

  it("preserves multi-line output verbatim when expanded", () => {
    const out = "line one\nline two\nline three";
    const { container } = render(
      <CommandBlock commandName="cat" output={out} exitCode={0} />,
    );
    fireEvent.click(container.querySelector("[role='button']")!);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(out);
  });

  it("uses pending color theme when exit code is undefined", () => {
    const { container } = render(<CommandBlock commandName="" output="" />);
    // amber tint is applied to the wrapper div
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("amber-500");
  });

  it("uses error color theme when exit code is non-zero", () => {
    const { container } = render(
      <CommandBlock commandName="bad" output="oops" exitCode={2} />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("red-500");
  });

  it("uses default success theme when exit code is 0", () => {
    const { container } = render(
      <CommandBlock commandName="ls" output="" exitCode={0} />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).not.toContain("amber-500");
    expect(wrapper.className).not.toContain("red-500");
  });

  it("does not show 'Running…' placeholder once exit code arrives", () => {
    render(<CommandBlock commandName="" output="" exitCode={0} />);
    expect(screen.queryByText(/Running…/)).toBeNull();
  });

  it("shows the command name even when exit code is non-zero", () => {
    render(<CommandBlock commandName="rm -rf /" output="nope" exitCode={1} />);
    expect(screen.getByText("rm -rf /")).toBeTruthy();
  });
});
