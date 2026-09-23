/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LocalModelSetupDialog } from "../LocalModelSetupDialog";
import { useLocalModelStore } from "../../../stores/localModelStore";
import { useSettingsStore } from "../../../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

// Stub commands so the store's mount-time fetch doesn't blow away our state.
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  localModelStatus: vi.fn(() => new Promise(() => {})),
  downloadLocalModel: vi.fn().mockResolvedValue(undefined),
  deleteLocalModel: vi.fn().mockResolvedValue(undefined),
  setActiveLocalModel: vi.fn().mockResolvedValue(undefined),
  ensureLocalLlmServer: vi.fn().mockResolvedValue(0),
  stopLocalLlmServer: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  useLocalModelStore.setState({
    status: null,
    downloading: false,
    downloadProgress: null,
    error: null,
    hasSeenSetupPrompt: false,
  });
  useSettingsStore.setState({ isSetupWizardOpen: false });
});

afterEach(() => cleanup());

describe("LocalModelSetupDialog", () => {
  it("renders nothing when status is null", () => {
    const { container } = render(<LocalModelSetupDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("honors dismissal so optional setup does not block the app", () => {
    useLocalModelStore.setState({
      status: { model_downloaded: false } as never,
      hasSeenSetupPrompt: true,
    });
    const { container } = render(<LocalModelSetupDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when model is already downloaded", () => {
    useLocalModelStore.setState({
      status: { model_downloaded: true } as never,
      hasSeenSetupPrompt: false,
    });
    const { container } = render(<LocalModelSetupDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while setup wizard is open", () => {
    useSettingsStore.setState({ isSetupWizardOpen: true });
    useLocalModelStore.setState({
      status: { model_downloaded: false } as never,
    });
    const { container } = render(<LocalModelSetupDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog when status indicates model not downloaded", () => {
    useLocalModelStore.setState({
      status: { model_downloaded: false } as never,
    });
    render(<LocalModelSetupDialog />);
    expect(screen.getByText(/download local ai model/i)).toBeTruthy();
    expect(screen.getByText(/works offline/i)).toBeTruthy();
    expect(screen.getByText(/maybe later/i)).toBeTruthy();
    expect(screen.queryByText(/continue in background/i)).toBeNull();
  });

  it("shows Retry when download failed", () => {
    useLocalModelStore.setState({
      status: { model_downloaded: false } as never,
      downloading: false,
      error: "network down",
    });
    render(<LocalModelSetupDialog />);
    expect(screen.getByText(/network down/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry download/i })).toBeTruthy();
  });

  it("re-shows when status flips back to not-downloaded", () => {
    const { rerender } = render(<LocalModelSetupDialog />);
    useLocalModelStore.setState({
      status: { model_downloaded: true } as never,
    });
    rerender(<LocalModelSetupDialog />);
    expect(screen.queryByText(/download local ai model/i)).toBeNull();

    useLocalModelStore.setState({
      status: { model_downloaded: false } as never,
    });
    rerender(<LocalModelSetupDialog />);
    expect(screen.getByText(/download local ai model/i)).toBeTruthy();
  });
});
