import { useEffect, useState } from "react";
import {
  X,
  Plus,
  Check,
  Trash2,
  Pencil,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { JournalKind, ThreadJournalEntry } from "../../lib/types";
import { useJournalStore } from "../../stores/journalStore";
import { useUiStore } from "../../stores/uiStore";

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

const sourceColors: Record<string, string> = {
  User: "bg-blue-500/20 text-blue-400",
  AgentParsed: "bg-purple-500/20 text-purple-400",
  System: "bg-zinc-500/20 text-zinc-400",
};

interface Props {
  threadId: string;
  onClose: () => void;
}

function EntryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: ThreadJournalEntry;
  onEdit: (entry: ThreadJournalEntry) => void;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              kindColors[entry.kind as JournalKind] || "bg-zinc-700 text-zinc-400"
            }`}
          >
            {entry.kind}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              sourceColors[entry.source] || "bg-zinc-700 text-zinc-400"
            }`}
          >
            {entry.source}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onEdit(entry)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
            title="Edit"
          >
            <Pencil size={12} />
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  onDelete(entry.id);
                  setConfirmDelete(false);
                }}
                className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-red-500"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-[10px] text-zinc-400 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      <h4 className="mb-1 text-sm font-medium text-zinc-200">{entry.title}</h4>
      <p className="line-clamp-3 text-xs text-zinc-400">{entry.content}</p>
      <p className="mt-1.5 text-[10px] text-zinc-500">
        {new Date(entry.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}

export function JournalPanel({ threadId, onClose }: Props) {
  const journalPanelOpen = useUiStore((s) => s.journalPanelOpen);
  const entries = useJournalStore((s) => s.entries);
  const proposals = useJournalStore((s) => s.proposals);
  const loading = useJournalStore((s) => s.loading);
  const fetchEntries = useJournalStore((s) => s.fetchEntries);
  const removeEntry = useJournalStore((s) => s.removeEntry);
  const acceptProposal = useJournalStore((s) => s.acceptProposal);
  const dismissProposal = useJournalStore((s) => s.dismissProposal);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addKind, setAddKind] = useState<JournalKind>("Note");
  const [addTitle, setAddTitle] = useState("");
  const [addContent, setAddContent] = useState("");
  const [editingEntry, setEditingEntry] = useState<ThreadJournalEntry | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const addEntry = useJournalStore((s) => s.addEntry);
  const updateEntry = useJournalStore((s) => s.updateEntry);

  useEffect(() => {
    fetchEntries(threadId);
  }, [threadId, fetchEntries]);

  const handleAdd = async () => {
    if (!addTitle.trim()) return;
    await addEntry(threadId, addKind, addTitle.trim(), addContent.trim());
    setAddTitle("");
    setAddContent("");
    setShowAddForm(false);
  };

  const handleEdit = (entry: ThreadJournalEntry) => {
    setEditingEntry(entry);
    setEditTitle(entry.title);
    setEditContent(entry.content);
  };

  const handleSaveEdit = async () => {
    if (!editingEntry || !editTitle.trim()) return;
    await updateEntry(editingEntry.id, editTitle.trim(), editContent.trim());
    setEditingEntry(null);
  };

  // Group entries by kind
  const grouped = entries.reduce<Record<string, ThreadJournalEntry[]>>((acc, entry) => {
    const k = entry.kind;
    if (!acc[k]) acc[k] = [];
    acc[k].push(entry);
    return acc;
  }, {});

  return (
    <AnimatePresence>
      {journalPanelOpen && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="flex h-full w-[340px] shrink-0 flex-col border-l border-white/5 bg-[var(--bg-panel)] shadow-xl z-10"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 bg-white/[0.02]">
            <h3 className="text-sm font-medium text-zinc-100">Thread Journal</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title="Add entry"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={onClose}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Add form */}
            {showAddForm && (
              <div className="rounded border border-zinc-700 bg-zinc-900 p-3 space-y-2">
                <div className="flex flex-wrap gap-1">
                  {JOURNAL_KINDS.map((k) => (
                    <button
                      key={k}
                      onClick={() => setAddKind(k)}
                      className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                        addKind === k
                          ? kindColors[k] + " ring-1 ring-current"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-300"
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  placeholder="Title"
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
                />
                <textarea
                  value={addContent}
                  onChange={(e) => setAddContent(e.target.value)}
                  placeholder="Content"
                  rows={3}
                  className="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => setShowAddForm(false)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAdd}
                    disabled={!addTitle.trim()}
                    className="rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {/* Edit form overlay */}
            {editingEntry && (
              <div className="rounded border border-blue-500/30 bg-zinc-900 p-3 space-y-2">
                <h4 className="text-xs font-medium text-zinc-400">Editing Entry</h4>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
                />
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => setEditingEntry(null)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={!editTitle.trim()}
                    className="rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}

            {/* Proposals */}
            {proposals.length > 0 && (
              <div className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <AlertCircle size={12} />
                  Proposed ({proposals.length})
                </h4>
                {proposals.map((p, i) => (
                  <div
                    key={i}
                    className="rounded border border-amber-500/20 bg-amber-950/10 p-3"
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        {p.kind}
                      </span>
                      <span className="text-[10px] text-zinc-400">
                        {Math.round(p.confidence * 100)}% confidence
                      </span>
                    </div>
                    <h4 className="mb-1 text-sm font-medium text-zinc-200">
                      {p.title}
                    </h4>
                    <p className="mb-2 line-clamp-2 text-xs text-zinc-400">
                      {p.content}
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => acceptProposal(threadId, p)}
                        className="flex items-center gap-1 rounded bg-green-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-green-500"
                      >
                        <Check size={10} />
                        Accept
                      </button>
                      <button
                        onClick={() => dismissProposal(i)}
                        className="rounded px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Loading */}
            {loading && (
              <p className="py-4 text-center text-xs text-zinc-400">Loading...</p>
            )}

            {/* Grouped entries */}
            {!loading &&
              JOURNAL_KINDS.map((kind) => {
                const items = grouped[kind];
                if (!items || items.length === 0) return null;
                return (
                  <div key={kind} className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
                      <ChevronDown size={12} />
                      {kind} ({items.length})
                    </h4>
                    {items.map((entry) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        onEdit={handleEdit}
                        onDelete={removeEntry}
                      />
                    ))}
                  </div>
                );
              })}

            {/* Empty state */}
            {!loading && entries.length === 0 && proposals.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-xs text-zinc-400">No journal entries yet.</p>
                <p className="mt-1 text-[10px] text-zinc-500">
                  Add entries from response blocks or use the + button above.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
