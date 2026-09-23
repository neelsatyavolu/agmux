/**
 * Minimal D1 shim over node:sqlite, so tests exercise real SQL semantics
 * (ON CONFLICT, CHECK constraints, COLLATE NOCASE) rather than a mock that
 * agrees with whatever the code happens to do.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../../src/env";

type Bind = unknown[];

/**
 * D1 rejects statements with more than 100 bind variables. node:sqlite has no
 * such limit, so we enforce it here — otherwise a multi-row insert that real
 * D1 refuses would sail through the test suite.
 */
const D1_MAX_BIND_VARS = 100;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: Bind = [],
  ) {}

  /** Returns a NEW statement — D1 lets one prepared stmt be bound many times. */
  bind(...args: Bind): Stmt {
    return new Stmt(this.db, this.sql, args);
  }

  private normalized(): unknown[] {
    if (this.args.length > D1_MAX_BIND_VARS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${this.args.length} > ${D1_MAX_BIND_VARS})`,
      );
    }
    // node:sqlite rejects undefined and booleans; D1 coerces them.
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

  async batch(stmts: Stmt[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

const SCHEMA_PATH = fileURLToPath(new URL("../../schema.sql", import.meta.url));

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));

  return {
    DB: new FakeD1(db) as unknown as D1Database,
    ASSETS: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) } as unknown as Fetcher,
    APP_ORIGIN: "https://teams.agmux.dev",
    RETENTION_DAYS: "90",
    INVITE_TTL_DAYS: "14",
    ...overrides,
  };
}

/** Seeds a user and returns its id. */
export async function seedUser(env: Env, id: string, name = id): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, email, handle, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, `${id}@example.test`, id, "#60a5fa", new Date().toISOString())
    .run();
  return id;
}

export async function seedTeam(
  env: Env,
  teamId: string,
  ownerId: string,
  name = "Helios Platform",
): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(teamId, teamId, name, ownerId, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)",
  )
    .bind(`mem_${teamId}_${ownerId}`, teamId, ownerId, now)
    .run();
  return teamId;
}

/** GitHub-linked user. Handle is the GitHub login. */
export async function seedGithubUser(
  env: Env,
  id: string,
  login: string,
  name = login,
): Promise<string> {
  await seedUser(env, id, name);
  await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(login, id).run();
  await env.DB.prepare(
    "INSERT INTO identities (provider, provider_user_id, user_id, created_at) VALUES ('github', ?, ?, ?)",
  )
    .bind(`gh_${id}`, id, new Date().toISOString())
    .run();
  return id;
}

export async function addMember(
  env: Env,
  teamId: string,
  userId: string,
  role: "owner" | "manager" | "employee",
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(`mem_${teamId}_${userId}`, teamId, userId, role, new Date().toISOString())
    .run();
}
