/* Team Knowledge — records + digests + owner settings.
   Pilot MVP: safe shared decisions (not mini-Confluence). */

import { html, esc, raw } from "../dom.js";

const DISCLOSURE_TEXT = `Team Knowledge stores short summaries and decisions you choose to share — not full chat transcripts, diffs, or secrets by default.

What can be stored
• Team records (decisions, facts, issues) that members add or promote
• Session digests you explicitly share from the desktop app

What is not collected automatically
• Full prompts, replies, or tool output
• Absolute file paths or secret tokens (best-effort pattern filter blocks common leaks)

Agents
• Only read official records when an owner turns on agent access (MCP)
• Digests are never shown to agents in this phase

This is a design-partner pilot. One team is one disclosure boundary — every member who can open Knowledge can read team records and digests.`;

export function knowledgeView({ team, settings, overview, role, searchHits }) {
  const policy = settings?.policy ?? {};
  const access = settings?.access ?? "none";
  const mode = policy.knowledgeMode ?? "disabled";
  const isOwner = role === "owner";
  const canManage = role === "owner" || role === "manager";
  const records = overview?.records ?? [];
  const digests = overview?.digests ?? [];
  const disclosureOk = Boolean(settings?.disclosureAccepted);
  const hits = searchHits?.hits ?? null;

  if (settings?.planRequired) {
    return html`
      <section class="page knowledge-page">
        <header class="page-h"><div><p class="eyeb">Teams plan</p><h2>Knowledge</h2></div></header>
        <div class="pnl">
          <div class="empty">
            <h3>Team Knowledge needs a Teams plan</h3>
            <p>
              Shared decisions and session digests are on the Teams plan (or an active trial), not
              Free. Free teams keep analytics and budgets only.
            </p>
            ${isOwner
              ? raw(
                  `<p class="mt"><a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/plan">Open Plan</a></p>`,
                )
              : raw(`<p class="muted small">Ask the team owner to upgrade on the Plan tab.</p>`)}
          </div>
        </div>
      </section>
    `;
  }

  if (access === "none" && mode === "disabled") {
    return html`
      <section class="page knowledge-page">
        <header class="page-h"><div><p class="eyeb">Teams plan</p><h2>Knowledge</h2></div></header>
        <div class="pnl">
          <div class="empty">
            <h3>Team Knowledge is off</h3>
            <p>
              Shared decisions and session digests for your team. Included with agmux Teams.
              ${isOwner
                ? "Review the disclosure, then enable Knowledge to start collecting team context."
                : "Ask a team owner to enable Knowledge in settings."}
            </p>
            ${isOwner && !disclosureOk
              ? raw(disclosurePanel())
              : isOwner
                ? raw(html`<button class="btn primary" data-kw-enable>Enable Team Knowledge</button>`)
                : ""}
          </div>
        </div>
        ${isOwner ? raw(settingsPanel(policy, true, disclosureOk)) : ""}
      </section>
    `;
  }

  const recordsBlock =
    hits != null
      ? hits.length
        ? html`<ul class="list">
            ${hits.map(
              (h) => html`<li class="list-row">
                <div>
                  <strong>${esc(h.title)}</strong>
                  <div class="muted small">
                    ${esc(h.kind)}${h.recordKind ? ` · ${esc(h.recordKind)}` : ""}${h.authority
                      ? ` · ${esc(h.authority)}`
                      : ""}
                  </div>
                </div>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted pad">No matches.</p>`
      : records.length
        ? html`<ul class="list">
            ${records.map(
              (r) => html`<li class="list-row">
                <div>
                  <strong>${esc(r.title)}</strong>
                  <div class="muted small">
                    ${esc(r.kind)} · ${esc(r.authority)}${r.important ? " · important" : ""}${r.createdByName
                      ? ` · ${esc(r.createdByName)}`
                      : ""}
                  </div>
                  <p class="clip">${esc((r.content || "").slice(0, 240))}</p>
                </div>
                <div class="row gap">
                  ${canManage && r.authority !== "official"
                    ? raw(html`<button class="btn small" data-kw-verify="${esc(r.id)}">Make official</button>`)
                    : ""}
                  ${canManage
                    ? raw(html`<button class="btn small danger" data-kw-delete="${esc(r.id)}">Delete</button>`)
                    : ""}
                </div>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted pad">No records yet. Promote from a session share or add one below.</p>`;

  const digestsBlock = digests.length
    ? html`<ul class="list">
        ${digests.map(
          (d) => html`<li class="list-row">
            <div>
              <strong>${esc(d.title)}</strong>
              <div class="muted small">${esc(d.createdAt?.slice?.(0, 10) || "")}</div>
              <p class="clip">${esc((d.summary || "").slice(0, 200))}</p>
            </div>
            <button
              class="btn small"
              data-kw-promote-title="${esc(d.title)}"
              data-kw-promote-body="${esc((d.decisions && d.decisions[0]) || d.summary || d.title)}"
            >
              Promote
            </button>
          </li>`,
        )}
      </ul>`
    : html`<p class="muted pad">No digests yet. Share a session from the desktop app.</p>`;

  return html`
    <section class="page knowledge-page">
      <header class="page-h">
        <div>
          <h2>Knowledge</h2>
          <p class="muted">
            Shared decisions for ${esc(team.name)}. Agents only read
            <strong>official</strong> records when MCP is on. Digests stay web-only.
          </p>
        </div>
        <div class="row gap">
          <span class="pill">${esc(mode === "full" ? "Full" : mode === "read_only" ? "Read only" : mode)}</span>
          ${policy.knowledgeMcpEnabled
            ? raw(html`<span class="pill">MCP on</span>`)
            : raw(html`<span class="pill muted">MCP off</span>`)}
          ${isOwner
            ? raw(html`<button class="btn small" data-kw-export>Export</button>`)
            : ""}
        </div>
      </header>

      ${!disclosureOk
        ? raw(html`<div class="pnl mb">${raw(disclosurePanel())}</div>`)
        : ""}

      <form class="pnl pad mb" data-kw-search-form>
        <div class="row gap">
          <input
            class="input"
            name="q"
            type="search"
            placeholder="Search records and digests…"
            maxlength="200"
            value="${esc(searchHits?.q || "")}"
            style="flex:1"
          />
          <button class="btn" type="submit">Search</button>
          ${hits != null
            ? raw(html`<button class="btn" type="button" data-kw-clear-search>Clear</button>`)
            : ""}
        </div>
      </form>

      <div class="grid2">
        <div class="pnl">
          <div class="pnl-h"><h3>Records</h3></div>
          ${raw(recordsBlock)}

          <form class="pad kw-form" data-kw-record-form>
            <h4>Add record</h4>
            <div>
              <label class="lbl" for="kw-kind">Kind</label>
              <select class="input" id="kw-kind" name="kind">
                <option value="decision">Decision</option>
                <option value="fact">Fact</option>
                <option value="issue">Issue</option>
              </select>
            </div>
            <div>
              <label class="lbl" for="kw-title">Title</label>
              <input class="input" id="kw-title" name="title" required maxlength="200" />
            </div>
            <div>
              <label class="lbl" for="kw-content">Content</label>
              <textarea class="input" id="kw-content" name="content" required maxlength="12000" rows="3"></textarea>
            </div>
            <p class="muted small">Best-effort filter blocks common secrets and absolute paths — not a full scanner.</p>
            <div><button class="btn primary" type="submit">Save record</button></div>
          </form>
        </div>

        <div class="pnl">
          <div class="pnl-h"><h3>Recent digests</h3></div>
          ${raw(digestsBlock)}

          ${isOwner ? raw(settingsPanel(policy, false, disclosureOk)) : ""}
        </div>
      </div>
    </section>
  `;
}

function disclosurePanel() {
  return html`
    <div class="pad" data-kw-disclosure>
      <h3>Before you share</h3>
      <pre class="kw-disclosure">${esc(DISCLOSURE_TEXT)}</pre>
      <button class="btn primary" data-kw-accept-disclosure>I understand — accept</button>
    </div>
  `;
}

function settingsPanel(policy, compact, disclosureOk) {
  return html`
    <div class="pnl ${compact ? "" : "mt"}">
      <div class="pnl-h"><h3>Knowledge settings</h3></div>
      <form class="pad kw-form" data-kw-settings-form>
        ${!disclosureOk
          ? raw(html`<p class="muted small">Accept the disclosure above before enabling Knowledge or agent access.</p>`)
          : ""}
        <div>
          <label class="lbl" for="kw-mode">Mode</label>
          <select class="input" id="kw-mode" name="knowledgeMode">
            <option value="disabled" ${policy.knowledgeMode === "disabled" ? "selected" : ""}>Off</option>
            <option value="read_only" ${policy.knowledgeMode === "read_only" ? "selected" : ""}>Read only</option>
            <option value="full" ${policy.knowledgeMode === "full" ? "selected" : ""}>Full</option>
          </select>
        </div>
        <div>
          <label class="lbl" for="kw-share">Who can share digests</label>
          <select class="input" id="kw-share" name="shareRole">
            <option value="owner_only" ${policy.shareRole === "owner_only" ? "selected" : ""}>Owner only</option>
            <option value="manager_plus" ${policy.shareRole === "manager_plus" ? "selected" : ""}>Managers+</option>
            <option value="all" ${policy.shareRole === "all" ? "selected" : ""}>Everyone</option>
          </select>
        </div>
        <div>
          <label class="lbl" for="kw-edit">Who can edit records</label>
          <select class="input" id="kw-edit" name="editRecordsRole">
            <option value="manager_plus" ${policy.editRecordsRole === "manager_plus" ? "selected" : ""}>Managers+</option>
            <option value="all" ${policy.editRecordsRole === "all" ? "selected" : ""}>Everyone</option>
          </select>
        </div>
        <label class="kw-check">
          <input type="checkbox" name="knowledgeMcpEnabled" ${policy.knowledgeMcpEnabled ? "checked" : ""} />
          <span>Allow agents to read team records (MCP)</span>
        </label>
        <div>
          <label class="lbl" for="kw-mcp-filter">Agent read scope</label>
          <select class="input" id="kw-mcp-filter" name="mcpAuthorityFilter">
            <option value="official_only" ${policy.mcpAuthorityFilter !== "official_and_member" ? "selected" : ""}>
              Official records only (recommended)
            </option>
            <option value="official_and_member" ${policy.mcpAuthorityFilter === "official_and_member" ? "selected" : ""}>
              Official + member records
            </option>
          </select>
        </div>
        <p class="muted small">Digests are never exposed to agents. Content is untrusted input even when official.</p>
        <div><button class="btn primary" type="submit">Save settings</button></div>
      </form>
    </div>
  `;
}

export function bindKnowledge(app, { api, teamKey, reload, toast, onSearch, onClearSearch }) {
  app.querySelector("[data-kw-accept-disclosure]")?.addEventListener("click", async () => {
    try {
      await api.knowledgeAcceptDisclosure(teamKey);
      toast("Disclosure accepted.");
      reload();
    } catch (e) {
      toast(e.message || "Failed");
    }
  });

  app.querySelector("[data-kw-enable]")?.addEventListener("click", async () => {
    try {
      await api.knowledgePatchSettings(teamKey, { knowledgeMode: "full" });
      toast("Team Knowledge enabled.");
      reload();
    } catch (e) {
      toast(e.message || "Failed");
    }
  });

  app.querySelector("[data-kw-export]")?.addEventListener("click", async () => {
    try {
      const data = await api.knowledgeExport(teamKey);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `knowledge-${teamKey}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Export downloaded.");
    } catch (e) {
      toast(e.message || "Export failed");
    }
  });

  const searchForm = app.querySelector("[data-kw-search-form]");
  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = String(new FormData(searchForm).get("q") || "").trim();
    if (!q) {
      onClearSearch?.();
      return;
    }
    try {
      const hits = await api.knowledgeSearch(teamKey, q);
      onSearch?.(hits);
    } catch (err) {
      toast(err.message || "Search failed");
    }
  });
  app.querySelector("[data-kw-clear-search]")?.addEventListener("click", () => onClearSearch?.());

  const settingsForm = app.querySelector("[data-kw-settings-form]");
  settingsForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(settingsForm);
    try {
      await api.knowledgePatchSettings(teamKey, {
        knowledgeMode: fd.get("knowledgeMode"),
        shareRole: fd.get("shareRole"),
        editRecordsRole: fd.get("editRecordsRole"),
        knowledgeMcpEnabled: fd.get("knowledgeMcpEnabled") === "on",
        mcpAuthorityFilter: fd.get("mcpAuthorityFilter"),
      });
      toast("Settings saved.");
      reload();
    } catch (err) {
      toast(err.message || "Failed");
    }
  });

  const recordForm = app.querySelector("[data-kw-record-form]");
  recordForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(recordForm);
    try {
      await api.knowledgeCreateRecord(teamKey, {
        kind: fd.get("kind"),
        title: fd.get("title"),
        content: fd.get("content"),
      });
      toast("Record saved.");
      reload();
    } catch (err) {
      toast(err.message || "Failed");
    }
  });

  app.querySelectorAll("[data-kw-verify]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.knowledgeVerifyRecord(teamKey, btn.getAttribute("data-kw-verify"));
        toast("Marked official.");
        reload();
      } catch (err) {
        toast(err.message || "Failed");
      }
    });
  });

  app.querySelectorAll("[data-kw-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this record? Managers can purge permanently later if needed.")) return;
      try {
        await api.knowledgeDeleteRecord(teamKey, btn.getAttribute("data-kw-delete"));
        toast("Record deleted.");
        reload();
      } catch (err) {
        toast(err.message || "Failed");
      }
    });
  });

  app.querySelectorAll("[data-kw-promote-title]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api.knowledgePromote(teamKey, {
          title: btn.getAttribute("data-kw-promote-title"),
          content: btn.getAttribute("data-kw-promote-body"),
          kind: "decision",
          from: "digest",
        });
        toast("Promoted to record.");
        reload();
      } catch (err) {
        toast(err.message || "Failed");
      }
    });
  });
}
