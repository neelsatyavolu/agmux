import { useEffect, useState } from "react";

let cached: string | null = null;
let inflight: Promise<string> | null = null;

function fetchVersion(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = import("@tauri-apps/api/app")
    .then((mod) => mod.getVersion())
    .then((v) => {
      cached = v;
      inflight = null;
      return v;
    })
    .catch((err) => {
      inflight = null;
      console.error("Failed to read app version:", err);
      cached = "unknown";
      return cached;
    });
  return inflight;
}

/**
 * Returns the app's version string from the Tauri runtime, cached
 * across components. Empty string until the first fetch resolves so
 * components can render without flicker.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(cached ?? "");
  useEffect(() => {
    if (cached !== null) {
      setVersion(cached);
      return;
    }
    let cancelled = false;
    fetchVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
