import { useRef, useCallback } from "react";
import { ResizeHandle } from "./ResizeHandle";

type SplitDirection = "horizontal" | "vertical";

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

interface Props {
  direction: SplitDirection;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  first: React.ReactNode;
  second: React.ReactNode;
}

export function SplitContainer({ direction, ratio, onRatioChange, first, second }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;

      const totalSize =
        direction === "horizontal" ? container.offsetWidth : container.offsetHeight;

      if (totalSize === 0) return;

      const deltaRatio = delta / totalSize;
      const newRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio + deltaRatio));
      onRatioChange(newRatio);
    },
    [direction, ratio, onRatioChange]
  );

  const firstPercent = `${(ratio * 100).toFixed(2)}%`;
  const secondPercent = `${((1 - ratio) * 100).toFixed(2)}%`;

  const isHorizontal = direction === "horizontal";

  return (
    <div
      ref={containerRef}
      className={["flex min-h-0 min-w-0 flex-1", isHorizontal ? "flex-row" : "flex-col"].join(" ")}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={isHorizontal ? { width: firstPercent } : { height: firstPercent }}
      >
        {first}
      </div>

      <ResizeHandle direction={direction} onResize={handleResize} />

      <div
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
        style={isHorizontal ? { width: secondPercent } : { height: secondPercent }}
      >
        {second}
      </div>
    </div>
  );
}
