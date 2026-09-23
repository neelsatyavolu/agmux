/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CodexCollapse } from "../CodexCollapse";
import { useSettingsStore } from "../../../../../stores/settingsStore";

afterEach(() => cleanup());

beforeEach(() => {
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, animationSpeed: "smooth" },
  });
});

describe("CodexCollapse", () => {
  it("renders nothing when closed", () => {
    render(<CodexCollapse open={false}>hidden body</CodexCollapse>);
    expect(screen.queryByText("hidden body")).toBeNull();
  });

  it("mounts children when open", () => {
    render(<CodexCollapse open>visible body</CodexCollapse>);
    expect(screen.getByText("visible body")).toBeTruthy();
  });

  it("clips the animating body so it does not overflow the row", () => {
    const { container } = render(<CodexCollapse open>body</CodexCollapse>);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.overflow).toBe("hidden");
  });

  it("still mounts children when animations are disabled", () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, animationSpeed: "none" },
    });
    render(<CodexCollapse open>body</CodexCollapse>);
    expect(screen.getByText("body")).toBeTruthy();
  });
});
