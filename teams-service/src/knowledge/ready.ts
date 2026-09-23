/**
 * Knowledge is additive and opt-in at deploy time.
 * Older clients never call Knowledge routes; new clients only show UI when
 * `features.knowledge === true` (schema present and not kill-switched).
 */
import type { Env } from "../env";

let cached: boolean | null = null;

/** Kill switch: KNOWLEDGE_ENABLED=false keeps feature dark after migration. */
export function knowledgeEnabledInEnv(env: Env): boolean {
  return env.KNOWLEDGE_ENABLED !== "false";
}

/**
 * True when kw_* tables exist and the env kill-switch is not off.
 * Safe to call often; result is cached per Worker isolate after first probe.
 */
export async function isKnowledgeReady(env: Env): Promise<boolean> {
  if (!knowledgeEnabledInEnv(env)) return false;
  if (cached === true) return true;
  try {
    // Empty table is fine; missing table throws on D1/SQLite.
    await env.DB.prepare("SELECT 1 AS ok FROM kw_team_policy LIMIT 1").first();
    cached = true;
    return true;
  } catch {
    cached = false;
    return false;
  }
}

/** Test helper / after migration in same process. */
export function resetKnowledgeReadyCache(): void {
  cached = null;
}

export async function featuresPayload(env: Env): Promise<{ knowledge: boolean }> {
  return { knowledge: await isKnowledgeReady(env) };
}
