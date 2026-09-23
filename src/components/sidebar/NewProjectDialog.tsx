import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, FolderOpen } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useProjectStore } from "../../stores/projectStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

function useDialogOpen() {
  const [dialogFn, setDialogFn] = useState<typeof import("@tauri-apps/plugin-dialog").open | null>(null);
  useEffect(() => {
    import("@tauri-apps/plugin-dialog")
      .then((mod) => setDialogFn(() => mod.open))
      .catch(() => {});
  }, []);
  return dialogFn;
}

export function NewProjectDialog({ open, onClose }: Props) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [loading, setLoading] = useState(false);
  const addProject = useProjectStore((s) => s.addProject);
  const dialogOpen = useDialogOpen();

  const handleBrowse = async () => {
    if (!dialogOpen) return;
    const selected = await dialogOpen({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setRepoPath(selected);
      const basename = selected.split("/").pop() ?? selected;
      setName(basename);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    setLoading(true);
    try {
      await addProject(name.trim(), repoPath.trim());
      setName("");
      setRepoPath("");
      onClose();
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "var(--glass-bg-heavy)", backdropFilter: "blur(24px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-[380px] rounded-xl border border-white/[0.08] shadow-2xl"
            style={{
              background: "var(--glass-bg)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
            }}
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <h2 className="text-sm font-medium text-zinc-200">New Project</h2>
              <button
                onClick={onClose}
                className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 transition-all duration-200"
              >
                <X size={14} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                  Folder
                </label>
                <button
                  type="button"
                  onClick={handleBrowse}
                  disabled={!dialogOpen}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] px-3 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 disabled:opacity-40"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <FolderOpen size={14} className="shrink-0 text-zinc-500" />
                  <span className={`flex-1 truncate ${repoPath ? "text-zinc-300" : "text-zinc-500"}`}>
                    {repoPath || "Browse for folder..."}
                  </span>
                </button>
              </div>

              <AnimatePresence>
                {repoPath && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Project"
                      autoFocus
                      className="w-full rounded-lg border border-white/[0.06] px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-white/[0.15] transition-all duration-200"
                      style={{ background: "rgba(255,255,255,0.03)" }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-4 py-2 text-sm text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 transition-all duration-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !name.trim() || !repoPath.trim()}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[#14110a] transition-all duration-200 disabled:opacity-40 hover:brightness-110"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  {loading ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
