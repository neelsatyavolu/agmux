/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AgentAvatar } from "../AgentAvatar";

afterEach(() => cleanup());

describe("AgentAvatar", () => {
  it("renders ClaudeCode avatar", () => {
    const { container } = render(<AgentAvatar provider="ClaudeCode" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders Codex avatar", () => {
    const { container } = render(<AgentAvatar provider="Codex" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders OpenCode avatar", () => {
    const { container } = render(<AgentAvatar provider="OpenCode" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders Kimi avatar", () => {
    const { container } = render(<AgentAvatar provider="Kimi" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders Droid avatar", () => {
    const { container } = render(<AgentAvatar provider="Droid" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders Pi avatar", () => {
    const { container } = render(<AgentAvatar provider="Pi" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("respects size prop", () => {
    const { container } = render(<AgentAvatar provider="ClaudeCode" size={32} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.width).toBe("32px");
    expect(div.style.height).toBe("32px");
  });

  it("uses default size of 22", () => {
    const { container } = render(<AgentAvatar provider="ClaudeCode" />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.width).toBe("22px");
    expect(div.style.height).toBe("22px");
  });

  it("ClaudeCode chip uses #C15F3C background", () => {
    const { container } = render(<AgentAvatar provider="ClaudeCode" />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.background).toMatch(/c15f3c|193, 95, 60/i);
  });

  it("Cline chip is dark with a full-bleed icon", () => {
    const { container } = render(<AgentAvatar provider="Cline" size={18} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.background).toMatch(/(17,\s*17,\s*17|#?111111)/i);
    const img = div.querySelector("img") as HTMLImageElement;
    expect(img.style.width).toBe("18px");
  });

  it("Codex chip uses white background and full-bleed icon", () => {
    const { container } = render(<AgentAvatar provider="Codex" size={20} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.background).toMatch(/(255,\s*255,\s*255|#?ffffff|white)/i);
    const img = div.querySelector("img") as HTMLImageElement;
    expect(img.style.width).toBe("20px"); // full-bleed = full size
  });

  it("ClaudeCode icon is 63% of container size (not full-bleed)", () => {
    const { container } = render(<AgentAvatar provider="ClaudeCode" size={100} />);
    const div = container.firstChild as HTMLElement;
    const img = div.querySelector("img") as HTMLImageElement;
    expect(img.style.width).toBe("63px");
  });

  it("falls back to OpenCode chip for unknown providers", () => {
    const { container } = render(<AgentAvatar provider={"Unknown" as any} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders an img tag for known providers", () => {
    const { container } = render(<AgentAvatar provider="Kimi" />);
    expect(container.querySelector("img")).toBeTruthy();
  });
});
