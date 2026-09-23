import { useCallback, useRef, useEffect, useState } from "react";

interface Props {
  /** "horizontal" drags left/right, "vertical" drags up/down */
  direction?: "horizontal" | "vertical";
  /** Called continuously during drag with the delta in px (positive = right/down) */
  onResize: (delta: number) => void;
  className?: string;
}

export function ResizeHandle({ direction = "horizontal", onResize, className }: Props) {
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef(0);
  // Stable ref for onResize to avoid re-binding mousemove/mouseup listeners mid-drag
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      setDragging(true);
    },
    [direction]
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const current = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = current - lastPos.current;
      if (delta !== 0) {
        onResizeRef.current(delta);
        lastPos.current = current;
      }
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.classList.add("resizing");
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, direction]);

  const isHorizontal = direction === "horizontal";

  return (
    <div
      onMouseDown={handleMouseDown}
      className={[
        "group relative z-30 flex items-center justify-center",
        isHorizontal ? "w-0 cursor-col-resize" : "h-0 cursor-row-resize",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Invisible hit area */}
      <div
        className={[
          "absolute",
          isHorizontal ? "inset-y-0 -left-[3px] w-[6px]" : "inset-x-0 -top-[3px] h-[6px]",
        ].join(" ")}
      />
      {/* Visible line — only on hover/drag */}
      <div
        className={[
          "absolute transition-opacity duration-150",
          isHorizontal ? "inset-y-0 w-[2px]" : "inset-x-0 h-[2px]",
          dragging
            ? "bg-[var(--accent-primary)] opacity-100"
            : "bg-[var(--accent-primary)] opacity-0 group-hover:opacity-60",
        ].join(" ")}
      />
    </div>
  );
}
