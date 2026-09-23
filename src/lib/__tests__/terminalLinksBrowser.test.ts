import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFileLinks } from "../terminalLinks";

const openUrl = vi.fn().mockResolvedValue(undefined);
const openPath = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
  openPath: (...args: unknown[]) => openPath(...args),
}));

describe("terminalLinks URL routing", () => {
  beforeEach(() => {
    openUrl.mockClear();
    openPath.mockClear();
  });

  it("plain click opens the OS default browser", async () => {
    const links = makeFileLinks(
      "see https://example.com/docs for more",
      1,
      "/tmp/project",
      "/Users/test",
    );
    const urlLink = links.find((l) => l.text.startsWith("https://"));
    expect(urlLink).toBeTruthy();

    const event = { metaKey: false, ctrlKey: false } as MouseEvent;
    urlLink!.activate(event, urlLink!.text);

    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    });
  });

  it("metaKey click opens the OS default browser", async () => {
    const links = makeFileLinks(
      "https://github.com/foo/bar",
      1,
      "/tmp/project",
      "/Users/test",
    );
    const urlLink = links.find((l) => l.text.startsWith("https://"));
    expect(urlLink).toBeTruthy();

    const event = { metaKey: true, ctrlKey: false } as MouseEvent;
    urlLink!.activate(event, urlLink!.text);

    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://github.com/foo/bar");
    });
  });

  it("ctrlKey click opens the OS default browser", async () => {
    const links = makeFileLinks(
      "https://example.org/x",
      1,
      "/tmp/project",
      "/Users/test",
    );
    const urlLink = links.find((l) => l.text.startsWith("https://"));
    const event = { metaKey: false, ctrlKey: true } as MouseEvent;
    urlLink!.activate(event, urlLink!.text);

    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://example.org/x");
    });
  });
});
