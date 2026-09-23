// Robustly stringify any error value (Tauri invoke rejection, Error instance,
// structured object, etc.) for display in the UI. Without this, errors with
// non-string `.message` (e.g. OpenCode SDK APIError carrying a structured body)
// surface as "[object Object]".
export function formatError(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.toString();
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
    try {
      return JSON.stringify(o);
    } catch {
      return Object.prototype.toString.call(o);
    }
  }
  return String(e);
}
