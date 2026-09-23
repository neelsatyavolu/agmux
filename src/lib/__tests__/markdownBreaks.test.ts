import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

/**
 * Renders markdown to HTML using the same remark pipeline as MarkdownContent.
 */
function renderMarkdown(md: string): string {
  const result = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(md);
  return String(result);
}

/** Same pipeline WITHOUT remark-breaks, to confirm the difference. */
function renderMarkdownNoBreaks(md: string): string {
  const result = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(md);
  return String(result);
}

const CIRCLED_NUMBER_LIST = [
  "All progress tracing added ✅. Here's the complete trace:",
  "① Query classified → query preview, categories with scores",
  "② PromptCalling: assembled per-query prompt → categories, questionIds, prompt preview",
  "③ LLM request intercepted and augmented → original/modified lengths, injected preview",
  "④ Parsed assistant text from delta stream → response length, preview",
  "⑤ Tool calls detected in SSE response → count, names, response preview",
].join("\n");

describe("MarkdownContent remark-breaks", () => {
  it("converts single newlines to <br> in circled-number lists", () => {
    const html = renderMarkdown(CIRCLED_NUMBER_LIST);
    // Each single \n should become a <br> — at least 5 breaks for 6 lines
    const brCount = (html.match(/<br>/g) || []).length;
    expect(brCount).toBeGreaterThanOrEqual(5);
  });

  it("WITHOUT remark-breaks, single newlines are collapsed", () => {
    const html = renderMarkdownNoBreaks(CIRCLED_NUMBER_LIST);
    // Standard markdown collapses single newlines — no <br> tags
    const brCount = (html.match(/<br>/g) || []).length;
    expect(brCount).toBe(0);
  });

  it("preserves double-newline paragraph breaks", () => {
    const md = "Paragraph one.\n\nParagraph two.";
    const html = renderMarkdown(md);
    // Double newlines still create separate <p> tags
    expect(html).toContain("</p>");
    expect(html).toMatch(/<p>.*Paragraph one/);
    expect(html).toMatch(/<p>.*Paragraph two/);
  });

  it("does not break fenced code blocks", () => {
    const md = "```\nline1\nline2\nline3\n```";
    const html = renderMarkdown(md);
    // Code blocks should NOT get <br> injected
    expect(html).toContain("<code>");
    expect(html).not.toMatch(/<code>[^<]*<br>/);
  });

  it("handles plain single-line text unchanged", () => {
    const md = "Just a single line.";
    const html = renderMarkdown(md);
    expect(html).toContain("Just a single line.");
    expect(html).not.toContain("<br>");
  });

  it("renders GFM tables correctly", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders strikethrough via GFM", () => {
    const md = "~~struck~~";
    const html = renderMarkdown(md);
    expect(html).toContain("<del>struck</del>");
  });

  it("renders task lists via GFM", () => {
    const md = "- [ ] todo\n- [x] done";
    const html = renderMarkdown(md);
    expect(html).toMatch(/<input[^>]+type="checkbox"/);
  });

  it("preserves inline code without injecting breaks", () => {
    const md = "Use `npm test` to run tests.";
    const html = renderMarkdown(md);
    expect(html).toContain("<code>npm test</code>");
  });

  it("renders link syntax", () => {
    const md = "[link](https://example.com)";
    const html = renderMarkdown(md);
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.com"[^>]*>link<\/a>/);
  });
});
