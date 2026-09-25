import { useEffect, useRef } from "react";
import {
  FileText,
  FolderOpen,
  Copy,
  FileCode,
  MessageSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { useUiStore } from "../../stores/uiStore";

interface Props {
  x: number;
  y: number;
  filePath: string;
  relativePath: string;
  isDirectory: boolean;
  onClose: () => void;
  onAskClaude?: (filePath: string) => void;
  onRename?: (filePath: string, isDirectory: boolean) => void;
  onDelete?: (filePath: string, isDirectory: boolean) => void;
}

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  visible: boolean;
  danger?: boolean;
}

export function FileTreeContextMenu({
  x,
  y,
  filePath,
  relativePath,
  isDirectory,
  onClose,
  onAskClaude,
  onRename,
  onDelete,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const openTab = useEditorStore((s) => s.openTab);
  const openFile = useUiStore((s) => s.openFile);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${vw - rect.width - 8}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${vh - rect.height - 8}px`;
    }
  }, [x, y]);

  const handleOpenInEditor = () => {
    openFile(filePath, { showFileTree: true });
    openTab(filePath);
    onClose();
  };

  const handleRevealInFinder = async () => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(filePath);
    } catch (err) {
      console.error("Failed to reveal in Finder:", err);
    }
    onClose();
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(filePath);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
    onClose();
  };

  const handleCopyRelativePath = async () => {
    try {
      await navigator.clipboard.writeText(relativePath);
    } catch (err) {
      console.error("Failed to copy relative path:", err);
    }
    onClose();
  };

  const handleAskClaude = () => {
    onAskClaude?.(filePath);
    onClose();
  };

  const handleRename = () => {
    onRename?.(filePath, isDirectory);
    onClose();
  };

  const handleDelete = () => {
    onDelete?.(filePath, isDirectory);
    onClose();
  };

  const items: MenuItem[] = [
    {
      label: "Open in Editor",
      icon: <FileText size={13} />,
      action: handleOpenInEditor,
      visible: !isDirectory,
    },
    {
      label: "Reveal in Finder",
      icon: <FolderOpen size={13} />,
      action: handleRevealInFinder,
      visible: true,
    },
    {
      label: "Copy Path",
      icon: <Copy size={13} />,
      action: handleCopyPath,
      visible: true,
    },
    {
      label: "Copy Relative Path",
      icon: <FileCode size={13} />,
      action: handleCopyRelativePath,
      visible: true,
    },
    {
      label: "Ask Claude about this file",
      icon: <MessageSquare size={13} />,
      action: handleAskClaude,
      visible: !!onAskClaude && !isDirectory,
    },
    {
      label: "Rename…",
      icon: <Pencil size={13} />,
      action: handleRename,
      visible: !!onRename,
    },
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      action: handleDelete,
      visible: !!onDelete,
      danger: true,
    },
  ];

  const visibleItems = items.filter((item) => item.visible);
  const lastNonDangerIdx = visibleItems.reduce(
    (acc, item, idx) => (item.danger ? acc : idx),
    -1,
  );

  return (
    <div
      ref={menuRef}
      className="file-tree-context-menu fixed z-50 min-w-[204px] overflow-hidden"
      style={{
        left: x,
        top: y,
        borderRadius: 8,
        border: "1px solid var(--glass-border)",
        background: "var(--surface-popover)",
        backdropFilter: "blur(14px)",
        boxShadow:
          "0 18px 40px -12px rgba(0,0,0,0.28), 0 0 0 1px var(--glass-border)",
        padding: "4px 0",
      }}
    >
      {visibleItems.map((item, idx) => {
        const needsDivider =
          item.danger && idx > 0 && idx === lastNonDangerIdx + 1;
        return (
          <div key={item.label}>
            {needsDivider && (
              <div
                style={{
                  height: 1,
                  margin: "4px 8px",
                  background: "var(--surface-2)",
                }}
              />
            )}
            <button
              onClick={item.action}
              className="group flex w-full items-center gap-2.5 px-3 py-[6px] text-left transition-colors"
              style={{
                fontSize: 11.5,
                letterSpacing: 0,
                color: item.danger ? "var(--status-red)" : "var(--text-primary)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = item.danger
                  ? "rgba(248,113,113,0.12)"
                  : "var(--glass-hover, rgba(255,255,255,0.05))";
                e.currentTarget.style.color = item.danger ? "var(--status-red)" : "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = item.danger ? "var(--status-red)" : "var(--text-primary)";
              }}
            >
              <span
                style={{
                  color: item.danger ? "var(--status-red)" : "var(--text-muted)",
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                {item.icon}
              </span>
              {item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
