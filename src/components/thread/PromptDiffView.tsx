import { useState } from "react";
import { Check, X, Pencil, Loader2 } from "lucide-react";

interface Props {
  original: string;
  optimized: string;
  loading: boolean;
  onAcceptOptimized: (text: string) => void;
  onUseOriginal: () => void;
  onCancel: () => void;
}

export function PromptDiffView({
  original,
  optimized,
  loading,
  onAcceptOptimized,
  onUseOriginal,
  onCancel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(optimized);

  // Update editedText when optimized changes (e.g., when loading completes)
  if (!editing && editedText !== optimized) {
    setEditedText(optimized);
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 border-t border-zinc-800 bg-zinc-900/80 px-4 py-6">
        <Loader2 size={20} className="animate-spin text-blue-400" />
        <p className="text-sm text-zinc-400">Optimizing prompt...</p>
        <button
          onClick={onCancel}
          className="text-xs text-zinc-400 hover:text-zinc-300"
        >
          Cancel and use original
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs font-medium text-zinc-400">
          Prompt Optimization Preview
        </span>
        <button
          onClick={onCancel}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-0 divide-x divide-zinc-800">
        {/* Original */}
        <div className="p-3">
          <h4 className="mb-2 text-xs font-medium text-zinc-400">Original</h4>
          <div className="rounded bg-zinc-950 p-3 text-sm text-zinc-300">
            <pre className="whitespace-pre-wrap font-sans">{original}</pre>
          </div>
        </div>

        {/* Optimized */}
        <div className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-zinc-400">Optimized</h4>
            {!editing && (
              <button
                onClick={() => {
                  setEditing(true);
                  setEditedText(optimized);
                }}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-300"
              >
                <Pencil size={10} />
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 p-3 text-sm text-zinc-100 outline-none focus:border-blue-500"
              rows={6}
              autoFocus
            />
          ) : (
            <div className="rounded bg-green-950/30 p-3 text-sm text-zinc-200">
              <pre className="whitespace-pre-wrap font-sans">{optimized}</pre>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">
        <button
          onClick={onUseOriginal}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
        >
          Use Original
        </button>
        <button
          onClick={() => {
            onAcceptOptimized(editing ? editedText : optimized);
            setEditing(false);
          }}
          className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
        >
          <Check size={12} />
          Use Optimized
        </button>
      </div>
    </div>
  );
}
