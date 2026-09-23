/**
 * When bulk-moving threads between projects, also transfer localStorage
 * sidebar prefs (pinned / hidden / created-claude) so discovered sessions
 * keep the same pin/hide state under the destination project id.
 */

import { transferPinnedSessions } from "./pinnedSessions";
import { transferHiddenSessions } from "./hiddenSessions";
import { transferCreatedClaudeSessions } from "./createdSessions";

export function transferProjectSessionPrefs(
  fromProjectId: string,
  toProjectId: string,
): void {
  if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) return;
  transferPinnedSessions(fromProjectId, toProjectId);
  transferHiddenSessions(fromProjectId, toProjectId);
  transferCreatedClaudeSessions(fromProjectId, toProjectId);
}
