import { motion } from "framer-motion";
import { Play, PenLine, X } from "lucide-react";

interface Props {
  onImplement: () => void;
  onRevise: () => void;
  onDismiss: () => void;
}

export function PlanFollowUpBanner({ onImplement, onRevise, onDismiss }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border border-purple-500/20 bg-purple-500/[0.07] px-4 py-2.5 backdrop-blur-sm"
    >
      <span className="flex-1 text-xs text-purple-300/90 font-medium">
        Plan proposed
      </span>
      <button
        onClick={onImplement}
        className="flex items-center gap-1.5 rounded-lg bg-purple-500/20 px-3 py-1.5 text-xs font-medium text-purple-200 transition-colors hover:bg-purple-500/30 fx-accent"
      >
        <Play size={11} />
        Implement
      </button>
      <button
        onClick={onRevise}
        className="flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10"
      >
        <PenLine size={11} />
        Revise
      </button>
      <button
        onClick={onDismiss}
        className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </motion.div>
  );
}
