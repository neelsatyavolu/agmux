import { useState, useEffect } from "react";
import { X, Plus, Trash2, GripVertical } from "lucide-react";
import { updateProjectConventions } from "../../lib/commands";
import type { Project } from "../../lib/types";

interface Props {
  open: boolean;
  project: Project;
  onClose: () => void;
}

export function ConventionsDialog({ open, project, onClose }: Props) {
  const [conventions, setConventions] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && project.conventions) {
      try {
        const parsed = JSON.parse(project.conventions);
        setConventions(Array.isArray(parsed) ? parsed : []);
      } catch {
        // If conventions is a plain string, split by newlines
        setConventions(
          project.conventions
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }
    } else if (open) {
      setConventions([]);
    }
  }, [open, project.conventions]);

  if (!open) return null;

  const handleAdd = () => {
    const trimmed = newItem.trim();
    if (!trimmed) return;
    setConventions((prev) => [...prev, trimmed]);
    setNewItem("");
  };

  const handleRemove = (index: number) => {
    setConventions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProjectConventions(project.id, conventions);
      onClose();
    } catch (err) {
      console.error("Failed to save conventions:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-medium text-zinc-100">
            Conventions: {project.name}
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
          {conventions.length === 0 ? (
            <p className="py-4 text-center text-xs text-zinc-400">
              No conventions yet. Add project-specific rules below.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {conventions.map((item, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-800/50 px-3 py-2"
                >
                  <GripVertical
                    size={12}
                    className="shrink-0 text-zinc-500"
                  />
                  <span className="flex-1 text-sm text-zinc-200">{item}</span>
                  <button
                    onClick={() => handleRemove(i)}
                    className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add new */}
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a convention..."
              className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
            <button
              onClick={handleAdd}
              disabled={!newItem.trim()}
              className="rounded bg-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-600 disabled:opacity-50"
              title="Add"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
