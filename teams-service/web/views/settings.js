/* Team settings — roster, invites, groups, policy, leaderboard.
   Layout mirrors Plan: tight page width, hero summary, labeled sections. */

import { esc, fmtDate, html, raw } from "../dom.js";
import { avatar, inviteCard, roleBadge, syncPillHtml } from "../components.js";
import { leaderboardSettingsPanel } from "./leaderboard.js";

export function teamSettings({
  team,
  role,
  members,
  invite,
  groups = [],
  managerScopes = [],
  leaderboard = null,
  leaderboardRepos = null,
}) {
  const isOwner = role === "owner";
  const counts = members.reduce(
    (acc, m) => ({ ...acc, [m.role]: (acc[m.role] ?? 0) + 1 }),
    {},
  );
  const scopeByUser = new Map(managerScopes.map((s) => [s.userId, s]));
  const managers = counts.manager ?? 0;
  const employees = counts.employee ?? 0;
  const inviteActive = invite?.state === "active";

  return html`
    <section class="page settings-page">
      <div class="phead set-phead">
        <div>
          <p class="eyeb">Administration</p>
          <h1>${role === "employee" ? "Members" : "Settings"}</h1>
          <div class="meta">
            <span>${esc(team.name)}</span>
            <span style="color:var(--t5)">·</span>
            <span
              >${members.length} ${members.length === 1 ? "member" : "members"}</span
            >
            ${
              isOwner
                ? raw(
                    `<span style="color:var(--t5)">·</span><a href="#/t/${encodeURIComponent(team.slug)}/plan" class="meta-link">Plan →</a>`,
                  )
                : ""
            }
          </div>
        </div>
        <div class="sp"></div>
        ${
          !isOwner
            ? raw(`<span class="pill">Roster · owner managed</span>`)
            : raw(
                `<a class="btn" href="#/t/${encodeURIComponent(team.slug)}/plan"><i data-lucide="credit-card"></i>Plan</a>`,
              )
        }
      </div>

      ${
        isOwner
          ? ""
          : raw(
              `<div class="banner set-ro-banner"><i data-lucide="lock"></i><div>Roster settings are read only. Only the team owner can rename the team, manage invites, groups, or change roles and scopes.</div></div>`,
            )
      }

      <div class="set-summary">
        <dl class="set-kpis">
          <div>
            <dt>Members</dt>
            <dd>${members.length}</dd>
          </div>
          <div>
            <dt>Managers</dt>
            <dd>${managers}</dd>
          </div>
          <div>
            <dt>Employees</dt>
            <dd>${employees}</dd>
          </div>
          <div>
            <dt>Groups</dt>
            <dd>${groups.length}</dd>
          </div>
          <div>
            <dt>Invite</dt>
            <dd class="set-kpi-sm">${inviteActive ? "Active" : invite?.state ? esc(invite.state) : "None"}</dd>
          </div>
        </dl>
      </div>

      <div class="set-stack">
        ${raw(teamAndInviteSection(team, invite, isOwner))}
        ${raw(membersSection(members, counts, scopeByUser, isOwner))}
        ${raw(groupsPanel(groups, members, isOwner))}
        ${raw(`<section class="set-card" aria-labelledby="set-restrictions-h">
          <header class="set-card-h">
            <div class="set-card-ico"><i data-lucide="shield"></i></div>
            <div class="set-card-h-main">
              <p class="eyeb">Workspace rules</p>
              <h2 id="set-restrictions-h">Restrictions</h2>
            </div>
            <a class="btn" href="#/t/${encodeURIComponent(team.slug)}/restrictions">Open restrictions</a>
          </header>
          <div class="set-card-b">
            <p class="hint" style="margin:0">Manage allowed session modes, agents, models and reasoning effort.</p>
          </div>
        </section>`)}
        ${
          isOwner
            ? raw(
                leaderboardSettingsPanel({
                  settings: leaderboard,
                  repos: leaderboardRepos,
                  isOwner,
                  teamSlug: team.slug,
                }),
              )
            : ""
        }
        ${isOwner ? raw(dangerSection()) : ""}
      </div>
    </section>
  `;
}

function teamAndInviteSection(team, invite, isOwner) {
  return html`
    <div class="set-grid-2">
      <section class="set-card" aria-labelledby="set-team-h">
        <header class="set-card-h">
          <div class="set-card-ico"><i data-lucide="building-2"></i></div>
          <div>
            <p class="eyeb">Workspace</p>
            <h2 id="set-team-h">Team</h2>
          </div>
        </header>
        <div class="set-card-b">
          <label class="lbl" for="tn2">Display name</label>
          <div class="set-inline">
            <input
              class="input"
              id="tn2"
              value="${esc(team.name)}"
              ${isOwner ? "" : "disabled"}
              autocomplete="organization"
            />
            ${isOwner ? raw('<button class="btn primary" data-act="rename">Save</button>') : ""}
          </div>
          <p class="hint set-hint">Shown in the nav and invite flow. Rename anytime.</p>
        </div>
      </section>

      <section class="set-card" aria-labelledby="set-invite-h">
        <header class="set-card-h">
          <div class="set-card-ico"><i data-lucide="link"></i></div>
          <div class="set-card-h-main">
            <p class="eyeb">Access</p>
            <h2 id="set-invite-h">Invite link</h2>
          </div>
          ${raw(inviteStatePill(invite))}
        </header>
        ${raw(inviteCard(invite, { canManage: isOwner }))}
      </section>
    </div>
  `;
}

function membersSection(members, counts, scopeByUser, isOwner) {
  return html`
    <section class="set-card set-card-wide" aria-labelledby="set-members-h">
      <header class="set-card-h">
        <div class="set-card-ico"><i data-lucide="users"></i></div>
        <div class="set-card-h-main">
          <p class="eyeb">Roster</p>
          <h2 id="set-members-h">Members</h2>
        </div>
        <span class="sub"
          >${members.length} · ${counts.owner ?? 0} owner · ${counts.manager ?? 0} manager ·
          ${counts.employee ?? 0} employee${(counts.employee ?? 0) === 1 ? "" : "s"}</span
        >
      </header>
      <div class="tbl-scroll">
        <table class="tbl set-tbl">
          <thead>
            <tr>
              <th>Member</th>
              <th>Joined</th>
              <th>Last sync</th>
              <th>Role</th>
              <th>Manages</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${members.map((m) => memberRow(m, isOwner, scopeByUser.get(m.user_id)))}
          </tbody>
        </table>
      </div>
      ${
        isOwner
          ? raw(
              `<div class="set-card-foot">
                <p class="hint" style="margin:0">
                  Managers default to the <b style="color:var(--t3)">entire team</b>. Use
                  <b style="color:var(--t3)">Edit scope</b> to limit a manager to groups and/or people.
                </p>
              </div>`,
            )
          : ""
      }
    </section>
  `;
}

function dangerSection() {
  return html`
    <section class="set-card set-card-danger" aria-labelledby="set-danger-h">
      <header class="set-card-h">
        <div class="set-card-ico danger"><i data-lucide="triangle-alert"></i></div>
        <div>
          <p class="eyeb">Irreversible</p>
          <h2 id="set-danger-h">Danger zone</h2>
        </div>
      </header>
      <div class="set-card-b">
        <div class="set-row">
          <div class="sp">
            <div class="t">Delete team</div>
            <div class="d">
              Permanently removes every member and all uploaded aggregates. This cannot be undone.
            </div>
          </div>
          <button class="btn danger" data-act="delete">
            <i data-lucide="trash-2"></i>Delete team
          </button>
        </div>
      </div>
    </section>
  `;
}

function groupsPanel(groups, members, isOwner) {
  const body =
    groups.length === 0
      ? `<div class="set-empty">
          <i data-lucide="folder-tree"></i>
          <p>No groups yet. Create ones like “Platform” or “Design”, then assign them under Manages.</p>
        </div>`
      : `<div class="group-list">
          ${groups
            .map((g) => {
              const n = g.member_count ?? 0;
              const countLabel = n === 1 ? "1 member" : `${n} members`;
              return `
            <div class="group-row" data-group-id="${esc(g.id)}">
              <div class="group-row-main">
                <div class="nm">${esc(g.name)}</div>
                <div class="meta">${countLabel}</div>
              </div>
              ${
                isOwner
                  ? `<div class="acts">
                       <button class="btn" data-act="group-edit" data-group-id="${esc(g.id)}">Edit</button>
                       <button class="btn" data-act="group-rename" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}">Rename</button>
                       <button class="btn danger" data-act="group-delete" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}">Delete</button>
                     </div>`
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>`;

  return html`
    <section class="set-card set-card-wide" aria-labelledby="set-groups-h">
      <header class="set-card-h">
        <div class="set-card-ico"><i data-lucide="folders"></i></div>
        <div class="set-card-h-main">
          <p class="eyeb">Structure</p>
          <h2 id="set-groups-h">Groups</h2>
        </div>
        ${
          groups.length
            ? raw(
                `<span class="sub">${groups.length} ${groups.length === 1 ? "group" : "groups"}</span>`,
              )
            : ""
        }
        ${
          isOwner
            ? raw(
                '<button class="btn primary" data-act="group-create"><i data-lucide="plus"></i>New group</button>',
              )
            : ""
        }
      </header>
      <div class="set-card-b">${raw(body)}</div>
      ${
        isOwner && members.length
          ? raw(
              `<div class="set-card-foot">
                <p class="hint" style="margin:0">
                  Named sets of people. Scope a manager to a group (or individuals) from
                  <b style="color:var(--t3)">Manages</b> in the members table.
                </p>
              </div>`,
            )
          : ""
      }
    </section>
  `;
}

function inviteStatePill(invite) {
  if (!invite)
    return '<span class="pill"><span class="dot" style="background:var(--t5)"></span>none</span>';
  if (invite.state === "active")
    return '<span class="pill ok"><span class="dot"></span>active</span>';
  return `<span class="pill err"><span class="dot"></span>${esc(invite.state)}</span>`;
}

function memberRow(m, isOwner, scope) {
  const isTeamOwner = m.role === "owner";
  const roleCell =
    isOwner && !isTeamOwner
      ? html`<select class="rolesel" data-role-for="${m.user_id}">
          <option value="employee" ${m.role === "employee" ? "selected" : ""}>employee</option>
          <option value="manager" ${m.role === "manager" ? "selected" : ""}>manager</option>
        </select>`
      : roleBadge(m.role);

  const managesCell =
    m.role === "manager"
      ? scopeLabel(scope, isOwner, m.user_id)
      : m.role === "owner"
        ? '<span class="dim">Entire team</span>'
        : '<span class="dim">—</span>';

  const action = isTeamOwner
    ? '<span class="pill">Owner</span>'
    : isOwner
      ? `<button class="btn danger" data-remove="${esc(m.user_id)}">Remove</button>`
      : "";

  return html`
    <tr>
      <td>
        <div class="who">
          ${raw(avatar(m.display_name, m.avatar_color, null, m.avatar_url))}
          <div>
            <div class="nm">${esc(m.display_name)}</div>
            <div class="hd">${esc(m.email ?? (m.handle ? "@" + m.handle : ""))}</div>
          </div>
        </div>
      </td>
      <td class="dim">${fmtDate(m.joined_at)}</td>
      <td>${raw(syncPillHtml(m.last_upload_at))}</td>
      <td>${raw(roleCell)}</td>
      <td>${raw(managesCell)}</td>
      <td class="set-tbl-act">${raw(action)}</td>
    </tr>
  `;
}

function scopeLabel(scope, isOwner, userId) {
  const label = scope?.label ?? "Entire team";
  const mode = scope?.mode ?? "team";
  const pill =
    mode === "team"
      ? `<span class="pill ok"><span class="dot"></span>${esc(label)}</span>`
      : `<span class="pill"><span class="dot" style="background:var(--accent)"></span>${esc(label)}</span>`;
  if (!isOwner) return pill;
  return `<div class="set-scope-cell">${pill}<button class="btn" data-act="scope-edit" data-user-id="${esc(userId)}">Edit scope</button></div>`;
}

/**
 * One modal for group create/edit (or people-only).
 * Optional `nameValue` shows a name field so we never stack a window.prompt
 * before this dialog (that felt like the name popup twice).
 *
 * Returns { name?, userIds, groupIds } or null if cancelled.
 */
export function pickPeopleDialog({
  title,
  members,
  selectedIds = [],
  groups = [],
  selectedGroupIds = [],
  nameValue = null,
  namePlaceholder = "e.g. Platform, Design",
  nameLabel = "Group name",
  saveLabel = "Save",
}) {
  return new Promise((resolve) => {
    // Only one of these dialogs at a time.
    document.querySelector(".modal-overlay")?.remove();

    const showName = nameValue !== null && nameValue !== undefined;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true" style="max-width:440px;width:92vw">
        <div class="pnl-h" style="border:0;padding:0 0 12px">
          <h3 style="margin:0">${title}</h3>
        </div>
        ${
          showName
            ? raw(`
          <div style="margin-bottom:14px">
            <label class="lbl" for="grp-name">${esc(nameLabel)}</label>
            <input class="input" id="grp-name" value="${esc(nameValue)}" placeholder="${esc(
              namePlaceholder,
            )}" autocomplete="off" style="width:100%;margin-top:6px" />
          </div>`)
            : ""
        }
        ${
          groups.length
            ? raw(`
          <div style="margin-bottom:14px">
            <div class="lbl" style="margin-bottom:6px">Groups</div>
            <div class="pick-list short">
              ${groups
                .map((g) => {
                  const n = g.member_count ?? 0;
                  return `
                <label class="pick">
                  <input type="checkbox" data-group-pick="${esc(g.id)}" ${
                    selectedGroupIds.includes(g.id) ? "checked" : ""
                  } />
                  <span class="nm">${esc(g.name)}</span>
                  <span class="meta">${n === 1 ? "1 member" : `${n} members`}</span>
                </label>`;
                })
                .join("")}
            </div>
          </div>`)
            : ""
        }
        ${
          members.length
            ? raw(`
        <div class="lbl" style="margin-bottom:6px">${groups.length ? "People (optional extras)" : "People"}</div>
        <div class="pick-list" style="margin-bottom:16px">
          ${members
            .map(
              (m) => `
            <label class="pick">
              <input type="checkbox" data-user-pick="${esc(m.user_id)}" ${
                selectedIds.includes(m.user_id) ? "checked" : ""
              } />
              <span class="nm">${esc(m.display_name)}</span>
              <span class="meta">${esc(m.role)}</span>
            </label>`,
            )
            .join("")}
        </div>`)
            : raw(
                showName
                  ? ""
                  : '<p class="hint" style="margin:0 0 16px">No people on this team yet.</p>',
              )
        }
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" type="button" data-pick="cancel">Cancel</button>
          <button class="btn primary" type="button" data-pick="ok">${esc(saveLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector("#grp-name");
    if (nameInput) {
      // Focus after paint so Safari doesn't fight the opening click.
      requestAnimationFrame(() => {
        nameInput.focus();
        nameInput.select();
      });
    }

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelector('[data-pick="cancel"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    });
    overlay.querySelector('[data-pick="ok"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const userIds = [...overlay.querySelectorAll("[data-user-pick]:checked")].map((el) =>
        el.getAttribute("data-user-pick"),
      );
      const groupIds = [...overlay.querySelectorAll("[data-group-pick]:checked")].map((el) =>
        el.getAttribute("data-group-pick"),
      );
      if (showName) {
        const name = (nameInput?.value ?? "").trim();
        if (!name) {
          nameInput?.focus();
          return;
        }
        close({ name, userIds, groupIds });
        return;
      }
      close({ userIds, groupIds });
    });
  });
}

/**
 * Scope editor: Entire team vs custom groups/people.
 */
export function editScopeDialog({ memberName, members, groups, current }) {
  return new Promise((resolve) => {
    document.querySelector(".modal-overlay")?.remove();
    const mode = current?.mode === "custom" ? "custom" : "team";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true" style="max-width:460px;width:92vw">
        <div class="pnl-h" style="border:0;padding:0 0 8px">
          <h3 style="margin:0">Who ${esc(memberName)} manages</h3>
        </div>
        <p class="hint" style="margin:0 0 14px">
          Entire team sees everyone. Custom mixes groups and specific people freely — the manager
          always sees their own stats too.
        </p>
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px">
          <label class="pick">
            <input type="radio" name="scope-mode" value="team" ${mode === "team" ? "checked" : ""} />
            <span class="nm">Entire team</span>
            <span class="meta">default</span>
          </label>
          <label class="pick">
            <input
              type="radio"
              name="scope-mode"
              value="custom"
              ${mode === "custom" ? "checked" : ""}
            />
            <span class="nm">Specific groups and people</span>
          </label>
        </div>
        <div id="scope-custom" ${mode === "custom" ? "" : "hidden"}>
          ${
            groups.length
              ? raw(`
            <div class="lbl" style="margin-bottom:6px">Groups</div>
            <div class="pick-list short" style="margin-bottom:12px">
              ${groups
                .map((g) => {
                  const n = g.member_count ?? 0;
                  return `
                <label class="pick">
                  <input type="checkbox" data-scope-group="${esc(g.id)}" ${
                    (current?.groupIds ?? []).includes(g.id) ? "checked" : ""
                  } />
                  <span class="nm">${esc(g.name)}</span>
                  <span class="meta">${n === 1 ? "1 member" : `${n} members`}</span>
                </label>`;
                })
                .join("")}
            </div>`)
              : raw(
                  '<p class="hint" style="margin:0 0 12px">No groups yet — pick people below, or create a group first.</p>',
                )
          }
          <div class="lbl" style="margin-bottom:6px">People</div>
          <div class="pick-list" style="max-height:180px;margin-bottom:16px">
            ${raw(
              members
                .map(
                  (m) => `
              <label class="pick">
                <input type="checkbox" data-scope-user="${esc(m.user_id)}" ${
                  (current?.userIds ?? []).includes(m.user_id) ? "checked" : ""
                } />
                <span class="nm">${esc(m.display_name)}</span>
                <span class="meta">${esc(m.role)}</span>
              </label>`,
                )
                .join(""),
            )}
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" data-scope="cancel">Cancel</button>
          <button class="btn primary" data-scope="ok">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const customBox = overlay.querySelector("#scope-custom");
    overlay.querySelectorAll('input[name="scope-mode"]').forEach((r) => {
      r.addEventListener("change", () => {
        customBox.hidden =
          overlay.querySelector('input[name="scope-mode"]:checked')?.value !== "custom";
      });
    });

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelector('[data-scope="cancel"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    });
    overlay.querySelector('[data-scope="ok"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const modeVal = overlay.querySelector('input[name="scope-mode"]:checked')?.value ?? "team";
      if (modeVal === "team") {
        close({ mode: "team" });
        return;
      }
      const userIds = [...overlay.querySelectorAll("[data-scope-user]:checked")].map((el) =>
        el.getAttribute("data-scope-user"),
      );
      const groupIds = [...overlay.querySelectorAll("[data-scope-group]:checked")].map((el) =>
        el.getAttribute("data-scope-group"),
      );
      close({ mode: "custom", userIds, groupIds });
    });
  });
}
