import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useSkillsStore } from "../../stores/skillsStore";

interface AddMcpServerDialogProps {
  open: boolean;
  onClose: () => void;
}

interface EnvRow {
  key: string;
  value: string;
}

export function AddMcpServerDialog({ open, onClose }: AddMcpServerDialogProps) {
  const addMcpServer = useSkillsStore((s) => s.addMcpServer);

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function reset() {
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setUrl("");
    setEnvRows([]);
    setScope("user");
    setSubmitting(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function addEnvRow() {
    setEnvRows((prev) => [...prev, { key: "", value: "" }]);
  }

  function updateEnvRow(index: number, field: "key" | "value", val: string) {
    setEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: val } : row)),
    );
  }

  function removeEnvRow(index: number) {
    setEnvRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    const commandOrUrl = transport === "stdio" ? command.trim() : url.trim();
    if (!commandOrUrl) {
      setError(transport === "stdio" ? "Command is required." : "URL is required.");
      return;
    }

    const parsedArgs = args
      .trim()
      .split(/\s+/)
      .filter((a) => a.length > 0);

    const envMap: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      const v = row.value.trim();
      if (k) envMap[k] = v;
    }

    setSubmitting(true);
    try {
      await addMcpServer(trimmedName, transport, commandOrUrl, parsedArgs, envMap, scope);
      handleClose();
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-zinc-950/80 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-md rounded-xl border border-white/[0.08] bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-100">Add MCP Server</h2>
          <button
            onClick={handleClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. filesystem"
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-zinc-800/60 px-3 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50 focus:ring-1 focus:ring-blue-600/20"
            />
          </div>

          {/* Transport */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">Transport</label>
            <div className="flex gap-2">
              {(["stdio", "sse"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                    transport === t
                      ? "border-blue-600/50 bg-blue-600/10 text-blue-400"
                      : "border-white/[0.06] bg-zinc-800/60 text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Command (stdio) or URL (sse) */}
          {transport === "stdio" ? (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Command <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. npx"
                  className="h-8 w-full rounded-lg border border-white/[0.06] bg-zinc-800/60 px-3 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50 focus:ring-1 focus:ring-blue-600/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Args{" "}
                  <span className="text-zinc-500">(space-separated)</span>
                </label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                  className="h-8 w-full rounded-lg border border-white/[0.06] bg-zinc-800/60 px-3 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50 focus:ring-1 focus:ring-blue-600/20"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                URL <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. http://localhost:8080/sse"
                className="h-8 w-full rounded-lg border border-white/[0.06] bg-zinc-800/60 px-3 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50 focus:ring-1 focus:ring-blue-600/20"
              />
            </div>
          )}

          {/* Env vars */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-400">Environment Variables</label>
              <button
                type="button"
                onClick={addEnvRow}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
              >
                <Plus size={11} />
                Add
              </button>
            </div>
            {envRows.length > 0 && (
              <div className="space-y-1.5">
                {envRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateEnvRow(i, "key", e.target.value)}
                      placeholder="KEY"
                      className="h-7 w-32 shrink-0 rounded-md border border-white/[0.06] bg-zinc-800/60 px-2 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50"
                    />
                    <span className="text-zinc-500">=</span>
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) => updateEnvRow(i, "value", e.target.value)}
                      placeholder="value"
                      className="h-7 flex-1 rounded-md border border-white/[0.06] bg-zinc-800/60 px-2 text-[11px] text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-600/50"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvRow(i)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scope */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">Scope</label>
            <div className="flex gap-2">
              {(["user", "project"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                    scope === s
                      ? "border-blue-600/50 bg-blue-600/10 text-blue-400"
                      : "border-white/[0.06] bg-zinc-800/60 text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-lg border border-white/[0.06] bg-zinc-800/60 px-4 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? "Adding..." : "Add Server"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
