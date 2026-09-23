/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SkillGridCard } from "../SkillGridCard";
import type { Skill } from "../../../stores/skillsStore";

afterEach(() => cleanup());

const baseSkill: Skill = {
  name: "linter",
  description: "Lint your code automatically",
  author: "neel",
  installed: false,
  source: "official",
  marketplace: "anthropic",
  category: "Official Plugins",
};

describe("SkillGridCard", () => {
  it("renders name, author, and description", () => {
    render(
      <SkillGridCard
        skill={baseSkill}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText("linter")).toBeTruthy();
    expect(screen.getByText("by neel")).toBeTruthy();
    expect(screen.getByText("Lint your code automatically")).toBeTruthy();
  });

  it("renders source label badge", () => {
    render(
      <SkillGridCard
        skill={baseSkill}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText("Official")).toBeTruthy();
  });

  it("shows Install button for not-installed skills", () => {
    const onInstall = vi.fn();
    render(
      <SkillGridCard
        skill={baseSkill}
        installing={false}
        onInstall={onInstall}
        onUninstall={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Install"));
    expect(onInstall).toHaveBeenCalled();
  });

  it("shows Installing... state when installing is true", () => {
    render(
      <SkillGridCard
        skill={baseSkill}
        installing={true}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText("Installing...")).toBeTruthy();
  });

  it("shows Installed badge and Up to date for installed skills", () => {
    render(
      <SkillGridCard
        skill={{ ...baseSkill, installed: true }}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
  });

  it("shows Uninstall button on hover for installed skills", () => {
    const onUninstall = vi.fn();
    const { container } = render(
      <SkillGridCard
        skill={{ ...baseSkill, installed: true }}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={onUninstall}
      />,
    );
    const card = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(card);
    fireEvent.click(screen.getByText("Uninstall"));
    expect(onUninstall).toHaveBeenCalled();
  });

  it("renders category badge when category is set", () => {
    render(
      <SkillGridCard
        skill={baseSkill}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    // Category text appears in the bottom badge — it's also the source mapped icon target
    expect(screen.getAllByText("Official Plugins").length).toBeGreaterThan(0);
  });

  it("falls back to raw source string when source is not in label map", () => {
    render(
      <SkillGridCard
        skill={{ ...baseSkill, source: "unknown" }}
        installing={false}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );
    expect(screen.getByText("unknown")).toBeTruthy();
  });
});
