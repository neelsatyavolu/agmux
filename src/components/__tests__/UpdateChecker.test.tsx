/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { UpdateChecker } from "../UpdateChecker";
import { useUpdateStore } from "../../stores/updateStore";
import { useSettingsStore } from "../../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

beforeEach(() => {
  useUpdateStore.setState({
    status: "idle",
    version: "",
    body: "",
    progress: 0,
    errorMessage: "",
    needsManualDownload: false,
    dismissed: false,
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    handleRelaunch: vi.fn().mockResolvedValue(undefined),
    openManualDownload: vi.fn().mockResolvedValue(undefined),
    dismissManualDownload: vi.fn(),
    dismissBanner: vi.fn(),
    clearDismiss: vi.fn(),
  });
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, autoUpdateEnabled: false },
  });
});

afterEach(() => cleanup());

describe("UpdateChecker", () => {
  it("checks for updates immediately on mount", () => {
    const checkForUpdate = vi.fn().mockResolvedValue(undefined);
    const clearDismiss = vi.fn();
    useUpdateStore.setState({ checkForUpdate, clearDismiss });
    render(<UpdateChecker />);
    expect(checkForUpdate).toHaveBeenCalled();
    // Mount no longer force-clears dismiss (avoids re-nagging manual toasts).
    expect(clearDismiss).not.toHaveBeenCalled();
  });

  it("renders nothing when status is idle", () => {
    const { container } = render(<UpdateChecker />);
    expect(container.textContent).not.toMatch(/available|downloading|ready|auto-update/i);
  });

  it("renders available banner bottom-right when status=available", () => {
    useUpdateStore.setState({ status: "available", version: "9.9.9" });
    const { container } = render(<UpdateChecker />);
    expect(screen.getByText(/update available/i)).toBeTruthy();
    expect(screen.getByText(/v9\.9\.9/)).toBeTruthy();
    const banner = container.querySelector(".fixed.bottom-6.right-6");
    expect(banner).toBeTruthy();
  });

  it("renders downloading state with progress", () => {
    useUpdateStore.setState({ status: "downloading", progress: 42 });
    render(<UpdateChecker />);
    expect(screen.getByText(/downloading/i)).toBeTruthy();
    expect(screen.getByText(/42%/)).toBeTruthy();
  });

  it("renders ready state with restart button", () => {
    useUpdateStore.setState({ status: "ready" });
    render(<UpdateChecker />);
    expect(screen.getByText(/update ready/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart/i })).toBeTruthy();
  });

  it("renders manual redownload banner when status=manual-required", () => {
    const openManualDownload = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ status: "manual-required", openManualDownload });
    render(<UpdateChecker />);
    expect(screen.getByText(/manual download needed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(openManualDownload).toHaveBeenCalled();
  });

  it("hides banner when dismissed", () => {
    const dismissBanner = vi.fn(() => {
      useUpdateStore.setState({ dismissed: true });
    });
    useUpdateStore.setState({ status: "available", version: "1.0.0", dismissBanner });
    const { rerender } = render(<UpdateChecker />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismissBanner).toHaveBeenCalled();
    useUpdateStore.setState({ dismissed: true });
    rerender(<UpdateChecker />);
    expect(screen.queryByText(/update available/i)).toBeNull();
  });

  it("re-shows banner on visibility when still available", () => {
    const clearDismiss = vi.fn();
    useUpdateStore.setState({
      status: "available",
      version: "2.0.0",
      dismissed: true,
      clearDismiss,
    });
    render(<UpdateChecker />);
    clearDismiss.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearDismiss).toHaveBeenCalled();
  });

  it("does not re-surface manual-required after dismiss on focus", () => {
    const clearDismiss = vi.fn();
    const checkForUpdate = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({
      status: "manual-required",
      dismissed: true,
      clearDismiss,
      checkForUpdate,
    });
    render(<UpdateChecker />);
    clearDismiss.mockClear();
    checkForUpdate.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearDismiss).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it("auto-installs when autoUpdateEnabled and update available", () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, autoUpdateEnabled: true },
    });
    useUpdateStore.setState({ status: "available", version: "3.0.0", installUpdate });
    render(<UpdateChecker />);
    expect(installUpdate).toHaveBeenCalled();
  });

  it("auto-relaunches when autoUpdateEnabled and update ready", () => {
    const handleRelaunch = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, autoUpdateEnabled: true },
    });
    useUpdateStore.setState({ status: "ready", handleRelaunch });
    render(<UpdateChecker />);
    expect(handleRelaunch).toHaveBeenCalled();
  });

  it("invokes handleRelaunch when 'Restart' button clicked on ready banner", () => {
    const handleRelaunch = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ status: "ready", handleRelaunch });
    render(<UpdateChecker />);
    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    expect(handleRelaunch).toHaveBeenCalled();
  });

  it("renders error banner with retry when status=error", () => {
    const checkForUpdate = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({
      status: "error",
      errorMessage: "Download failed",
      checkForUpdate,
    });
    render(<UpdateChecker />);
    expect(screen.getByText(/update failed/i)).toBeTruthy();
    expect(screen.getByText(/download failed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(checkForUpdate).toHaveBeenCalledWith({ force: true });
  });

  it("retries auto-install after error when status returns to available", () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, autoUpdateEnabled: true },
    });
    useUpdateStore.setState({ status: "available", version: "3.0.0", installUpdate });
    const { rerender } = render(<UpdateChecker />);
    expect(installUpdate).toHaveBeenCalledTimes(1);

    // Install failed — latch must clear so a later "available" can retry.
    useUpdateStore.setState({ status: "error", errorMessage: "boom" });
    rerender(<UpdateChecker />);

    installUpdate.mockClear();
    useUpdateStore.setState({ status: "available", version: "3.0.0", installUpdate });
    rerender(<UpdateChecker />);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("renders 0% progress when downloading just starting", () => {
    useUpdateStore.setState({ status: "downloading", progress: 0 });
    render(<UpdateChecker />);
    expect(screen.getByText(/0%/)).toBeTruthy();
  });

  it("renders 100% progress when download finishing", () => {
    useUpdateStore.setState({ status: "downloading", progress: 100 });
    render(<UpdateChecker />);
    expect(screen.getByText(/100%/)).toBeTruthy();
  });
});
