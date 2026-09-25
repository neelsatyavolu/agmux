/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  DropdownHeader,
  DropdownSectionHeader,
  DropdownDivider,
  DropdownRow,
  DropdownTag,
  DropdownKbd,
  DropdownFooterAction,
  EffortBars,
  SelectedRail,
} from "../ComposerDropdown";

afterEach(() => cleanup());

describe("DropdownHeader", () => {
  it("renders title", () => {
    render(<DropdownHeader title="Options" />);
    expect(screen.getByText("Options")).toBeTruthy();
  });

  it("renders kbd hint when provided", () => {
    render(<DropdownHeader title="Models" kbd="⌘M" />);
    expect(screen.getByText("⌘M")).toBeTruthy();
  });
});

describe("DropdownSectionHeader", () => {
  it("renders children text", () => {
    render(<DropdownSectionHeader>Section</DropdownSectionHeader>);
    expect(screen.getByText("Section")).toBeTruthy();
  });
});

describe("DropdownDivider", () => {
  it("renders a div", () => {
    const { container } = render(<DropdownDivider />);
    expect(container.querySelector("div")).toBeTruthy();
  });
});

describe("DropdownRow", () => {
  it("renders title text", () => {
    render(<DropdownRow title="Item One" />);
    expect(screen.getByText("Item One")).toBeTruthy();
  });

  it("renders meta text when provided", () => {
    render(<DropdownRow title="Item" meta="some-meta" />);
    expect(screen.getByText("some-meta")).toBeTruthy();
  });

  it("renders meta in sans by default", () => {
    render(<DropdownRow title="Item" meta="display label" />);
    expect(screen.getByText("display label").className).not.toContain("font-mono");
  });

  it("renders meta in mono when metaMono is set (paths/branches/commands)", () => {
    render(<DropdownRow title="Item" meta="~/code/agmux" metaMono />);
    expect(screen.getByText("~/code/agmux").className).toContain("font-mono");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<DropdownRow title="Clickable" onClick={onClick} />);
    fireEvent.click(screen.getByText("Clickable"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies danger styling when danger is true", () => {
    render(<DropdownRow title="Delete" danger />);
    const btn = document.querySelector("button")!;
    expect(btn.className).toContain("red");
  });

  it("applies selected styling when selected is true", () => {
    render(<DropdownRow title="Selected" selected />);
    const btn = document.querySelector("button")!;
    expect(btn.className).toContain("var(--accent-dim)");
  });

  it("renders icon node when provided", () => {
    render(<DropdownRow title="With Icon" icon={<span data-testid="icon" />} />);
    expect(screen.getByTestId("icon")).toBeTruthy();
  });

  it("renders right node when provided", () => {
    render(<DropdownRow title="With Right" right={<span data-testid="right" />} />);
    expect(screen.getByTestId("right")).toBeTruthy();
  });
});

describe("DropdownTag", () => {
  it("renders children", () => {
    render(<DropdownTag>New</DropdownTag>);
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("applies accent variant by default", () => {
    render(<DropdownTag>Rec</DropdownTag>);
    expect(document.querySelector("span")!.className).toContain("var(--accent)");
  });

  it("applies violet variant", () => {
    render(<DropdownTag variant="violet">Pro</DropdownTag>);
    expect(document.querySelector("span")!.className).toContain("violet");
  });

  it("applies amber variant", () => {
    render(<DropdownTag variant="amber">Beta</DropdownTag>);
    expect(document.querySelector("span")!.className).toContain("amber");
  });
});

describe("DropdownKbd", () => {
  it("renders children", () => {
    render(<DropdownKbd>⌘K</DropdownKbd>);
    expect(screen.getByText("⌘K")).toBeTruthy();
  });
});

describe("DropdownFooterAction", () => {
  it("renders children", () => {
    render(<DropdownFooterAction>Settings</DropdownFooterAction>);
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<DropdownFooterAction onClick={onClick}>Action</DropdownFooterAction>);
    fireEvent.click(screen.getByText("Action"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("EffortBars", () => {
  it("renders 6 bar spans", () => {
    const { container } = render(<EffortBars level={3} />);
    // The outer span + 6 inner spans (low…ultra)
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBe(7);
  });

  it("lights up correct number of bars for level 1", () => {
    render(<EffortBars level={1} />);
    expect(document.querySelectorAll("[data-lit]").length).toBe(1);
  });

  it("lights up all 6 bars for level 6 (Ultra)", () => {
    render(<EffortBars level={6} />);
    expect(document.querySelectorAll("[data-lit]").length).toBe(6);
  });

  it("leaves the remaining bars unlit", () => {
    render(<EffortBars level={2} />);
    const bars = Array.from(document.querySelectorAll("span")).slice(1);
    expect(bars.length).toBe(6);
    expect(bars.filter((b) => !b.hasAttribute("data-lit")).length).toBe(4);
  });
});

describe("SelectedRail", () => {
  it("renders a span", () => {
    render(<SelectedRail />);
    expect(document.querySelector("span")).toBeTruthy();
  });

  it("is aria-hidden", () => {
    render(<SelectedRail />);
    expect(document.querySelector("span")!.getAttribute("aria-hidden")).toBe("true");
  });
});
