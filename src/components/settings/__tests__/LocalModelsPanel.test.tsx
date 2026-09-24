import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { LocalModelsPanel } from "../LocalModelsPanel";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { CatalogModel, MlxModel } from "../../../lib/mlx";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

function model(over: Partial<CatalogModel>): CatalogModel {
  return {
    repoId: "example-org/model",
    name: "Model",
    params: "27B",
    quant: "4bit",
    sizeGb: 15,
    ramGb: 18,
    memoryGb: 21,
    fitsThisMac: true,
    description: "A test model.",
    tier: "24",
    role: "balanced",
    installed: false,
    kvBits: null,
    maxKvSize: null,
    supportsNativeTools: true,
    supportsFim: false,
    ...over,
  };
}

const CATALOG: CatalogModel[] = [
  model({ repoId: "example-org/quality-24", name: "Quality 24", role: "quality" }),
  model({ repoId: "example-org/speed-24", name: "Speed 24", role: "speed" }),
  model({ repoId: "example-org/balanced-24", name: "Balanced 24", role: "balanced" }),
  model({ repoId: "example-org/balanced-64", name: "Balanced 64", tier: "64", memoryGb: 50, fitsThisMac: false }),
];

const ON_DISK: MlxModel[] = [
  { id: "example-org/old-pick", displayName: "old-pick", source: "xanomManaged", path: "/tmp/x", sizeBytes: 2 * 1024 ** 3, supportsTools: true },
  { id: "example-org/lm-studio", displayName: "lm", source: "lmStudio", path: "/tmp/y", sizeBytes: 1024 ** 3, supportsTools: true },
];

function routeInvoke() {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "mlx_hardware_info":
        return { chip: "Apple M4 Pro", totalRamGb: 24, cores: 12, tier: "24", isAppleSilicon: true };
      case "mlx_download_status":
        return { active: false, repoId: null };
      case "mlx_model_catalog":
        return CATALOG;
      case "mlx_list_models":
        return ON_DISK;
      case "mlx_capability":
        return { supported: true, available: true, reason: null, needsPython: false, needsVenv: false, needsModel: false };
      case "mlx_bootstrap_status":
        return { state: "idle" };
      case "mlx_get_exa_api_key_status":
        return { configured: false, source: "none", last4: "" };
      default:
        return undefined;
    }
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  routeInvoke();
  useSettingsStore.getState().updateSettings({ mlxCatalogTier: "auto" });
});
afterEach(cleanup);

function recommendedNames(): string[] {
  const card = screen.getByText(/^Recommended for/).closest(".settings-card") as HTMLElement;
  return ["Speed 24", "Balanced 24", "Quality 24", "Balanced 64"].filter((n) => within(card).queryByText(n));
}

it("shows this Mac's picks fastest-first and switches memory tier", async () => {
  render(<LocalModelsPanel />);
  await screen.findByText("Speed 24");
  expect(screen.getByText("Recommended for this Mac")).toBeTruthy();
  expect(recommendedNames()).toEqual(["Speed 24", "Balanced 24", "Quality 24"]);
  const names = screen.getAllByText(/^(Speed|Balanced|Quality) 24$/).map((el) => el.textContent);
  expect(names).toEqual(["Speed 24", "Balanced 24", "Quality 24"]);

  fireEvent.click(screen.getByRole("radio", { name: "64 GB" }));
  await screen.findByText("Recommended for 64 GB Macs");
  expect(recommendedNames()).toEqual(["Balanced 64"]);
  expect(useSettingsStore.getState().settings.mlxCatalogTier).toBe("64");
});

it("shows the memory agmux plans for this Mac, not the catalog's estimate", async () => {
  render(<LocalModelsPanel />);
  await screen.findByText("Speed 24");
  expect(screen.getAllByText("~21 GB memory").length).toBe(3);
  expect(screen.queryByText("~18 GB memory")).toBeNull();

  fireEvent.click(screen.getByRole("radio", { name: "64 GB" }));
  expect(await screen.findByText("Needs ~50 GB, more than this Mac has")).toBeTruthy();
});

it("lists agmux-downloaded models and asks before deleting one", async () => {
  render(<LocalModelsPanel />);
  const card = (await screen.findByRole("heading", { name: "Installed" })).closest(".settings-card") as HTMLElement;
  expect(within(card).getByText("example-org/old-pick")).toBeTruthy();
  expect(within(card).queryByText("example-org/lm-studio")).toBeNull();

  fireEvent.click(within(card).getByRole("button", { name: /Remove/ }));
  expect(invoke).not.toHaveBeenCalledWith("mlx_delete_catalog_model", expect.anything());
  fireEvent.click(within(card).getByRole("button", { name: /Delete files/ }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("mlx_delete_catalog_model", { repoId: "example-org/old-pick" }),
  );
});
