import { useEffect, useState } from "react";
import { useSettingsStore, type AppTheme, type UIFont, type MonoFont, type AnimationSpeed } from "../stores/settingsStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setWindowTheme } from "../lib/commands";

/**
 * Base theme definitions at default intensity (50).
 *
 * Rules for dual-mode themes (everything except midnight, which is brand-locked):
 * - tint: deep near-black with a subtle hue (glass wash), never mid-tone mud
 * - border: soft near-white / desaturated hue — NOT the raw accent (avoids neon edges)
 * - accent: mid-sat colour that still reads on dark glass
 * - text: neutral zinc ladder with a light hue tip — never use accent as body/muted text
 * - light mode is derived in buildThemeVars (paper surfaces + contrast-safe accent)
 */
const THEME_BASES: Record<Exclude<AppTheme, "custom">, {
  tint: [number, number, number];
  border: [number, number, number];
  accent: string;
  accentRgb: [number, number, number];
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
}> = {
  "midnight-glass": {
    // Brand gold shared with agmux.dev and the phone app (#f2a516).
    // Leave alone — default product look.
    tint: [0, 0, 0], border: [255, 255, 255], accent: "#f2a516", accentRgb: [242, 165, 22],
    textPrimary: "#ffffff", textSecondary: "#e4e4e7", textTertiary: "#d4d4d8", textMuted: "#a1a1aa",
  },
  "forest-green": {
    tint: [6, 18, 12], border: [180, 210, 190], accent: "#34d399", accentRgb: [52, 211, 153],
    textPrimary: "#f4faf7", textSecondary: "#d5e6dc", textTertiary: "#9fb8aa", textMuted: "#6f8a7c",
  },
  "frosted-indigo": {
    tint: [10, 14, 28], border: [160, 175, 200], accent: "#60a5fa", accentRgb: [96, 165, 250],
    textPrimary: "#f1f5f9", textSecondary: "#d0d9e6", textTertiary: "#94a3b8", textMuted: "#64748b",
  },
  "obsidian-gold": {
    tint: [18, 14, 6], border: [210, 195, 155], accent: "#eab308", accentRgb: [234, 179, 8],
    textPrimary: "#faf8f2", textSecondary: "#e4dcc8", textTertiary: "#b5a88a", textMuted: "#8a7e64",
  },
  "violet-haze": {
    tint: [16, 10, 28], border: [185, 170, 220], accent: "#a78bfa", accentRgb: [167, 139, 250],
    textPrimary: "#f6f4fb", textSecondary: "#ddd6ee", textTertiary: "#a89fc4", textMuted: "#756d90",
  },
  "sunset-ember": {
    tint: [24, 12, 8], border: [220, 180, 150], accent: "#f97316", accentRgb: [249, 115, 22],
    textPrimary: "#faf6f3", textSecondary: "#e8d8ce", textTertiary: "#b89a88", textMuted: "#8a7062",
  },
  "rose-quartz": {
    tint: [24, 10, 16], border: [220, 170, 185], accent: "#f43f5e", accentRgb: [244, 63, 94],
    textPrimary: "#faf4f6", textSecondary: "#e8d4da", textTertiary: "#b8909a", textMuted: "#8a6a74",
  },
  "arctic-frost": {
    tint: [6, 16, 24], border: [150, 200, 215], accent: "#22d3ee", accentRgb: [34, 211, 238],
    textPrimary: "#f2f9fb", textSecondary: "#cfe3e9", textTertiary: "#8fafba", textMuted: "#678490",
  },
  "neon-noir": {
    // Soft cyber mint — pure #00ffaa is unreadable as UI chrome in light mode.
    tint: [4, 16, 14], border: [120, 200, 175], accent: "#2dd4bf", accentRgb: [45, 212, 191],
    textPrimary: "#f0faf7", textSecondary: "#c8e8df", textTertiary: "#7fb5a8", textMuted: "#5a8a7e",
  },
  "mocha-latte": {
    tint: [22, 16, 12], border: [195, 170, 140], accent: "#c4a484", accentRgb: [196, 164, 132],
    textPrimary: "#faf7f3", textSecondary: "#e4d8cc", textTertiary: "#b5a090", textMuted: "#8a7868",
  },
  "slate-steel": {
    tint: [12, 14, 18], border: [150, 160, 180], accent: "#94a3b8", accentRgb: [148, 163, 184],
    textPrimary: "#f1f5f9", textSecondary: "#cbd5e1", textTertiary: "#94a3b8", textMuted: "#64748b",
  },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance 0–1 (sRGB). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Accents that are bright on dark glass often fail contrast on light paper.
 * Darken to at least 4.5:1 against #ebebeb, the shaded light paper surface.
 */
function contrastSafeAccent(rgb: [number, number, number]): {
  hex: string;
  rgb: [number, number, number];
} {
  let [r, g, b] = rgb;
  let guard = 0;
  while ((relativeLuminance([235, 235, 235]) + 0.05) / (relativeLuminance([r, g, b]) + 0.05) < 4.5 && guard < 8) {
    r = Math.round(r * 0.82);
    g = Math.round(g * 0.82);
    b = Math.round(b * 0.82);
    guard += 1;
  }
  const out: [number, number, number] = [r, g, b];
  return { hex: rgbToHex(out), rgb: out };
}

/** Soft paper RGB for light mode — white mixed with the theme accent. */
function lightPaperRgb(accentRgb: [number, number, number]): [number, number, number] {
  const [ar, ag, ab] = accentRgb;
  const mix = 0.055;
  return [
    Math.round(250 * (1 - mix) + ar * mix),
    Math.round(250 * (1 - mix) + ag * mix),
    Math.round(252 * (1 - mix) + ab * mix),
  ];
}

/** Generate CSS variables from a theme base + intensity/border settings. */
function buildThemeVars(
  tint: [number, number, number],
  border: [number, number, number],
  accent: string,
  accentRgb: [number, number, number],
  textPrimary: string,
  textSecondary: string,
  textTertiary: string,
  textMuted: string,
  intensity: number,
  borderBrightness: number,
  lightMode: boolean,
): Record<string, string> {
  if (lightMode) {
    // Paper surfaces tinted by accent; dark readable text; contrast-safe accent.
    const [lr, lg, lb] = lightPaperRgb(accentRgb);
    const safe = contrastSafeAccent(accentRgb);
    const [ar, ag, ab] = safe.rgb;

    const i = intensity / 100;
    const b = borderBrightness / 100;

    return {
      "--glass-bg": `rgba(${lr}, ${lg}, ${lb}, ${clamp01(0.72 * i * 2).toFixed(2)})`,
      "--glass-bg-heavy": `rgba(${lr}, ${lg}, ${lb}, ${clamp01(0.86 * i * 2).toFixed(2)})`,
      "--glass-sidebar": `rgba(${lr}, ${lg}, ${lb}, ${clamp01(0.68 * i * 2).toFixed(2)})`,
      "--glass-header": `rgba(${lr}, ${lg}, ${lb}, ${clamp01(0.78 * i * 2).toFixed(2)})`,
      "--glass-card": `rgba(${lr}, ${lg}, ${lb}, ${clamp01(0.62 * i * 2).toFixed(2)})`,
      "--glass-border": `rgba(15, 18, 22, ${clamp01(0.07 * b * 2).toFixed(3)})`,
      "--glass-border-highlight": `rgba(15, 18, 22, ${clamp01(0.11 * b * 2).toFixed(3)})`,
      "--glass-border-strong": `rgba(15, 18, 22, ${clamp01(0.17 * b * 2).toFixed(3)})`,
      "--glass-hover": `rgba(15, 18, 22, ${clamp01(0.04 * b * 2).toFixed(3)})`,
      "--glass-active": `rgba(15, 18, 22, ${clamp01(0.08 * b * 2).toFixed(3)})`,
      "--accent": safe.hex,
      "--accent-dim": `rgba(${ar}, ${ag}, ${ab}, 0.12)`,
      "--accent-border": `rgba(${ar}, ${ag}, ${ab}, 0.32)`,
      // Neutral zinc ladder — readable body text on paper in every theme.
      "--text-primary": "#18181b",
      "--text-secondary": "#3f3f46",
      "--text-tertiary": "#52525b",
      "--text-muted": "#71717a",
    };
  }

  // Dark mode
  const [tr, tg, tb] = tint;
  const [br, bg, bb] = border;
  const [ar, ag, ab] = accentRgb;

  // Intensity scales glass surface opacities (0-100, default 50)
  const i = intensity / 100;
  // Border brightness scales border alpha (0-100, default 50)
  const b = borderBrightness / 100;

  return {
    "--glass-bg": `rgba(${tr}, ${tg}, ${tb}, ${(0.30 * i * 2).toFixed(2)})`,
    "--glass-bg-heavy": `rgba(${tr}, ${tg}, ${tb}, ${(0.45 * i * 2).toFixed(2)})`,
    "--glass-sidebar": `rgba(${tr}, ${tg}, ${tb}, ${(0.30 * i * 2).toFixed(2)})`,
    "--glass-header": `rgba(${tr}, ${tg}, ${tb}, ${(0.35 * i * 2).toFixed(2)})`,
    "--glass-card": `rgba(${tr}, ${tg}, ${tb}, ${(0.25 * i * 2).toFixed(2)})`,
    "--glass-border": `rgba(${br}, ${bg}, ${bb}, ${(0.08 * b * 2).toFixed(3)})`,
    "--glass-border-highlight": `rgba(${br}, ${bg}, ${bb}, ${(0.14 * b * 2).toFixed(3)})`,
    "--glass-border-strong": `rgba(${br}, ${bg}, ${bb}, ${(0.20 * b * 2).toFixed(3)})`,
    "--glass-hover": `rgba(${br}, ${bg}, ${bb}, ${(0.06 * b * 2).toFixed(3)})`,
    "--glass-active": `rgba(${br}, ${bg}, ${bb}, ${(0.12 * b * 2).toFixed(3)})`,
    "--accent": accent,
    "--accent-dim": `rgba(${ar}, ${ag}, ${ab}, 0.15)`,
    "--accent-border": `rgba(${ar}, ${ag}, ${ab}, 0.40)`,
    "--text-primary": textPrimary,
    "--text-secondary": textSecondary,
    "--text-tertiary": textTertiary,
    "--text-muted": textMuted,
  };
}

/**
 * Flat surfaces (the unified agmux.dev / phone look): opaque slate instead of
 * tinted glass. Accent handling stays in the theme effect, so every theme and
 * custom accent keeps working. Values mirror remote-relay/public/app.html.
 */
export function buildFlatVars(lightMode: boolean): Record<string, string> {
  if (lightMode) {
    return {
      "--glass-bg": "#f7f8fa",
      "--glass-bg-heavy": "#edf0f3",
      "--glass-sidebar": "#edf0f3",
      "--glass-header": "#f7f8fa",
      "--glass-card": "#ffffff",
      "--glass-border": "#dde1e6",
      "--glass-border-highlight": "#cdd2d9",
      "--glass-border-strong": "#b9c0c9",
      "--glass-hover": "rgba(23, 27, 34, 0.045)",
      "--glass-active": "rgba(23, 27, 34, 0.08)",
      "--text-primary": "#171b22",
      "--text-secondary": "#2b313b",
      "--text-tertiary": "#586170",
      "--text-muted": "#818a98",
    };
  }
  return {
    "--glass-bg": "#0f1115",
    "--glass-bg-heavy": "#13161b",
    "--glass-sidebar": "#13161b",
    "--glass-header": "#0f1115",
    "--glass-card": "#1a1e25",
    "--glass-border": "#252a33",
    "--glass-border-highlight": "#313744",
    "--glass-border-strong": "#3b4250",
    "--glass-hover": "rgba(255, 255, 255, 0.045)",
    "--glass-active": "rgba(255, 255, 255, 0.08)",
    "--text-primary": "#eef0f3",
    "--text-secondary": "#cfd4dc",
    "--text-tertiary": "#98a1af",
    "--text-muted": "#6c7482",
  };
}

/** Resolve effective light/dark mode from setting + system preference. */
export function useResolvedColorMode(): boolean {
  const colorMode = useSettingsStore((s) => s.settings.colorMode) ?? "dark";
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);

  useEffect(() => {
    if (colorMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPrefersDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [colorMode]);

  if (colorMode === "light") return true;
  if (colorMode === "dark") return false;
  return !systemPrefersDark; // system mode
}

const UI_FONT_MAP: Record<UIFont, string> = {
  "archivo": '"Archivo", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "geist": '"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "inter": '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "sf-pro": '"SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif',
  "zed-sans": '"Zed Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "system": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

export const MONO_FONT_MAP: Record<MonoFont, string> = {
  "geist-mono": '"Geist Mono", "JetBrains Mono", "SF Mono", monospace',
  "jetbrains-mono": '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
  "fira-code": '"Fira Code", "JetBrains Mono", monospace',
  "hack": '"Hack", "SF Mono", "Fira Code", monospace',
  "zed-mono": '"Zed Mono", "SF Mono", "Fira Code", monospace',
  "sf-mono": '"SF Mono", "Menlo", "Cascadia Code", monospace',
  "menlo": '"Menlo", "SF Mono", "Consolas", monospace',
  "source-code-pro": '"Source Code Pro", "SF Mono", "Fira Code", monospace',
  "system": '"SF Mono", "Cascadia Code", "Consolas", monospace',
};

/** Parse a 6-digit hex color string (#rrggbb) into r, g, b components. Returns null if invalid. */
function parseHex(hex: string): [number, number, number] | null {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b];
}

/** Build sidebar rgba using the theme's tint color at a given opacity. */
function buildSidebarColor(tint: [number, number, number], opacityPct: number): string {
  const [r, g, b] = tint;
  return `rgba(${r}, ${g}, ${b}, ${opacityPct / 100})`;
}

/** Get the tint color for any theme including custom. */
function getTint(theme: AppTheme, customColor: string): [number, number, number] {
  if (theme === "custom") {
    const rgb = parseHex(customColor);
    if (rgb) {
      // Darken the custom color to use as tint (divide by ~4 for subtle tint)
      return [Math.round(rgb[0] / 4), Math.round(rgb[1] / 4), Math.round(rgb[2] / 4)];
    }
    return [0, 0, 0];
  }
  return THEME_BASES[theme]?.tint ?? [0, 0, 0];
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const accentColor = useSettingsStore((s) => s.settings.accentColor);
  const uiFont = useSettingsStore((s) => s.settings.uiFont);
  const monoFont = useSettingsStore((s) => s.settings.monoFont);
  const uiFontSize = useSettingsStore((s) => s.settings.uiFontSize);
  const chatFontSize = useSettingsStore((s) => s.settings.chatFontSize);
  const animationSpeed = useSettingsStore((s) => s.settings.animationSpeed);
  const glassBlur = useSettingsStore((s) => s.settings.glassBlur);
  const sidebarOpacity = useSettingsStore((s) => s.settings.sidebarOpacity);
  const glassIntensity = useSettingsStore((s) => s.settings.glassIntensity);
  const borderBrightness = useSettingsStore((s) => s.settings.borderBrightness);
  const customThemeColor = useSettingsStore((s) => s.settings.customThemeColor);
  const surfaceStyle = useSettingsStore((s) => s.settings.surfaceStyle) ?? "flat";
  const isLightMode = useResolvedColorMode();
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Detect fullscreen changes to toggle vibrancy fallback
  useEffect(() => {
    // Guard: getCurrentWindow requires the Tauri runtime
    if (!("__TAURI_INTERNALS__" in window)) return;

    const appWindow = getCurrentWindow();
    let cancelled = false;

    // Check initial state
    appWindow.isFullscreen().then((fs) => {
      if (!cancelled) setIsFullscreen(fs);
    }).catch(console.error);

    // Listen for resize events (fullscreen triggers resize)
    const unlisten = appWindow.onResized(() => {
      appWindow.isFullscreen().then((fs) => {
        if (!cancelled) setIsFullscreen(fs);
      }).catch(console.error);
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  // Toggle fullscreen class on root
  useEffect(() => {
    const root = document.documentElement;
    if (isFullscreen) {
      root.classList.add("no-vibrancy");
    } else {
      root.classList.remove("no-vibrancy");
    }
  }, [isFullscreen]);

  // Apply theme variables
  useEffect(() => {
    const root = document.documentElement;
    const intensity = glassIntensity ?? 50;
    const border = borderBrightness ?? 50;

    let vars: Record<string, string>;

    if (theme === "custom") {
      const rgb = parseHex(customThemeColor || "#6366f1") ?? [99, 102, 241];
      const tint: [number, number, number] = [Math.round(rgb[0] / 4), Math.round(rgb[1] / 4), Math.round(rgb[2] / 4)];
      vars = buildThemeVars(
        tint, rgb as [number, number, number],
        customThemeColor || "#6366f1", rgb as [number, number, number],
        "#f8fafc", "#e2e8f0", "#94a3b8", "#64748b",
        intensity, border, isLightMode,
      );
    } else {
      const base = THEME_BASES[theme] ?? THEME_BASES["midnight-glass"];
      vars = buildThemeVars(
        base.tint, base.border, base.accent, base.accentRgb,
        base.textPrimary, base.textSecondary, base.textTertiary, base.textMuted,
        intensity, border, isLightMode,
      );
    }

    // Resolve overrides together so changing one setting cannot reset another.
    const rgb = accentColor ? parseHex(accentColor) : null;
    if (rgb) {
      const safe = isLightMode ? contrastSafeAccent(rgb) : { hex: accentColor, rgb };
      const [r, g, b] = safe.rgb;
      vars["--accent"] = safe.hex;
      vars["--accent-dim"] = `rgba(${r}, ${g}, ${b}, ${isLightMode ? 0.12 : 0.15})`;
      vars["--accent-border"] = `rgba(${r}, ${g}, ${b}, ${isLightMode ? 0.32 : 0.40})`;
    }

    if (surfaceStyle === "flat") {
      Object.assign(vars, buildFlatVars(isLightMode));
    } else if (isLightMode) {
      // Match light-mode paper formula so sidebar doesn't fight the theme wash.
      let accentRgb: [number, number, number];
      if (theme === "custom") {
        accentRgb = parseHex(customThemeColor || "#6366f1") ?? [99, 102, 241];
      } else {
        accentRgb = (THEME_BASES[theme] ?? THEME_BASES["midnight-glass"]).accentRgb;
      }
      const [lr, lg, lb] = lightPaperRgb(accentRgb);
      const color = `rgba(${lr}, ${lg}, ${lb}, ${(sidebarOpacity ?? 55) / 100})`;
      vars["--glass-sidebar"] = color;
    } else {
      const tint = getTint(theme, customThemeColor || "#6366f1");
      const color = buildSidebarColor(tint, sidebarOpacity ?? 65);
      vars["--glass-sidebar"] = color;
    }

    // Consumers with solid accent fills need a paired foreground, including custom accents.
    const appliedAccent = parseHex(vars["--accent"]);
    if (appliedAccent) {
      vars["--accent-foreground"] = relativeLuminance(appliedAccent) > 0.179 ? "#000000" : "#ffffff";
    }

    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }

    root.setAttribute("data-theme", theme);
    root.setAttribute("data-mode", isLightMode ? "light" : "dark");
    root.setAttribute("data-surface", surfaceStyle);
    root.style.colorScheme = isLightMode ? "light" : "dark";
  }, [theme, glassIntensity, borderBrightness, customThemeColor, isLightMode, accentColor, sidebarOpacity, surfaceStyle]);

  // Sync macOS window theme with color mode so vibrancy material adapts
  useEffect(() => {
    const colorMode = useSettingsStore.getState().settings.colorMode ?? "dark";
    setWindowTheme(colorMode, isLightMode).catch(() => {});
  }, [isLightMode]);

  // Font family overrides
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-sans", UI_FONT_MAP[uiFont ?? "archivo"]);
  }, [uiFont]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-mono", MONO_FONT_MAP[monoFont ?? "geist-mono"]);
  }, [monoFont]);

  // UI font size on <html>
  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontSize ?? 14}px`;
  }, [uiFontSize]);

  // Chat font size CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-font-size", `${chatFontSize ?? 15}px`);
  }, [chatFontSize]);

  // Animation speed
  useEffect(() => {
    const speed: AnimationSpeed = animationSpeed ?? "smooth";
    document.documentElement.setAttribute("data-animation", speed);
  }, [animationSpeed]);

  // Glass blur
  useEffect(() => {
    document.documentElement.style.setProperty("--glass-blur", `${glassBlur ?? 12}px`);
  }, [glassBlur]);

  return <>{children}</>;
}
