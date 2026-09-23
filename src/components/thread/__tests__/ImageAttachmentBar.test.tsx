/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, renderHook, act } from "@testing-library/react";
import {
  ImageAttachmentBar,
  useImageAttachments,
  fileToImageAttachment,
  extractImagesFromPaste,
  extractImagesFromDrop,
  extractImagePathsFromDrop,
  extractFilePathsFromDrop,
  isImagePath,
  quotePathIfNeeded,
  appendPathsToText,
  type ImageAttachment,
} from "../ImageAttachmentBar";

afterEach(() => cleanup());

const makeImage = (overrides: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id: "img-1",
  file: null,
  dataUrl: "data:image/png;base64,AAA",
  base64: "AAA",
  mediaType: "image/png",
  fileName: "pic.png",
  ...overrides,
});

describe("ImageAttachmentBar", () => {
  it("renders nothing visible when no images supplied", () => {
    const { container } = render(
      <ImageAttachmentBar images={[]} onRemove={vi.fn()} />,
    );
    // The wrapper exists but no image children
    expect(container.querySelectorAll("img").length).toBe(0);
  });

  it("renders an image and its filename", () => {
    render(<ImageAttachmentBar images={[makeImage()]} onRemove={vi.fn()} />);
    expect(screen.getByAltText("pic.png")).toBeTruthy();
    expect(screen.getByText("pic.png")).toBeTruthy();
  });

  it("calls onRemove with image id when X button is clicked", () => {
    const onRemove = vi.fn();
    render(<ImageAttachmentBar images={[makeImage()]} onRemove={onRemove} />);
    fireEvent.click(screen.getByTitle("Remove image"));
    expect(onRemove).toHaveBeenCalledWith("img-1");
  });

  it("renders multiple images", () => {
    render(
      <ImageAttachmentBar
        images={[makeImage(), makeImage({ id: "img-2", fileName: "two.png" })]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("pic.png")).toBeTruthy();
    expect(screen.getByText("two.png")).toBeTruthy();
  });
});

describe("useImageAttachments", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useImageAttachments());
    expect(result.current.images).toEqual([]);
  });

  it("adds images via addImages", () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() => result.current.addImages([makeImage()]));
    expect(result.current.images).toHaveLength(1);
  });

  it("removes a specific image by id", () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() =>
      result.current.addImages([
        makeImage(),
        makeImage({ id: "img-2", fileName: "two.png" }),
      ]),
    );
    act(() => result.current.removeImage("img-1"));
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0].id).toBe("img-2");
  });

  it("clears all images", () => {
    const { result } = renderHook(() => useImageAttachments());
    act(() => result.current.addImages([makeImage(), makeImage({ id: "img-2" })]));
    act(() => result.current.clearImages());
    expect(result.current.images).toEqual([]);
  });
});

describe("fileToImageAttachment", () => {
  it("converts a File to an ImageAttachment with base64", async () => {
    // Use a minimal Blob backed File; FileReader.readAsDataURL is supported in jsdom
    const file = new File(["hello"], "test.png", { type: "image/png" });
    const result = await fileToImageAttachment(file);
    expect(result.fileName).toBe("test.png");
    expect(result.mediaType).toBe("image/png");
    expect(result.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(result.base64.length).toBeGreaterThan(0);
  });
});

describe("extractImagesFromPaste", () => {
  it("returns empty array when clipboardData is missing", () => {
    const fakeEvent = { clipboardData: null } as unknown as ClipboardEvent;
    expect(extractImagesFromPaste(fakeEvent)).toEqual([]);
  });

  it("returns image files from clipboard items", () => {
    const file = new File(["x"], "x.png", { type: "image/png" });
    const fakeEvent = {
      clipboardData: {
        items: [
          { type: "image/png", getAsFile: () => file },
          { type: "text/plain", getAsFile: () => null },
        ],
      },
    } as unknown as ClipboardEvent;
    expect(extractImagesFromPaste(fakeEvent)).toEqual([file]);
  });
});

describe("extractImagesFromDrop", () => {
  it("returns empty when no dataTransfer files", () => {
    const fakeEvent = { dataTransfer: { files: null } } as unknown as DragEvent;
    expect(extractImagesFromDrop(fakeEvent)).toEqual([]);
  });

  it("filters non-image files out by extension", () => {
    const png = new File(["x"], "x.png", { type: "image/png" });
    const txt = new File(["x"], "x.txt", { type: "text/plain" });
    const fakeFiles = [png, txt];
    // FileList-like object with length and indexed access
    const fakeEvent = {
      dataTransfer: {
        files: Object.assign(fakeFiles, { length: fakeFiles.length }),
      },
    } as unknown as DragEvent;
    const result = extractImagesFromDrop(fakeEvent);
    expect(result).toEqual([png]);
  });
});

describe("extractImagePathsFromDrop", () => {
  it("extracts image paths from text/plain payload", () => {
    const fakeEvent = {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/plain" ? "/a/foo.png\n/b/bar.txt\n/c/baz.jpg" : "",
      },
    } as unknown as DragEvent;
    expect(extractImagePathsFromDrop(fakeEvent)).toEqual(["/a/foo.png", "/c/baz.jpg"]);
  });

  it("returns empty array when no text data", () => {
    const fakeEvent = {
      dataTransfer: { getData: () => "" },
    } as unknown as DragEvent;
    expect(extractImagePathsFromDrop(fakeEvent)).toEqual([]);
  });
});

describe("extractFilePathsFromDrop", () => {
  it("returns all file paths regardless of extension", () => {
    const fakeEvent = {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/plain" ? "/a/foo.png\n/b/bar.txt\n/c/notes.md" : "",
      },
    } as unknown as DragEvent;
    expect(extractFilePathsFromDrop(fakeEvent)).toEqual([
      "/a/foo.png",
      "/b/bar.txt",
      "/c/notes.md",
    ]);
  });

  it("trims whitespace and skips blank lines", () => {
    const fakeEvent = {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/plain" ? "  /a/x.txt  \n\n/b/y.txt\n" : "",
      },
    } as unknown as DragEvent;
    expect(extractFilePathsFromDrop(fakeEvent)).toEqual(["/a/x.txt", "/b/y.txt"]);
  });

  it("returns empty array when no text data", () => {
    const fakeEvent = {
      dataTransfer: { getData: () => "" },
    } as unknown as DragEvent;
    expect(extractFilePathsFromDrop(fakeEvent)).toEqual([]);
  });

  it("prefers text/uri-list and decodes file:// URLs", () => {
    const fakeEvent = {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/uri-list"
            ? "# comment line\nfile:///Users/me/My%20Doc.txt\nfile:///tmp/a.bin"
            : "",
      },
    } as unknown as DragEvent;
    expect(extractFilePathsFromDrop(fakeEvent)).toEqual([
      "/Users/me/My Doc.txt",
      "/tmp/a.bin",
    ]);
  });

  it("falls back to text/plain when uri-list is empty", () => {
    const fakeEvent = {
      dataTransfer: {
        getData: (type: string) =>
          type === "text/plain" ? "/a/notes.md" : "",
      },
    } as unknown as DragEvent;
    expect(extractFilePathsFromDrop(fakeEvent)).toEqual(["/a/notes.md"]);
  });
});

describe("isImagePath", () => {
  it("detects image extensions case-insensitively", () => {
    expect(isImagePath("/a/photo.PNG")).toBe(true);
    expect(isImagePath("/a/pic.jpeg")).toBe(true);
    expect(isImagePath("/a/icon.svg")).toBe(true);
  });
  it("rejects non-image and extension-less paths", () => {
    expect(isImagePath("/a/report.pdf")).toBe(false);
    expect(isImagePath("/a/notes.md")).toBe(false);
    expect(isImagePath("/a/Makefile")).toBe(false);
  });
});

describe("quotePathIfNeeded", () => {
  it("leaves clean paths bare", () => {
    expect(quotePathIfNeeded("/Users/me/report.pdf")).toBe("/Users/me/report.pdf");
  });
  it("double-quotes paths containing whitespace", () => {
    expect(quotePathIfNeeded("/Users/me/My File.pdf")).toBe('"/Users/me/My File.pdf"');
  });
});

describe("appendPathsToText", () => {
  it("inserts into empty text with a trailing space", () => {
    expect(appendPathsToText("", ["/a/x.pdf"])).toBe("/a/x.pdf ");
  });
  it("adds a separating space when the existing text does not end in one", () => {
    expect(appendPathsToText("look at", ["/a/x.pdf"])).toBe("look at /a/x.pdf ");
  });
  it("does not double the separator when text already ends in a space", () => {
    expect(appendPathsToText("look at ", ["/a/x.pdf"])).toBe("look at /a/x.pdf ");
  });
  it("joins multiple paths and quotes only those with spaces", () => {
    expect(appendPathsToText("", ["/a/x.pdf", "/a/My Doc.txt"])).toBe(
      '/a/x.pdf "/a/My Doc.txt" ',
    );
  });
  it("returns the original text unchanged when no paths are given", () => {
    expect(appendPathsToText("hello", [])).toBe("hello");
  });
});
