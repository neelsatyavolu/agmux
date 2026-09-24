import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  mlxClearExaApiKey,
  mlxGetExaApiKeyStatus,
  mlxSetExaApiKey,
  type ExaKeyStatus,
} from "../../../lib/mlx";
import { formatError } from "../../../lib/formatError";
import { SettingsRow } from "../settingsLayout";
import { ErrorNote, btn, btnAccent, btnDanger, textInput } from "./ui";

/** Exa API key used by local models' web search tool. */
export function ExaKeyRow() {
  const [status, setStatus] = useState<ExaKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await mlxGetExaApiKeyStatus());
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function mutate(fn: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await fn();
      setDraft("");
      setEditing(false);
      setReveal(false);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSaving(false);
    }
  }

  const configured = !!status?.configured;
  const showForm = editing || (status !== null && !configured);

  const description = (
    <>
      {status?.source === "env"
        ? "Read from the EXA_API_KEY environment variable. Remove it from your shell profile to clear it."
        : status?.source === "settings"
          ? "Stored in ~/.agmux/secrets.json."
          : "Lets local models search the web."}{" "}
      <button
        type="button"
        onClick={() => openUrl("https://dashboard.exa.ai/api-keys").catch(() => {})}
        className="text-[var(--accent)] underline-offset-2 hover:underline"
      >
        Get a key
      </button>
    </>
  );

  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          Exa API key
          {configured && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--accent)]">
              <CheckCircle2 size={11} /> …{status?.last4}
            </span>
          )}
        </span>
      }
      description={description}
      stacked={showForm || !!error}
    >
      {showForm ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type={reveal ? "text" : "password"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) mutate(() => mlxSetExaApiKey(draft.trim()));
            }}
            placeholder="exa_…"
            aria-label="Exa API key"
            spellCheck={false}
            autoComplete="off"
            className={`${textInput} flex-1 font-mono sm:max-w-[320px]`}
          />
          <button type="button" className={btn} onClick={() => setReveal((v) => !v)}>
            {reveal ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            className={btnAccent}
            disabled={!draft.trim() || saving}
            onClick={() => mutate(() => mlxSetExaApiKey(draft.trim()))}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : "Save"}
          </button>
          {editing && configured && (
            <button
              type="button"
              className={btn}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : configured && status?.source === "settings" ? (
        <>
          <button type="button" className={btn} onClick={() => setEditing(true)}>
            Replace
          </button>
          <button type="button" className={btnDanger} disabled={saving} onClick={() => mutate(mlxClearExaApiKey)}>
            Remove
          </button>
        </>
      ) : null}
      {error && (
        <div className={showForm ? "mt-2" : undefined}>
          <ErrorNote message={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </SettingsRow>
  );
}
