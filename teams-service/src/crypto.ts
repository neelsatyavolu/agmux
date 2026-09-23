/** Token minting + hashing. Raw tokens are never persisted. */

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** URL-safe random token. 32 bytes → 64 hex chars. */
export function mintToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Shorter, still-unguessable token for invite URLs (16 bytes → 32 chars). */
export const mintInviteToken = () => mintToken(16);

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Constant-time string compare, so callers can't time their way to a token. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Deterministic avatar color from a stable id — matches the design palette. */
const AVATAR_COLORS = [
  "#a3e635",
  "#60a5fa",
  "#fbbf24",
  "#f472b6",
  "#22d3ee",
  "#a78bfa",
  "#fb923c",
  "#34d399",
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
