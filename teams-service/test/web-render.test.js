/**
 * Render smoke tests for the SPA views. These are string-templating functions,
 * so they run without a DOM — which makes the escaping and honest-state rules
 * cheap to pin down.
 */
import { describe, expect, it } from "vitest";
import { esc, html, raw } from "../web/dom.js";
import {
  mixRows,
  auditList,
  budgetCard,
  efficiencyGrid,
  memberTable,
  outputPanel,
  projectsTable,
  statCard,
  tokenBreakdown,
  toolMixPanel,
} from "../web/components.js";
import { teamHome } from "../web/views/team.js";
import { memberDetail } from "../web/views/member.js";
import { teamSettings } from "../web/views/settings.js";
import { teamPlan } from "../web/views/plan.js";
import { membersDirectory, sortMembers } from "../web/views/members.js";
import { privacy } from "../web/views/privacy.js";
import { teamHelp } from "../web/views/help.js";
import { landing } from "../web/views/landing.js";
import { disclosureBlock, NEVER, NEVER_SHORT, SHARED } from "../web/disclosure.js";
import {
  leaderboardView,
  memberDisplayName,
  prettifyHandle,
  sortLeaderboardRows,
  weekUtcToCustomRange,
} from "../web/views/leaderboard.js";
import { knowledgeView } from "../web/views/knowledge.js";

const emptyTotals = {
  tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, tokens: 0,
  cacheHitRate: 0, costUsd: 0, activeHours: 0, afterHoursShare: 0, weekendShare: 0,
  sessions: 0, turns: 0, toolCalls: 0, peakConcurrent: 0, daysWithData: 0,
  toolMix: { bash: 0, edit: 0, read: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
  toolErrors: 0, toolsMeasured: 0, toolErrorRate: null,
  filesChanged: 0, linesAdded: 0, linesRemoved: 0,
};

const totalsWith = (over) => ({ ...emptyTotals, ...over });

const day = (over = {}) => ({
  date: "2026-07-29", label: "7/29", full: "Wed, Jul 29",
  tokens: 1000, activeHours: 2, sessions: 3, peakConcurrent: 2,
  weekend: false, hasData: true, ...over,
});

const member = (over = {}) => ({
  userId: "u1", displayName: "Dani Okafor", handle: "dokafor", avatarColor: "#fbbf24", avatarUrl: null,
  role: "employee", lastUploadAt: new Date().toISOString(), neverSynced: false,
  joinedAt: "2026-04-09T00:00:00.000Z",
  totals: totalsWith({ activeHours: 29.5, tokens: 12_700_000, sessions: 68, turns: 455 }),
  ...over,
});

const overview = (over = {}) => ({
  range: "30d", scope: "team", role: "owner",
  totals: totalsWith({ tokens: 75_500_000, costUsd: 412.8, activeHours: 183.5, sessions: 426, turns: 2918, toolCalls: 7104, peakConcurrent: 11, daysWithData: 22 }),
  deltas: { tokens: 0.12, costUsd: 0.09, activeHours: null, sessions: 0.04 },
  daily: [day(), day({ hasData: false, tokens: 0, activeHours: 0, sessions: 0 })],
  heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)),
  providerMix: [{ key: "ClaudeCode", tokens: 100, share: 0.58 }],
  modelMix: [{ key: "claude-opus-4-6", tokens: 50, share: 0.44 }],
  projects: [{ projectKey: "helios-api", activeHours: 13.1, tokens: 5_900_000, sessions: 28 }],
  flags: { afterHoursShare: 0.18, afterHoursSharePrev: 0.11, weekendShare: 0.06, idleDays: 4 },
  members: [member()],
  memberCount: 8,
  lastUploadAt: new Date().toISOString(),
  from: "2026-07-01",
  to: "2026-07-30",
  ...over,
});

const team = { id: "tm1", slug: "helios-platform", name: "Helios Platform" };

/** Nothing should ever render a literal undefined/NaN/[object Object]. */
function assertClean(markup) {
  expect(markup).not.toMatch(/undefined/);
  expect(markup).not.toMatch(/\bNaN\b/);
  expect(markup).not.toMatch(/\[object Object\]/);
}

describe("html templating", () => {
  it("escapes interpolated values", () => {
    expect(html`<p>${'<img src=x onerror="alert(1)">'}</p>`).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
  });

  it("passes raw() through untouched", () => {
    expect(html`<p>${raw("<b>hi</b>")}</p>`).toBe("<p><b>hi</b></p>");
  });

  it("joins arrays without re-escaping nested templates", () => {
    expect(html`${[html`<li>a</li>`, html`<li>b</li>`]}`).toBe("<li>a</li><li>b</li>");
  });

  it("escapes a hostile team name where it lands in markup", () => {
    expect(esc('</h1><script>x()</script>')).not.toMatch(/<script>/);
  });
});

describe("statCard", () => {
  it("renders help markup once while escaping its text beside the delta", () => {
    const m = statCard({ icon: "receipt", label: "Partial est. cost", value: "5,370", delta: 156.16, help: "Missing <rates> & details" });
    expect(m).toContain('<div class="d"><span>Missing &lt;rates&gt; &amp; details</span></div>');
    expect(m).not.toContain("&lt;div");
    expect(m).not.toContain("&amp;lt;rates");
    expect(m).toContain("+15616%");
  });

  it("renders exactly one delta line, never two", () => {
    const m = statCard({ icon: "coins", label: "Tokens", value: "75.5", unit: "M", delta: 0.12, note: "ignored" });
    expect((m.match(/class="d/g) ?? []).length).toBe(1);
    expect(m).toContain("+12%");
    expect(m).not.toContain("ignored");
  });

  it("falls back to the note when there is no baseline to compare", () => {
    const m = statCard({ icon: "timer", label: "Active", value: "1.0", delta: null, note: "idle excluded" });
    expect(m).toContain("idle excluded");
    expect(m).not.toMatch(/[+-]\d+%/);
  });
});

describe("nested html fragments must not re-escape", () => {
  // Regression: .join("") on html`` fragments produced a plain string that the
  // outer template escaped, so Work rates / Projects rendered as raw markup.
  it("knowledgeView disabled owner state emits real button + settings form", () => {
    const m = knowledgeView({
      team: { name: "Helios Platform" },
      settings: {
        access: "none",
        disclosureAccepted: true,
        policy: {
          knowledgeMode: "disabled",
          shareRole: "manager_plus",
          editRecordsRole: "manager_plus",
          knowledgeMcpEnabled: false,
        },
      },
      overview: { records: [], digests: [] },
      role: "owner",
    });
    expect(m).toContain("Team Knowledge is off");
    expect(m).toContain('data-kw-enable');
    expect(m).toContain("Enable Team Knowledge");
    expect(m).toContain("data-kw-settings-form");
    expect(m).toContain("Knowledge settings");
    expect(m).toContain('class="lbl"');
    expect(m).toContain('class="input"');
    expect(m).toContain("kw-form");
    expect(m).toContain(">Off<");
    expect(m).toContain(">Managers+<");
    expect(m).not.toContain("&lt;button");
    expect(m).not.toContain("&lt;form");
    assertClean(m);
  });

  it("knowledgeView full state emits real record/digest lists", () => {
    const m = knowledgeView({
      team: { name: "Helios Platform" },
      settings: {
        access: "full",
        disclosureAccepted: true,
        policy: {
          knowledgeMode: "full",
          shareRole: "manager_plus",
          editRecordsRole: "manager_plus",
          knowledgeMcpEnabled: true,
        },
      },
      overview: {
        records: [
          {
            id: "r1",
            title: "Use npm",
            kind: "decision",
            authority: "proposed",
            important: true,
            content: "Always npm not yarn",
          },
        ],
        digests: [
          {
            title: "Session dig",
            summary: "Did stuff",
            createdAt: "2026-08-10T00:00:00Z",
            decisions: ["Use npm"],
          },
        ],
      },
      role: "owner",
    });
    expect(m).toContain("<ul class=\"list\">");
    expect(m).toContain("Use npm");
    expect(m).toContain('data-kw-verify="r1"');
    expect(m).toContain("data-kw-promote-title");
    expect(m).toContain("MCP on");
    expect(m).not.toContain("&lt;ul");
    expect(m).not.toContain("&lt;button");
    assertClean(m);
  });

  it("knowledgeView pending disclosure renders a real panel, not escaped tags", () => {
    const m = knowledgeView({
      team: { name: "nenu" },
      settings: {
        access: "full",
        disclosureAccepted: false,
        policy: {
          knowledgeMode: "full",
          shareRole: "manager_plus",
          editRecordsRole: "manager_plus",
          knowledgeMcpEnabled: false,
        },
      },
      overview: { records: [], digests: [] },
      role: "owner",
    });
    expect(m).toContain('data-kw-disclosure');
    expect(m).toContain("<h3>Before you share</h3>");
    expect(m).toContain('data-kw-accept-disclosure');
    expect(m).toContain("I understand — accept");
    expect(m).not.toContain("&lt;div");
    expect(m).not.toContain("&lt;h3");
    expect(m).not.toContain("&lt;pre");
    expect(m).not.toContain("&lt;button");
    assertClean(m);
  });

  it("efficiencyGrid emits real cells, not escaped tags", () => {
    const m = efficiencyGrid(
      totalsWith({ sessions: 10, turns: 80, toolCalls: 120, tokens: 1_000_000, activeHours: 5, costUsd: 10 }),
    );
    expect(m).toContain('class="eff-cell"');
    expect(m).toContain("Turns / active session-hour");
    expect(m).not.toContain("&lt;div");
    assertClean(m);
  });

  it("projectsTable emits real rows, not escaped tags", () => {
    const m = projectsTable([{ projectKey: "strix", activeHours: 8.7, tokens: 318_800_000, sessions: 235 }]);
    expect(m).toContain("<tr>");
    expect(m).toContain("strix");
    expect(m).toContain("8.7h");
    expect(m).not.toContain("&lt;tr");
    assertClean(m);
  });

  it("toolMixPanel and outputPanel emit real markup", () => {
    const t = totalsWith({
      toolCalls: 30,
      toolMix: { bash: 12, edit: 8, read: 6, search: 4, web: 0, agent: 0, mcp: 0, other: 0 },
      toolsMeasured: 30,
      toolErrors: 3,
      toolErrorRate: 0.1,
      filesChanged: 8,
      linesAdded: 420,
      linesRemoved: 96,
    });
    const mix = toolMixPanel(t);
    expect(mix).toContain("Terminal");
    expect(mix).toContain('class="tb-bar"');
    expect(mix).not.toContain("&lt;div");
    assertClean(mix);

    const out = outputPanel(t);
    expect(out).toContain("Files changed");
    expect(out).toContain("+420");
    expect(out).toContain("−96");
    expect(out).not.toContain("&lt;div");
    assertClean(out);
  });

  it("auditList emits real rows", () => {
    const m = auditList([
      {
        id: "a1",
        actor_name: "Ada Owner",
        action: "member.role_changed",
        target_name: "Eve Employee",
        detail: "employee → manager",
        created_at: new Date().toISOString(),
      },
    ]);
    expect(m).toContain('class="audit-row"');
    expect(m).toContain("Ada Owner");
    expect(m).toContain("changed a role");
    expect(m).toContain("Eve Employee");
    expect(m).toContain("employee → manager");
    expect(m).not.toContain("&lt;div");
    assertClean(m);
  });

  it("auditList humanizes billing/group actions and collapses bursts", () => {
    const t = new Date().toISOString();
    const m = auditList([
      {
        id: "b1",
        actor_user_id: "u1",
        actor_name: "Neel",
        action: "billing.checkout_started",
        target: null,
        detail: "month",
        created_at: t,
      },
      {
        id: "b2",
        actor_user_id: "u1",
        actor_name: "Neel",
        action: "billing.checkout_started",
        target: null,
        detail: "month",
        created_at: t,
      },
      {
        id: "b3",
        actor_user_id: "u1",
        actor_name: "Neel",
        action: "billing.checkout_started",
        target: null,
        detail: "month",
        created_at: t,
      },
      {
        id: "g1",
        actor_user_id: "u1",
        actor_name: "Neel",
        action: "group.created",
        target: "gid",
        detail: "India",
        created_at: t,
      },
      {
        id: "e1",
        actor_user_id: "u1",
        actor_name: "Neel",
        action: "data.exported",
        target: null,
        detail: "day CSV, 7d, 69 rows",
        created_at: t,
      },
    ]);
    expect(m).toContain("started checkout");
    expect(m).toContain("Monthly plan");
    expect(m).toContain("×3");
    expect(m).toContain("created group");
    expect(m).toContain("India");
    expect(m).not.toContain("billing.checkout_started");
    expect(m).not.toContain("group.created");
    expect(m).toContain("Day CSV · 7 days · 69 rows");
    // Three checkout rows collapsed → one row; total rows = 3.
    expect(m.match(/class="audit-row"/g)?.length).toBe(3);
    assertClean(m);
  });
});

describe("tool mix and output honesty", () => {
  it("says an unmeasurable failure rate is not reported, never 0%", () => {
    // Codex-only activity: calls happened and were classified (Codex exec ->
    // bash), but no outcome was ever recorded for them.
    const m = outputPanel(
      totalsWith({
        toolCalls: 50,
        toolMix: { bash: 50, edit: 0, read: 0, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
        toolsMeasured: 0,
        toolErrorRate: null,
      }),
    );
    expect(m).toContain("not reported");
    expect(m).toMatch(/Codex/);
    expect(m).not.toMatch(/Failure rate<\/div>\s*<div class="eff-v mono">0%/);
  });

  it("shows the measured denominator alongside the rate", () => {
    const m = outputPanel(totalsWith({ toolsMeasured: 200, toolErrors: 6, toolErrorRate: 0.03 }));
    expect(m).toContain("of 200");
  });

  it("says nothing at all when there is no tool activity", () => {
    expect(toolMixPanel(emptyTotals)).toContain("No tool activity");
  });

  // Buckets uploaded before the per-kind columns existed have tool_calls > 0
  // and every kind at 0. Claiming "no tool activity" directly under a header
  // reading "3,307 tool calls" is a contradiction the user can see.
  it("does not claim zero activity when only the breakdown is missing", () => {
    const legacy = totalsWith({ toolCalls: 3307 });
    const m = toolMixPanel(legacy);
    expect(m).not.toContain("No tool activity");
    expect(m).toContain("3,307");
    // The copy wraps in the template, so collapse whitespace before matching.
    expect(m.replace(/\s+/g, " ")).toMatch(/before the breakdown existed/);
  });

  it("does not print a grid of zeros for output that predates the counters", () => {
    const m = outputPanel(totalsWith({ toolCalls: 3307 }));
    expect(m.replace(/\s+/g, " ")).toContain("Not recorded for this range");
    expect(m).not.toContain("Files changed");
    expect(m).not.toContain("+0");
  });

  it("still shows real zeros when the counters genuinely recorded none", () => {
    // Read-only work: reads happened, nothing was edited. That 0 is a fact.
    const m = outputPanel(
      totalsWith({
        toolCalls: 40,
        toolMix: { bash: 0, edit: 0, read: 40, search: 0, web: 0, agent: 0, mcp: 0, other: 0 },
        toolsMeasured: 40,
        toolErrorRate: 0,
      }),
    );
    expect(m).toContain("Files changed");
    expect(m.replace(/\s+/g, " ")).not.toContain("Not recorded for this range");
  });
});

describe("tokenBreakdown", () => {
  it("shows reasoning as part of output, not as extra tokens", () => {
    // Reasoning is a reported subset of output: 400 in + 100 out = 500 tokens.
    const out = tokenBreakdown(totalsWith({ tokensIn: 400, tokensOut: 100, tokensReasoning: 60, tokens: 500 }));
    const rows = [...out.toString().matchAll(/<\/i>([^<]+)<\/span\s*>\s*<span class="tb-v">([^<]+)<\/span>\s*<span class="tb-p">([^<]+)<\/span>/g)]
      .map((m) => [m[1].trim(), m[2].trim(), m[3].trim()]);
    expect(rows).toEqual([
      ["Input", "400", "80%"],
      ["Output", "40", "8%"],
      ["Reasoning", "60", "12%"],
    ]);
  });
});

describe("budgetCard", () => {
  const budget = (over = {}) => ({
    month: "2026-07", monthlyUsd: 1000, spendUsd: 300, usedShare: 0.3,
    projectedUsd: 930, projectedShare: 0.93, daysElapsed: 10, daysInMonth: 31,
    onTrackToExceed: false, thresholds: [80, 100], hasWebhook: false, ...over,
  });

  it("renders spend, projection and the day counter", () => {
    const m = budgetCard(budget());
    expect(m).toContain("30%");
    expect(m).toContain("Day 10 of 31");
    expect(m).toContain("Projected");
    assertClean(m);
  });

  it("marks unknown budget estimates partial without a green under-budget signal", () => {
    const m = budgetCard(budget());
    expect(m).toContain("Partial estimate");
    expect(m).toContain("Missing prices or usage details are excluded; not an invoice.");
    expect(m).not.toContain("var(--green)");
    expect(budgetCard(budget({ costIncomplete: false }))).not.toContain("Partial estimate");
  });

  it("warns when the run rate would blow the budget", () => {
    const m = budgetCard(budget({ spendUsd: 500, usedShare: 0.5, projectedUsd: 1550, projectedShare: 1.55, onTrackToExceed: true }));
    expect(m).toContain("over the");
    expect(m).toContain("banner warn");
    assertClean(m);
  });

  it("renders nothing for a viewer who can't set one, rather than a $0 budget", () => {
    expect(budgetCard(null, { canManage: false })).toBe("");
    expect(budgetCard(null, { canManage: true })).toContain("Set a budget");
  });
});

describe("memberTable honest-state rule", () => {
  it("collapses a never-synced member into one sentence, not a row of zeros", () => {
    const m = memberTable([member({ neverSynced: true, lastUploadAt: null, totals: emptyTotals })]);
    expect(m).toContain("waiting for first sync");
    expect(m).toContain("never");
    // No zeroed metric cells masquerading as measurements.
    expect(m).not.toMatch(/<td class="n">0<\/td>/);
    assertClean(m);
  });

  it("renders full metrics for a synced member", () => {
    const m = memberTable([member()]);
    expect(m).toContain("29.5h");
    expect(m).toContain("12.7M");
    expect(m).not.toContain("waiting for first sync");
    assertClean(m);
  });
});

describe("team home", () => {
  it("labels incomplete and legacy costs as partial while keeping the help visible", () => {
    for (const flag of [undefined, true, false]) {
      const data = overview({ totals: totalsWith({ costUsd: 0, costIncomplete: flag }) });
      const markup = teamHome({ team, data, role: "owner" });
      expect(markup).toContain(flag === false ? "Est. cost" : "Partial est. cost");
      expect(markup).toContain("Missing prices or usage details are excluded; not an invoice.");
      if (flag === false) expect(markup).not.toContain("Partial est. cost");
    }
  });

  it("renders the full dashboard", () => {
    const m = teamHome({ team, data: overview(), role: "owner" });
    expect(m).toContain("Helios Platform");
    // Units live in a de-emphasised <small>, per the design's stat-card spec.
    expect(m).toContain("75.5<small>M</small>");
    expect(m).toContain("$412<small>.80</small>");
    expect(m).toContain('data-chart="daily"');
    expect(m).toContain('data-chart="heat"');
    expect(m).toContain('data-chart="conc"');
    expect(m).toContain("After-hours 18%");
    expect(m).toContain("4 idle days");
    // Provider/model ids are prettified for display.
    expect(m).toContain("Claude Code");
    expect(m).toContain("Claude Opus 4.6");
    expect(m).not.toContain(">ClaudeCode<");
    // Manager-useful panels that fill the page.
    expect(m).toContain("Token composition");
    expect(m).toContain("Work rates");
    expect(m).toContain("helios-api");
    // Range control uses human labels + a Custom option.
    expect(m).toContain("7 days");
    expect(m).toContain("Custom");
    assertClean(m);
  });

  // A CSS grid row is as tall as its TALLEST cell, so pairing a short chart
  // with a tall list left hundreds of pixels of dead space underneath. The
  // wide charts are now full-width and every card-like panel flows in a
  // masonry — putting any of them back in a fixed row reintroduces the holes.
  it("keeps the analytics panels in a flow, not fixed grid rows", () => {
    const m = teamHome({ team, data: overview(), role: "owner" });
    expect(m).toMatch(/class="flow(\s|")/);
    expect(m).toContain("overview-page");
    expect(m).not.toContain('class="g2"');
    expect(m).not.toContain('class="g3"');
    // The wide charts still mount, now at full width.
    expect(m).toContain('data-chart="daily"');
    expect(m).toContain('data-chart="heat"');
    expect(m).toContain('data-chart="conc"');
  });

  it("shows the waiting-for-first-sync state instead of a zeroed dashboard", () => {
    const m = teamHome({
      team,
      data: overview({ totals: emptyTotals, members: [member({ neverSynced: true, lastUploadAt: null })], lastUploadAt: null }),
      role: "owner",
    });
    expect(m).toContain("Waiting for first sync");
    expect(m).not.toContain('data-chart="daily"');
    assertClean(m);
  });

  it("hides the owner-only Invite action from a manager", () => {
    const asOwner = teamHome({ team, data: overview(), role: "owner" });
    const asManager = teamHome({ team, data: overview({ role: "manager" }), role: "manager" });
    expect(asOwner).toContain("Invite");
    expect(asManager).not.toContain(">Invite<");
  });

  it("links to the Members directory instead of embedding the roster table", () => {
    const m = teamHome({ team, data: overview(), role: "owner" });
    expect(m).toContain(`#/t/${team.slug}/members`);
    expect(m).toContain("Open members");
    expect(m).not.toContain('id="memberTable"');
    assertClean(m);
  });
});

describe("members directory", () => {
  it("renders roomy rows with metrics, not the dense table", () => {
    const m = membersDirectory({
      team,
      role: "owner",
      members: [member()],
      range: "30d",
      sortKey: "activeHours",
    });
    expect(m).toContain("mem-row");
    expect(m).toContain("Dani Okafor");
    expect(m).toContain("mem-metrics");
    expect(m).toContain("data-mem-sort");
    expect(m).not.toContain('id="memberTable"');
    assertClean(m);
  });

  it("shows pending sync honestly", () => {
    const m = membersDirectory({
      team,
      role: "manager",
      members: [member({ neverSynced: true, lastUploadAt: null, totals: emptyTotals })],
      range: "7d",
    });
    expect(m).toContain("Never synced");
    expect(m).toContain("is-pending");
    assertClean(m);
  });

  it("sortMembers sinks never-synced to the bottom", () => {
    const a = member({
      userId: "a",
      displayName: "Active",
      neverSynced: false,
      totals: totalsWith({ activeHours: 1 }),
    });
    const b = member({
      userId: "b",
      displayName: "Pending",
      neverSynced: true,
      lastUploadAt: null,
      totals: emptyTotals,
    });
    const c = member({
      userId: "c",
      displayName: "Busy",
      neverSynced: false,
      totals: totalsWith({ activeHours: 10 }),
    });
    const sorted = sortMembers([a, b, c], "activeHours", false);
    expect(sorted.map((m) => m.userId)).toEqual(["c", "a", "b"]);
  });
});

describe("member detail", () => {
  const detail = (over = {}) => ({
    range: "30d", role: "owner", isSelf: false,
    member: { user_id: "u1", display_name: "Dani Okafor", handle: "dokafor", avatar_color: "#fbbf24", role: "employee", joined_at: "2026-04-09T00:00:00.000Z", last_upload_at: new Date().toISOString() },
    totals: totalsWith({ activeHours: 29.5, tokens: 12_700_000, sessions: 68, turns: 455, toolCalls: 1208, peakConcurrent: 5, cacheHitRate: 0.74, costUsd: 68.4 }),
    deltas: { tokens: 0.1, activeHours: null, sessions: null },
    daily: [day()], heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    providerMix: [{ key: "ClaudeCode", tokens: 100, share: 0.71 }],
    modelMix: [{ key: "gpt-5.3-codex", tokens: 40, share: 0.4 }],
    projects: [{ projectKey: "helios-api", activeHours: 13.1, tokens: 5_900_000, sessions: 28 }],
    flags: { afterHoursShare: 0.27, afterHoursSharePrev: 0.2, weekendShare: 0, idleDays: 1 },
    from: "2026-07-01", to: "2026-07-30",
    neverSynced: false, ...over,
  });

  it("renders a manager's view of a member", () => {
    const m = memberDetail({ team, data: detail(), isSelf: false });
    expect(m).toContain("Dani Okafor");
    expect(m).toContain("helios-api");
    expect(m).toContain("Claude Code");
    expect(m).toContain("GPT 5.3 Codex");
    expect(m).toContain("Token composition");
    expect(m).toContain("Work rates");
    expect(m).toContain("Work patterns");
    expect(m).not.toContain("What managers can see");
    assertClean(m);
  });

  it("keeps the analytics panels in a flow, not fixed grid rows", () => {
    // Same rule as the team page: the member view paired a 7-row heatmap with
    // a 13-row projects list, which left ~700px of dead space under the chart.
    const m = memberDetail({ team, data: detail(), isSelf: false });
    expect(m).toContain('class="flow"');
    expect(m).not.toContain('class="g2"');
    expect(m).not.toContain('class="g3"');
    expect(m).toContain('data-chart="daily"');
    expect(m).toContain('data-chart="heat"');
    // Projects moved into the flow rather than being pinned beside the heatmap.
    expect(m).toContain("Projects");
  });

  it("adds the disclosure panel only on the self view", () => {
    const m = memberDetail({ team, data: detail({ isSelf: true }), isSelf: true });
    expect(m).toContain("Your metrics");
    expect(m).toContain("What managers can see");
    expect(m).toContain("What managers see");
    assertClean(m);
  });

  it("renders the stale banner without throwing on a missing helper", () => {
    // The banner path is only reached when a member is stale, so a typo or an
    // unimported helper here stays invisible until it hits a real user.
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    const m = memberDetail({
      team,
      data: detail({ member: { ...detail().member, last_upload_at: twoDaysAgo } }),
      isSelf: false,
    });
    expect(m).toContain("Partial data.");
    expect(m).toMatch(/Last successful upload was \d+d ago/);
    assertClean(m);
  });

  it("shows reasoning tokens only when the provider reports them", () => {
    const without = memberDetail({ team, data: detail(), isSelf: false });
    expect(without).not.toContain("Reasoning tokens");

    const withReasoning = memberDetail({
      team,
      data: detail({ totals: totalsWith({ tokensReasoning: 150_299, turns: 5 }) }),
      isSelf: false,
    });
    expect(withReasoning).toContain("Reasoning tokens");
    expect(withReasoning).toContain("150k");
    assertClean(withReasoning);
  });

  it("shows never-synced rather than an empty chart set", () => {
    const m = memberDetail({ team, data: detail({ neverSynced: true, member: { ...detail().member, last_upload_at: null } }), isSelf: false });
    expect(m).toContain("Never synced");
    expect(m).not.toContain('data-chart="daily"');
    assertClean(m);
  });

  it("shows leaderboard-week banner and crumb when opened from the board", () => {
    const m = memberDetail({
      team,
      data: detail(),
      isSelf: false,
      fromLeaderboard: { week: "2026-W32", from: "2026-08-03", to: "2026-08-09" },
    });
    expect(m).toContain("Leaderboard week 2026-W32");
    expect(m).toContain("token composition");
    expect(m).toContain("Back to leaderboard");
    expect(m).toContain(`#/t/${team.slug}/leaderboard`);
    assertClean(m);
  });
});

describe("team settings", () => {
  const members = [
    { user_id: "u0", display_name: "Priya Raman", handle: "priya", email: "priya@helios.dev", avatar_color: "#a3e635", role: "owner", joined_at: "2026-04-02T00:00:00.000Z", last_upload_at: new Date().toISOString() },
    { user_id: "u1", display_name: "Dani Okafor", handle: "dokafor", email: "dani@helios.dev", avatar_color: "#fbbf24", role: "employee", joined_at: "2026-04-09T00:00:00.000Z", last_upload_at: null },
  ];


  it("gives the owner rename, delete, invite and role controls", () => {
    const m = teamSettings({ team, role: "owner", members, invite: { state: "active", url: "https://teams.agmux.dev/join/abc", expiresAt: "2026-08-05T00:00:00.000Z", usesLeft: 14, creatorName: "Priya Raman" } });
    expect(m).toContain('data-act="rename"');
    expect(m).toContain('data-act="delete"');
    expect(m).toContain('data-act="invite-revoke"');
    expect(m).toContain("data-role-for=");
    expect(m).toContain(`#/t/${team.slug}/plan`);
    expect(m).toContain("set-summary");
    expect(m).toContain("Danger zone");
    expect(m).toContain("Open restrictions");
    expect(m).not.toContain('id="restrictions"');
    expect(m).not.toContain("billing-checkout");
    assertClean(m);
  });

  it("keeps roster controls read-only for a manager", () => {
    const m = teamSettings({ team, role: "manager", members, invite: null });
    expect(m).toContain("Roster settings are read only");
    expect(m).toContain("Roster · owner managed");
    expect(m).not.toContain('data-act="rename"');
    expect(m).not.toContain('data-act="delete"');
    expect(m).not.toContain("data-role-for=");
    expect(m).not.toContain("data-remove=");
    expect(m).not.toContain("Danger zone");
    assertClean(m);
  });

  it("keeps an expired link visible and struck through with a way forward", () => {
    const m = teamSettings({ team, role: "owner", members, invite: { state: "expired", url: null, expiresAt: "2026-07-21T00:00:00.000Z", usesLeft: 0 } });
    expect(m).toContain("link dead");
    expect(m).toContain("Create new link");
    assertClean(m);
  });
});

describe("plan page", () => {
  const prices = { freeSeats: 3, monthlyUsd: 12, annualUsdPerYear: 120 };

  it("shows Free hero and Free vs Teams features for small teams", () => {
    const m = teamPlan({
      team,
      role: "owner",
      membersCount: 2,
      prices,
      billing: {
        status: "trialing",
        seats: 2,
        freeSeats: 3,
        onFreeTierize: true,
        access: "full",
        hasSubscription: false,
        hasCustomer: false,
      },
    });
    expect(m).toContain("Your team is on Free");
    expect(m).toContain("plan-tier");
    expect(m).toContain("Unlimited members");
    expect(m).toContain("Team Knowledge");
    expect(m).toContain("PR Leaderboard");
    expect(m).toContain("not Knowledge or Leaderboard");
    expect(m).not.toContain("billing-checkout-month");
    assertClean(m);
  });

  it("shows trial CTA when oversized and not subscribed", () => {
    const m = teamPlan({
      team,
      role: "owner",
      membersCount: 5,
      prices,
      billing: {
        status: "trialing",
        seats: 5,
        freeSeats: 3,
        onFreeTierize: false,
        billableSeats: 2,
        estimatedMonthlyUsd: 24,
        access: "full",
        trialEndsAt: "2099-12-01T00:00:00.000Z",
        hasSubscription: false,
        hasCustomer: false,
      },
    });
    expect(m).toContain("free trial");
    expect(m).toContain('data-act="billing-checkout-month"');
    expect(m).toContain('data-act="billing-checkout-year"');
    assertClean(m);
  });

  it("shows licensed seat manager when subscribed", () => {
    const m = teamPlan({
      team,
      role: "owner",
      membersCount: 5,
      prices,
      billing: {
        status: "active",
        seats: 5,
        freeSeats: 3,
        seatQuantity: 6,
        billableSeats: 3,
        estimatedMonthlyUsd: 36,
        hasSubscription: true,
        hasCustomer: true,
        periodEnd: "2099-09-01T00:00:00.000Z",
        access: "full",
      },
    });
    expect(m).toContain("Your team is on Teams");
    expect(m).toContain('data-act="billing-seats-update"');
    expect(m).toContain('data-act="billing-portal"');
    expect(m).not.toContain("billing-checkout-month");
    assertClean(m);
  });

  it("is view-only for non-owners", () => {
    const m = teamPlan({
      team,
      role: "manager",
      membersCount: 5,
      prices,
      billing: {
        status: "active",
        seats: 5,
        hasSubscription: true,
        hasCustomer: true,
        seatQuantity: 5,
        access: "full",
      },
    });
    expect(m).toContain("View only");
    expect(m).not.toContain("billing-seats-update");
    expect(m).not.toContain("billing-checkout");
    assertClean(m);
  });
});

describe("landing", () => {
  it("renders sign-in, pricing note and the disclosure list", () => {
    // signInUrl reads location; vitest node has none.
    globalThis.location = { pathname: "/", hash: "", search: "" };
    const m = landing({});
    expect(m).toContain("See how your team uses AI coding agents.");
    expect(m).toContain("First 3 seats are free");
    expect(m).toContain("Continue with GitHub");
    expect(m).toContain("Continue with Google");
    expect(m).toContain('class="dsc landing-dsc"');
    for (const line of NEVER_SHORT) expect(m).toContain(esc(line));
    assertClean(m);
  });
});

describe("disclosure copy", () => {
  it("is rendered identically wherever it appears", () => {
    const block = disclosureBlock();
    for (const line of [...SHARED, ...NEVER]) {
      expect(block).toContain(esc(line));
    }
    // The privacy page must carry the same list, word for word.
    const page = privacy({ backHref: "#/teams" });
    for (const line of [...SHARED, ...NEVER]) {
      expect(page).toContain(esc(line));
    }
    // Help reuses the same block so join / privacy / help stay aligned.
    const help = teamHelp({ team: { name: "Acme", slug: "acme" }, role: "owner" });
    for (const line of [...SHARED, ...NEVER]) {
      expect(help).toContain(esc(line));
    }
  });

  it("help covers setup, roles, tabs, and troubleshooting", () => {
    const page = teamHelp({ team: { name: "Acme", slug: "acme" }, role: "manager" });
    expect(page).toContain("You're signed in as <b");
    expect(page).toContain("manager");
    expect(page).toContain("id=\"help-start\"");
    expect(page).toContain("id=\"help-roles\"");
    expect(page).toContain("id=\"help-tabs\"");
    expect(page).toContain("id=\"help-fix\"");
    expect(page).toContain("Waiting for first sync");
    expect(page).toContain("First");
    expect(page).toContain("3 seats");
    assertClean(page);
  });

  it("always names both columns", () => {
    const block = disclosureBlock();
    expect(block).toContain("shield-check");
    expect(block).toContain("eye-off");
    expect(block).toContain('class="shared"');
    expect(block).toContain('class="never"');
  });
});

describe("leaderboard view", () => {
  const row = (over = {}) => ({
    rank: 1,
    userId: "u1",
    displayName: "Ada Lovelace",
    handle: "ada",
    githubLogin: "ada",
    prSmall: 1,
    prMedium: 2,
    prLarge: 0,
    prMerged: 2,
    points: 5.5,
    tokens: 1_000_000,
    costUsd: 10,
    tokensPerPoint: 181_818,
    costPerPoint: 1.82,
    ...over,
  });

  it("prettifies handle-like display names", () => {
    expect(prettifyHandle("mohan-gummalam")).toBe("Mohan Gummalam");
    expect(memberDisplayName("mohan-gummalam", "mohan-gummalam")).toBe("Mohan Gummalam");
    expect(memberDisplayName("Schwark Satyavolu", "schwark-satyavolu")).toBe("Schwark Satyavolu");
    expect(memberDisplayName("vivek-rajakumar", "vivek-rajakumar")).toBe("Vivek Rajakumar");
  });

  it("left-aligns the member column and exposes sortable headers", () => {
    const m = leaderboardView({
      team,
      role: "owner",
      week: "current",
      hasGithub: true,
      sortKey: "costPerPoint",
      sortAsc: true,
      data: {
        enabled: true,
        week: "2026-W32",
        weekStart: "2026-08-03T00:00:00.000Z",
        weekEnd: "2026-08-10T00:00:00.000Z",
        rows: [
          row({ rank: 1, displayName: "mohan-gummalam", githubLogin: "mohan-gummalam", prMerged: 3, tokens: 3e6 }),
          row({
            rank: 2,
            userId: "u2",
            displayName: "Ada Lovelace",
            githubLogin: "ada",
            prMerged: 10,
            tokens: 9e6,
            costPerPoint: 3,
          }),
        ],
        memberCountRanked: 2,
        memberCountEligible: 2,
        lastSyncAt: "2026-08-06T00:00:00.000Z",
      },
    });
    expect(m).toContain("Mohan Gummalam");
    expect(m).toContain("@mohan-gummalam");
    expect(m).toContain('data-sort="prMerged"');
    expect(m).toContain('data-sort="tokens"');
    expect(m).toContain('data-sort="tokensPerPr"');
    expect(m).toContain('data-sort="costPerPoint"');
    expect(m).toContain('class="l"');
    expect(m).toContain("Tok/PR");
    // Rows drill into member token breakdown for the week
    expect(m).toContain('data-member="u1"');
    expect(m).toContain('data-member="u2"');
    expect(m).toContain("Click a person");
    // Default sort column highlighted
    expect(m).toMatch(/data-sort="costPerPoint"[^>]*class="[^"]*sorted/);
    // Desktop table + mobile card list (CSS swaps at ≤720px)
    expect(m).toContain('class="tbl-scroll lb-desktop"');
    expect(m).toContain('class="lb-cards"');
    expect(m).toContain('class="lb-card"');
    expect(m).toContain("$/pt");
    assertClean(m);
  });

  it("maps ISO week bounds to inclusive custom date range", () => {
    expect(weekUtcToCustomRange("2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z")).toEqual({
      from: "2026-08-03",
      to: "2026-08-09",
    });
    expect(weekUtcToCustomRange(null, "2026-08-10T00:00:00.000Z")).toBeNull();
  });

  it("shows complexity columns when scoringMode is complexity", () => {
    const m = leaderboardView({
      team,
      role: "manager",
      week: "current",
      hasGithub: true,
      data: {
        enabled: true,
        scoringMode: "complexity",
        week: "2026-W32",
        complexityCoverage: { withPoints: 8, total: 10 },
        rows: [row({ prOpened: 4, prSmall: 1, prMedium: 1, prLarge: 2, points: 16.5 })],
        memberCountRanked: 1,
        memberCountEligible: 1,
        lastSyncAt: "2026-08-06T00:00:00.000Z",
      },
    });
    expect(m).toContain("complexity points");
    expect(m).toContain('data-sort="prOpened"');
    expect(m).not.toContain('data-sort="prSmall"');
    expect(m).toContain("Size on 8/10 PRs");
    expect(m).toContain("XS=1");
    assertClean(m);
  });

  it("sorts by merged PRs and tokens/PR", () => {
    const rows = [
      row({ rank: 1, prMerged: 2, tokens: 4_000_000, userId: "a" }),
      row({ rank: 2, prMerged: 10, tokens: 5_000_000, userId: "b", displayName: "Bob" }),
      row({ rank: 3, prMerged: 0, tokens: 1_000_000, userId: "c", displayName: "Cara" }),
    ];
    const byMerged = sortLeaderboardRows(rows, "prMerged", false);
    expect(byMerged.map((r) => r.userId)).toEqual(["b", "a", "c"]);

    // 4M/2 = 2M, 5M/10 = 0.5M — lower tokens/PR first when asc
    const byTokPr = sortLeaderboardRows(rows, "tokensPerPr", true);
    expect(byTokPr[0].userId).toBe("b");
    // zero merged sinks
    expect(byTokPr[byTokPr.length - 1].userId).toBe("c");
  });
});


describe("all-provider mix", () => {
  it("renders every app provider label", () => {
    const providers = ["ClaudeCode", "Codex", "Grok", "Cursor", "Droid", "Pi", "Kimi", "Cline", "Gemini", "Hermes", "OpenCode", "MLX"];
    const markup = mixRows(providers.map((key) => ({ key, tokens: 100, share: 1 / 12, activeMs: 60000, timeShare: 1 / 12 })));
    for (const provider of providers) expect(markup).toMatch(new RegExp(`>${provider === "ClaudeCode" ? "Claude Code" : provider}\\s*<`));
    assertClean(markup);
  });
});
