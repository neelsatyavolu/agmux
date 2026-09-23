import {
  File,
  FileCode,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Braces,
  Globe,
  Palette,
  Image,
  Settings,
  Database,
} from "lucide-react";

interface Props {
  name: string;
  isFolder?: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

function getFileIconConfig(name: string): {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  colorClass: string;
} {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() || "";
  const basename = lower.split("/").pop() || lower;

  // Folder handled separately
  // Config/special files by full name
  if (
    basename === ".env" ||
    basename === ".gitignore" ||
    basename.endsWith(".lock") ||
    basename === ".prettierrc" ||
    basename === ".eslintrc" ||
    basename === ".eslintrc.json" ||
    basename === ".eslintrc.js" ||
    basename === ".babelrc"
  ) {
    return { Icon: Settings, colorClass: "text-zinc-400" };
  }

  switch (ext) {
    case "ts":
    case "tsx":
      return { Icon: FileCode2, colorClass: "text-blue-400" };
    case "js":
    case "jsx":
      return { Icon: FileCode2, colorClass: "text-yellow-400" };
    case "json":
      return { Icon: Braces, colorClass: "text-yellow-600" };
    case "rs":
      return { Icon: FileCode, colorClass: "text-orange-400" };
    case "css":
    case "scss":
      return { Icon: Palette, colorClass: "text-purple-400" };
    case "html":
      return { Icon: Globe, colorClass: "text-orange-500" };
    case "md":
      return { Icon: FileText, colorClass: "text-zinc-300" };
    case "py":
      return { Icon: FileCode2, colorClass: "text-green-400" };
    case "yml":
    case "yaml":
    case "toml":
      return { Icon: FileCode, colorClass: "text-red-400" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return { Icon: Image, colorClass: "text-pink-400" };
    case "sql":
      return { Icon: Database, colorClass: "text-[color:var(--accent)]" };
    default:
      return { Icon: File, colorClass: "text-zinc-400" };
  }
}

export function FileIcon({ name, isFolder, isOpen, size = 14, className }: Props) {
  if (isFolder) {
    const FolderIcon = isOpen ? FolderOpen : Folder;
    return (
      <FolderIcon
        size={size}
        className={`shrink-0 text-amber-400 ${className ?? ""}`}
      />
    );
  }

  const { Icon, colorClass } = getFileIconConfig(name);
  return (
    <Icon
      size={size}
      className={`shrink-0 ${colorClass} ${className ?? ""}`}
    />
  );
}
