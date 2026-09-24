/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  detectAvailableProviders: vi.fn().mockResolvedValue([]),
  remoteSetEnabled: vi.fn().mockResolvedValue({ enabled: false }),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  sdkCheckAvailable: vi.fn().mockResolvedValue(true),
  localModelStatus: vi.fn(() => new Promise(() => {})),
  downloadLocalModel: vi.fn().mockResolvedValue(undefined),
  deleteLocalModel: vi.fn().mockResolvedValue(undefined),
  setActiveLocalModel: vi.fn().mockResolvedValue(undefined),
  ensureLocalLlmServer: vi.fn().mockResolvedValue(0),
  stopLocalLlmServer: vi.fn().mockResolvedValue(undefined),
  isLegacyLocalModelVariant: (v: string) => v === "small" || v === "large",
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));

import { SetupWizardDialog } from "../SetupWizardDialog";
import { useSettingsStore, ONBOARDING_REVISION } from "../../../stores/settingsStore";
import { useLocalModelStore } from "../../../stores/localModelStore";

function setWizardState(open: boolean, overrides: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    isSetupWizardOpen: open,
    settings: {
      ...useSettingsStore.getState().settings,
      // Satisfied revision so auto-open useEffect stays closed unless tests open it.
      setupWizardCompleted: true,
      onboardingRevision: ONBOARDING_REVISION,
      ...overrides,
    },
  });
}

beforeEach(() => {
  setWizardState(false);
  useLocalModelStore.setState({
    status: null,
    downloading: false,
    downloadProgress: null,
    error: null,
    hasSeenSetupPrompt: false,
  });
});

afterEach(() => cleanup());

describe("SetupWizardDialog", () => {
  it("renders nothing when wizard is closed", () => {
    const { container } = render(<SetupWizardDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the welcome step when wizard is open", () => {
    setWizardState(true);
    render(<SetupWizardDialog />);
    expect(screen.getByText("Welcome to agmux")).toBeTruthy();
  });

  it("renders the Continue button on the welcome step", () => {
    setWizardState(true);
    render(<SetupWizardDialog />);
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("renders the Skip setup button so users can dismiss the wizard", () => {
    setWizardState(true);
    render(<SetupWizardDialog />);
    expect(screen.getByText("Skip setup")).toBeTruthy();
  });

  it("does not render Welcome heading when wizard closed mid-render", () => {
    const { rerender } = render(<SetupWizardDialog />);
    expect(screen.queryByText("Welcome to agmux")).toBeNull();
    setWizardState(true);
    rerender(<SetupWizardDialog />);
    expect(screen.getByText("Welcome to agmux")).toBeTruthy();
  });

  it("renders without crashing when wizard auto-opens (closed-by-default test guard)", () => {
    const { container } = render(<SetupWizardDialog />);
    expect(container).toBeTruthy();
  });

  it("toggles between closed and open via store update", () => {
    const { rerender } = render(<SetupWizardDialog />);
    expect(screen.queryByText("Continue")).toBeNull();
    setWizardState(true);
    rerender(<SetupWizardDialog />);
    expect(screen.getByText("Continue")).toBeTruthy();
    setWizardState(false);
    rerender(<SetupWizardDialog />);
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("walks optional customization steps through defaults, agents, connect, and local model", () => {
    setWizardState(true, {
      setupWizardCompleted: false,
      onboardingRevision: 0,
    });
    render(<SetupWizardDialog />);
    expect(screen.getByText("Welcome to agmux")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Customize appearance and advanced options"));

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Agent Providers")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Midnight")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Fonts")).toBeTruthy();
    expect(screen.getByText("Geist")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Session layout")).toBeTruthy();
    expect(screen.getByText("Horizontal tabs")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Defaults")).toBeTruthy();
    expect(screen.getByText("Quick Open")).toBeTruthy();
    expect(screen.getByText("Default Claude view")).toBeTruthy();
    expect(screen.getByText("Default Codex view")).toBeTruthy();
    expect(screen.getByText("Commit message model")).toBeTruthy();


    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Agents & memory")).toBeTruthy();
    expect(screen.getByText("Project memory")).toBeTruthy();
    expect(screen.getByText("Default to full permissions")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Phone, alerts & updates")).toBeTruthy();
    expect(screen.getByText("Phone remote")).toBeTruthy();
    expect(screen.getByText("Automatic updates")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Local AI model")).toBeTruthy();
    // Continue stays disabled until a model is on disk (required step).
    const blocked = screen.getByRole("button", { name: /download required/i });
    expect(blocked).toBeTruthy();
    expect((blocked as HTMLButtonElement).disabled).toBe(true);

    // A retired Qwen2.5 model on disk doesn't unlock the step, and isn't offered.
    act(() => {
      useLocalModelStore.setState({
        status: {
          model_downloaded: true,
          server_downloaded: true,
          server_running: false,
          model_name: "Qwen2.5",
          model_size_bytes: 1,
          active_variant: "small",
          variants: [
            {
              variant: "small",
              display_name: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
              blurb: "Legacy · fastest, lower quality",
              recommended: false,
              legacy: true,
              downloaded: true,
              size_bytes: 1,
              approx_size_bytes: 1,
            },
          ],
        },
      });
    });
    expect(screen.getByText(/is retired/i)).toBeTruthy();
    expect(screen.queryByText("Qwen2.5-1.5B-Instruct (Q4_K_M)")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /download required/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      useLocalModelStore.setState({
        status: {
          model_downloaded: true,
          server_downloaded: true,
          server_running: false,
          model_name: "Qwen3-1.7B",
          model_size_bytes: 1,
          active_variant: "qwen3-1.7b",
          variants: [],
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(screen.getByText("Start your first conversation")).toBeTruthy();
  });

  it("gets first-time users to a conversation without appearance or model downloads", () => {
    setWizardState(true, { setupWizardCompleted: false, onboardingRevision: 0 });
    render(<SetupWizardDialog />);
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Agent Providers")).toBeTruthy();
    expect(screen.getByText("Installation and sign-in help")).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Agents & memory")).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Start your first conversation")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open project folder" })).toBeTruthy();
    expect(screen.queryByText("Download required")).toBeNull();
  });

  it("uses upgrade welcome when completed but revision is behind", () => {
    setWizardState(true, {
      setupWizardCompleted: true,
      onboardingRevision: 0,
    });
    render(<SetupWizardDialog />);
    expect(screen.getByText("New setup options")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    // Upgrade is delta-only: memory/permissions, not full look re-setup
    expect(screen.getByText("Agents & memory")).toBeTruthy();
    expect(screen.queryByText("Appearance")).toBeNull();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Phone, alerts & updates")).toBeTruthy();

    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("You're up to date")).toBeTruthy();
  });

  it("persists onboardingRevision on skip", () => {
    setWizardState(true, {
      setupWizardCompleted: false,
      onboardingRevision: 0,
    });
    render(<SetupWizardDialog />);
    fireEvent.click(screen.getByText("Skip setup"));
    const s = useSettingsStore.getState().settings;
    expect(s.setupWizardCompleted).toBe(true);
    expect(s.onboardingRevision).toBe(ONBOARDING_REVISION);
    expect(useSettingsStore.getState().isSetupWizardOpen).toBe(false);
  });
});
