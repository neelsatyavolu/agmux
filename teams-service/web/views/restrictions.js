import { esc, icons } from "../dom.js";

const sections = [
  ["allowedModes", "Session modes", "Choose where your team can start work. Any model or effort restriction makes terminals unavailable, even if Terminal is checked, because terminal agents choose these values internally.", [["chat", "Chat", "Conversations in agmux"], ["terminal", "Terminal", "Agent terminal sessions"]]],
  ["allowedProviders", "Agents", "Choose which agents your team can use.", ["ClaudeCode", "Codex", "Grok", "OpenCode", "Cursor", "Kimi", "Pi", "Droid", "Cline", "Gemini", "Hermes", "MLX"].map(p => [p, p === "ClaudeCode" ? "Claude" : p])],
  ["allowedModels", "Models", "Allow only these selected model IDs, one per line. IDs are exact and case-sensitive. No wildcards or display-name matching. Provider-routed IDs must include their full prefix.", null],
  ["allowedEfforts", "Reasoning effort", "Choose the reasoning effort settings your team can select. Availability varies by agent and model.", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(e => [e, e])],
];

export function restrictionsPage(team) {
  return `<section class="page restrictions-page">
    <div class="phead"><div><p class="eyeb">Workspace rules</p><h1>Restrictions</h1>
      <div class="meta">${esc(team.name)}</div></div></div>
    ${restrictionsLoading()}
  </section>`;
}

export function restrictionsLoading() {
  return '<section id="restrictions" class="set-card restrictions" aria-label="Restrictions"><div class="set-card-b" role="status">Loading restrictions…</div></section>';
}

export function restrictionsSummary(policy) {
  const summary = sections.map(([key, label]) => {
    const values = policy[key];
    return `${label}: ${values === null ? "unrestricted" : values.length ? values.join(", ") : "deny all"}`;
  }).join(" · ");
  return summary + (policy.allowedModels !== null || policy.allowedEfforts !== null ? " · Terminals unavailable: a model or effort rule is set." : "");
}

export function restrictionsPanel(data) {
  const { policy, editablePolicy, canManage, scopeLabel } = data;
  const layer = editablePolicy || policy;
  return `<header class="set-card-h"><div class="set-card-ico"><i data-lucide="shield-check"></i></div>
    <div class="set-card-h-main"><p class="eyeb">Workspace rules</p><h2>Restrictions</h2></div>
    <span class="pill">${canManage ? "Editable" : "Read only"}</span></header>
    <div class="set-card-b">
      <div class="restriction-intro">
      <p class="restriction-scope">${esc(scopeLabel)}</p>
      <p class="hint">${editablePolicy && !("teamId" in editablePolicy) ? "Your rules can only narrow what the owner allows. They follow the people and groups you currently manage, covering active employees and yourself, never owners or other managers." : "The owner sets the team’s rules. Managers can add tighter rules for the employees they manage."}</p>
      <p class="hint">Applies to work started in agmux. It does not stop running turns or control external apps.</p>
      <details class="restriction-support"><summary>Supported restrictions</summary>
        <p>Claude and Codex support selected model and effort rules. Cursor, OpenCode and Local MLX support model rules only. For Local MLX, use the full model ID <code>local/&lt;id&gt;</code>, keeping the <code>local/</code> prefix. Local agents can run when MLX is the only allowed agent, subject to your other rules. Grok and Gemini cannot start work when a model or effort rule is set, until their settings can be reliably verified.</p>
        <p>These rules apply to the model and effort you select, not internal subagents. Terminals are unavailable whenever a model or effort rule is set.</p>
        <p>Everything is allowed by default. Linked desktops check rules before starting work, with a cache of up to 30 seconds. If saved restrictions cannot be verified, new work is blocked until the connection recovers.</p>
      </details>
      </div>
      <form data-restrictions-form>
        <fieldset class="restriction-fields" ${canManage ? "" : "disabled"}>
        ${sections.map(([key, label, hint, choices], index) => `<section class="restriction-section">
          <div class="restriction-heading"><div><span class="restriction-number">0${index + 1}</span><h3>${label}</h3></div>
          <label class="restriction-toggle"><input type="checkbox" data-unrestricted="${key}" ${layer[key] === null ? "checked" : ""}>Unrestricted</label></div>
          <p class="hint" id="${key}-hint">${hint}</p>
          ${choices ? `<div class="restriction-options ${key === "allowedModes" ? "restriction-modes" : ""}">${choices.map(([value, title, detail]) => `<label class="restriction-choice"><input type="checkbox" data-choice="${key}" value="${value}" ${layer[key]?.includes(value) ? "checked" : ""} ${layer[key] === null ? "disabled" : ""}><span><strong>${title}</strong>${detail ? `<small>${detail}</small>` : ""}</span></label>`).join("")}</div>` : `<textarea class="input restriction-models" data-models aria-label="Allowed model IDs" aria-describedby="${key}-hint" rows="4" spellcheck="false" placeholder="One exact model ID per line" ${layer[key] === null ? "disabled" : ""}>${esc((layer[key] || []).join("\n"))}</textarea>`}
          <p class="hint restriction-empty" data-empty="${key}">${layer[key] === null ? "All values allowed by this layer." : layer[key].length ? `${layer[key].length} selected.` : "None selected — this layer denies all."}</p>
        </section>`).join("")}
        </fieldset>
        <div class="restriction-review"><p class="eyeb">${canManage ? "Review before saving" : "Your effective restrictions"}</p><p data-restrictions-summary>${esc(restrictionsSummary(layer))}</p>
        ${canManage ? `<details><summary>Your current effective restrictions</summary><p>${esc(restrictionsSummary(policy))}</p></details>` : ""}</div>
        <div class="set-actions"><p class="hint" role="status" data-restrictions-status></p>${canManage ? '<button type="submit" class="btn primary" disabled>Save restrictions</button>' : ""}</div>
      </form>
    </div>`;
}

export function readRestrictions(form) {
  return Object.fromEntries(sections.map(([key]) => [key,
    form.querySelector(`[data-unrestricted="${key}"]`).checked ? null : key === "allowedModels"
      ? form.querySelector("[data-models]").value.split("\n").map(s => s.trim()).filter(Boolean)
      : [...form.querySelectorAll(`[data-choice="${key}"]:checked`)].map(el => el.value),
  ]));
}

export async function mountRestrictions(root, api, slug) {
  if (!root) return;
  try {
    const data = await api.getPolicy(slug);
    if (data.enforcementVersion !== 2) throw new Error("Restrictions require an updated Teams service.");
    if (!root.isConnected) return;
    render(data);
  } catch (error) {
    if (!root.isConnected) return;
    root.innerHTML = `<div class="set-card-b"><h2>Restrictions</h2><p role="alert">${esc(error.message || "Could not load restrictions.")}</p><button class="btn" data-restrictions-retry>Try again</button></div>`;
    root.querySelector("[data-restrictions-retry]").onclick = () => mountRestrictions(root, api, slug);
  }

  function render(data, saved = false) {
    root.innerHTML = restrictionsPanel(data);
    icons();
    const form = root.querySelector("form");
    const save = form.querySelector('button[type="submit"]');
    if (!save) return;
    const initial = JSON.stringify(readRestrictions(form));
    const status = form.querySelector("[data-restrictions-status]");
    if (saved) status.textContent = "Restrictions saved.";
    let saving = false;
    const update = () => {
      const draft = readRestrictions(form);
      for (const [key] of sections) {
        form.querySelectorAll(`[data-choice="${key}"]${key === "allowedModels" ? ", [data-models]" : ""}`).forEach(el => { el.disabled = draft[key] === null; });
        form.querySelector(`[data-empty="${key}"]`).textContent = draft[key] === null ? "All values allowed by this layer." : draft[key].length ? `${draft[key].length} selected.` : "None selected — this layer denies all.";
      }
      form.querySelector("[data-restrictions-summary]").textContent = restrictionsSummary(draft);
      const models = draft.allowedModels;
      const invalid = models && (models.length > 128 || new Set(models).size !== models.length || models.some(m => m.length > 200 || /[\x00-\x1f]/.test(m)));
      status.textContent = invalid ? "Use up to 128 unique model IDs, each at most 200 characters." : "";
      save.disabled = saving || !!invalid || JSON.stringify(draft) === initial;
    };
    form.addEventListener("input", update);
    form.onsubmit = async event => {
      event.preventDefault();
      if (save.disabled || saving) return;
      const draft = readRestrictions(form);
      saving = true;
      save.disabled = true;
      form.querySelector("fieldset").disabled = true;
      save.textContent = "Saving…";
      status.textContent = "Saving restrictions…";
      try {
        const result = await api.putPolicy(slug, draft);
        if (result.enforcementVersion !== 2) throw new Error("The service returned an unsupported policy response. Reload to verify your changes.");
        if (root.isConnected) render(result, true);
      } catch (error) {
        saving = false;
        form.querySelector("fieldset").disabled = false;
        save.textContent = "Save restrictions";
        update();
        status.textContent = error.message || "Could not save restrictions. Try again.";
        status.setAttribute("role", "alert");
      }
    };
  }
}
