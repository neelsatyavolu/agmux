/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MarkdownContent } from "../MarkdownContent";
import { WorkDirProvider } from "../WorkDirContext";

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }));

vi.mock("../../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      openFile,
      selectedCodexSessionCwd: null,
      selectedClaudeSessionCwd: null,
    }),
  },
}));

afterEach(() => {
  cleanup();
  openFile.mockClear();
});

describe("MarkdownContent", () => {
  it("renders plain paragraph text", () => {
    render(<MarkdownContent content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("renders headings", () => {
    const { container } = render(<MarkdownContent content="# Title" />);
    expect(container.querySelector("h1")).toBeTruthy();
  });

  it("renders inline code as <code> element", () => {
    const { container } = render(<MarkdownContent content="run `npm test` first" />);
    const codes = container.querySelectorAll("code");
    expect(codes.length).toBeGreaterThan(0);
  });

  it("allows long inline code to wrap inside the message column", () => {
    const { container } = render(
      <MarkdownContent content="run `python3 -m unittest tests.test_gambling_turn_messages.TurnMessageAuthorizationTests.test_validate_play_usage_limit_message_mentions_shop_upgrade_and_balance_pool`" />,
    );
    const code = container.querySelector("code.md-inline-code");
    expect(code).toBeTruthy();
    expect(code?.className).toContain("md-inline-code");
  });

  it("renders fenced code block with language label and copy control", () => {
    const md = "```ts\nconst x = 1;\n```";
    render(<MarkdownContent content={md} />);
    expect(screen.getByText("ts")).toBeTruthy();
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
    expect(screen.getByTestId("md-code").getAttribute("data-lang")).toBe("ts");
  });

  it("renders bash fenced blocks with shell chrome and copy", () => {
    const md = "```bash\ngit status\n```";
    render(<MarkdownContent content={md} />);
    const block = screen.getByTestId("md-code");
    expect(block.className).toContain("md-code-shell");
    expect(block.getAttribute("data-lang")).toBe("bash");
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
  });

  it("renders fenced code without language with a Copy affordance", () => {
    const md = "```\nplain code\n```";
    render(<MarkdownContent content={md} />);
    expect(screen.getByText("code")).toBeTruthy();
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
  });


  it("renders bullet list items", () => {
    const md = `- one\n- two\n- three`;
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelectorAll("li").length).toBe(3);
  });

  it("renders external links with target=_blank", () => {
    const { container } = render(
      <MarkdownContent content="[click](https://example.com)" />,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });

  it("strips Codex citation metadata blocks", () => {
    const md =
      "before<oai-mem-citation>secret meta</oai-mem-citation>after";
    render(<MarkdownContent content={md} />);
    expect(screen.queryByText(/secret meta/)).toBeNull();
  });

  it("auto-closes unclosed bold markers from streaming content", () => {
    const { container } = render(
      <MarkdownContent content="streaming **bold" />,
    );
    expect(container.querySelector("strong")).toBeTruthy();
  });

  it("auto-closes unclosed fenced code block from streaming", () => {
    const md = "```\nsome partial code";
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelector("code")).toBeTruthy();
  });

  it("auto-closes unclosed italic markers", () => {
    const { container } = render(<MarkdownContent content="streaming *italic" />);
    expect(container.querySelector("em")).toBeTruthy();
  });

  it("auto-closes unclosed strikethrough markers", () => {
    const { container } = render(<MarkdownContent content="text ~~strike" />);
    expect(container.querySelector("del")).toBeTruthy();
  });

  it("auto-closes unclosed inline code markers", () => {
    const { container } = render(<MarkdownContent content="run `npm test" />);
    expect(container.querySelector("code")).toBeTruthy();
  });

  it("does not close paired bold markers (no-op for fully formed)", () => {
    const { container } = render(<MarkdownContent content="this **is** bold" />);
    const strongs = container.querySelectorAll("strong");
    expect(strongs.length).toBe(1);
    expect(strongs[0].textContent).toBe("is");
  });

  it("renders ordered lists", () => {
    const md = "1. one\n2. two\n3. three";
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelector("ol")).toBeTruthy();
    expect(container.querySelectorAll("li").length).toBe(3);
  });

  it("renders blockquotes", () => {
    const { container } = render(<MarkdownContent content="> quote me" />);
    expect(container.querySelector("blockquote")).toBeTruthy();
  });

  it("renders tables via remark-gfm", () => {
    const md = `| col1 | col2 |\n| ---- | ---- |\n| a | b |`;
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(screen.getByTestId("md-table")).toBeTruthy();
    expect(container.querySelector(".md-table-th")).toBeTruthy();
  });

  it("renders multiple heading levels", () => {
    const md = "# H1\n## H2\n### H3";
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelector("h1")).toBeTruthy();
    expect(container.querySelector("h2")).toBeTruthy();
    expect(container.querySelector("h3")).toBeTruthy();
  });

  it("trims trailing whitespace from content", () => {
    render(<MarkdownContent content={"hi   \n\n\n"} />);
    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("renders fenced code block without language as block code", () => {
    const md = "```\nplain code\n```";
    const { container } = render(<MarkdownContent content={md} />);
    const codes = container.querySelectorAll("code");
    expect(codes.length).toBeGreaterThan(0);
  });

  it("strips multiple citation blocks", () => {
    const md =
      "before<oai-mem-citation>a</oai-mem-citation>middle<oai-mem-citation>b</oai-mem-citation>after";
    render(<MarkdownContent content={md} />);
    expect(screen.queryByText(/oai-mem-citation/)).toBeNull();
  });

  it("renders italic via single asterisks", () => {
    const { container } = render(<MarkdownContent content="*italic*" />);
    expect(container.querySelector("em")).toBeTruthy();
  });

  it("opens ChatGPT Work absolute file links in the editor", () => {
    const md =
      "[leaders-citizens.md](/Users/neel/Colleges/essays/supplements/university-of-michigan/leaders-citizens.md)";
    render(<MarkdownContent content={md} />);
    fireEvent.click(screen.getByText("leaders-citizens.md"));
    expect(openFile).toHaveBeenCalledWith(
      "/Users/neel/Colleges/essays/supplements/university-of-michigan/leaders-citizens.md",
    );
  });

  it("strips :line from Work file links before opening", () => {
    render(<MarkdownContent content="[app.py](/Users/me/proj/app.py:12)" />);
    fireEvent.click(screen.getByText("app.py"));
    expect(openFile).toHaveBeenCalledWith("/Users/me/proj/app.py");
  });

  it("resolves relative file links against the session work dir", () => {
    render(
      <WorkDirProvider workDir="/Users/neel/Colleges">
        <MarkdownContent content="[why-lsa.md](essays/supplements/university-of-michigan/why-lsa.md)" />
      </WorkDirProvider>,
    );
    fireEvent.click(screen.getByText("why-lsa.md"));
    expect(openFile).toHaveBeenCalledWith(
      "/Users/neel/Colleges/essays/supplements/university-of-michigan/why-lsa.md",
    );
  });

  it("does not treat https links as files", () => {
    const { container } = render(
      <MarkdownContent content="[click](https://example.com)" />,
    );
    const a = container.querySelector("a");
    fireEvent.click(a!);
    expect(openFile).not.toHaveBeenCalled();
    expect(a?.getAttribute("target")).toBe("_blank");
  });
});
