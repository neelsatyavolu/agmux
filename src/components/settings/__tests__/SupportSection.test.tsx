/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SupportSection } from "../SupportSection";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../hooks/useNativeFileDrop", () => ({ useNativeFileDrop: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(["/tmp/screenshot.png"]) }));
afterEach(cleanup);
beforeEach(() => { vi.mocked(invoke).mockReset(); });
function fill() {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Cannot open project" } });
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "Clicked Open, nothing happened" } });
}
describe("SupportSection", () => {
  it("sends only on explicit submit and confirms the receipt", async () => {
    vi.mocked(invoke).mockResolvedValue("receipt-123");
    render(<SupportSection />); fill();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Send report"));
    await screen.findByText("Report sent");
    expect(invoke).toHaveBeenCalledWith("submit_support_report", { report: expect.objectContaining({ paths: [], includeDiagnostics: false, title: "Cannot open project" }) });
    expect(screen.getByText("Reference: receipt-123")).toBeTruthy();
  });
  it("keeps the draft and selected files when sending fails", async () => {
    vi.mocked(invoke).mockRejectedValue("Offline");
    render(<SupportSection />); fill();
    await waitFor(() => expect((screen.getByText("Attach files") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Attach files"));
    await screen.findByText("screenshot.png");
    fireEvent.click(screen.getByText("Send report"));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Cannot open project");
    expect(screen.getByText("screenshot.png")).toBeTruthy();
  });
  it("does not send crash details without a user action", () => {
    render(<SupportSection initialDetails="Example error stack" />);
    expect((screen.getByLabelText("What happened?") as HTMLTextAreaElement).value).toContain("Example error stack");
    expect(invoke).not.toHaveBeenCalled();
  });
});
