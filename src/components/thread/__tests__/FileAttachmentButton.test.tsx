/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileAttachmentButton } from "../FileAttachmentButton";
import { open } from "@tauri-apps/plugin-dialog";
import { readImageBase64 } from "../../../lib/commands";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../../lib/commands", () => ({ readImageBase64: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("FileAttachmentButton", () => {
  it("keeps mixed documents as paths and loads only supported images", async () => {
    vi.mocked(open).mockResolvedValue(["/Users/me/PA Script.pdf", "/tmp/photo.PNG", "/tmp/data.csv", "/tmp/icon.svg", "/tmp/LICENSE"]);
    vi.mocked(readImageBase64).mockResolvedValue(["AAAA", "image/png"]);
    const onPaths = vi.fn(), onImages = vi.fn();
    render(<FileAttachmentButton onPaths={onPaths} onImages={onImages} />);
    fireEvent.click(screen.getByTitle("Attach files"));
    await waitFor(() => expect(onPaths).toHaveBeenCalledWith(["/Users/me/PA Script.pdf", "/tmp/data.csv", "/tmp/icon.svg", "/tmp/LICENSE"]));
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(readImageBase64).toHaveBeenCalledExactlyOnceWith("/tmp/photo.PNG");
    expect(onImages).toHaveBeenCalledWith([expect.objectContaining({ mediaType: "image/png", base64: "AAAA" })]);
  });

  it("does nothing when cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    const onPaths = vi.fn(), onImages = vi.fn();
    render(<FileAttachmentButton onPaths={onPaths} onImages={onImages} />);
    fireEvent.click(screen.getByTitle("Attach files"));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(onPaths).not.toHaveBeenCalled();
    expect(onImages).not.toHaveBeenCalled();
  });

  it("preserves unreadable images as file paths", async () => {
    vi.mocked(open).mockResolvedValue("/Users/me/Desktop/photo.png");
    vi.mocked(readImageBase64).mockRejectedValue(new Error("Access denied"));
    const onPaths = vi.fn();
    render(<FileAttachmentButton onPaths={onPaths} onImages={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Attach files"));
    await waitFor(() => expect(onPaths).toHaveBeenCalledWith(["/Users/me/Desktop/photo.png"]));
  });

  it("shows picker failures", async () => {
    vi.mocked(open).mockRejectedValue(new Error("Picker unavailable"));
    render(<FileAttachmentButton onPaths={vi.fn()} onImages={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Attach files"));
    expect((await screen.findByRole("alert")).textContent).toContain("Picker unavailable");
  });
});
