/**
 * 持久化层（§3.2 storage/）：状态、产物、预算、检查点。
 * 使用 Node 内置 SQLite（node:sqlite，Node ≥ 22.5），不存凭证、不存完整敏感日志。
 * 通过 createRequire 加载：node:sqlite 仅支持 node: 前缀，打包器需绕过静态解析。
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { Checkpoint, Store } from "../ports";
import type { IssueLedgerEntry } from "../protocols";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  state     TEXT NOT NULL,
  round     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS issues (
  run_id    TEXT NOT NULL,
  issue_id  TEXT NOT NULL,
  summary   TEXT NOT NULL,
  severity  TEXT NOT NULL,
  status    TEXT NOT NULL,
  related_criteria TEXT NOT NULL,
  location  TEXT NOT NULL,
  round     INTEGER NOT NULL,
  PRIMARY KEY (run_id, issue_id)
);
CREATE TABLE IF NOT EXISTS session_refs (
  run_id      TEXT NOT NULL,
  role        TEXT NOT NULL,
  session_key TEXT NOT NULL,
  PRIMARY KEY (run_id, role, session_key)
);
CREATE TABLE IF NOT EXISTS meta (
  run_id TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
`;

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    this.#db = new SqliteDatabase(dbPath);
    this.#db.exec(SCHEMA);
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    const seqRow = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM checkpoints WHERE run_id = ?")
      .get(cp.runId) as { seq: number };
    this.#db
      .prepare(
        `INSERT INTO checkpoints (run_id, seq, state, round, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(cp.runId, seqRow.seq + 1, cp.state, cp.round, cp.createdAt, JSON.stringify(cp.payload));
  }

  async latestCheckpoint(runId: string): Promise<Checkpoint | undefined> {
    const row = this.#db
      .prepare(
        `SELECT run_id, state, round, created_at, payload FROM checkpoints
         WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId) as
      | { run_id: string; state: string; round: number; created_at: string; payload: string }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      state: row.state,
      round: row.round,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload) as unknown,
    };
  }

  async addIssues(runId: string, entries: readonly IssueLedgerEntry[]): Promise<void> {
    const stmt = this.#db.prepare(
      `INSERT INTO issues (run_id, issue_id, summary, severity, status, related_criteria, location, round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, issue_id) DO UPDATE SET
         summary = excluded.summary,
         severity = excluded.severity,
         status = excluded.status,
         related_criteria = excluded.related_criteria,
         location = excluded.location,
         round = excluded.round`,
    );
    for (const e of entries) {
      stmt.run(
        runId,
        e.issueId,
        e.summary,
        e.severity,
        e.status,
        JSON.stringify(e.relatedCriteria),
        e.location,
        e.round,
      );
    }
  }

  async updateIssueStatus(
    runId: string,
    issueId: string,
    status: IssueLedgerEntry["status"],
  ): Promise<void> {
    this.#db
      .prepare("UPDATE issues SET status = ? WHERE run_id = ? AND issue_id = ?")
      .run(status, runId, issueId);
  }

  async listIssues(runId: string): Promise<IssueLedgerEntry[]> {
    const rows = this.#db
      .prepare(
        `SELECT issue_id, summary, severity, status, related_criteria, location, round
         FROM issues WHERE run_id = ? ORDER BY round, issue_id`,
      )
      .all(runId) as Array<{
      issue_id: string;
      summary: string;
      severity: IssueLedgerEntry["severity"];
      status: IssueLedgerEntry["status"];
      related_criteria: string;
      location: string;
      round: number;
    }>;
    return rows.map((r) => ({
      issueId: r.issue_id,
      summary: r.summary,
      severity: r.severity,
      status: r.status,
      relatedCriteria: JSON.parse(r.related_criteria) as string[],
      location: r.location,
      round: r.round,
    }));
  }

  async putSessionRef(runId: string, role: string, sessionKey: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO session_refs (run_id, role, session_key) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(runId, role, sessionKey);
  }

  async listSessionRefs(runId: string): Promise<Array<{ role: string; sessionKey: string }>> {
    const rows = this.#db
      .prepare("SELECT role, session_key FROM session_refs WHERE run_id = ?")
      .all(runId) as Array<{ role: string; session_key: string }>;
    return rows.map((r) => ({ role: r.role, sessionKey: r.session_key }));
  }

  async setMeta(runId: string, key: string, value: unknown): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO meta (run_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (run_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(runId, key, JSON.stringify(value ?? null));
  }

  async getMeta<T = unknown>(runId: string, key: string): Promise<T | undefined> {
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE run_id = ? AND key = ?")
      .get(runId, key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  #closed = false;

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
