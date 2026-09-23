import { useEffect, useRef } from "react";
import { useSplitViewStore, type LayoutNode } from "../../stores/splitViewStore";
import { SplitPane } from "./SplitPane";
import { SplitContainer } from "./SplitContainer";

interface Props {
  enabled: boolean;
}

/**
 * Get the first leaf pane ID in a layout subtree.
 * Used as a proxy to identify which split to resize.
 */
function getFirstLeafPaneId(node: LayoutNode): string {
  if (node.type === "pane") return node.paneId;
  return getFirstLeafPaneId(node.first);
}

function renderNode(
  node: LayoutNode,
  updateSplitRatio: (paneId: string, ratio: number) => void
): React.ReactNode {
  if (node.type === "pane") {
    return <SplitPane key={node.paneId} paneId={node.paneId} />;
  }

  // Use the second child's first leaf as the pane ID for ratio updates.
  // The store's findParentSplit will find the split that directly contains this pane.
  const secondLeafId = getFirstLeafPaneId(node.second);

  return (
    <SplitContainer
      key={`split-${getFirstLeafPaneId(node.first)}-${secondLeafId}`}
      direction={node.direction}
      ratio={node.ratio}
      onRatioChange={(ratio) => updateSplitRatio(secondLeafId, ratio)}
      first={renderNode(node.first, updateSplitRatio)}
      second={renderNode(node.second, updateSplitRatio)}
    />
  );
}

export function SplitViewPanel({ enabled }: Props) {
  const layout = useSplitViewStore((s) => s.layout);
  const updateSplitRatio = useSplitViewStore((s) => s.updateSplitRatio);
  const reset = useSplitViewStore((s) => s.reset);

  const prevEnabled = useRef(enabled);

  useEffect(() => {
    if (prevEnabled.current && !enabled) {
      reset();
    }
    prevEnabled.current = enabled;
  }, [enabled, reset]);

  if (!enabled || !layout) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {renderNode(layout, updateSplitRatio)}
    </div>
  );
}
