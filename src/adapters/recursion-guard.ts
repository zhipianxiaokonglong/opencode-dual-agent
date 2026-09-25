/**
 * 递归触发防护（§7.3）：
 * 插件监听事件并自建会话时，维护：根任务 ID、内部会话 ID、角色、
 * 事件去重键、工作区执行锁。若平台无自定义会话元数据，则在 SQLite 建立映射表。
 */
import type { Store } from "../ports";

export interface GuardedEvent {
  type: string;
  sessionID?: string;
  id?: string;
  [key: string]: unknown;
}

export class RecursionGuard {
  /** 内部会话 → { runId, role } */
  readonly #sessions = new Map<string, { runId: string; role: string }>();
  /** 已处理事件去重键 */
  readonly #seen = new Set<string>();
  /** 工作区执行锁：workspaceRoot → runId（进程级共享，跨 guard 实例互斥）。 */
  static readonly #locks = new Map<string, string>();

  constructor(
    private readonly runId: string,
    private readonly store?: Store,
  ) {}

  async registerSession(role: string, sessionID: string): Promise<void> {
    this.#sessions.set(sessionID, { runId: this.runId, role });
    await this.store?.putSessionRef(this.runId, role, sessionID);
  }

  isInternal(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.#sessions.has(sessionID);
  }

  /**
   * 事件是否需要处理：
   * - 内部会话产生的事件跳过（防递归触发）
   * - 重复事件（同去重键）跳过
   */
  shouldHandle(event: GuardedEvent): boolean {
    const key = `${event.type}:${event.sessionID ?? ""}:${event.id ?? ""}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > 10_000) {
      // 有界去重表
      const first = this.#seen.values().next().value;
      if (first !== undefined) this.#seen.delete(first);
    }
    return !this.isInternal(event.sessionID);
  }

  /** 工作区执行锁：同一工作区同时只允许一个根任务。 */
  acquireWorkspaceLock(workspaceRoot: string): boolean {
    const owner = RecursionGuard.#locks.get(workspaceRoot);
    if (owner && owner !== this.runId) return false;
    RecursionGuard.#locks.set(workspaceRoot, this.runId);
    return true;
  }

  releaseWorkspaceLock(workspaceRoot: string): void {
    if (RecursionGuard.#locks.get(workspaceRoot) === this.runId) RecursionGuard.#locks.delete(workspaceRoot);
  }

  listInternalSessions(): Array<{ sessionID: string; role: string }> {
    return [...this.#sessions.entries()].map(([sessionID, v]) => ({ sessionID, role: v.role }));
  }
}
