import { describe, expect, it } from "vitest";
import {
  BudgetTracker,
  DEFAULT_BUDGET,
  NoProgressTracker,
} from "../src/orchestrator/budget";

describe("BudgetTracker", () => {
  it("修复轮次上限", () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGET, maxRounds: 2 }, { now: () => 0 });
    tracker.beginRound(1);
    expect(tracker.check().ok).toBe(true);
    tracker.beginRound(2);
    expect(tracker.check().ok).toBe(true);
    tracker.beginRound(3);
    const status = tracker.check();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe("rounds");
  });

  it("超时上限", () => {
    let now = 0;
    const tracker = new BudgetTracker(
      { ...DEFAULT_BUDGET, maxDurationMs: 1000 },
      { now: () => now },
    );
    now = 999;
    expect(tracker.check().ok).toBe(true);
    now = 1001;
    const status = tracker.check();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe("time");
  });

  it("费用与 token 上限", () => {
    const tracker = new BudgetTracker(
      { ...DEFAULT_BUDGET, maxCostUsd: 1, maxTokens: 100 },
      { now: () => 0 },
    );
    tracker.addUsage({ inputTokens: 60, outputTokens: 30, costUsd: 0.5 });
    expect(tracker.check().ok).toBe(true);
    tracker.addUsage({ inputTokens: 10, outputTokens: 10, costUsd: 0.6 });
    const status = tracker.check();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe("cost");
  });

  it("可快照恢复", () => {
    const tracker = new BudgetTracker(DEFAULT_BUDGET, { now: () => 100 });
    tracker.beginRound(2);
    tracker.addUsage({ inputTokens: 5, outputTokens: 5, costUsd: 0.1 });
    const restored = new BudgetTracker(DEFAULT_BUDGET, { now: () => 100 }, tracker.snapshot());
    expect(restored.snapshot()).toEqual(tracker.snapshot());
    expect(restored.usage).toEqual({ inputTokens: 5, outputTokens: 5, costUsd: 0.1 });
  });
});

describe("NoProgressTracker", () => {
  it("同类问题连续 2 轮无改善判定停滞", () => {
    const tracker = new NoProgressTracker();
    const sig = (score: number, ids = ["ISSUE-001"], checks = ["test"]) => ({
      openIssueIds: ids,
      failedChecks: checks,
      score,
    });

    expect(tracker.record(sig(10)).stalled).toBe(false); // 首轮
    expect(tracker.record(sig(10)).stalled).toBe(false); // 第 1 轮无改善
    const third = tracker.record(sig(10)); // 第 2 轮无改善
    expect(third.stalled).toBe(true);
    expect(third.staleRounds).toBe(2);
  });

  it("有改善即重置", () => {
    const tracker = new NoProgressTracker();
    tracker.record({ openIssueIds: ["A"], failedChecks: ["test"], score: 10 });
    tracker.record({ openIssueIds: ["A"], failedChecks: ["test"], score: 10 });
    expect(tracker.record({ openIssueIds: [], failedChecks: [], score: 0 }).stalled).toBe(false);
    expect(tracker.record({ openIssueIds: [], failedChecks: [], score: 0 }).stalled).toBe(false);
    expect(tracker.record({ openIssueIds: [], failedChecks: [], score: 0 }).stalled).toBe(true);
  });
});
