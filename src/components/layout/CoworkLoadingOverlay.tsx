import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Briefcase } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";

export function CoworkLoadingOverlay() {
  const open = useUiStore((s) => s.coworkLoading);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="cowork-switch-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          style={{ pointerEvents: "none" }}
        >
          <div className="cowork-switch-mark">
            <span className="cowork-switch-glow" aria-hidden />
            <Briefcase size={28} strokeWidth={1.5} />
          </div>
          <div className="cowork-switch-label">Opening Cowork</div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
