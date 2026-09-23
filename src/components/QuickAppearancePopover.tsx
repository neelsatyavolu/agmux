import { useState, useRef, useEffect } from "react";
import { Palette } from "lucide-react";
import { useSettingsStore, type UIFont, type MonoFont } from "../stores/settingsStore";
import { THEMES } from "./sidebar/SettingsDialog";

const UI_FONTS: { value: UIFont; label: string }[] = [
  { value: "system", label: "System" },
  { value: "inter", label: "Inter" },
  { value: "geist", label: "Geist" },
];

const MONO_FONTS: { value: MonoFont; label: string }[] = [
  { value: "system", label: "System Mono" },
  { value: "jetbrains-mono", label: "JetBrains" },
  { value: "fira-code", label: "Fira Code" },
  { value: "geist-mono", label: "Geist Mono" },
];

const FONT_SIZES = [12, 13, 14, 15, 16] as const;
const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const;

export function QuickAppearancePopover() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const theme = useSettingsStore((s) => s.settings.theme);
  const uiFont = useSettingsStore((s) => s.settings.uiFont);
  const monoFont = useSettingsStore((s) => s.settings.monoFont);
  const uiFontSize = useSettingsStore((s) => s.settings.uiFontSize);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);

  // Find current theme label
  const currentTheme = THEMES.find((t) => t.value === theme);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
        title="Appearance"
      >
        <Palette size={12} />
        <span className="hidden sm:inline">{currentTheme?.label ?? "Theme"}</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-white/[0.08] bg-zinc-900/95 backdrop-blur-xl shadow-2xl p-3 space-y-3">
          {/* Theme grid */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Theme
            </label>
            <div className="grid grid-cols-4 gap-1">
              {THEMES.filter((t) => t.value !== "custom").map((t) => (
                <button
                  key={t.value}
                  onClick={() => updateSettings({ theme: t.value })}
                  className={`flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10px] transition-colors ${
                    theme === t.value
                      ? "bg-blue-600/20 text-blue-400 ring-1 ring-blue-500/30"
                      : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  <div
                    className="h-4 w-4 rounded-full ring-1 ring-white/10"
                    style={{ background: t.accent }}
                  />
                  <span className="truncate w-full text-center">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* UI Font */}
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              UI Font
            </label>
            <div className="flex gap-1">
              {UI_FONTS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => updateSettings({ uiFont: f.value })}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                    uiFont === f.value
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mono Font */}
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Code Font
            </label>
            <div className="flex gap-1">
              {MONO_FONTS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => updateSettings({ monoFont: f.value })}
                  className={`flex-1 rounded-md px-1 py-1 text-[10px] transition-colors ${
                    monoFont === f.value
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font sizes */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                UI Size
              </label>
              <div className="flex gap-0.5">
                {FONT_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => updateSettings({ uiFontSize: s })}
                    className={`flex-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
                      uiFontSize === s
                        ? "bg-blue-600/20 text-blue-400"
                        : "text-zinc-500 hover:bg-zinc-800"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Term Size
              </label>
              <div className="flex gap-0.5">
                {TERMINAL_FONT_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => updateSettings({ terminalFontSize: s })}
                    className={`flex-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
                      terminalFontSize === s
                        ? "bg-blue-600/20 text-blue-400"
                        : "text-zinc-500 hover:bg-zinc-800"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
