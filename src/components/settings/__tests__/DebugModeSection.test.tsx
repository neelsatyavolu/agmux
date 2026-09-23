import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DebugModeSection } from "../DebugModeSection";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
const status = { enabled: false, recordCount: 0, lastError: null };
beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockResolvedValue(status); });
afterEach(cleanup);
it("loads without enabling collection, then toggles through the backend", async () => {
  render(<DebugModeSection />);
  const toggle = await screen.findByRole("switch", { name: "Debug Mode" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockResolvedValue({ ...status, enabled: true });
  fireEvent.click(toggle);
  await screen.findByText("Recording");
  expect(invoke).toHaveBeenLastCalledWith("debug_set_enabled", { enabled: true });
  vi.mocked(invoke).mockResolvedValue(status);
  fireEvent.click(toggle);
  await screen.findByText("Off");
  expect(invoke).toHaveBeenLastCalledWith("debug_set_enabled", { enabled: false });
});
it("surfaces command failures without claiming recording started", async () => {
  render(<DebugModeSection />);
  const toggle = await screen.findByRole("switch", { name: "Debug Mode" });
  vi.mocked(invoke).mockRejectedValue(new Error("Unavailable"));
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toContain("Unavailable");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});
it("surfaces a recorder storage failure returned in status", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...status, lastError: "Could not save local diagnostics" });
  render(<DebugModeSection />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not save");
});
