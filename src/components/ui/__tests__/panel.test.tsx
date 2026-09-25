/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Database } from "lucide-react";
import {
  PanelHeader,
  PanelToolbar,
  SectionEyebrow,
  Card,
  ListRow,
  Chip,
  Stat,
  EmptyState,
} from "../panel";

afterEach(() => cleanup());

describe("SectionEyebrow", () => {
  it("renders its label", () => {
    render(<SectionEyebrow label="Durable memory" />);
    expect(screen.getByText("Durable memory")).toBeTruthy();
  });

  it("uses the eyebrow type token (M8: via the shared .ui-eyebrow class, not a duplicated inline size/tracking + color that could drift from it)", () => {
    const { container } = render(<SectionEyebrow label="X" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ui-eyebrow");
    expect(el.style.fontSize).toBe("");
    expect(el.style.letterSpacing).toBe("");
    expect(el.style.color).toBe("");
  });
});

describe("PanelHeader", () => {
  it("renders title and count", () => {
    render(<PanelHeader title="Memory" count={166} />);
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("166")).toBeTruthy();
  });

  it("omits the count when undefined", () => {
    render(<PanelHeader title="Memory" />);
    expect(screen.queryByTestId("panel-header-count")).toBeNull();
  });

  it("renders an actions slot", () => {
    render(<PanelHeader title="Memory" actions={<button>Refresh</button>} />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

describe("PanelToolbar", () => {
  it("renders a search box and reports changes", () => {
    const onSearch = vi.fn();
    render(<PanelToolbar searchValue="" onSearchChange={onSearch} searchPlaceholder="Find" />);
    const input = screen.getByPlaceholderText("Find");
    fireEvent.change(input, { target: { value: "auth" } });
    expect(onSearch).toHaveBeenCalledWith("auth");
  });

  it("renders children alongside search", () => {
    render(<PanelToolbar searchValue="" onSearchChange={() => {}}><span>filters</span></PanelToolbar>);
    expect(screen.getByText("filters")).toBeTruthy();
  });

  it("omits search entirely when no handler is given", () => {
    render(<PanelToolbar><span>only</span></PanelToolbar>);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("Card", () => {
  it("renders children", () => {
    render(<Card>body</Card>);
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders a head when given", () => {
    render(<Card head="Projects">body</Card>);
    expect(screen.getByText("Projects")).toBeTruthy();
  });
});

describe("ListRow", () => {
  it("renders content and trailing slots", () => {
    render(<ListRow content="entry title" trailing={<span>2h</span>} />);
    expect(screen.getByText("entry title")).toBeTruthy();
    expect(screen.getByText("2h")).toBeTruthy();
  });

  it("is a button when selectable and fires onSelect", () => {
    const onSelect = vi.fn();
    render(<ListRow content="row" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("is not a button when not selectable", () => {
    render(<ListRow content="row" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks selection state for styling and a11y", () => {
    render(<ListRow content="row" onSelect={() => {}} selected />);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBe("true");
  });
});

describe("Chip", () => {
  it("renders its label", () => {
    render(<Chip label="binding" />);
    expect(screen.getByText("binding")).toBeTruthy();
  });

  it("passes tone through for styling", () => {
    render(<Chip label="warn" tone="warn" />);
    expect(screen.getByText("warn").getAttribute("data-tone")).toBe("warn");
  });
});

describe("Stat", () => {
  it("renders label, value and detail", () => {
    render(<Stat label="Total tokens" value="1.2M" detail="+4% vs last week" />);
    expect(screen.getByText("Total tokens")).toBeTruthy();
    expect(screen.getByText("1.2M")).toBeTruthy();
    expect(screen.getByText("+4% vs last week")).toBeTruthy();
  });

  it("renders without a detail", () => {
    render(<Stat label="Input" value="800k" />);
    expect(screen.queryByTestId("stat-detail")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders headline and body", () => {
    render(<EmptyState icon={Database} headline="No durable memory yet" body="Agents record decisions here." />);
    expect(screen.getByText("No durable memory yet")).toBeTruthy();
    expect(screen.getByText("Agents record decisions here.")).toBeTruthy();
  });

  it("renders an action when given", () => {
    render(<EmptyState icon={Database} headline="Empty" action={<button>Add</button>} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("does not render a body element when body is omitted", () => {
    render(<EmptyState icon={Database} headline="Empty" />);
    expect(screen.queryByTestId("empty-state-body")).toBeNull();
  });
});
