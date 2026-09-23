import { useState } from "react";
import { Plus } from "lucide-react";
import { pathToImageAttachment, type ImageAttachment } from "./ImageAttachmentBar";

interface Props {
  onPaths: (paths: string[]) => void;
  onImages: (images: ImageAttachment[]) => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function FileAttachmentButton({ onPaths, onImages, disabled, className, children }: Props) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFiles = async () => {
    setPicking(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const files: string[] = [];
      const images: ImageAttachment[] = [];
      for (const path of paths) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
          try {
            images.push(await pathToImageAttachment(path));
            continue;
          } catch {
            // Keep the file usable when preview loading is unavailable.
          }
        }
        files.push(path);
      }
      if (images.length > 0) onImages(images);
      if (files.length > 0) onPaths(files);
    } catch (err) {
      setError(`Could not attach files: ${String(err)}`);
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <button type="button" onClick={pickFiles} disabled={disabled || picking} className={className} title="Attach files">
        {children ?? <Plus size={15} />}
      </button>
      {error && <span role="alert" className="text-xs text-[var(--text-secondary)]">{error}</span>}
    </>
  );
}
