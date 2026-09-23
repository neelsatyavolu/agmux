# Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run setup wizard that guides new users through essential app configuration (provider detection, SDK mode, theme, color mode), and provide a way to re-launch it from Settings.

**Architecture:** Single new component `SetupWizardDialog.tsx` renders a multi-step modal wizard. A `setupWizardCompleted` boolean in `settingsStore` gates first-run display. Each wizard step is a pure function component receiving settings + updateSettings props. The wizard is mounted in `App.tsx` alongside existing dialogs and suppresses `LocalModelSetupDialog` and `NotificationPromptDialog` while active. A "Re-run Setup Wizard" button in the General settings page resets the flag and opens the wizard.

**Tech Stack:** React 19, TypeScript, Framer Motion 12, Zustand 5, Tailwind CSS v4, Tauri invoke (`detectAvailableProviders`, `sdkCheckAvailable`)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/components/sidebar/SetupWizardDialog.tsx` | Multi-step wizard dialog component (~350 lines) |
| Modify | `src/stores/settingsStore.ts` | Add `setupWizardCompleted` field + `openSetupWizard` / `closeSetupWizard` state |
| Modify | `src/App.tsx` | Mount `SetupWizardDialog`; suppress other first-run dialogs while wizard is open |
| Modify | `src/components/sidebar/SettingsDialog.tsx` | Add "Re-run Setup Wizard" button to GeneralPage |

---

### Task 1: Add `setupWizardCompleted` to Settings Store

**Files:**
- Modify: `src/stores/settingsStore.ts`

- [ ] **Step 1: Add the field to `AppSettings` interface**

In `src/stores/settingsStore.ts`, add a new field to the `AppSettings` interface after the `worktreeRoot` field:

```typescript
  // ── Setup Wizard ──
  /** Whether the user has completed (or skipped) the first-run setup wizard. */
  setupWizardCompleted: boolean;
```

- [ ] **Step 2: Add the default value**

In the `DEFAULT_SETTINGS` object, add after `worktreeRoot: ""`:

```typescript
  setupWizardCompleted: false,
```

- [ ] **Step 3: Add wizard open/close state and actions to the store**

Add `isSetupWizardOpen` and its actions to the `SettingsState` interface:

```typescript
interface SettingsState {
  settings: AppSettings;
  isOpen: boolean;
  isSetupWizardOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}
```

And implement them in the `create` call:

```typescript
  isSetupWizardOpen: false,
  openSetupWizard: () => set({ isSetupWizardOpen: true }),
  closeSetupWizard: () => set({ isSetupWizardOpen: false }),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to settingsStore (existing code may have unrelated warnings)

- [ ] **Step 5: Commit**

```bash
git add src/stores/settingsStore.ts
git commit -m "feat: add setupWizardCompleted flag and wizard open/close state to settings store"
```

---

### Task 2: Create the Setup Wizard Dialog Component

**Files:**
- Create: `src/components/sidebar/SetupWizardDialog.tsx`

- [ ] **Step 1: Create the wizard component file**

Create `src/components/sidebar/SetupWizardDialog.tsx` with the full implementation:

```tsx
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  ChevronLeft,
  Sparkles,
  CheckCircle2,
  XCircle,
  Loader2,
  Moon,
  Sun,
  Monitor,
  Cpu,
  Zap,
} from "lucide-react";
import { useSettingsStore, type AppTheme, type ColorMode } from "../../stores/settingsStore";
import { detectAvailableProviders, sdkCheckAvailable } from "../../lib/commands";
import type { AvailableProvider } from "../../lib/commands";

// ── Constants ────────────────────────────────────────────────────────────────

const THEMES: { value: AppTheme; label: string; accent: string }[] = [
  { value: "midnight-glass", label: "Midnight", accent: "#18181b" },
  { value: "forest-green", label: "Forest", accent: "#22c55e" },
  { value: "frosted-indigo", label: "Indigo", accent: "#3b82f6" },
  { value: "obsidian-gold", label: "Golden", accent: "#fbbf24" },
  { value: "violet-haze", label: "Violet", accent: "#a78bfa" },
  { value: "sunset-ember", label: "Sunset", accent: "#fb923c" },
  { value: "rose-quartz", label: "Rose", accent: "#fb7185" },
  { value: "arctic-frost", label: "Arctic", accent: "#22d3ee" },
  { value: "neon-noir", label: "Neon", accent: "#00ffaa" },
  { value: "mocha-latte", label: "Mocha", accent: "#d4a574" },
  { value: "slate-steel", label: "Steel", accent: "#94a3b8" },
];

const STEP_COUNT = 4;

type WizardStep = 0 | 1 | 2 | 3;

// ── Step Components ──────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600/20 border border-indigo-500/30">
        <Sparkles size={28} className="text-indigo-400" />
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-zinc-100">
        Welcome to Xanom
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
        Let's get you set up. We'll check your agent CLI tools, configure the
        SDK, and pick a look that suits you. This only takes a minute.
      </p>
    </div>
  );
}

function ProvidersStep({
  providers,
  providersLoading,
  sdkAvailable,
  sdkEnabled,
  onToggleSdk,
  defaultProvider,
  onSetProvider,
}: {
  providers: AvailableProvider[];
  providersLoading: boolean;
  sdkAvailable: boolean | null;
  sdkEnabled: boolean;
  onToggleSdk: (v: boolean) => void;
  defaultProvider: "ClaudeCode" | "Codex";
  onSetProvider: (p: "ClaudeCode" | "Codex") => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">Agent Providers</h2>
      <p className="mb-6 text-sm text-zinc-400">
        We checked which agent CLIs are installed on your system.
      </p>

      {/* Provider detection */}
      <div className="mb-6 space-y-2">
        {providersLoading ? (
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-400">
            <Loader2 size={16} className="animate-spin" />
            Detecting installed providers...
          </div>
        ) : (
          providers.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3"
            >
              {p.available ? (
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
              ) : (
                <XCircle size={16} className="text-zinc-500 shrink-0" />
              )}
              <span className={`text-sm font-medium ${p.available ? "text-zinc-200" : "text-zinc-500"}`}>
                {p.name}
              </span>
              <span className={`ml-auto text-xs ${p.available ? "text-emerald-400/80" : "text-zinc-600"}`}>
                {p.available ? "Installed" : "Not found"}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Default provider */}
      {providers.filter((p) => p.available).length > 1 && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Default Provider
          </p>
          <div className="flex gap-2">
            {(["ClaudeCode", "Codex"] as const).map((prov) => {
              const info = providers.find(
                (pp) => pp.id === (prov === "ClaudeCode" ? "claude" : "codex"),
              );
              if (!info?.available) return null;
              const isActive = defaultProvider === prov;
              return (
                <button
                  key={prov}
                  onClick={() => onSetProvider(prov)}
                  className={`rounded-lg border px-4 py-2 text-xs font-medium transition-all ${
                    isActive
                      ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-400"
                      : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/8"
                  }`}
                >
                  {prov === "ClaudeCode" ? "Claude Code" : "Codex"}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* SDK toggle */}
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Cpu size={16} className="text-indigo-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Agent SDK Mode</p>
              <p className="text-xs text-zinc-500">
                Structured chat interface instead of raw terminal.
                {sdkAvailable === false && " (Node.js not found)"}
              </p>
            </div>
          </div>
          <button
            onClick={() => onToggleSdk(!sdkEnabled)}
            disabled={sdkAvailable === false}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              sdkEnabled ? "bg-indigo-600" : "bg-zinc-700"
            } ${sdkAvailable === false ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                sdkEnabled ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function AppearanceStep({
  colorMode,
  theme,
  onSetColorMode,
  onSetTheme,
}: {
  colorMode: ColorMode;
  theme: AppTheme;
  onSetColorMode: (m: ColorMode) => void;
  onSetTheme: (t: AppTheme) => void;
}) {
  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">Appearance</h2>
      <p className="mb-6 text-sm text-zinc-400">
        Pick a color mode and theme. You can always change these later in Settings.
      </p>

      {/* Color mode */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Color Mode
      </p>
      <div className="mb-6 flex gap-2">
        {([
          { value: "dark" as ColorMode, label: "Dark", icon: <Moon size={14} /> },
          { value: "light" as ColorMode, label: "Light", icon: <Sun size={14} /> },
          { value: "system" as ColorMode, label: "System", icon: <Monitor size={14} /> },
        ]).map((m) => {
          const isActive = colorMode === m.value;
          return (
            <button
              key={m.value}
              onClick={() => onSetColorMode(m.value)}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-medium transition-all ${
                isActive
                  ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-400"
                  : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/8"
              }`}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Theme grid */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Theme
      </p>
      <div className="grid grid-cols-4 gap-2">
        {THEMES.map((t) => {
          const isActive = theme === t.value;
          return (
            <button
              key={t.value}
              onClick={() => onSetTheme(t.value)}
              className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-medium transition-all ${
                isActive
                  ? "border-indigo-500/50 bg-indigo-500/10 shadow-lg"
                  : "border-white/10 bg-white/5 hover:bg-white/8"
              }`}
            >
              <span
                className="h-3.5 w-3.5 rounded-full"
                style={{
                  backgroundColor: t.accent,
                  boxShadow: isActive ? `0 0 10px ${t.accent}80` : "none",
                }}
              />
              <span className={isActive ? "text-zinc-100" : "text-zinc-400"}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/20 border border-emerald-500/30">
        <Zap size={28} className="text-emerald-400" />
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-zinc-100">
        You're all set
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
        Everything is configured. You can always tweak these settings later from
        the Settings panel (<kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300 font-mono">&#8984;,</kbd>).
      </p>
    </div>
  );
}

// ── Main Wizard Component ────────────────────────────────────────────────────

export function SetupWizardDialog() {
  const settings = useSettingsStore((s) => s.settings);
  const isOpen = useSettingsStore((s) => s.isSetupWizardOpen);
  const closeSetupWizard = useSettingsStore((s) => s.closeSetupWizard);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [step, setStep] = useState<WizardStep>(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  // Provider detection state
  const [providers, setProviders] = useState<AvailableProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [sdkAvailable, setSdkAvailable] = useState<boolean | null>(null);

  // Auto-open on first launch when wizard hasn't been completed
  useEffect(() => {
    if (!settings.setupWizardCompleted) {
      useSettingsStore.getState().openSetupWizard();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect providers when wizard opens
  useEffect(() => {
    if (!isOpen) return;
    setStep(0);
    setDirection(1);
    setProvidersLoading(true);

    Promise.all([
      detectAvailableProviders().catch(() => [] as AvailableProvider[]),
      sdkCheckAvailable().catch(() => false),
    ]).then(([provs, sdk]) => {
      setProviders(provs);
      setSdkAvailable(sdk);
      setProvidersLoading(false);

      // Auto-select a default provider if only one is available
      const available = provs.filter((p) => p.available);
      if (available.length === 1) {
        const prov = available[0].id === "codex" ? "Codex" : "ClaudeCode";
        updateSettings({ defaultProvider: prov as "ClaudeCode" | "Codex" });
      }

      // Auto-enable SDK if Node.js is available
      if (sdk && !useSettingsStore.getState().settings.sdkEnabled) {
        updateSettings({ sdkEnabled: true });
      }
    });
  }, [isOpen, updateSettings]);

  const goNext = useCallback(() => {
    if (step < STEP_COUNT - 1) {
      setDirection(1);
      setStep((s) => (s + 1) as WizardStep);
    }
  }, [step]);

  const goBack = useCallback(() => {
    if (step > 0) {
      setDirection(-1);
      setStep((s) => (s - 1) as WizardStep);
    }
  }, [step]);

  const handleComplete = useCallback(() => {
    updateSettings({ setupWizardCompleted: true });
    closeSetupWizard();
  }, [updateSettings, closeSetupWizard]);

  const handleSkip = useCallback(() => {
    updateSettings({ setupWizardCompleted: true });
    closeSetupWizard();
  }, [updateSettings, closeSetupWizard]);

  const isLastStep = step === STEP_COUNT - 1;

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0 }),
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(20px)" }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl"
            style={{ backdropFilter: "blur(24px)" }}
          >
            {/* Progress bar */}
            <div className="px-8 pt-6">
              <div className="flex gap-1.5">
                {Array.from({ length: STEP_COUNT }).map((_, i) => (
                  <div
                    key={i}
                    className="h-1 flex-1 rounded-full transition-colors duration-300"
                    style={{
                      backgroundColor: i <= step ? "var(--accent, #6366f1)" : "rgba(255,255,255,0.1)",
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Step content */}
            <div className="relative min-h-[340px] overflow-hidden px-8 py-8">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={step}
                  custom={direction}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                >
                  {step === 0 && <WelcomeStep />}
                  {step === 1 && (
                    <ProvidersStep
                      providers={providers}
                      providersLoading={providersLoading}
                      sdkAvailable={sdkAvailable}
                      sdkEnabled={settings.sdkEnabled}
                      onToggleSdk={(v) => updateSettings({ sdkEnabled: v })}
                      defaultProvider={settings.defaultProvider}
                      onSetProvider={(p) => updateSettings({ defaultProvider: p })}
                    />
                  )}
                  {step === 2 && (
                    <AppearanceStep
                      colorMode={settings.colorMode}
                      theme={settings.theme}
                      onSetColorMode={(m) => updateSettings({ colorMode: m })}
                      onSetTheme={(t) => updateSettings({ theme: t })}
                    />
                  )}
                  {step === 3 && <CompleteStep />}
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Footer navigation */}
            <div className="flex items-center justify-between border-t border-white/10 px-8 py-5">
              <div>
                {step > 0 ? (
                  <button
                    onClick={goBack}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/6 hover:text-zinc-200 transition-colors"
                  >
                    <ChevronLeft size={15} />
                    Back
                  </button>
                ) : (
                  <button
                    onClick={handleSkip}
                    className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Skip setup
                  </button>
                )}
              </div>
              <button
                onClick={isLastStep ? handleComplete : goNext}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
              >
                {isLastStep ? "Get Started" : "Continue"}
                {!isLastStep && <ChevronRight size={15} />}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to SetupWizardDialog

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/SetupWizardDialog.tsx
git commit -m "feat: add SetupWizardDialog component with 4-step first-run wizard"
```

---

### Task 3: Mount the Wizard in App.tsx and Suppress Other First-Run Dialogs

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the import**

At the top of `src/App.tsx`, add after the `LocalModelSetupDialog` import:

```typescript
import { SetupWizardDialog } from "./components/sidebar/SetupWizardDialog";
```

- [ ] **Step 2: Mount the wizard in the render tree**

In the `App` component's return JSX, add `<SetupWizardDialog />` right after `<SettingsDialog />` (before `<LocalModelSetupDialog />`):

Replace:
```tsx
      <SettingsDialog />
      <LocalModelSetupDialog />
```

With:
```tsx
      <SettingsDialog />
      <SetupWizardDialog />
      <LocalModelSetupDialog />
```

Note: No conditional rendering needed here — `SetupWizardDialog` internally reads `isSetupWizardOpen` from the store and renders nothing when closed. The z-index of `z-[60]` on the wizard is higher than the `z-50` on `LocalModelSetupDialog` and `NotificationPromptDialog`, so the wizard naturally overlays them. Those dialogs also have their own localStorage-based dismissal gates, so they'll simply show after the wizard if applicable.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: mount SetupWizardDialog in App component"
```

---

### Task 4: Add "Re-run Setup Wizard" Button in Settings General Page

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx`

- [ ] **Step 1: Add the import for `openSetupWizard`**

The `SettingsDialog` already imports `useSettingsStore`. The `GeneralPage` component receives `settings` and `updateSettings` as props. We need to add a call to `openSetupWizard` and `closeSettings`. Modify the `GeneralPage` function signature to also accept these:

Find the `GeneralPage` function definition:
```typescript
function GeneralPage({
  settings,
  updateSettings,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
}) {
```

Replace with:
```typescript
function GeneralPage({
  settings,
  updateSettings,
  onRerunWizard,
}: {
  settings: SettingsShape;
  updateSettings: (patch: Partial<SettingsShape>) => void;
  onRerunWizard: () => void;
}) {
```

- [ ] **Step 2: Add the wizard button section at the bottom of GeneralPage**

Find the closing `</SettingsCard>` of the "Behavior" section (the last `</SettingsCard>` before the closing `</div>` of `GeneralPage`). After it, add:

```tsx
      <SectionTitle className="mt-6">Setup</SectionTitle>
      <SettingsCard>
        <SettingsRow
          label="Setup wizard"
          description="Re-run the first-launch setup wizard to reconfigure providers, SDK, and theme."
          last
        >
          <button
            onClick={onRerunWizard}
            className="rounded-lg border border-indigo-500/50 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-400 hover:bg-indigo-500/20 transition-colors"
          >
            Run Wizard
          </button>
        </SettingsRow>
      </SettingsCard>
```

- [ ] **Step 3: Update the GeneralPage callsite in SettingsDialog**

Find where `GeneralPage` is rendered inside `SettingsDialog`:
```tsx
                    {activeTab === "general" && (
                      <GeneralPage
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    )}
```

Replace with:
```tsx
                    {activeTab === "general" && (
                      <GeneralPage
                        settings={settings}
                        updateSettings={updateSettings}
                        onRerunWizard={() => {
                          closeSettings();
                          updateSettings({ setupWizardCompleted: false });
                          useSettingsStore.getState().openSetupWizard();
                        }}
                      />
                    )}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/SettingsDialog.tsx
git commit -m "feat: add 'Re-run Setup Wizard' button to General settings page"
```

---

### Task 5: Manual Smoke Test

- [ ] **Step 1: Clear the wizard completion flag to simulate first run**

Open the app dev tools console and run:
```javascript
const raw = JSON.parse(localStorage.getItem("xanom-settings") || "{}");
delete raw.setupWizardCompleted;
localStorage.setItem("xanom-settings", JSON.stringify(raw));
location.reload();
```

Expected: The wizard dialog appears with the Welcome step.

- [ ] **Step 2: Walk through the wizard**

1. Welcome step — click "Continue"
2. Providers step — verify Claude Code and/or Codex detection, toggle SDK, click "Continue"
3. Appearance step — switch color mode, pick a theme, click "Continue"
4. Complete step — click "Get Started"

Expected: Wizard closes, app is usable, settings persist.

- [ ] **Step 3: Verify wizard doesn't reappear on refresh**

Refresh the page (Cmd+R in dev mode).
Expected: Wizard does not appear.

- [ ] **Step 4: Re-run wizard from Settings**

Open Settings (Cmd+,) → General tab → scroll to "Setup" section → click "Run Wizard".
Expected: Settings closes, wizard opens, all steps work again.

- [ ] **Step 5: Test skip functionality**

Clear the flag again (step 1), reload, click "Skip setup" on the Welcome step.
Expected: Wizard closes, `setupWizardCompleted` is set to `true`.

---

### Task 6: Final TypeScript Check and Commit

- [ ] **Step 1: Run full type check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: Clean output (no errors)

- [ ] **Step 2: Verify no regressions**

Run: `cd /Users/neel/Documents/GitHub/xanom && npm run dev`
Expected: App launches, wizard appears on first run, settings work normally.
