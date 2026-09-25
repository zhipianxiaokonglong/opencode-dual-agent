/**
 * JSON 文件存储：node:sqlite 不可用时的降级实现（如 Bun 运行时）。
 * 数据量小（检查点/台账/映射），同步落盘保证可恢复。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Checkpoint, Store } from "../ports";
import type { IssueLedgerEntry } from "../protocols";

interface Shape {
  checkpoints: Record<string, Checkpoint[]>;
  issues: Record<string, Record<string, IssueLedgerEntry>>;
  sessionRefs: Record<string, Array<{ role: string; sessionKey: string }>>;
  meta: Record<string, Record<string, unknown>>;
}

export class JsonFileStore implements Store {
  readonly #file: string;
  #data: Shape;

  constructor(file: string) {
    this.#file = file;
    this.#data = { checkpoints: {}, issues: {}, sessionRefs: {}, meta: {} };
    try {
      this.#data = { ...this.#data, ...(JSON.parse(fs.readFileSync(file, "utf8")) as Shape) };
    } catch {
      // 文件不存在或损坏时从空状态开始
    }
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(this.#data), "utf8");
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    (this.#data.checkpoints[cp.runId] ??= []).push(cp);
    this.#persist();
  }

  async latestCheckpoint(runId: string): Promise<Checkpoint | undefined> {
    const list = this.#data.checkpoints[runId] ?? [];
    return list[list.length - 1];
  }

  async addIssues(runId: string, entries: readonly IssueLedgerEntry[]): Promise<void> {
    const bucket = (this.#data.issues[runId] ??= {});
    for (const e of entries) bucket[e.issueId] = e;
    this.#persist();
  }

  async updateIssueStatus(
    runId: string,
    issueId: string,
    status: IssueLedgerEntry["status"],
  ): Promise<void> {
    const entry = this.#data.issues[runId]?.[issueId];
    if (entry) {
      entry.status = status;
      this.#persist();
    }
  }

  async listIssues(runId: string): Promise<IssueLedgerEntry[]> {
    return Object.values(this.#data.issues[runId] ?? {});
  }

  async putSessionRef(runId: string, role: string, sessionKey: string): Promise<void> {
    const list = (this.#data.sessionRefs[runId] ??= []);
    if (!list.some((r) => r.role === role && r.sessionKey === sessionKey)) {
      list.push({ role, sessionKey });
      this.#persist();
    }
  }

  async listSessionRefs(runId: string): Promise<Array<{ role: string; sessionKey: string }>> {
    return this.#data.sessionRefs[runId] ?? [];
  }

  async setMeta(runId: string, key: string, value: unknown): Promise<void> {
    ((this.#data.meta[runId] ??= {}))[key] = value ?? null;
    this.#persist();
  }

  async getMeta<T = unknown>(runId: string, key: string): Promise<T | undefined> {
    return this.#data.meta[runId]?.[key] as T | undefined;
  }

  async close(): Promise<void> {
    this.#persist();
  }
}
