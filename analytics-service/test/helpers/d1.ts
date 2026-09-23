import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../../src/env";

type Bind = unknown[];
const D1_MAX_BIND_VARS = 100;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: Bind = [],
  ) {}

  bind(...args: Bind): Stmt {
    return new Stmt(this.db, this.sql, args);
  }

  private normalized(): unknown[] {
    if (this.args.length > D1_MAX_BIND_VARS) {
      throw new Error(`D1_ERROR: too many SQL variables (${this.args.length} > ${D1_MAX_BIND_VARS})`);
    }
    return this.args.map((a) => {
      if (a === undefined) return null;
      if (typeof a === "boolean") return a ? 1 : 0;
      return a;
    });
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.normalized() as never[]));
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.normalized() as never[]));
    return Promise.resolve({ results: rows as T[] });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...(this.normalized() as never[]));
    return Promise.resolve({ meta: { changes: Number(r.changes ?? 0) } });
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql);
  }
}

const SCHEMA_PATH = fileURLToPath(new URL("../../schema.sql", import.meta.url));

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return {
    DB: new FakeD1(db) as unknown as D1Database,
    ASSETS: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) } as unknown as Fetcher,
    APP_ORIGIN: "https://owner.agmux.dev",
    ...overrides,
  };
}

export const INSTALL_ID = "550e8400-e29b-41d4-a716-446655440000";

export function heartbeatBody(over: Record<string, unknown> = {}) {
  return {
    install_id: INSTALL_ID,
    app_version: "4.0.2",
    os_name: "macos",
    os_version: "15.5",
    arch: "aarch64",
    channel: "release",
    ...over,
  };
}
