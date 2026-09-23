import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

describe("cost completeness migration", () => {
  it("marks retained rows unknown and restricts storage to booleans", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE metric_hourly(id TEXT PRIMARY KEY, cost_usd REAL); INSERT INTO metric_hourly VALUES('old', 12.5)");
      db.exec(readFileSync(new URL("../migrations/011_cost_completeness.sql", import.meta.url), "utf8"));
      expect(db.prepare("SELECT cost_usd,cost_incomplete FROM metric_hourly").get()).toMatchObject({ cost_usd: 12.5, cost_incomplete: 1 });
      db.exec("UPDATE metric_hourly SET cost_incomplete=0");
      expect(() => db.exec("UPDATE metric_hourly SET cost_incomplete=2")).toThrow();
    } finally { db.close(); }
  });
});
