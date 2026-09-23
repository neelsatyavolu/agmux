import { useState, useCallback } from "react";
import { X } from "lucide-react";
import { readImageBase64 } from "../../lib/commands";

export interface ImageAttachment {
  id: string;
  file: File | null;
  dataUrl: string;
  base64: string;
  mediaType: string;
  fileName: string;
  filePath?: string;
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const commaIdx = dataUrl.indexOf(",");
      const base64 = dataUrl.slice(commaIdx + 1);
      resolve({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        file,
        dataUrl,
        base64,
        mediaType: file.type || "image/png",
        fileName: file.name || "pasted-image.png",
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function extractImagesFromPaste(
  e: ClipboardEvent | React.ClipboardEvent
): File[] {
  const files: File[] = [];
  const items = e.clipboardData?.items;
  if (!items) return files;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg"]);

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** True when a filesystem path points at an image, judged by extension. */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Quote a dropped path for insertion into a text/PTY input, but only when it
 * contains whitespace — clean paths stay bare, spaced paths get double-quoted.
 */
export function quotePathIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * Append space-separated (quoted-if-needed) paths to existing composer text,
 * inserting a separating space only when needed and leaving a trailing space
 * so the user can keep typing.
 */
export function appendPathsToText(current: string, paths: string[]): string {
  if (paths.length === 0) return current;
  const insert = paths.map(quotePathIfNeeded).join(" ");
  if (current.length === 0) return `${insert} `;
  return `${current.endsWith(" ") ? current : `${current} `}${insert} `;
}

/** Read an image file at `path` into an ImageAttachment (base64 + data URL). */
export async function pathToImageAttachment(path: string): Promise<ImageAttachment> {
  const [base64, mediaType] = await readImageBase64(path);
  const fileName = path.split("/").pop() ?? "image";
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file: null,
    dataUrl: `data:${mediaType};base64,${base64}`,
    base64,
    mediaType,
    fileName,
    filePath: path,
  };
}

export function extractImagesFromDrop(e: DragEvent | React.DragEvent): File[] {
  const files: File[] = [];
  const items = e.dataTransfer?.files;
  if (!items) return files;
  for (let i = 0; i < items.length; i++) {
    const file = items[i];
    if (file && isImageFile(file)) {
      files.push(file);
    }
  }
  return files;
}

/** Extract file paths from drag text (macOS Finder drops in Tauri) */
export function extractImagePathsFromDrop(e: DragEvent | React.DragEvent): string[] {
  return extractFilePathsFromDrop(e).filter((l) => {
    const ext = l.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_EXTENSIONS.has(ext);
  });
}

/**
 * Decode a `file://` URL to a filesystem path.
 * macOS Finder drags deliver `file:///Users/foo/My%20File.txt`-style URLs;
 * we want the plain path `/Users/foo/My File.txt`.
 */
function fileUrlToPath(s: string): string {
  if (!s.startsWith("file://")) return s;
  let path = s.slice(7); // strip "file://"
  // Some forms include a host (file://localhost/...). Drop it.
  if (path.startsWith("localhost/")) path = path.slice(9);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Extract any file paths from a drag event — no extension filter.
 * Prefers `text/uri-list` (the W3C standard for file drops in WebKit/WKWebView),
 * falls back to `text/plain`. Lines starting with `#` in `text/uri-list` are
 * comments per RFC 2483. `file://` URLs are decoded to plain paths.
 */
export function extractFilePathsFromDrop(e: DragEvent | React.DragEvent): string[] {
  const dt = e.dataTransfer;
  if (!dt) return [];
  const tryParse = (raw: string): string[] =>
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map(fileUrlToPath);

  const uriList = dt.getData("text/uri-list") ?? "";
  if (uriList) {
    const paths = tryParse(uriList);
    if (paths.length > 0) return paths;
  }
  const text = dt.getData("text/plain") ?? "";
  if (text) {
    const paths = tryParse(text);
    if (paths.length > 0) return paths;
  }
  return [];
}

export function useImageAttachments() {
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const addImages = useCallback((newImages: ImageAttachment[]) => {
    setImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  return { images, addImages, removeImage, clearImages };
}

interface Props {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export function ImageAttachmentBar({ images, onRemove, disabled }: Props) {
  return (
    <div className="flex items-start gap-2 px-4 py-2">
      {images.map((img) => (
        <div key={img.id} className="group relative shrink-0">
          <img
            src={img.dataUrl}
            alt={img.fileName}
            className="h-12 w-12 rounded-lg border border-white/10 object-cover"
          />
          <button
            onClick={() => onRemove(img.id)}
            disabled={disabled}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-600 hover:text-white disabled:pointer-events-none"
            title="Remove image"
          >
            <X size={10} />
          </button>
          <p className="mt-0.5 w-12 truncate text-[10px] text-zinc-400">
            {img.fileName}
          </p>
        </div>
      ))}
    </div>
  );
}
