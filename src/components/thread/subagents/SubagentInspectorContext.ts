import { createContext, useContext } from "react";
import type { SubagentReference, SubagentStatus, SubagentConversationItem } from "../../../lib/subagentConversations";

export interface SubagentInspectorState {
  selectedId: string | null;
  references: SubagentReference[];
  activity: Readonly<Record<string, SubagentConversationItem | undefined>>;
  overview: boolean;
  exiting: boolean;
  setOverviewExpanded: (expanded: boolean) => void;
  register: (reference: SubagentReference) => void;
  open: (reference: SubagentReference) => void;
  statuses: Readonly<Record<string, SubagentStatus>>;
}
export const SubagentInspectorContext = createContext<SubagentInspectorState | null>(null);
export function useSubagentInspector(): SubagentInspectorState | null {
  return useContext(SubagentInspectorContext);
}
