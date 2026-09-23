import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSettingsStore } from "../../../../stores/settingsStore";

/** Ease-out-quint — decelerates hard, so the panel "settles" rather than stops. */
const EASE = [0.22, 1, 0.36, 1] as const;

export interface CodexCollapseProps {
  open: boolean;
  children: ReactNode;
}

/**
 * Height-animated reveal for a tool row's diff / terminal / result body.
 *
 * Children unmount when closed (rather than being hidden with CSS), which keeps
 * collapsed content out of the accessibility tree and out of text queries.
 * Honours the user's animation-speed preference.
 */
export function CodexCollapse({ open, children }: CodexCollapseProps) {
  const animationSpeed = useSettingsStore((s) => s.settings.animationSpeed);
  const duration = animationSpeed === "none" ? 0 : animationSpeed === "quick" ? 0.12 : 0.22;

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration, ease: EASE }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
