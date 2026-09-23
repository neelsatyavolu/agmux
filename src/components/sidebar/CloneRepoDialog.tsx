import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, FolderOpen, GitBranch, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../../stores/projectStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface SshHost {
  name: string;
  hostname: string;
  user: string | null;
  identity_file: string | null;
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

type CloneMethod = "https" | "ssh";

export function CloneRepoDialog({ open, onClose }: Props) {
  const [repoUrl, setRepoUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [projectName, setProjectName] = useState("");
  const [method, setMethod] = useState<CloneMethod>("https");
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [selectedSshHost, setSelectedSshHost] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSshDropdown, setShowSshDropdown] = useState(false);
  const addProject = useProjectStore((s) => s.addProject);
  const dialogOpen = useDialogOpen();

  // Load SSH hosts when dialog opens
  useEffect(() => {
    if (open) {
      invoke<SshHost[]>("list_ssh_hosts")
        .then((hosts) => {
          setSshHosts(hosts);
          if (hosts.length > 0) {
            setSelectedSshHost(hosts[0].name);
          }
        })
        .catch(() => setSshHosts([]));
    } else {
      // Reset state on close
      setRepoUrl("");
      setDestination("");
      setProjectName("");
      setMethod("https");
      setSelectedSshHost("");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  // Auto-detect method from URL
  useEffect(() => {
    if (repoUrl.startsWith("git@") || repoUrl.includes("ssh://")) {
      setMethod("ssh");
    } else if (repoUrl.startsWith("https://")) {
      setMethod("https");
    }
  }, [repoUrl]);

  // Derive project name from URL
  useEffect(() => {
    if (!repoUrl) {
      setProjectName("");
      return;
    }
    const match = repoUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) {
      setProjectName(match[1]);
    }
  }, [repoUrl]);

  const handleBrowse = async () => {
    if (!dialogOpen) return;
    const selected = await dialogOpen({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestination(selected);
    }
  };

  // Build the final clone URL based on method + SSH host
  const buildCloneUrl = (): string => {
    if (method === "https") return repoUrl;

    // If already an SSH URL, use as-is
    if (repoUrl.startsWith("git@") || repoUrl.includes("ssh://")) return repoUrl;

    // Convert HTTPS to SSH using selected host
    const match = repoUrl.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
    if (match) {
      const host = selectedSshHost || "github.com";
      return `git@${host}:${match[1]}.git`;
    }

    return repoUrl;
  };

  const handleClone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim() || !destination.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const cloneUrl = buildCloneUrl();
      const fullDest = projectName
        ? `${destination}/${projectName}`
        : destination;

      await invoke<string>("git_clone", { url: cloneUrl, destination: fullDest });
      await addProject(projectName || "Cloned Project", fullDest);
      onClose();
    } catch (err) {
      setError(String(err));
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
            className="w-[420px] rounded-xl border border-white/[0.08] shadow-2xl"
            style={{
              background: "var(--glass-bg)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
            }}
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-zinc-400" />
                <h2 className="text-sm font-medium text-zinc-200">Clone Repository</h2>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 transition-all duration-200"
              >
                <X size={14} />
              </button>
            </div>

            <form onSubmit={handleClone} className="p-5 space-y-4">
              {/* Repository URL */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                  Repository URL
                </label>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  autoFocus
                  className="w-full rounded-lg border border-white/[0.06] px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-white/[0.15] transition-all duration-200"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                />
              </div>

              {/* Clone Method */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                  Method
                </label>
                <div className="flex gap-1 rounded-lg border border-white/[0.06] p-1" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <button
                    type="button"
                    onClick={() => setMethod("https")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                      method === "https"
                        ? "bg-white/[0.1] text-zinc-200"
                        : "text-zinc-500 hover:text-zinc-400"
                    }`}
                  >
                    HTTPS
                  </button>
                  <button
                    type="button"
                    onClick={() => setMethod("ssh")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                      method === "ssh"
                        ? "bg-white/[0.1] text-zinc-200"
                        : "text-zinc-500 hover:text-zinc-400"
                    }`}
                  >
                    SSH
                  </button>
                </div>
              </div>

              {/* SSH Host Selector */}
              <AnimatePresence>
                {method === "ssh" && sshHosts.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                      SSH Account
                    </label>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowSshDropdown(!showSshDropdown)}
                        className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.06] transition-all duration-200"
                        style={{ background: "rgba(255,255,255,0.03)" }}
                      >
                        <span>{selectedSshHost || "Select SSH host..."}</span>
                        <ChevronDown size={14} className="text-zinc-500" />
                      </button>
                      <AnimatePresence>
                        {showSshDropdown && (
                          <motion.div
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.12 }}
                            className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-white/[0.08] py-1 shadow-xl"
                            style={{ background: "var(--surface-popover)" }}
                          >
                            {sshHosts.map((host) => (
                              <button
                                key={host.name}
                                type="button"
                                onClick={() => {
                                  setSelectedSshHost(host.name);
                                  setShowSshDropdown(false);
                                }}
                                className={`flex w-full flex-col px-3 py-2 text-left hover:bg-white/[0.06] transition-colors ${
                                  selectedSshHost === host.name ? "bg-white/[0.04]" : ""
                                }`}
                              >
                                <span className="text-sm text-zinc-200">{host.name}</span>
                                {host.hostname && (
                                  <span className="text-[11px] text-zinc-500">
                                    {host.user ? `${host.user}@` : ""}{host.hostname}
                                  </span>
                                )}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Destination Folder */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                  Clone Into
                </label>
                <button
                  type="button"
                  onClick={handleBrowse}
                  disabled={!dialogOpen}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] px-3 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 disabled:opacity-40"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <FolderOpen size={14} className="shrink-0 text-zinc-500" />
                  <span className={`flex-1 truncate ${destination ? "text-zinc-300" : "text-zinc-500"}`}>
                    {destination || "Browse for folder..."}
                  </span>
                </button>
              </div>

              {/* Project Name */}
              <AnimatePresence>
                {projectName && (
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
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      className="w-full rounded-lg border border-white/[0.06] px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-white/[0.15] transition-all duration-200"
                      style={{ background: "rgba(255,255,255,0.03)" }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Error */}
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}

              {/* Actions */}
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
                  disabled={loading || !repoUrl.trim() || !destination.trim()}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[#14110a] transition-all duration-200 disabled:opacity-40 hover:brightness-110"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  {loading ? "Cloning..." : "Clone"}
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
