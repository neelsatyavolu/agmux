/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { StartupGate } from "../StartupGate";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../App", () => ({ default: () => <div>Main application</div> }));
vi.mock("../settings/SupportSection", () => ({ SupportSection: ({ initialDetails }: { initialDetails: string }) => <div>Support: {initialDetails}</div> }));
vi.mock("../../lib/appVisibility", () => ({ installAppVisibilitySync: vi.fn() }));
vi.mock("../../lib/notifications", () => ({ installNotificationActivationHandler: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.mocked(invoke).mockReset(); });
it("does not mount the main app after failed database startup", async () => {
  vi.mocked(invoke).mockResolvedValue({ error: "Migration failed", dataPath: "/tmp/test-data", backups: [] });
  const splash = document.createElement("div"); splash.id = "splash"; document.body.append(splash);
  render(<StartupGate />);
  await screen.findByText("agmux could not open your data");
  expect(document.getElementById("splash")).toBeNull();
  expect(screen.queryByText("Main application")).toBeNull();
  fireEvent.click(screen.getByText("Contact Support"));
  expect(screen.getByText("Support: Startup failed: Migration failed")).toBeTruthy();
});
it("requires explicit restore confirmation", async () => {
  vi.mocked(invoke).mockResolvedValue({ error: "Migration failed", dataPath: "/tmp/test-data", backups: ["pre-migration-1.db"] });
  render(<StartupGate />);
  const restore = await screen.findByText("Restore database") as HTMLButtonElement;
  expect(restore.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("I want to restore this saved database."));
  fireEvent.click(restore);
  await screen.findByText("Database restored. Restart the app to try opening it.");
  expect(invoke).toHaveBeenCalledWith("startup_restore_backup", { name: "pre-migration-1.db" });
});
it("loads the main app after a successful startup", async () => {
  vi.mocked(invoke).mockResolvedValue({ error: null, dataPath: "/tmp/test-data", backups: [] });
  render(<StartupGate />);
  await screen.findByText("Main application");
});
