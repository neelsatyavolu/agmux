import { useCallback, useEffect, useRef, useState } from "react";
import { teamsGetEffectivePolicy, type TeamsEffectivePolicy } from "../lib/teams";

export function useTeamsRestrictions() {
  const [policy, setPolicy] = useState<TeamsEffectivePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await teamsGetEffectivePolicy();
      if (!next) throw new Error("Missing team restrictions");
      if (request === generation.current) setPolicy(next);
    } catch {
      if (request === generation.current) setError("Could not load team restrictions. Retry before starting a session.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      generation.current++;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { policy, loading, error, refresh };
}
