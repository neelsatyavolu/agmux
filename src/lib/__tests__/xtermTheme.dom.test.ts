import { describe, it, expect } from "vitest";
import { darkTheme, lightTheme, panelLightTheme, FLUSH_TERMINAL_BG_DARK } from "../xterm-loader";

describe("darkTheme", () => {
  it("keeps a bright ANSI white for regular terminals", () => {
    const theme = darkTheme("#000000");
    expect(theme.white).toBe("#e4e4e7");
    expect(theme.foreground).toBe("#e4e4e7");
  });

  it("uses Terminal.app Pro ANSI on Grok flush chrome, not the lifted zinc slots", () => {
    const theme = darkTheme(FLUSH_TERMINAL_BG_DARK, FLUSH_TERMINAL_BG_DARK);
    expect(theme.background).toBe("#141414");
    expect(theme.black).toBe("#141414");
    expect(theme.foreground).toBe("#F4F4F4");
    expect(theme.white).toBe("#BFBFBF");
    expect(theme.brightWhite).toBe("#E5E5E5");
    expect(theme.red).toBe("#990000");
  });
});

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map((v) => parseInt(v, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

describe("light terminal palettes", () => {
  it.each([lightTheme, panelLightTheme])("preserves ANSI black/white backgrounds and readable colored text", (build) => {
    const theme = build("#f6f5f3");
    // TUIs use these same slots for backgrounds, not just foreground text.
    expect(luminance(theme.black!)).toBeLessThan(0.05);
    expect(luminance(theme.white!)).toBeGreaterThan(0.7);
    expect(luminance(theme.brightWhite!)).toBeGreaterThan(0.9);
    for (const key of ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"] as const) {
      expect((luminance(theme.background!) + 0.05) / (luminance(theme[key]!) + 0.05), key).toBeGreaterThanOrEqual(4.5);
    }
  });
});
