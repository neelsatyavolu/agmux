import { useState } from "react";
import { X } from "lucide-react";
import type { JournalKind } from "../../lib/types";
import { useJournalStore } from "../../stores/journalStore";

const JOURNAL_KINDS: JournalKind[] = [
  "Decision",
  "Convention",
  "CompletedWork",
  "KnownIssue",
  "Note",
  "Pin",
];

const kindColors: Record<JournalKind, string> = {
  Decision: "bg-purple-500/20 text-purple-400",
  Convention: "bg-blue-500/20 text-blue-400",
  CompletedWork: "bg-green-500/20 text-green-400",
  KnownIssue: "bg-amber-500/20 text-amber-400",
  Note: "bg-zinc-500/20 text-zinc-400",
  Pin: "bg-cyan-500/20 text-cyan-400",
};

interface Props {
  open: boolean;
  threadId: string;
  initialContent: string;
  initialKind?: JournalKind;
  onClose: () => void;
}

export function AddToJournalDialog({ open, threadId, initialContent, initialKind, onClose }: Props) {
  const [kind, setKind] = useState<JournalKind>(initialKind ?? "Note");
  const [title, setTitle] = useState(() => {
    const firstLine = initialContent.split("\n")[0] || "";
    return firstLine.slice(0, 100);
  });
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const addEntry = useJournalStore((s) => s.addEntry);

  if (!open) return null;

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await addEntry(threadId, kind, title.trim(), content.trim());
      onClose();
    } catch (err) {
      console.error("Failed to save journal entry:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-[20px] border border-zinc-800 bg-zinc-900 shadow-xl fx-dialog">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-medium text-zinc-100">Add to Journal</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-4 py-4">
          {/* Kind selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Kind
            </label>
            <div className="flex flex-wrap gap-1.5">
              {JOURNAL_KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`ui-chip sm rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    kind === k
                      ? kindColors[k] + " ring-1 ring-current"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-300"
                  } ${k === "KnownIssue" ? "fx-soft-gold" : "fx-chip-q"}`}
                >
                  {k === "CompletedWork" ? "Completed" : k === "KnownIssue" ? "Issue" : k}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 fx-input"
              placeholder="Entry title..."
            />
          </div>

          {/* Content */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Content
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              className="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 fx-input"
              placeholder="Entry content..."
            />
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
            disabled={saving || !title.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Entry"}
          </button>
        </div>
      </div>
    </div>
  );
}
