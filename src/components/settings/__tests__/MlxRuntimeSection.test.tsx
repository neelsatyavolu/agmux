/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MlxRuntimeSection,
  mlxRuntimePhase,
} from "../MlxRuntimeSection";
import { useMlxBootstrapStore } from "../../../stores/mlxBootstrapStore";
import {
  mlxCapability,
  mlxInstallPython,
  mlxStartBootstrap,
  type MlxCapability,
} from "../../../lib/mlx";

vi.mock("../../../stores/mlxBootstrapStore", () => ({
  useMlxBootstrapStore: vi.fn(),
}));

vi.mock("../../../lib/mlx", () => ({
  mlxCapability: vi.fn(),
  mlxStartBootstrap: vi.fn(),
  mlxInstallPython: vi.fn(),
}));

// The component reads the store with field selectors, so the mock has to
// emulate Zustand's selector call signature rather than return a fixed value.
function mockStore(state: unknown) {
  const value = { state, init: vi.fn() };
  (useMlxBootstrapStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (s: typeof value) => unknown) => selector(value),
  );
}

function cap(over: Partial<MlxCapability> = {}): MlxCapability {
  return {
    supported: true,
    available: false,
    reason: null,
    needsPython: false,
    needsVenv: true,
    needsModel: false,
    ...over,
  };
}

describe("mlxRuntimePhase", () => {
  it("treats idle + venv-missing as not installed", () => {
    expect(mlxRuntimePhase({ state: "idle" }, cap())).toEqual({
      kind: "notInstalled",
      needsPython: false,
    });
  });

  it("treats idle + nothing missing as ready (state resets to idle each launch)", () => {
    expect(
      mlxRuntimePhase({ state: "idle" }, cap({ needsVenv: false, available: true })),
    ).toEqual({ kind: "ready" });
  });

  it("waits for the capability probe before judging idle", () => {
    expect(mlxRuntimePhase({ state: "idle" }, null)).toEqual({ kind: "checking" });
  });

  it("maps the live install states to progress", () => {
    expect(
      mlxRuntimePhase({ state: "installingMlxLm", line: "Collecting mlx-lm..." }, cap()),
    ).toEqual({ kind: "working", label: "Installing mlx-lm…", line: "Collecting mlx-lm..." });
    expect(
      mlxRuntimePhase({ state: "installingPython", tool: "uv", line: "x" }, cap()),
    ).toEqual({ kind: "working", label: "Installing Python 3.12 via uv…", line: "x" });
  });

  it("reports ready even when the capability probe is stale", () => {
    expect(mlxRuntimePhase({ state: "ready", pythonPath: "/x/python" }, cap())).toEqual({
      kind: "ready",
    });
  });
});

describe("MlxRuntimeSection", () => {
  // No `globals: true` in this project's vitest config, so testing-library's
  // auto-cleanup never registers — without this each render stacks up.
  afterEach(cleanup);

  beforeEach(() => {
    vi.resetAllMocks();
    (mlxCapability as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cap());
    (mlxStartBootstrap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mlxInstallPython as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("offers an install action when the runtime is missing", async () => {
    mockStore({ state: "idle" });
    render(<MlxRuntimeSection />);
    const btn = await screen.findByText("Install runtime");
    fireEvent.click(btn);
    expect(mlxStartBootstrap).toHaveBeenCalledTimes(1);
    expect(mlxInstallPython).not.toHaveBeenCalled();
  });

  it("installs Python first when Python is also missing", async () => {
    (mlxCapability as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      cap({ needsPython: true }),
    );
    mockStore({ state: "idle" });
    render(<MlxRuntimeSection />);
    fireEvent.click(await screen.findByText("Install runtime"));
    expect(mlxInstallPython).toHaveBeenCalledTimes(1);
  });

  it("collapses to a quiet confirmation when ready", async () => {
    mockStore({ state: "ready", pythonPath: "/x/python" });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText("MLX runtime installed.")).toBeTruthy();
    expect(screen.queryByText("Install runtime")).toBeNull();
  });

  it("shows the python-missing suggestion and its auto-install button", async () => {
    mockStore({
      state: "pythonMissing",
      suggestion: "uv python install 3.12",
      canAutoInstall: true,
      installer: "uv",
    });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText(/Python 3\.10–3\.13/)).toBeTruthy();
    expect(screen.getByText("uv python install 3.12")).toBeTruthy();
    fireEvent.click(screen.getByText(/Install with uv/));
    expect(mlxInstallPython).toHaveBeenCalledTimes(1);
  });

  it("shows the brew suggestion without an auto-install button", async () => {
    mockStore({
      state: "pythonMissing",
      suggestion: "brew install python@3.12",
      canAutoInstall: false,
    });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText("brew install python@3.12")).toBeTruthy();
    expect(screen.queryByText(/Install with/)).toBeNull();
  });

  it("shows the mlx-lm install progress line", async () => {
    mockStore({ state: "installingMlxLm", line: "Collecting mlx-lm..." });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText(/Installing mlx-lm/)).toBeTruthy();
    expect(screen.getByText(/Collecting mlx-lm/)).toBeTruthy();
  });

  it("renders the installToolMissing hint with a retry", async () => {
    mockStore({ state: "installToolMissing", hint: "Install uv or Homebrew first" });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText("Install uv or Homebrew first")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(mlxStartBootstrap).toHaveBeenCalledTimes(1);
  });

  it("surfaces an install failure and lets the user retry", async () => {
    mockStore({ state: "installFailed", error: "pip exploded" });
    render(<MlxRuntimeSection />);
    expect(await screen.findByText(/pip exploded/)).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(mlxStartBootstrap).toHaveBeenCalledTimes(1));
  });
});
