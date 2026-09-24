import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Search, X } from "lucide-react";
import { mlxSearchHfModels, type HfSearchHit } from "../../../lib/mlx";
import { formatError } from "../../../lib/formatError";
import { InstalledBadge, ModelRowShell, RemoveButton, type DownloadControls } from "./ModelRow";
import { ErrorNote, btn, btnAccent, textInput } from "./ui";

const SEARCH_DEBOUNCE_MS = 300;

/** Search MLX-tagged HuggingFace repos beyond the curated list. Renders rows for a SettingsCard. */
export function HfSearch({
  installedIds,
  controls,
}: {
  installedIds: ReadonlySet<string>;
  controls: DownloadControls;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HfSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const seq = ++requestSeq.current;
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      mlxSearchHfModels(q)
        .then((hits) => {
          if (seq !== requestSeq.current) return;
          setResults(hits);
          setError(null);
        })
        .catch((e) => {
          if (seq === requestSeq.current) setError(formatError(e));
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const trimmed = query.trim();

  return (
    <>
      <div className="px-6 py-3.5">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search MLX models, e.g. qwen coder, devstral…"
            aria-label="Search HuggingFace MLX models"
            spellCheck={false}
            className={`${textInput} pl-8 pr-8`}
          />
          {searching ? (
            <Loader2
              size={12}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-[var(--text-muted)]"
            />
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        {error && (
          <div className="mt-2">
            <ErrorNote message={error} onDismiss={() => setError(null)} />
          </div>
        )}
      </div>

      {results.map((hit) => (
        <SearchHitRow key={hit.id} hit={hit} installed={installedIds.has(hit.id.toLowerCase())} controls={controls} />
      ))}

      {!searching && !error && trimmed.length >= 2 && results.length === 0 && (
        <div className="px-6 py-3.5 text-[12px] text-[var(--text-muted)]">
          No MLX models match <span className="font-mono text-[var(--text-secondary)]">{trimmed}</span>.
        </div>
      )}
    </>
  );
}

function SearchHitRow({
  hit,
  installed,
  controls,
}: {
  hit: HfSearchHit;
  installed: boolean;
  controls: DownloadControls;
}) {
  const downloading = controls.activeRepo?.toLowerCase() === hit.id.toLowerCase();
  return (
    <ModelRowShell
      title={hit.id}
      badges={installed ? <InstalledBadge /> : undefined}
      meta={[`${hit.downloads.toLocaleString()} downloads`, `${hit.likes.toLocaleString()} likes`]}
      action={
        installed ? (
          <RemoveButton onConfirm={() => controls.onRemove(hit.id)} />
        ) : downloading ? (
          <button type="button" className={btn} onClick={controls.onCancel}>
            <X size={12} /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className={btnAccent}
            onClick={() => controls.onDownload(hit.id)}
            disabled={!!controls.activeRepo}
          >
            <Download size={12} /> Download
          </button>
        )
      }
      progress={
        downloading && controls.progress?.repoId.toLowerCase() === hit.id.toLowerCase()
          ? controls.progress
          : null
      }
    />
  );
}
