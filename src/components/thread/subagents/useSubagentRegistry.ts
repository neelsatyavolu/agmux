import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SubagentConversationItem, SubagentReference, SubagentSnapshot, SubagentStatus } from "../../../lib/subagentConversations";

interface Observation {
  childId?: string;
  declaredStatus: SubagentStatus;
  status: SubagentStatus;
  activity?: SubagentConversationItem;
}

/** Parent transcript feeds are authoritative; mounted tool rows are only a fallback. */
export function useSubagentRegistry(scope: string, feed?: SubagentReference[]) {
  const [state, setState] = useState(() => ({ scope, references: [] as SubagentReference[], selectedId: null as string | null, observations: {} as Record<string, Observation> }));
  if (state.scope !== scope) {
    // Reset the inspector without remounting its lifecycle-owning parent chat.
    setState({ scope, references: [], selectedId: null, observations: {} });
  }
  const references = feed ?? state.references;
  const hasFeed = feed !== undefined;
  const selectedId = references.some((entry) => entry.toolUseId === state.selectedId) ? state.selectedId : null;
  const revision = JSON.stringify(references.map((entry) => [entry.toolUseId, entry.childId, entry.status]));
  const current = useRef({ scope, references, revision });
  current.current = { scope, references, revision };
  const register = useCallback((reference: SubagentReference) => {
    if (hasFeed || current.current.scope !== scope) return;
    setState((prev) => {
      const existing = prev.references.find((entry) => entry.toolUseId === reference.toolUseId);
      if (existing && JSON.stringify(existing) === JSON.stringify(reference)) return prev;
      return { ...prev, references: existing ? prev.references.map((entry) => entry === existing ? reference : entry) : [...prev.references, reference] };
    });
  }, [scope, hasFeed]);
  const setSelectedId = useCallback((id: string | null) => {
    setState((prev) => prev.selectedId === id ? prev : { ...prev, selectedId: id });
  }, []);
  const { statuses, activity } = useMemo(() => {
    const statuses: Record<string, SubagentStatus> = {};
    const activity: Record<string, SubagentConversationItem | undefined> = {};
    for (const reference of references) {
      const observed = state.observations[reference.toolUseId];
      if (!observed || observed.childId !== reference.childId || observed.declaredStatus !== reference.status) continue;
      if (observed.status !== "unknown") statuses[reference.toolUseId] = observed.status;
      activity[reference.toolUseId] = observed.activity;
    }
    return { statuses, activity };
  }, [references, state.observations]);
  useEffect(() => {
    // Removed agents must not regain cached completion if their IDs are reused.
    setState((prev) => {
      const observations = Object.fromEntries(Object.entries(prev.observations).filter(([id, observation]) => references.some((entry) => entry.toolUseId === id && entry.childId === observation.childId && entry.status === observation.declaredStatus)));
      const selectedId = references.some((entry) => entry.toolUseId === prev.selectedId) ? prev.selectedId : null;
      return Object.keys(observations).length === Object.keys(prev.observations).length && selectedId === prev.selectedId ? prev : { ...prev, observations, selectedId };
    });
  }, [references]);
  const report = useCallback((id: string, status: SubagentStatus, item?: SubagentConversationItem) => {
    if (current.current.scope !== scope || current.current.revision !== revision) return;
    const reference = current.current.references.find((entry) => entry.toolUseId === id);
    if (!reference) return;
    setState((prev) => {
      if (prev.scope !== scope) return prev;
      const prior = prev.observations[id];
      const observation = { childId: reference.childId, declaredStatus: reference.status, status: status === "unknown" ? prior?.status ?? status : status, activity: item ?? prior?.activity };
      return JSON.stringify(prior) === JSON.stringify(observation) ? prev : { ...prev, observations: { ...prev.observations, [id]: observation } };
    });
  }, [scope, revision]);
  const reportStatus = useCallback((id: string, status: SubagentStatus) => {
    if (status !== "unknown") report(id, status);
  }, [report]);
  const reportActivity = useCallback((id: string, snapshot: SubagentSnapshot) => {
    report(id, snapshot.status, snapshot.items.find((item) => item.type === "tool"));
  }, [report]);
  return { references, selectedId, setSelectedId, register, statuses, activity, reportStatus, reportActivity };
}
