import type { CursorModel } from "./cursorSdkCommands";

export interface CursorReasoningOption {
  slug: string;
  label: string;
}

export interface CursorReasoningOptions {
  options: CursorReasoningOption[];
  currentLabel: string | null;
  title: string;
  minLabel?: string;
  maxLabel?: string;
}

const BOOLEAN_LABELS: Record<string, "On" | "Off"> = {
  true: "On",
  on: "On",
  yes: "On",
  "1": "On",
  false: "Off",
  off: "Off",
  no: "Off",
  "0": "Off",
};

/** Map catalog tokens like `false`/`true` to Off/On. Keep named levels (Low, High). */
export function prettyCursorParamValueLabel(
  value: string,
  displayName?: string | null,
): string {
  const named = (displayName ?? "").trim();
  if (named) {
    return BOOLEAN_LABELS[named.toLowerCase()] ?? named;
  }
  const raw = String(value ?? "").trim();
  return BOOLEAN_LABELS[raw.toLowerCase()] ?? raw;
}

export function cursorBaseModelSlug(slug: string | null | undefined): string {
  return String(slug ?? "").split("?")[0];
}

export function cursorModelParamValue(
  slug: string | null | undefined,
  paramId: string,
): string | null {
  const query = String(slug ?? "").split("?")[1] ?? "";
  return new URLSearchParams(query).get(paramId);
}

export function cursorSlugWithParam(slug: string, paramId: string, value: string): string {
  const base = cursorBaseModelSlug(slug);
  const existingQuery = slug.includes("?") ? slug.slice(slug.indexOf("?") + 1) : "";
  const params = new URLSearchParams(existingQuery);
  params.set(paramId, value);
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function isReasoningParam(param: { id: string; displayName?: string }): boolean {
  const id = param.id.toLowerCase();
  if (id === "thinking" || id === "reasoning" || id === "effort") return true;
  const haystack = `${param.id} ${param.displayName ?? ""}`.toLowerCase();
  return /\b(reason|think|effort)\b/.test(haystack);
}

export function cursorReasoningOptionsForModel(
  models: CursorModel[] | undefined,
  selectedModel: string,
): CursorReasoningOptions {
  const empty: CursorReasoningOptions = { options: [], currentLabel: null, title: "Thinking" };
  const base = cursorBaseModelSlug(selectedModel);
  const model = models?.find((m) => cursorBaseModelSlug(m.slug) === base || m.slug === selectedModel);
  if (!model) return empty;

  const reasoningParam = model.parameters?.find(isReasoningParam);
  if (!reasoningParam || reasoningParam.values.length === 0) return empty;

  const current = cursorModelParamValue(selectedModel, reasoningParam.id);
  const options = reasoningParam.values.map((value) => ({
    slug: cursorSlugWithParam(selectedModel || model.slug, reasoningParam.id, value.value),
    label: prettyCursorParamValueLabel(value.value, value.displayName),
  }));
  const booleanToggle =
    options.length >= 2 && options.every((option) => option.label === "Off" || option.label === "On");
  return {
    options,
    currentLabel:
      options.find((option) => cursorModelParamValue(option.slug, reasoningParam.id) === current)
        ?.label ?? null,
    title: reasoningParam.displayName ?? "Thinking",
    ...(booleanToggle
      ? {
          minLabel: options[0]?.label,
          maxLabel: options[options.length - 1]?.label,
        }
      : {}),
  };
}
