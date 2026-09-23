import { useEffect, useRef } from "react";
import { Briefcase } from "lucide-react";
import { toggleCoworkAppMode } from "../../lib/coworkMode";
import { useUiStore } from "../../stores/uiStore";

/**
 * Titlebar briefcase. Activate on pointerdown so a nearby window-drag
 * region cannot swallow the following click, and ignore that leftover
 * click so one press does not toggle twice.
 */
export function CoworkModeButton({ iconSize = 13 }: { iconSize?: number }) {
  const appMode = useUiStore((s) => s.appMode);
  const handledByPointerRef = useRef(false);
  const clearHandled = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearHandled.current != null) window.clearTimeout(clearHandled.current);
    };
  }, []);

  const markPointerHandled = () => {
    handledByPointerRef.current = true;
    if (clearHandled.current != null) window.clearTimeout(clearHandled.current);
    clearHandled.current = window.setTimeout(() => {
      handledByPointerRef.current = false;
      clearHandled.current = null;
    }, 400);
  };

  return (
    <button
      type="button"
      className="tbtn"
      data-active={appMode === "cowork" ? "true" : "false"}
      title="Cowork — Claude Cowork and ChatGPT Work chats"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        markPointerHandled();
        toggleCoworkAppMode();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        if (handledByPointerRef.current) return;
        toggleCoworkAppMode();
      }}
    >
      <Briefcase size={iconSize} />
    </button>
  );
}
