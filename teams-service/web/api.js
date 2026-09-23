/* Thin fetch layer over the Worker API. Every call unwraps { ok, data } and
   throws an ApiError carrying the server's human-readable message, so views can
   render the real reason instead of "something went wrong". */

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection.", "network");
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error page */
  }

  if (!res.ok || !payload?.ok) {
    throw new ApiError(
      res.status,
      payload?.error ?? "Something went wrong on our side.",
      payload?.code ?? "error",
    );
  }
  return payload.data;
}

export const api = {
  me: () => call("GET", "/api/auth/me"),
  logout: () => call("POST", "/api/auth/logout"),
  /** Binds a pending desktop link code to the signed-in user. */
  attachDevice: (code) => call("POST", "/api/auth/device/attach", { code }),

  listTeams: () => call("GET", "/api/teams"),
  createTeam: (name) => call("POST", "/api/teams", { name }),
  getTeam: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}`),
  renameTeam: (key, name) => call("PATCH", `/api/teams/${encodeURIComponent(key)}`, { name }),
  deleteTeam: (key) => call("DELETE", `/api/teams/${encodeURIComponent(key)}`),
  leaveTeam: (key) => call("POST", `/api/teams/${encodeURIComponent(key)}/leave`),

  getBilling: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/billing`),
  billingCheckout: (key, interval, seats) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/billing/checkout`, {
      interval,
      ...(seats != null ? { seats } : {}),
    }),
  billingPortal: (key) => call("POST", `/api/teams/${encodeURIComponent(key)}/billing/portal`),
  billingConfirm: (key, sessionId) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/billing/confirm`, { sessionId }),
  billingSetSeats: (key, seats) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/billing/seats`, { seats }),

  members: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/members`),
  setRole: (key, userId, role) =>
    call("PATCH", `/api/teams/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`, { role }),
  removeMember: (key, userId) =>
    call("DELETE", `/api/teams/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`),
  getMemberScope: (key, userId) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}/scope`),
  setMemberScope: (key, userId, body) =>
    call("PUT", `/api/teams/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}/scope`, body),
  managerScopes: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/manager-scopes`),

  groups: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/groups`),
  createGroup: (key, body) => call("POST", `/api/teams/${encodeURIComponent(key)}/groups`, body),
  getGroup: (key, groupId) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/groups/${encodeURIComponent(groupId)}`),
  renameGroup: (key, groupId, name) =>
    call("PATCH", `/api/teams/${encodeURIComponent(key)}/groups/${encodeURIComponent(groupId)}`, { name }),
  deleteGroup: (key, groupId) =>
    call("DELETE", `/api/teams/${encodeURIComponent(key)}/groups/${encodeURIComponent(groupId)}`),
  setGroupMembers: (key, groupId, memberIds) =>
    call("PUT", `/api/teams/${encodeURIComponent(key)}/groups/${encodeURIComponent(groupId)}/members`, {
      memberIds,
    }),

  getInvite: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/invite`),
  createInvite: (key) => call("POST", `/api/teams/${encodeURIComponent(key)}/invite`, {}),
  revokeInvite: (key) => call("POST", `/api/teams/${encodeURIComponent(key)}/invite/revoke`),
  previewInvite: (token) => call("GET", `/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token) => call("POST", `/api/invites/${encodeURIComponent(token)}/accept`, { accepted: true }),

  overview: (key, range) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/overview?${rangeQuery(range)}`),
  memberDetail: (key, userId, range) =>
    call(
      "GET",
      `/api/teams/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}/detail?${rangeQuery(range)}`,
    ),
  selfDetail: (key, range) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/me?${rangeQuery(range)}`),

  getBudget: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/budget`),
  setBudget: (key, budget) => call("PUT", `/api/teams/${encodeURIComponent(key)}/budget`, budget),
  getPolicy: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/policy`),
  putPolicy: (key, body) => call("PUT", `/api/teams/${encodeURIComponent(key)}/policy`, body),
  audit: (key, limit = 40) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/audit?limit=${encodeURIComponent(limit)}`),

  leaderboardSettings: (key) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/leaderboard/settings`),
  patchLeaderboardSettings: (key, body) =>
    call("PATCH", `/api/teams/${encodeURIComponent(key)}/leaderboard/settings`, body),
  leaderboardInstallUrl: (key) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/leaderboard/install-url`),
  leaderboardRepos: (key) =>
    call("GET", `/api/teams/${encodeURIComponent(key)}/leaderboard/repos`),
  setLeaderboardRepos: (key, repos) =>
    call("PUT", `/api/teams/${encodeURIComponent(key)}/leaderboard/repos`, { repos }),
  leaderboardSync: (key) => call("POST", `/api/teams/${encodeURIComponent(key)}/leaderboard/sync`),
  leaderboardWeek: (key, week) => {
    const q = week ? `?week=${encodeURIComponent(week)}` : "";
    return call("GET", `/api/teams/${encodeURIComponent(key)}/leaderboard/week${q}`);
  },

  // Team Knowledge (content plane)
  knowledgeSettings: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/knowledge/settings`),
  knowledgePatchSettings: (key, body) =>
    call("PATCH", `/api/teams/${encodeURIComponent(key)}/knowledge/settings`, body),
  knowledgeAcceptDisclosure: (key) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/knowledge/disclosure/accept`),
  knowledgeOverview: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/knowledge/overview`),
  knowledgeSearch: (key, q) =>
    call(
      "GET",
      `/api/teams/${encodeURIComponent(key)}/knowledge/search?q=${encodeURIComponent(q)}`,
    ),
  knowledgeCreateRecord: (key, body) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/knowledge/records`, body),
  knowledgeDeleteRecord: (key, id) =>
    call("DELETE", `/api/teams/${encodeURIComponent(key)}/knowledge/records/${encodeURIComponent(id)}`),
  knowledgeVerifyRecord: (key, id) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/knowledge/records/${encodeURIComponent(id)}/verify`),
  knowledgePromote: (key, body) =>
    call("POST", `/api/teams/${encodeURIComponent(key)}/knowledge/promote`, body),
  knowledgeExport: (key) => call("GET", `/api/teams/${encodeURIComponent(key)}/knowledge/export`),
};

/** Start OAuth to attach a second identity (e.g. GitHub) to the signed-in user. */
export function linkProviderUrl(provider, next) {
  const q = new URLSearchParams({
    intent: "link",
    next: next || location.pathname + location.hash || "/#/teams",
  });
  return `/api/auth/${provider}/start?${q}`;
}

/**
 * The CSV download URL.
 *
 * Deliberately a plain link rather than a fetch: the browser's own download
 * handling gets the filename from `content-disposition`, and the response never
 * has to be buffered into memory.
 */
export function exportCsvUrl(key, range, granularity = "day") {
  return `/api/teams/${encodeURIComponent(key)}/export.csv?${rangeQuery(range)}&granularity=${encodeURIComponent(
    granularity,
  )}`;
}

/**
 * `range` is either a preset key ("30d") or `{ from, to }` (YYYY-MM-DD).
 * Custom windows go out as from/to; presets as range=.
 */
export function rangeQuery(range) {
  if (range && typeof range === "object" && range.from && range.to) {
    return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  }
  return `range=${encodeURIComponent(range || "30d")}`;
}

export function signInUrl(provider, next) {
  const q = new URLSearchParams({ next: next || location.pathname + location.search });
  return `/api/auth/${provider}/start?${q}`;
}

