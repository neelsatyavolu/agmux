/**
 * The manager-facing surface: CSV export, budgets + forecast + alerting, and
 * the audit log.
 *
 * The recurring theme in these tests is *honesty under aggregation*: an export
 * that silently widens an employee's scope, a budget that reads 100% before any
 * spend, or an alert that re-fires every hour are all worse than the feature
 * not existing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCsv, csvCell } from "../src/routes/export";
import {
  budgetFor,
  getBudget,
  monthSpend,
  newlyCrossed,
  parseThresholds,
  runBudgetAlerts,
  setBudget,
} from "../src/routes/budget";
import { listAudit, writeAudit } from "../src/routes/audit";
import { budgetStatus, daysInMonth } from "../src/aggregate";
import type { Env } from "../src/env";
import type { Principal } from "../src/session";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

const principal = (userId: string): Principal => ({ userId, deviceId: null, via: "cookie" });

/** Routes wrap payloads in the `{ ok, data }` envelope; unwrap it here. */
async function data<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data: T };
  return body.data;
}

async function fixture() {
  const env = makeEnv();
  await seedUser(env, "owner1", "Ada Owner");
  await seedUser(env, "mgr1", "Max Manager");
  await seedUser(env, "emp1", "Eve Employee");
  await seedTeam(env, "tm1", "owner1");
  await addMember(env, "tm1", "mgr1", "manager");
  await addMember(env, "tm1", "emp1", "employee");
  return env;
}

async function addMetric(
  env: Env,
  userId: string,
  hourUtc: string,
  over: Record<string, number | string> = {},
) {
  const row = {
    tokens_in: 1000,
    tokens_out: 500,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    tokens_reasoning: 0,
    cost_usd: 1,
    active_ms: 60_000,
    after_hours_ms: 0,
    weekend_ms: 0,
    sessions: 1,
    turns: 2,
    tool_calls: 10,
    peak_concurrent: 1,
    tool_bash: 6,
    tool_edit: 2,
    tool_read: 2,
    tool_search: 0,
    tool_web: 0,
    tool_agent: 0,
    tool_mcp: 0,
    tool_other: 0,
    tool_errors: 1,
    tools_measured: 10,
    files_changed: 2,
    lines_added: 30,
    lines_removed: 4,
    ...over,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO metric_hourly (team_id, user_id, device_id, hour_utc, provider, model, project_key,
       ${cols.join(", ")}, local_hour, local_dow, updated_at)
     VALUES (?, ?, ?, ?, 'ClaudeCode', 'claude-opus-5', 'helios-api',
       ${cols.map(() => "?").join(", ")}, 14, 2, ?)`,
  )
    .bind("tm1", userId, `dev-${userId}`, hourUtc, ...cols.map((c) => row[c as keyof typeof row]), "2026-07-29T00:00:00Z")
    .run();
}

const req = (url: string) => new Request(url);

describe("csvCell", () => {
  it("quotes separators and escapes quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("defuses spreadsheet formulas in a display name", () => {
    // A member could name themselves =HYPERLINK(...). Excel executes that when
    // the manager opens the export.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1-555")).toBe("'+1-555");
    expect(csvCell("@here")).toBe("'@here");
  });

  it("leaves ordinary numbers alone", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
  });
});

describe("CSV export", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });
  it("returns a downloadable csv with a header row", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-29T14");
    const res = await exportCsv(req("https://x/api/teams/tm1/export.csv"), env, principal("owner1"), "tm1");

    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.text();
    const [header, ...rows] = body.trim().split("\n");
    expect(header).toContain("tokens_total");
    expect(header.split(",")).toContain("active_session_hours");
    expect(header.split(",")).not.toContain("sessions");
    expect(header).toContain("tool_bash");
    expect(header).toContain("lines_added");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Eve Employee");
  });

  it("gives an employee only their own rows, without a 403", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-29T14");
    await addMetric(env, "mgr1", "2026-07-29T14");

    const mine = await exportCsv(req("https://x/e.csv"), env, principal("emp1"), "tm1");
    const body = await mine.text();
    expect(mine.status).toBe(200);
    expect(body).toContain("Eve Employee");
    expect(body).not.toContain("Max Manager");
  });

  it("lets a manager export the whole team", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-29T14");
    await addMetric(env, "mgr1", "2026-07-29T14");
    const body = await (await exportCsv(req("https://x/e.csv"), env, principal("mgr1"), "tm1")).text();
    expect(body).toContain("Eve Employee");
    expect(body).toContain("Max Manager");
  });

  it("folds hours into days by default and keeps them when asked", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-29T14", { cost_usd: 1 });
    await addMetric(env, "emp1", "2026-07-29T15", { cost_usd: 2 });

    const daily = await (await exportCsv(req("https://x/e.csv"), env, principal("owner1"), "tm1")).text();
    const dailyRows = daily.trim().split("\n").slice(1);
    expect(dailyRows).toHaveLength(1);
    expect(dailyRows[0]).toContain("3"); // summed cost

    const hourly = await (
      await exportCsv(req("https://x/e.csv?granularity=hour"), env, principal("owner1"), "tm1")
    ).text();
    expect(hourly.trim().split("\n").slice(1)).toHaveLength(2);
  });

  it("rejects an unknown granularity rather than silently guessing", async () => {
    const env = await fixture();
    await expect(
      exportCsv(req("https://x/e.csv?granularity=week"), env, principal("owner1"), "tm1"),
    ).rejects.toThrow();
  });

  it("records the export in the audit log", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-29T14");
    await exportCsv(req("https://x/e.csv"), env, principal("owner1"), "tm1");

    const res = await listAudit(req("https://x/audit"), env, principal("owner1"), "tm1");
    const { entries } = await data<{ entries: Array<{ action: string }> }>(res);
    expect(entries.some((e) => e.action === "data.exported")).toBe(true);
  });
});

describe("budgetStatus", () => {
  it("projects month-end spend from the run rate", () => {
    // $300 by day 10 of a 31-day month → $930 projected.
    const s = budgetStatus(1000, 300, new Date("2026-07-10T12:00:00Z"));
    expect(s.daysElapsed).toBe(10);
    expect(s.daysInMonth).toBe(31);
    expect(s.projectedUsd).toBeCloseTo(930);
    expect(s.usedShare).toBeCloseTo(0.3);
    expect(s.onTrackToExceed).toBe(false);
  });

  it("flags a team on track to exceed", () => {
    const s = budgetStatus(1000, 500, new Date("2026-07-10T12:00:00Z"));
    expect(s.projectedUsd).toBeCloseTo(1550);
    expect(s.onTrackToExceed).toBe(true);
  });

  it("does not divide by a part-day on the first of the month", () => {
    // Day one must count as a whole day, or the projection explodes.
    const s = budgetStatus(1000, 10, new Date("2026-07-01T00:30:00Z"));
    expect(s.daysElapsed).toBe(1);
    expect(s.projectedUsd).toBeCloseTo(310);
  });

  it("knows how long each month is, including a leap February", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 7)).toBe(31);
  });
});

describe("budget configuration", () => {
  it("is null until someone sets one", async () => {
    const env = await fixture();
    expect(await budgetFor(env, "tm1")).toBeNull();
  });

  it("stores a budget and reports spend against it", async () => {
    const env = await fixture();
    const now = new Date("2026-07-10T12:00:00Z");
    await addMetric(env, "emp1", "2026-07-05T14", { cost_usd: 120 });

    await setBudget(
      new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 1000 }) }),
      env,
      principal("owner1"),
      "tm1",
    );

    const status = await budgetFor(env, "tm1", now);
    expect(status?.monthlyUsd).toBe(1000);
    expect(status?.spendUsd).toBeCloseTo(120);
    expect(status?.costIncomplete).toBe(true);
    await env.DB.prepare("UPDATE metric_hourly SET cost_incomplete=0").run();
    expect((await budgetFor(env, "tm1", now))?.costIncomplete).toBe(false);
    await addMetric(env, "emp1", "2026-07-06T14", { cost_usd: 0 });
    expect((await budgetFor(env, "tm1", now))?.costIncomplete).toBe(true);
    expect(status?.thresholds).toEqual([80, 100]);
  });

  it("counts only the current calendar month", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-06-30T23", { cost_usd: 999 });
    await addMetric(env, "emp1", "2026-07-02T10", { cost_usd: 5 });
    expect(await monthSpend(env, "tm1", new Date("2026-07-10T12:00:00Z"))).toBeCloseTo(5);
  });

  it("clears the budget when set to zero instead of storing an impossible target", async () => {
    const env = await fixture();
    await setBudget(
      new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 500 }) }),
      env,
      principal("owner1"),
      "tm1",
    );
    await setBudget(
      new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 0 }) }),
      env,
      principal("owner1"),
      "tm1",
    );
    expect(await budgetFor(env, "tm1")).toBeNull();
  });

  it("never returns the webhook url, only whether one is set", async () => {
    const env = await fixture();
    await setBudget(
      new Request("https://x/b", {
        method: "PUT",
        body: JSON.stringify({ monthlyUsd: 100, webhookUrl: "https://hooks.example/secret-token" }),
      }),
      env,
      principal("owner1"),
      "tm1",
    );
    const status = await budgetFor(env, "tm1");
    expect(status?.hasWebhook).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("refuses a non-https webhook", async () => {
    const env = await fixture();
    await expect(
      setBudget(
        new Request("https://x/b", {
          method: "PUT",
          body: JSON.stringify({ monthlyUsd: 100, webhookUrl: "http://insecure.example" }),
        }),
        env,
        principal("owner1"),
        "tm1",
      ),
    ).rejects.toThrow();
  });

  it("lets a manager read the budget but not set it", async () => {
    const env = await fixture();
    const res = await getBudget(env, principal("mgr1"), "tm1");
    expect(res.status).toBe(200);
    expect((await data<{ canManage: boolean }>(res)).canManage).toBe(false);

    await expect(
      setBudget(
        new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 10 }) }),
        env,
        principal("mgr1"),
        "tm1",
      ),
    ).rejects.toThrow();
  });

  it("keeps the budget away from employees entirely", async () => {
    const env = await fixture();
    await expect(getBudget(env, principal("emp1"), "tm1")).rejects.toThrow();
  });

  it("parses and de-duplicates thresholds", () => {
    expect(parseThresholds("80,100")).toEqual([80, 100]);
    expect(parseThresholds("100, 80, 80")).toEqual([80, 100]);
    expect(parseThresholds("0,-5,2000,abc,50")).toEqual([50]);
  });
});

describe("budget alerts", () => {
  it("fires only thresholds that have been crossed and not yet sent", () => {
    expect(newlyCrossed(0.85, [80, 100], [])).toEqual([80]);
    expect(newlyCrossed(0.85, [80, 100], [80])).toEqual([]);
    expect(newlyCrossed(1.2, [80, 100], [80])).toEqual([100]);
    expect(newlyCrossed(0.5, [80, 100], [])).toEqual([]);
  });

  it("records a crossing once, no matter how often the cron runs", async () => {
    const env = await fixture();
    const now = new Date("2026-07-10T12:00:00Z");
    await addMetric(env, "emp1", "2026-07-05T14", { cost_usd: 90 });
    await setBudget(
      new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 100 }) }),
      env,
      principal("owner1"),
      "tm1",
    );

    expect(await runBudgetAlerts(env, now)).toBe(1); // crossed 80%
    expect(await runBudgetAlerts(env, now)).toBe(0); // and stays quiet
    expect(await runBudgetAlerts(env, now)).toBe(0);

    const r = await env.DB.prepare("SELECT threshold FROM budget_alerts WHERE team_id = 'tm1'").all<{
      threshold: number;
    }>();
    expect(r.results?.map((x) => x.threshold)).toEqual([80]);
  });

  it("fires the next threshold when spend keeps climbing", async () => {
    const env = await fixture();
    const now = new Date("2026-07-10T12:00:00Z");
    await addMetric(env, "emp1", "2026-07-05T14", { cost_usd: 90 });
    await setBudget(
      new Request("https://x/b", { method: "PUT", body: JSON.stringify({ monthlyUsd: 100 }) }),
      env,
      principal("owner1"),
      "tm1",
    );
    await runBudgetAlerts(env, now);

    await addMetric(env, "emp1", "2026-07-06T14", { cost_usd: 30 });
    expect(await runBudgetAlerts(env, now)).toBe(1); // now past 100%
  });

  it("ignores teams with no budget", async () => {
    const env = await fixture();
    await addMetric(env, "emp1", "2026-07-05T14", { cost_usd: 5000 });
    expect(await runBudgetAlerts(env, new Date("2026-07-10T12:00:00Z"))).toBe(0);
  });
});

describe("audit log", () => {
  it("is readable by owners and managers, not employees", async () => {
    const env = await fixture();
    await writeAudit(env, "tm1", "owner1", "team.created", null, "Helios Platform");

    expect((await listAudit(req("https://x/a"), env, principal("owner1"), "tm1")).status).toBe(200);
    expect((await listAudit(req("https://x/a"), env, principal("mgr1"), "tm1")).status).toBe(200);
    await expect(listAudit(req("https://x/a"), env, principal("emp1"), "tm1")).rejects.toThrow();
  });

  it("resolves actor and target names", async () => {
    const env = await fixture();
    await writeAudit(env, "tm1", "owner1", "member.role_changed", "emp1", "employee → manager");

    const { entries } = await data<{
      entries: Array<{ actor_name: string; target_name: string; detail: string }>;
    }>(await listAudit(req("https://x/a"), env, principal("owner1"), "tm1"));
    expect(entries[0]).toMatchObject({
      actor_name: "Ada Owner",
      target_name: "Eve Employee",
      detail: "employee → manager",
    });
  });

  it("returns newest first and honours a limit", async () => {
    const env = await fixture();
    for (const n of [1, 2, 3]) {
      await writeAudit(env, "tm1", "owner1", "invite.created", `inv${n}`, `n=${n}`);
      // The ledger orders by timestamp; nudge it so ordering is deterministic.
      await env.DB.prepare("UPDATE audit_log SET created_at = ? WHERE target = ?")
        .bind(`2026-07-0${n}T00:00:00Z`, `inv${n}`)
        .run();
    }
    const { entries } = await data<{ entries: Array<{ target: string }> }>(
      await listAudit(req("https://x/a?limit=2"), env, principal("owner1"), "tm1"),
    );
    expect(entries.map((e) => e.target)).toEqual(["inv3", "inv2"]);
  });

  it("never breaks the action it records", async () => {
    // A broken audit table must not fail a role change the user asked for.
    const env = await fixture();
    await env.DB.prepare("DROP TABLE audit_log").run();
    await expect(writeAudit(env, "tm1", "owner1", "team.renamed", null, "x")).resolves.toBeUndefined();
  });
});
