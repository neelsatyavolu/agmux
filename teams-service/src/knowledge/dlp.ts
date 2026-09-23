/**
 * Best-effort pattern filters for Knowledge content.
 * Not a complete secret scanner — known high-confidence patterns only.
 */
import { HttpError } from "../http";

const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_RECORD = 12_000;
const MAX_ARRAY = 20;
const MAX_ITEM = 240;
const MAX_FILES = 40;

/** Absolute / Windows / UNC paths. */
const ABS_PATH =
  /(?:^|[\s"'`=(])(\/(?:Users|home|var|tmp|private|opt|etc)\/\S+|C:\\[^\s"'`]+|\\\\[^\s"'`]+)/i;

const SECRET_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "openai_key", re: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { code: "openrouter_key", re: /\bsk-or-v1-[a-zA-Z0-9]{20,}\b/ },
  { code: "github_pat", re: /\bghp_[a-zA-Z0-9]{20,}\b/ },
  { code: "github_oauth", re: /\bgho_[a-zA-Z0-9]{20,}\b/ },
  { code: "slack", re: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/ },
  { code: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "bearer", re: /\bBearer\s+[a-zA-Z0-9._\-+/=]{20,}\b/i },
  { code: "pem", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: "jwt", re: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/ },
];

const BAD_BASENAME = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|.*\.pem)$/i;

export type DlpHit = { code: string; field: string };

export function findSecrets(text: string, field: string): DlpHit[] {
  const hits: DlpHit[] = [];
  if (ABS_PATH.test(text)) hits.push({ code: "absolute_path", field });
  for (const { code, re } of SECRET_PATTERNS) {
    if (re.test(text)) hits.push({ code, field });
  }
  return hits;
}

export function assertCleanText(text: string, field: string): void {
  const hits = findSecrets(text, field);
  if (hits.length) {
    throw new HttpError(
      422,
      `Content blocked (${hits.map((h) => h.code).join(", ")}). Remove secrets and absolute paths, then retry.`,
      "knowledge_secret_blocked",
    );
  }
}

export function clampStr(s: unknown, max: number, field: string): string {
  if (typeof s !== "string") throw new HttpError(400, `${field} must be a string.`, "bad_request");
  const t = s.trim();
  if (!t) throw new HttpError(400, `${field} is required.`, "bad_request");
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`, "bad_request");
  return t;
}

export function optionalClamp(s: unknown, max: number): string | null {
  if (s == null || s === "") return null;
  if (typeof s !== "string") return null;
  return s.trim().slice(0, max) || null;
}

export function parseStringArray(raw: unknown, maxItems: number, maxLen: number, field: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, `${field} must be an array.`, "bad_request");
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim().slice(0, maxLen);
    if (!t) continue;
    assertCleanText(t, field);
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseFiles(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "files must be an array.", "bad_request");
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // Basename only — strip any path separators
    const base = item.trim().replace(/\\/g, "/").split("/").pop() ?? "";
    if (!base || base.length > 200) continue;
    if (BAD_BASENAME.test(base)) {
      throw new HttpError(422, `File name blocked: ${base}`, "knowledge_secret_blocked");
    }
    if (base.includes("..") || ABS_PATH.test(base)) {
      throw new HttpError(422, "Absolute paths are not allowed in files.", "knowledge_secret_blocked");
    }
    out.push(base);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

export function validateTitle(title: unknown): string {
  const t = clampStr(title, MAX_TITLE, "title");
  assertCleanText(t, "title");
  return t;
}

export function validateSummary(summary: unknown): string {
  const t = clampStr(summary, MAX_SUMMARY, "summary");
  assertCleanText(t, "summary");
  return t;
}

export function validateRecordContent(content: unknown): string {
  const t = clampStr(content, MAX_RECORD, "content");
  assertCleanText(t, "content");
  return t;
}

export function validateDigestBody(body: Record<string, unknown>): {
  title: string;
  summary: string;
  outcomes: string[];
  decisions: string[];
  files: string[];
  providers: string | null;
  projectKey: string | null;
  sourceProjectId: string | null;
  threadId: string | null;
} {
  // Reject never-leave-device fields if clients send them
  for (const banned of ["transcript", "toolArgs", "tool_args", "diff", "diffs", "fileContents", "body"]) {
    if (body[banned] != null) {
      throw new HttpError(400, `Field '${banned}' is not allowed.`, "bad_request");
    }
  }
  return {
    title: validateTitle(body.title),
    summary: validateSummary(body.summary),
    outcomes: parseStringArray(body.outcomes, MAX_ARRAY, MAX_ITEM, "outcomes"),
    decisions: parseStringArray(body.decisions, MAX_ARRAY, MAX_ITEM, "decisions"),
    files: parseFiles(body.files),
    providers: optionalClamp(body.providers, 80),
    projectKey: knowledgeProjectKey(optionalClamp(body.projectKey ?? body.project_key, 200)),
    sourceProjectId: optionalClamp(body.sourceProjectId ?? body.source_project_id, 80),
    threadId: optionalClamp(body.threadId ?? body.thread_id, 80),
  };
}

/** Knowledge project_key uses a different salt than analytics. */
export function knowledgeProjectKey(raw: string | null): string | null {
  if (!raw) return null;
  // Basename-ish only
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? raw;
  if (!base || base.includes("..")) return null;
  return base.slice(0, 200);
}

export const RECORD_KINDS = new Set(["decision", "fact", "issue"]);
export { MAX_TITLE, MAX_SUMMARY, MAX_RECORD };
