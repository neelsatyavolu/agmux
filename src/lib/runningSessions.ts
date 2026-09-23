/**
 * Count sessions that are actively working — same signal as the sidebar spinner
 * (`claudeProcessingById` / `codexProcessingById`), not the state machine.
 *
 * Why not sessionStates? After Stop the machine sits in `awaiting_stop` /
 * `awaiting_approval` while processing is already false. Counting those made
 * the quit dialog claim "N sessions running" for idle sessions.
 */

export type RunningSessionSources = {
  claudeProcessingById: Record<string, boolean>;
  codexProcessingById: Record<string, boolean>;
  /** agmux UUID → provider session id(s); used to avoid double-counting one PTY. */
  claudeSessionMap?: Record<string, string[]>;
};

export function countRunningSessions(s: RunningSessionSources): number {
  const ids = new Set<string>();
  for (const id of Object.keys(s.claudeProcessingById)) {
    if (s.claudeProcessingById[id]) ids.add(id);
  }
  for (const id of Object.keys(s.codexProcessingById)) {
    if (s.codexProcessingById[id]) ids.add(id);
  }
  const map = s.claudeSessionMap;
  if (map) {
    for (const [xanomId, realIds] of Object.entries(map)) {
      if (!ids.has(xanomId)) continue;
      for (const realId of realIds) ids.delete(realId);
    }
  }
  return ids.size;
}
