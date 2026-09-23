/** agmux Teams — Tauri command bindings and shared types. */

import { invoke } from "@tauri-apps/api/core";

export type TeamRole = "owner" | "manager" | "employee";
export type TeamRange = "7d" | "14d" | "30d" | "90d";

export const TEAM_RANGES: TeamRange[] = ["7d", "14d", "30d", "90d"];

export const TEAM_RANGE_LABELS: Record<TeamRange, string> = {
  "7d": "7 days",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days",
};

/** Provider ids as stored in metric_hourly → display labels. */
export function prettyProvider(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "Unknown";
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  const map: Record<string, string> = {
    claudecode: "Claude Code",
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok",
    cursor: "Cursor",
    kimi: "Kimi",
    pi: "Pi",
    opencode: "OpenCode",
    mlx: "MLX",
    other: "Other",
    unknown: "Unknown",
  };
  if (map[key]) return map[key];
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

/** Model slugs → human labels (Claude Opus 4.6, GPT 5.3 Codex, Grok 4.5, …). */
export function prettyModel(slug: string): string {
  let s = String(slug ?? "").trim();
  if (!s) return "Unknown";
  if (s === "Other" || s === "other") return "Other";
  if (s === "unknown") return "Unknown";
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);

  let context = "";
  const ctx = s.match(/\[(\d+)m\]$/i);
  if (ctx) {
    context = ` (${ctx[1]}M)`;
    s = s.slice(0, -ctx[0].length);
  }

  if (/^claude[-_]/i.test(s)) {
    let rest = s.replace(/^claude[-_]/i, "").replace(/[-_]\d{8}$/, "");
    const parts = rest.split(/[-_]/).filter(Boolean);
    const out: string[] = ["Claude"];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (/^\d+$/.test(p)) {
        let ver = p;
        while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1]!)) {
          i += 1;
          ver += `.${parts[i]}`;
        }
        out.push(ver);
      } else {
        out.push(capWord(p));
      }
    }
    return out.join(" ") + context;
  }

  if (/^gpt[-_]/i.test(s) || /^o[1-9]/i.test(s)) {
    const parts = s.split(/[-_]/).filter(Boolean);
    const out: string[] = [];
    let i = 0;
    if (parts[0]?.toLowerCase() === "gpt" && parts[1] && /^\d/.test(parts[1])) {
      out.push("GPT", parts[1]);
      i = 2;
    } else if (/^o\d/i.test(parts[0] ?? "")) {
      out.push(parts[0]!.toUpperCase());
      i = 1;
    }
    for (; i < parts.length; i++) out.push(capWord(parts[i]!));
    return out.join(" ") + context;
  }

  if (/^grok/i.test(s) || /composer/i.test(s)) {
    if (/composer/i.test(s)) {
      const m = s.match(/composer[-_]?([\d.]+)/i);
      return (m ? `Composer ${m[1]}` : "Composer") + context;
    }
    const rest = s.replace(/^grok[-_]?/i, "");
    if (!rest) return "Grok" + context;
    const titled = rest
      .split(/[-_]/)
      .filter(Boolean)
      .map((p) => (/^\d/.test(p) ? p : capWord(p)))
      .join(" ");
    return `Grok ${titled}` + context;
  }

  return (
    s
      .split(/[-_/]/)
      .filter(Boolean)
      .map((p) => (/^\d/.test(p) ? p : capWord(p)))
      .join(" ") + context
  );
}

const ALL_CAPS = new Set(["api", "sdk", "cli", "ml", "ai", "cpu", "gpu", "id"]);

function capWord(w: string): string {
  if (!w) return w;
  const lower = w.toLowerCase();
  if (ALL_CAPS.has(lower)) return lower.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function prettyMixLabel(key: string, mono = false): string {
  if (mono) return prettyModel(key);
  if (key === "Other" || key === "other") return "Other";
  if (/[/]|claude-|gpt-|grok|composer|sonnet|opus|haiku|fable/i.test(key)) {
    return prettyModel(key);
  }
  return prettyProvider(key);
}

export interface TeamsAccount {
  userId: string;
  displayName: string;
  email: string | null;
  handle: string | null;
  avatarColor: string;
  deviceId: string;
  linkedAt: string;
}

export interface TeamMembership {
  teamId: string;
  slug: string;
  name: string;
  role: TeamRole;
  joinedAt: string | null;
  active: boolean;
}

export interface AccountingCoverage {
  unverifiedLegacyRecords: number;
  awaitingNativeBinding: number;
  unrevalidatedCodexSnapshots: number;
}

export interface TeamsSyncStatus {
  linked: boolean;
  account: TeamsAccount | null;
  teams: TeamMembership[];
  lastUploadAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  backoffStep: number;
  queuedBatches: number;
  queuedBytes: number;
  baseUrl: string;
  accountingCoverage?: AccountingCoverage;
}

export interface QueuedBatch {
  batchId: string;
  bucketCount: number;
  byteSize: number;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface FlushOutcome {
  sent: number;
  failed: number;
  dropped: number;
  duplicates: number;
  buckets: number;
  backoffStep: number;
  lastError: string | null;
  teams: string[];
}

export interface LinkStart {
  code: string;
  url: string;
  deviceId: string;
}

/** Exactly what would be uploaded — counters and short labels, no content. */
export interface HourlyBucket {
  hourUtc: string;
  provider: string;
  model: string;
  projectKey: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  costUsd: number;
  costIncomplete?: boolean;
  activeMs: number;
  afterHoursMs: number;
  weekendMs: number;
  sessions: number;
  turns: number;
  toolCalls: number;
  peakConcurrent: number;
  toolBash: number;
  toolEdit: number;
  toolRead: number;
  toolSearch: number;
  toolWeb: number;
  toolAgent: number;
  toolMcp: number;
  toolOther: number;
  toolErrors: number;
  toolsMeasured: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  localHour: number;
  localDow: number;
}

/** Server-computed totals, mirroring teams-service/src/aggregate.ts. */
export interface Totals {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  tokens: number;
  cacheHitRate: number;
  costUsd: number;
  costIncomplete?: boolean;
  activeHours: number;
  afterHoursShare: number;
  weekendShare: number;
  sessions: number;
  turns: number;
  toolCalls: number;
  peakConcurrent: number;
  daysWithData: number;
  /** Tool calls per kind — keys match the server's `TOOL_KINDS`. */
  toolMix: Record<string, number>;
  toolErrors: number;
  /** Calls whose outcome the provider actually reported. Not `toolCalls`. */
  toolsMeasured: number;
  /** Null when nothing was measurable — render that, never a 0% that lies. */
  toolErrorRate: number | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Monthly spend against a budget, with a straight-line month-end forecast. */
export interface BudgetStatus {
  /** Completeness of recorded cost estimates, not invoice verification. */
  costIncomplete?: boolean;
  month: string;
  monthlyUsd: number;
  spendUsd: number;
  usedShare: number;
  projectedUsd: number;
  projectedShare: number;
  daysElapsed: number;
  daysInMonth: number;
  onTrackToExceed: boolean;
  thresholds: number[];
  hasWebhook: boolean;
}

export interface DayPoint {
  date: string;
  label: string;
  full: string;
  tokens: number;
  activeHours: number;
  sessions: number;
  peakConcurrent: number;
  weekend: boolean;
  hasData: boolean;
}

export interface MixSlice {
  key: string;
  tokens: number;
  share: number;
  /** Gap-capped active agent time attributed to this provider/model. */
  activeMs: number;
  /** Share of active time (0–1). Independent of `share` (tokens). */
  timeShare: number;
}

export interface TeamFlags {
  afterHoursShare: number;
  afterHoursSharePrev: number;
  weekendShare: number;
  idleDays: number;
}

export interface MemberRow {
  userId: string;
  displayName: string;
  handle: string | null;
  avatarColor: string;
  /** GitHub/Google profile photo URL when available. */
  avatarUrl?: string | null;
  role: TeamRole;
  lastUploadAt: string | null;
  /** IANA zone used for after-hours / weekend / heatmap, e.g. `Asia/Tokyo`. */
  timezone: string | null;
  neverSynced: boolean;
  joinedAt: string;
  totals: Totals;
}

export interface ProjectRow {
  projectKey: string;
  activeHours: number;
  tokens: number;
  sessions: number;
}

export interface TeamOverview {
  range: TeamRange | "custom";
  from?: string;
  to?: string;
  /** team = whole org; partial = manager's people; self = employee rescope. */
  scope: "team" | "partial" | "self";
  /** Human label for partial scopes ("Platform · 4 people"). */
  scopeLabel?: string;
  role: TeamRole;
  totals: Totals;
  deltas: {
    tokens: number | null;
    costUsd: number | null;
    activeHours: number | null;
    sessions: number | null;
  };
  daily: DayPoint[];
  heatmap: number[][];
  providerMix: MixSlice[];
  modelMix: MixSlice[];
  projects?: ProjectRow[];
  flags: TeamFlags;
  /** Null when no budget is set, or the caller can't see team spend. */
  budget: BudgetStatus | null;
  canManageBudget: boolean;
  canViewAudit: boolean;
  members: MemberRow[];
  memberCount: number;
  /** Full team size when scope is partial (optional). */
  teamMemberCount?: number;
  lastUploadAt: string | null;
}

export interface MemberDetail {
  range: TeamRange | "custom";
  from?: string;
  to?: string;
  role: TeamRole;
  isSelf: boolean;
  member: {
    user_id: string;
    display_name: string;
    handle: string | null;
    avatar_color: string;
    avatar_url?: string | null;
    role: TeamRole;
    joined_at: string;
    last_upload_at: string | null;
    /** IANA zone used for after-hours / weekend classification. */
    timezone: string | null;
  };
  totals: Totals;
  daily: DayPoint[];
  heatmap: number[][];
  providerMix: MixSlice[];
  modelMix: MixSlice[];
  projects: ProjectRow[];
  flags: TeamFlags;
  neverSynced: boolean;
}

/* ── commands ─────────────────────────────────────────────────────────── */

export async function teamsLinkStart(deviceLabel?: string): Promise<LinkStart> {
  return invoke<LinkStart>("teams_link_start", { deviceLabel: deviceLabel ?? null });
}

export async function teamsLinkClaim(code: string, deviceId: string): Promise<TeamsAccount | null> {
  return invoke<TeamsAccount | null>("teams_link_claim", { code, deviceId });
}

export async function teamsSignOut(): Promise<void> {
  return invoke<void>("teams_sign_out");
}

export async function teamsGetStatus(): Promise<TeamsSyncStatus> {
  return invoke<TeamsSyncStatus>("teams_get_status");
}

export async function teamsListQueue(): Promise<QueuedBatch[]> {
  return invoke<QueuedBatch[]>("teams_list_queue");
}

export async function teamsRefresh(): Promise<TeamMembership[]> {
  return invoke<TeamMembership[]>("teams_refresh");
}

/** Org policy intersection: null is unrestricted; [] denies every choice. */
export interface TeamsEffectivePolicy {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  allowedModes: string[] | null;
  allowedEfforts: string[] | null;
  defaultPermissionMode: string | null;
  policies: Array<{
    teamId: string;
    slug: string;
    allowedProviders: string[] | null;
    allowedModels: string[] | null;
    allowedModes: string[] | null;
    allowedEfforts: string[] | null;
    defaultPermissionMode: string | null;
    spendHardStopUsd: number | null;
  }>;
}

export async function teamsGetEffectivePolicy(): Promise<TeamsEffectivePolicy> {
  return invoke<TeamsEffectivePolicy>("teams_get_effective_policy");
}

export async function teamsSyncNow(): Promise<FlushOutcome> {
  return invoke<FlushOutcome>("teams_sync_now");
}

export async function teamsPreviewPayload(): Promise<HourlyBucket[]> {
  return invoke<HourlyBucket[]>("teams_preview_payload");
}

export async function teamsOverview(team: string, range: TeamRange): Promise<TeamOverview> {
  return invoke<TeamOverview>("teams_overview", { team, range });
}

export async function teamsSelfView(team: string, range: TeamRange): Promise<MemberDetail> {
  return invoke<MemberDetail>("teams_self_view", { team, range });
}

export async function teamsMemberDetail(
  team: string,
  userId: string,
  range: TeamRange,
): Promise<MemberDetail> {
  return invoke<MemberDetail>("teams_member_detail", { team, userId, range });
}

export async function teamsLeave(team: string): Promise<void> {
  return invoke<void>("teams_leave", { team });
}

export interface InvitePreview {
  state: "active" | "expired" | "revoked" | "exhausted";
  expiresAt: string | null;
  team: { name: string };
  inviter: { display_name: string; avatar_color: string } | null;
  ownerName: string | null;
  memberCount: number;
}

/** Reads an invite link without joining. Accepts a full URL or a bare token. */
export async function teamsPreviewInvite(link: string): Promise<InvitePreview> {
  return invoke<InvitePreview>("teams_preview_invite", { link });
}

/** Joins the team. Only call after the disclosure has actually been accepted. */
export async function teamsAcceptInvite(link: string): Promise<TeamMembership[]> {
  return invoke<TeamMembership[]>("teams_accept_invite", { link });
}

/* ── Team Knowledge (content plane; separate from analytics) ───────────── */

/** True only after the Teams server has Knowledge migrated; false on older servers. */
export async function teamsKnowledgeAvailable(): Promise<boolean> {
  return invoke<boolean>("teams_knowledge_available");
}

export async function teamsKnowledgeSettings(team: string): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("teams_knowledge_settings", { team });
}

export async function teamsKnowledgeShareDigest(args: {
  team: string;
  title: string;
  summary: string;
  outcomes?: string[];
  decisions?: string[];
  files?: string[];
  projectKey?: string;
  threadId?: string;
}): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("teams_knowledge_share_digest", {
    team: args.team,
    title: args.title,
    summary: args.summary,
    outcomes: args.outcomes ?? null,
    decisions: args.decisions ?? null,
    files: args.files ?? null,
    projectKey: args.projectKey ?? null,
    threadId: args.threadId ?? null,
  });
}

export async function teamsKnowledgePromote(args: {
  team: string;
  title: string;
  content: string;
  kind?: string;
}): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("teams_knowledge_promote", {
    team: args.team,
    title: args.title,
    content: args.content,
    kind: args.kind ?? null,
  });
}

export async function teamsKnowledgeAcceptDisclosure(
  team: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("teams_knowledge_accept_disclosure", {
    team,
  });
}

export interface ProjectTeamBind {
  teamId: string;
  teamSlug: string;
  teamName: string;
  boundAt: string;
}

export async function teamsGetProjectBind(
  projectId: string,
): Promise<ProjectTeamBind | null> {
  return invoke<ProjectTeamBind | null>("teams_get_project_bind", { projectId });
}

export async function teamsSetProjectBind(args: {
  projectId: string;
  teamId: string;
  teamSlug: string;
  teamName: string;
}): Promise<ProjectTeamBind> {
  return invoke<ProjectTeamBind>("teams_set_project_bind", {
    projectId: args.projectId,
    teamId: args.teamId,
    teamSlug: args.teamSlug,
    teamName: args.teamName,
  });
}

export async function teamsClearProjectBind(projectId: string): Promise<void> {
  return invoke<void>("teams_clear_project_bind", { projectId });
}

/* ── formatting helpers (shared by every Teams surface) ───────────────── */

export function fmtTokens(n: number): { value: string; unit: string } {
  if (n >= 1e9) return { value: (n / 1e9).toFixed(1), unit: "B" };
  if (n >= 1e6) return { value: (n / 1e6).toFixed(1), unit: "M" };
  if (n >= 1e3) return { value: (n / 1e3).toFixed(0), unit: "k" };
  return { value: String(Math.round(n)), unit: "" };
}

export function fmtMoney(n: number): { value: string; unit: string } {
  const s = n.toFixed(2);
  const dot = s.indexOf(".");
  const intPart = Number(s.slice(0, dot)).toLocaleString("en-US");
  return { value: `$${intPart}`, unit: s.slice(dot) };
}

export const fmtPct = (n: number): string => `${Math.round(n * 100)}%`;

/** Compact active-time label: `<1m` / `12m` / `1.4h` / `18h`. */
export function fmtActiveMs(ms: number): string {
  if (!ms || ms <= 0) return "0m";
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = ms / 3_600_000;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

/**
 * Parse a Teams timestamp to ms since epoch.
 *
 * Desktop stores sync times via SQLite `datetime('now')` — UTC in
 * `"YYYY-MM-DD HH:MM:SS"` form with no `Z`. Naive `Date.parse` treats that as
 * *local* time, so absolute clocks sit one UTC offset ahead (e.g. +7h on PDT)
 * while relative "just now" still looks fine (future diffs floor to "now").
 * Server-side RFC3339 strings pass through unchanged.
 */
export function parseTeamsTs(raw: string): number {
  // Already-ISO with timezone or Z — trust as-is.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    return Date.parse(raw);
  }
  // Plain date — UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(`${raw}T00:00:00Z`);
  }
  // SQLite default: "YYYY-MM-DD HH:MM:SS[.fff]" (space or T, no zone).
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
    return Date.parse(raw.replace(" ", "T") + "Z");
  }
  return Date.parse(raw);
}

/** Absolute local wall-clock for a Teams timestamp, or null if unparseable. */
export function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const t = parseTeamsTs(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString();
}

/** Compact relative time: "now", "6m", "4h", "2d". */
export function since(iso: string | null): string | null {
  if (!iso) return null;
  const t = parseTeamsTs(iso);
  if (!Number.isFinite(t)) return null;
  // Clamp future (clock skew / residual naive-UTC rows) so we never invent "−7m".
  const ms = Math.max(0, Date.now() - t);
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function agoLabel(iso: string | null): string | null {
  const s = since(iso);
  if (!s) return null;
  return s === "now" ? "just now" : `${s} ago`;
}

/**
 * Sync freshness: green under an hour, amber beyond, grey when nothing has ever
 * arrived. Colour is always paired with a word — never colour alone.
 */
export function syncTone(lastUploadAt: string | null): {
  tone: "ok" | "warn" | "none";
  label: string;
} {
  const label = since(lastUploadAt);
  if (!label) return { tone: "none", label: "never" };
  const t = parseTeamsTs(lastUploadAt!);
  return {
    tone: Number.isFinite(t) && Date.now() - t < 3_600_000 ? "ok" : "warn",
    label,
  };
}

export function initials(name: string): string {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
