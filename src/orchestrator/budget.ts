/**
 * 预算与进展跟踪（§4.2 终止条件）：
 * - 最大轮次（默认 5）
 * - 超时（默认 30 分钟）
 * - token / 费用上限
 * - 无进展：同类问题连续 2 轮无改善
 */
import type { Clock } from "../ports";
import { systemClock } from "../ports";

export interface BudgetConfig {
  maxRounds: number;
  maxDurationMs: number;
  maxCostUsd: number;
  maxTokens: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxRounds: 5,
  maxDurationMs: 30 * 60_000,
  maxCostUsd: 10,
  maxTokens: 2_000_000,
};

export type BudgetExhaustion = "rounds" | "time" | "cost" | "tokens";

export type BudgetStatus = { ok: true } | { ok: false; reason: BudgetExhaustion; detail: string };

export interface BudgetSnapshot {
  startedAt: number;
  roundsUsed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class BudgetTracker {
  #startedAt: number;
  #roundsUsed = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;

  constructor(
    private readonly config: BudgetConfig = DEFAULT_BUDGET,
    private readonly clock: Clock = systemClock,
    snapshot?: BudgetSnapshot,
  ) {
    this.#startedAt = snapshot?.startedAt ?? clock.now();
    if (snapshot) {
      this.#roundsUsed = snapshot.roundsUsed;
      this.#inputTokens = snapshot.inputTokens;
      this.#outputTokens = snapshot.outputTokens;
      this.#costUsd = snapshot.costUsd;
    }
  }

  beginRound(round: number): void {
    this.#roundsUsed = Math.max(this.#roundsUsed, round);
  }

  addUsage(usage: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    this.#inputTokens += usage.inputTokens ?? 0;
    this.#outputTokens += usage.outputTokens ?? 0;
    this.#costUsd += usage.costUsd ?? 0;
  }

  check(): BudgetStatus {
    const { maxRounds, maxDurationMs, maxCostUsd, maxTokens } = this.config;
    if (this.#roundsUsed > maxRounds) {
      return { ok: false, reason: "rounds", detail: `修复轮次 ${this.#roundsUsed} 超过上限 ${maxRounds}` };
    }
    const elapsed = this.clock.now() - this.#startedAt;
    if (elapsed > maxDurationMs) {
      return { ok: false, reason: "time", detail: `耗时 ${Math.round(elapsed / 1000)}s 超过上限 ${Math.round(maxDurationMs / 1000)}s` };
    }
    if (this.#costUsd > maxCostUsd) {
      return { ok: false, reason: "cost", detail: `费用 $${this.#costUsd.toFixed(4)} 超过上限 $${maxCostUsd}` };
    }
    const tokens = this.#inputTokens + this.#outputTokens;
    if (tokens > maxTokens) {
      return { ok: false, reason: "tokens", detail: `token ${tokens} 超过上限 ${maxTokens}` };
    }
    return { ok: true };
  }

  snapshot(): BudgetSnapshot {
    return {
      startedAt: this.#startedAt,
      roundsUsed: this.#roundsUsed,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      costUsd: this.#costUsd,
    };
  }

  get usage() {
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      costUsd: this.#costUsd,
    };
  }
}

/**
 * 无进展检测：签名连续 2 轮无改善 → 停止（防“两模型互相认同错误”空转）。
 * 签名 = 未解决问题集合 + 失败检查集合 + 分数（问题越少分越低）。
 */
export interface ProgressSignature {
  openIssueIds: string[];
  failedChecks: string[];
  score: number;
}

export class NoProgressTracker {
  #last: ProgressSignature | null = null;
  #staleRounds = 0;

  record(signature: ProgressSignature): { stalled: boolean; staleRounds: number } {
    const improved =
      this.#last === null ||
      signature.score < this.#last.score ||
      signature.failedChecks.length < this.#last.failedChecks.length;
    const sameSet =
      this.#last !== null &&
      sameIds(signature.openIssueIds, this.#last.openIssueIds) &&
      sameIds(signature.failedChecks, this.#last.failedChecks);

    if (improved) this.#staleRounds = 0;
    else if (sameSet) this.#staleRounds += 1;
    else this.#staleRounds = 0;

    this.#last = signature;
    return { stalled: this.#staleRounds >= 2, staleRounds: this.#staleRounds };
  }

  snapshot(): { last: ProgressSignature | null; staleRounds: number } {
    return { last: this.#last, staleRounds: this.#staleRounds };
  }

  restore(state: { last: ProgressSignature | null; staleRounds: number }): void {
    this.#last = state.last;
    this.#staleRounds = state.staleRounds;
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
