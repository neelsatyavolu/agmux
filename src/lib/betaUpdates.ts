export const BETA_VERIFY_URL = "https://agmux.dev/api/beta/token/verify";

export function updaterCheckOptions(
  enabled: boolean,
  token: string,
): { headers: Record<string, string> } | undefined {
  const t = token.trim();
  if (!enabled || !t) return undefined;
  return { headers: { Authorization: `Bearer ${t}` } };
}

/** Must be passed as the *options* argument so check() headers are replaced. */
export function updaterDownloadOptions(): { headers: Record<string, string> } {
  return { headers: {} };
}

export type BetaVerifyResult = { ok: true } | { ok: false; reason: "invalid" | "revoked" };

export async function verifyBetaToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BetaVerifyResult | null> {
  const t = token.trim();
  if (!t) return null;
  const res = await fetchImpl(BETA_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t }),
  });
  const data = (await res.json()) as { ok?: boolean; reason?: string };
  if (data.ok) return { ok: true };
  const reason = data.reason === "revoked" ? "revoked" : "invalid";
  return { ok: false, reason };
}

export function isExpiredAssetError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("403") || msg.includes("forbidden");
}
