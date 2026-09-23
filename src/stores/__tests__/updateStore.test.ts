import { beforeEach, describe, expect, it } from "vitest";
import { useUpdateStore } from "../updateStore";

const INITIAL = {
  status: "idle" as const,
  version: "",
  body: "",
  progress: 0,
  errorMessage: "",
  needsManualDownload: false,
  dismissed: false,
  _update: null,
};

describe("updateStore (pure state)", () => {
  beforeEach(() => {
    useUpdateStore.setState(INITIAL, false);
  });

  it("starts in idle status with empty fields", () => {
    const s = useUpdateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.version).toBe("");
    expect(s.progress).toBe(0);
    expect(s.errorMessage).toBe("");
    expect(s._update).toBeNull();
  });

  it("supports manual setState transitions through the lifecycle", () => {
    useUpdateStore.setState({ status: "checking" });
    expect(useUpdateStore.getState().status).toBe("checking");
    useUpdateStore.setState({
      status: "available",
      version: "1.2.3",
      body: "Notes",
    });
    const s = useUpdateStore.getState();
    expect(s.status).toBe("available");
    expect(s.version).toBe("1.2.3");
    expect(s.body).toBe("Notes");
  });

  it("downloading status carries progress", () => {
    useUpdateStore.setState({ status: "downloading", progress: 42 });
    const s = useUpdateStore.getState();
    expect(s.status).toBe("downloading");
    expect(s.progress).toBe(42);
  });

  it("error status carries errorMessage", () => {
    useUpdateStore.setState({ status: "error", errorMessage: "boom" });
    expect(useUpdateStore.getState().errorMessage).toBe("boom");
  });

  it("up-to-date status clears _update", () => {
    useUpdateStore.setState({ status: "up-to-date", _update: null });
    expect(useUpdateStore.getState()._update).toBeNull();
    expect(useUpdateStore.getState().status).toBe("up-to-date");
  });

  it("progress can range from 0 to 100", () => {
    useUpdateStore.setState({ progress: 0 });
    expect(useUpdateStore.getState().progress).toBe(0);
    useUpdateStore.setState({ progress: 100 });
    expect(useUpdateStore.getState().progress).toBe(100);
  });

  it("returning to idle clears progress and error", () => {
    useUpdateStore.setState({ status: "downloading", progress: 50 });
    useUpdateStore.setState({ ...INITIAL });
    const s = useUpdateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.progress).toBe(0);
    expect(s.errorMessage).toBe("");
  });

  it("checkForUpdate is exposed as a function on the store", () => {
    expect(typeof useUpdateStore.getState().checkForUpdate).toBe("function");
  });

  it("exposes openManualDownload and dismissManualDownload", () => {
    const s = useUpdateStore.getState();
    expect(typeof s.openManualDownload).toBe("function");
    expect(typeof s.dismissManualDownload).toBe("function");
  });

  it("dismissBanner and clearDismiss toggle dismissed for available", () => {
    useUpdateStore.setState({ status: "available", dismissed: false });
    useUpdateStore.getState().dismissBanner();
    expect(useUpdateStore.getState().dismissed).toBe(true);
    useUpdateStore.getState().clearDismiss();
    expect(useUpdateStore.getState().dismissed).toBe(false);
  });

  it("clearDismiss does not un-dismiss manual-required", () => {
    useUpdateStore.setState({ status: "manual-required", dismissed: true });
    useUpdateStore.getState().clearDismiss();
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it("manual-required status can carry needsManualDownload", () => {
    useUpdateStore.setState({
      status: "manual-required",
      needsManualDownload: true,
      errorMessage: "404",
    });
    const s = useUpdateStore.getState();
    expect(s.status).toBe("manual-required");
    expect(s.needsManualDownload).toBe(true);
  });

  it("setting status to 'installed' is supported", () => {
    useUpdateStore.setState({ status: "installed" as any });
    expect(useUpdateStore.getState().status).toBe("installed");
  });
});
