/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SkillCard } from "../SkillCard";
import type { Skill } from "../../../stores/skillsStore";

afterEach(() => cleanup());

const baseSkill: Skill = {
  name: "test-skill",
  description: "A test skill",
  category: "testing",
  source: "official",
  marketplace: "off",
  installed: false,
};

describe("SkillCard", () => {
  it("renders skill name", () => {
    render(<SkillCard skill={baseSkill} installing={false} onInstall={() => {}} onUninstall={() => {}} />);
    expect(screen.getByText("test-skill")).toBeTruthy();
  });

  it("renders description", () => {
    render(<SkillCard skill={baseSkill} installing={false} onInstall={() => {}} onUninstall={() => {}} />);
    expect(screen.getByText("A test skill")).toBeTruthy();
  });

  it("renders Install button when not installed", () => {
    render(<SkillCard skill={baseSkill} installing={false} onInstall={() => {}} onUninstall={() => {}} />);
    expect(screen.getByRole("button", { name: /install/i })).toBeTruthy();
  });

  it("calls onInstall when Install button clicked", () => {
    const onInstall = vi.fn();
    render(<SkillCard skill={baseSkill} installing={false} onInstall={onInstall} onUninstall={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    expect(onInstall).toHaveBeenCalled();
  });

  it("shows Installed badge when installed and not hovered", () => {
    render(
      <SkillCard
        skill={{ ...baseSkill, installed: true }}
        installing={false}
        onInstall={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(screen.getByText(/installed/i)).toBeTruthy();
  });

  it("shows source label", () => {
    render(<SkillCard skill={baseSkill} installing={false} onInstall={() => {}} onUninstall={() => {}} />);
    expect(screen.getByText("Official")).toBeTruthy();
  });

  it("shows spinner when installing", () => {
    const { container } = render(
      <SkillCard skill={baseSkill} installing={true} onInstall={() => {}} onUninstall={() => {}} />,
    );
    // No install button when in installing state
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    // Loader has animate-spin
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("shows Remove button when installed and hovered", () => {
    const installed = { ...baseSkill, installed: true };
    render(
      <SkillCard skill={installed} installing={false} onInstall={() => {}} onUninstall={() => {}} />,
    );
    // Hover the card
    const card = screen.getByText("test-skill").closest(".group");
    if (card) fireEvent.mouseEnter(card);
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("calls onUninstall when Remove button clicked", () => {
    const onUninstall = vi.fn();
    const installed = { ...baseSkill, installed: true };
    render(
      <SkillCard skill={installed} installing={false} onInstall={() => {}} onUninstall={onUninstall} />,
    );
    const card = screen.getByText("test-skill").closest(".group");
    if (card) fireEvent.mouseEnter(card);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onUninstall).toHaveBeenCalled();
  });

  it("renders category label when present", () => {
    render(
      <SkillCard skill={baseSkill} installing={false} onInstall={() => {}} onUninstall={() => {}} />,
    );
    expect(screen.getByText("testing")).toBeTruthy();
  });

  it("does not render description when missing", () => {
    const noDesc = { ...baseSkill, description: undefined as any };
    render(
      <SkillCard skill={noDesc} installing={false} onInstall={() => {}} onUninstall={() => {}} />,
    );
    expect(screen.queryByText("A test skill")).toBeNull();
  });
});
