import { describe, it, expect } from "vitest";
import {
  darkTheme,
  lightTheme,
  panelDarkTheme,
  panelLightTheme,
  FLUSH_TERMINAL_BG_DARK,
  UNIFIED_TERMINAL_BG_DARK,
  UNIFIED_TERMINAL_BG_LIGHT,
} from "../xterm-loader";

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

const TEXT_SLOTS = ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("unified (Flat) terminal palette", () => {
  it("paints the slate terminal surface instead of pure black", () => {
    const theme = darkTheme("#000000", undefined, true);
    expect(UNIFIED_TERMINAL_BG_DARK).toBe("#0b0d10");
    expect(theme.background).toBe(UNIFIED_TERMINAL_BG_DARK);
    expect(theme.cursorAccent).toBe(UNIFIED_TERMINAL_BG_DARK);
    expect(theme.foreground).toBe("#c9d1d9");
    expect(theme.cursor).toBe("#f2a516");
  });

  it("keeps every text color readable on the slate surface", () => {
    const theme = darkTheme("#000000", undefined, true);
    for (const key of TEXT_SLOTS) {
      expect(contrast(theme.background!, theme[key]!), key).toBeGreaterThanOrEqual(4.5);
    }
    // ANSI black also paints panel backgrounds, so it stays near-black.
    expect(luminance(theme.black!)).toBeLessThan(0.1);
  });

  it("leaves the Grok full-screen palette alone", () => {
    const theme = darkTheme(FLUSH_TERMINAL_BG_DARK, FLUSH_TERMINAL_BG_DARK, true);
    expect(theme.background).toBe("#141414");
    expect(theme.foreground).toBe("#F4F4F4");
  });

  it("uses the off-white surface in light mode with readable colors", () => {
    const theme = lightTheme("#ffffff", true);
    expect(UNIFIED_TERMINAL_BG_LIGHT).toBe("#fbfbfc");
    expect(theme.background).toBe(UNIFIED_TERMINAL_BG_LIGHT);
    expect(luminance(theme.black!)).toBeLessThan(0.05);
    expect(luminance(theme.brightWhite!)).toBeGreaterThan(0.9);
    for (const key of TEXT_SLOTS.filter((k) => k !== "white" && k !== "brightWhite")) {
      expect(contrast(theme.background!, theme[key]!), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives the shell panel the same surface as the agent terminals", () => {
    expect(panelDarkTheme(UNIFIED_TERMINAL_BG_DARK, true).background).toBe(UNIFIED_TERMINAL_BG_DARK);
    expect(panelDarkTheme(UNIFIED_TERMINAL_BG_DARK, true).foreground).toBe("#c9d1d9");
    expect(panelLightTheme(UNIFIED_TERMINAL_BG_LIGHT, true).background).toBe(UNIFIED_TERMINAL_BG_LIGHT);
  });

  it("keeps the Glass palette unchanged when flat is off", () => {
    expect(darkTheme("#000000").background).toBe("#000000");
    expect(darkTheme("#000000").foreground).toBe("#e4e4e7");
    expect(lightTheme("#ffffff").background).toBe("#ffffff");
  });
});
