/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LocalModelUpgradeDialog } from "../LocalModelUpgradeDialog";
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
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

const startDownload = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../lib/commands", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/commands")>(
    "../../../lib/commands",
  );
  return {
    ...actual,
    localModelStatus: vi.fn(() => new Promise(() => {})),
    downloadLocalModel: vi.fn().mockResolvedValue(undefined),
    deleteLocalModel: vi.fn().mockResolvedValue(undefined),
    setActiveLocalModel: vi.fn().mockResolvedValue(undefined),
    ensureLocalLlmServer: vi.fn().mockResolvedValue(0),
    stopLocalLlmServer: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  startDownload.mockClear();
  useLocalModelStore.setState({
    status: null,
    downloading: false,
    downloadProgress: null,
    error: null,
    hasSeenSetupPrompt: true,
    startDownload,
    fetchStatus: vi.fn().mockResolvedValue(undefined),
  } as never);
  useSettingsStore.setState({ isSetupWizardOpen: false, isOpen: false });
});

afterEach(() => cleanup());

function legacyStatus() {
  return {
    model_downloaded: true,
    server_downloaded: true,
    server_running: false,
    model_name: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
    model_size_bytes: 1_100_000_000,
    active_variant: "small" as const,
    variants: [],
  };
}

describe("LocalModelUpgradeDialog", () => {
  it("renders nothing when status is null", () => {
    const { container } = render(<LocalModelUpgradeDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when already on a recommended model", () => {
    useLocalModelStore.setState({
      status: {
        ...legacyStatus(),
        active_variant: "qwen3-1.7b",
        model_name: "Qwen3-1.7B (Q4_K_M)",
      },
    });
    const { container } = render(<LocalModelUpgradeDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("shows when active model is legacy Qwen2.5", () => {
    useLocalModelStore.setState({ status: legacyStatus() });
    render(<LocalModelUpgradeDialog />);
    expect(screen.getByText(/switch local model required/i)).toBeTruthy();
    expect(screen.getByText(/Qwen3-1\.7B/)).toBeTruthy();
    expect(screen.getByText(/Qwen3-4B Instruct/)).toBeTruthy();
    expect(screen.getByText(/Phi-4-mini/)).toBeTruthy();
    // Required upgrade — no dismiss path.
    expect(screen.queryByText(/not now/i)).toBeNull();
  });

  it("hides while setup wizard is open", () => {
    useSettingsStore.setState({ isSetupWizardOpen: true });
    useLocalModelStore.setState({ status: legacyStatus() });
    const { container } = render(<LocalModelUpgradeDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("picking a model starts download", () => {
    useLocalModelStore.setState({ status: legacyStatus() });
    render(<LocalModelUpgradeDialog />);
    fireEvent.click(screen.getByText(/Qwen3-1\.7B/));
    expect(startDownload).toHaveBeenCalledWith("qwen3-1.7b");
  });
});
