import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  WorkflowMachine,
  isTerminal,
  nextState,
} from "../src/orchestrator/transitions";

describe("状态机转换表（§4）", () => {
  it("主链路 CREATED → … → COMPLETED", () => {
    const path = [
      ["CREATED", "START", "ANALYZING"],
      ["ANALYZING", "ANALYSIS_READY", "PLANNING"],
      ["PLANNING", "PLAN_READY", "WAITING_APPROVAL"],
      ["WAITING_APPROVAL", "PLAN_APPROVED", "IMPLEMENTING"],
      ["IMPLEMENTING", "IMPL_DONE", "VERIFYING"],
      ["VERIFYING", "VERIFY_DONE", "REVIEWING"],
      ["REVIEWING", "REVIEW_APPROVE", "FINALIZING"],
      ["FINALIZING", "FINALIZE_DONE", "COMPLETED"],
    ] as const;
    for (const [from, event, to] of path) {
      expect(nextState(from, event)).toBe(to);
    }
  });

  it("评审分支：可修复 / 重规划 / 阻塞 / 询问用户", () => {
    expect(nextState("REVIEWING", "REVIEW_FIXABLE")).toBe("IMPLEMENTING");
    expect(nextState("REVIEWING", "REVIEW_REPLAN")).toBe("REPLANNING");
    expect(nextState("REPLANNING", "REPLAN_DONE")).toBe("IMPLEMENTING");
    expect(nextState("REVIEWING", "REVIEW_BLOCKED")).toBe("BLOCKED");
    expect(nextState("REVIEWING", "REVIEW_ASK")).toBe("WAITING_USER");
    expect(nextState("WAITING_USER", "USER_RESPONDED")).toBe("PLANNING");
  });

  it("终止条件：超预算 / 无进展 → STOPPED", () => {
    expect(nextState("REVIEWING", "BUDGET_EXCEEDED")).toBe("STOPPED");
    expect(nextState("IMPLEMENTING", "NO_PROGRESS")).toBe("STOPPED");
  });

  it("任意活动状态可取消 / 出错", () => {
    expect(nextState("ANALYZING", "CANCEL")).toBe("CANCELLED");
    expect(nextState("WAITING_APPROVAL", "CANCEL")).toBe("CANCELLED");
    expect(nextState("REVIEWING", "ERROR")).toBe("FAILED");
  });

  it("非法转换抛错", () => {
    expect(() => nextState("CREATED", "IMPL_DONE")).toThrow(IllegalTransitionError);
    expect(() => nextState("COMPLETED", "START")).toThrow(IllegalTransitionError);
    expect(() => nextState("COMPLETED", "CANCEL")).toThrow(IllegalTransitionError);
  });

  it("终态判定", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("STOPPED")).toBe(true);
    expect(isTerminal("IMPLEMENTING")).toBe(false);
  });
});

describe("WorkflowMachine", () => {
  it("记录转换历史并可快照", () => {
    let t = 0;
    const machine = new WorkflowMachine(() => ++t);
    machine.send("START");
    machine.send("ANALYSIS_READY");
    expect(machine.state).toBe("PLANNING");
    expect(machine.history).toHaveLength(2);
    expect(machine.history[0]).toMatchObject({ from: "CREATED", event: "START", to: "ANALYZING" });

    const snap = machine.snapshot();
    const restored = new WorkflowMachine(() => 0, snap);
    expect(restored.state).toBe("PLANNING");
    expect(restored.history).toHaveLength(2);
  });

  it("can() 预检非法事件", () => {
    const machine = new WorkflowMachine();
    expect(machine.can("START")).toBe(true);
    expect(machine.can("REVIEW_APPROVE")).toBe(false);
  });
});
