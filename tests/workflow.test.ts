import { describe, expect, it } from "vitest";
import { runWorkflow, buildFixTask } from "../src/orchestrator/workflow";
import { SqliteStore } from "../src/storage";
import { FilePromptSource } from "../src/prompts";
import { silentLogger } from "../src/logging";
import { saveCheckpoint, type CheckpointPayload } from "../src/orchestrator/recovery";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../src/ports";
import {
  ANALYSIS_OK,
  FakeCoder,
  FakeGateway,
  FakeVerifier,
  FakeWorkspace,
  findingFixture,
  makeReport,
  planFixture,
  reviewFixture,
} from "./helpers";

class FakeApprovals implements ApprovalGate {
  planQueue: ApprovalDecision[] = [];
  operationQueue: boolean[] = [];
  answers: string[] = [];
  asked: string[][] = [];
  operations: ApprovalRequest[] = [];

  async requestPlanApproval(): Promise<ApprovalDecision> {
    return this.planQueue.shift() ?? "approve";
  }

  async askUser(questions: string[]): Promise<Record<string, string>> {
    this.asked.push(questions);
    const answer = this.answers.shift() ?? "ok";
    return Object.fromEntries(questions.map((q) => [q, answer]));
  }

  async requestOperation(req: ApprovalRequest): Promise<boolean> {
    this.operations.push(req);
    return this.operationQueue.shift() ?? true;
  }
}

interface Setup {
  gateway: FakeGateway;
  workspace: FakeWorkspace;
  approvals: FakeApprovals;
  store: SqliteStore;
  coder: FakeCoder;
  verifier: FakeVerifier;
}

function setup(
  gatewayOptions: ConstructorParameters<typeof FakeGateway>[0],
  opts: {
    workspace?: FakeWorkspace;
    approvals?: FakeApprovals;
    verifierReports?: (input: { revision: string }) => ReturnType<typeof makeReport>[];
    budget?: Partial<{ maxRounds: number; maxDurationMs: number; maxCostUsd: number; maxTokens: number }>;
    runId?: string;
    signal?: AbortSignal;
  } = {},
): Setup {
  const workspace = opts.workspace ?? new FakeWorkspace();
  return {
    gateway: new FakeGateway(gatewayOptions),
    workspace,
    approvals: opts.approvals ?? new FakeApprovals(),
    store: new SqliteStore(),
    coder: new FakeCoder(),
    verifier: new FakeVerifier((input) =>
      (opts.verifierReports?.(input) ?? [makeReport(input.revision)]).map((r) => ({
        ...r,
        revision: input.revision,
      })),
    ),
    ...({ budget: opts.budget, runId: opts.runId, signal: opts.signal } as object),
  } as Setup & { budget?: unknown; runId?: string; signal?: AbortSignal };
}

async function run(s: Setup & { budget?: unknown; runId?: string; signal?: AbortSignal }, requirement = "实现 add 函数") {
  return runWorkflow(
    {
      gateway: s.gateway,
      coder: s.coder,
      verifier: s.verifier,
      workspace: s.workspace,
      approvals: s.approvals,
      store: s.store,
      prompts: new FilePromptSource(),
      logger: silentLogger,
      budget: s.budget as never,
      runId: s.runId,
      signal: s.signal,
    },
    { requirement },
  );
}

describe("runWorkflow 端到端（P2 MVP 闭环）", () => {
  it("一次通过：分析→规划→审批→实现→测试→评审→完成", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      review: [reviewFixture("approve")],
    });
    const result = await run(s);

    expect(result.status).toBe("completed");
    expect(result.state).toBe("COMPLETED");
    expect(result.roundsUsed).toBe(1);
    expect(result.finalRevision).toBe("rev-0");
    expect(result.finalReports.every((r) => r.revision === "rev-0")).toBe(true);
    expect(s.coder.executed).toHaveLength(1);
    expect(s.gateway.consumed).toEqual(["analyze", "plan", "review"]);
    expect(result.stats.inputTokens).toBeGreaterThan(0);
  });

  it("评审可修复 → 修复轮次 → 通过", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      review: [reviewFixture("request_changes", [findingFixture("ISSUE-001")]), reviewFixture("approve")],
    });
    const result = await run(s);

    expect(result.status).toBe("completed");
    expect(result.roundsUsed).toBe(2);
    expect(s.coder.executed).toHaveLength(2);
    expect(s.coder.executed[1]?.fixGuidance?.findings[0]?.issueId).toBe("ISSUE-001");
    expect(result.issues.find((i) => i.issueId === "ISSUE-001")?.status).toBe("verified");
  });

  it("计划被拒绝 → 重规划 → 实现 → 完成", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      replan: [planFixture({ architecture: "调整后的架构" })],
      review: [reviewFixture("approve")],
    });
    s.approvals.planQueue = ["reject"];
    s.approvals.answers = ["需要增加鉴权模块"];
    const result = await run(s);

    expect(result.status).toBe("completed");
    expect(result.plan?.architecture).toBe("调整后的架构");
    expect(s.gateway.consumed).toContain("replan");
    expect(s.approvals.asked).toHaveLength(1);
  });

  it("分析阶段向用户提问并采用答复", async () => {
    const s = setup({
      analyze: [{ ...ANALYSIS_OK, questions: ["需要支持多语言吗？"] }],
      plan: [planFixture()],
      review: [reviewFixture("approve")],
    });
    s.approvals.answers = ["仅中文"];
    const result = await run(s);

    expect(result.status).toBe("completed");
    expect(s.approvals.asked[0]).toEqual(["需要支持多语言吗？"]);
  });

  it("用户取消 → CANCELLED，且不触发实现", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
    });
    s.approvals.planQueue = ["cancel"];
    const result = await run(s);

    expect(result.status).toBe("cancelled");
    expect(result.state).toBe("CANCELLED");
    expect(s.coder.executed).toHaveLength(0);
  });

  it("评审 blocked → BLOCKED 并返回部分成果", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      review: [reviewFixture("blocked")],
    });
    const result = await run(s);

    expect(result.status).toBe("blocked");
    expect(result.state).toBe("BLOCKED");
    expect(result.finalRevision).toBe("rev-0");
  });

  it("评审 ask_user → 用户答复 → 重规划（重新审批）→ 完成", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      replan: [planFixture()],
      review: [reviewFixture("ask_user", [], { questions: ["用 SQLite 还是 JSON 存储？"] }), reviewFixture("approve")],
    });
    s.approvals.answers = ["SQLite"];
    const result = await run(s);

    expect(result.status).toBe("completed");
    expect(s.approvals.asked[0]).toEqual(["用 SQLite 还是 JSON 存储？"]);
    // 初始计划 + 重规划后计划共两次审批
    expect(result.roundsUsed).toBe(2);
  });

  it("连续 2 轮无进展 → STOPPED", async () => {
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
      review: [
        reviewFixture("request_changes", [findingFixture("ISSUE-001")]),
        reviewFixture("request_changes", [findingFixture("ISSUE-001")]),
        reviewFixture("request_changes", [findingFixture("ISSUE-001")]),
      ],
    });
    const result = await run(s);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toContain("无进展");
    expect(result.roundsUsed).toBe(3);
  });

  it("超出修复轮次预算 → STOPPED", async () => {
    const s = setup(
      {
        analyze: [ANALYSIS_OK],
        plan: [planFixture()],
        review: [reviewFixture("request_changes", [findingFixture("ISSUE-001")])],
      },
      { budget: { maxRounds: 1 } },
    );
    const result = await run(s);

    expect(result.status).toBe("stopped");
    expect(result.state).toBe("STOPPED");
    expect(result.stopReason).toContain("轮次");
  });

  it("评审 approve 但测试失败时以证据为准，不宣告完成", async () => {
    const s = setup(
      {
        analyze: [ANALYSIS_OK],
        plan: [planFixture()],
        review: [reviewFixture("approve")],
      },
      {
        budget: { maxRounds: 1 },
        verifierReports: ({ revision }) => [
          makeReport(revision, {
            checkId: "test",
            status: "failed",
            exitCode: 1,
            failedTests: [{ name: "add works", summary: "expected 3" }],
          }),
        ],
      },
    );
    const result = await run(s);

    expect(result.status).not.toBe("completed");
    expect(result.state).toBe("STOPPED");
  });

  it("测试被修改且未获批准 → 记录 blocker 并阻止完成", async () => {
    const workspace = new FakeWorkspace(
      "/tmp/ws",
      [
        "--- a/tests/index.test.ts",
        "+++ b/tests/index.test.ts",
        "-  it('add works', () => {",
        "+  it.skip('add works', () => {",
      ].join("\n"),
      ["tests/index.test.ts"],
    );
    const s = setup(
      {
        analyze: [ANALYSIS_OK],
        plan: [planFixture()],
        review: [reviewFixture("approve")],
      },
      { workspace, budget: { maxRounds: 1 } },
    );
    s.approvals.operationQueue = [false];
    const result = await run(s);

    expect(s.approvals.operations[0]?.kind).toBe("test-modification");
    const tamper = result.issues.find((i) => i.issueId.startsWith("ISSUE-TAMPER"));
    expect(tamper?.severity).toBe("blocker");
    expect(tamper?.status).toBe("open");
    expect(result.status).not.toBe("completed");
  });

  it("取消信号生效 → CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();
    const s = setup({
      analyze: [ANALYSIS_OK],
      plan: [planFixture()],
    });
    (s as { signal?: AbortSignal }).signal = controller.signal;
    const result = await run(s);
    expect(result.status).toBe("cancelled");
    expect(s.coder.executed).toHaveLength(0);
  });

  it("从检查点恢复（§8.5）：跳过分析与规划，继续修复循环", async () => {
    const runId = "run-resume-test";
    const s = setup({ review: [reviewFixture("approve")] }, { runId, budget: { maxRounds: 5 } });

    const payload: CheckpointPayload = {
      requirement: "实现 add 函数",
      analysis: ANALYSIS_OK,
      plan: planFixture(),
      reports: [],
      issues: [],
      changedFiles: [],
      budget: { startedAt: Date.now(), roundsUsed: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
      progress: { last: null, staleRounds: 0 },
      userAnswers: {},
    };
    await saveCheckpoint(s.store, {
      runId,
      state: "IMPLEMENTING",
      round: 1,
      payload,
    });

    const result = await runWorkflow(
      {
        gateway: s.gateway,
        coder: s.coder,
        verifier: s.verifier,
        workspace: s.workspace,
        approvals: s.approvals,
        store: s.store,
        prompts: new FilePromptSource(),
        logger: silentLogger,
        runId,
      },
      { requirement: "实现 add 函数", resume: true },
    );

    expect(result.status).toBe("completed");
    expect(s.gateway.consumed).toEqual(["review"]); // 未重新分析/规划
  });
});

describe("buildFixTask", () => {
  it("修复任务包沿用计划栈与白名单并合并验收项", () => {
    const plan = planFixture() as never as Parameters<typeof buildFixTask>[0];
    const task = buildFixTask(plan, undefined, 2);
    expect(task.taskId).toBe("task-102");
    expect(task.stack.language).toBe("TypeScript");
    expect(task.allowedPaths).toContain("src/**");
    expect(task.acceptanceCriteria[0]?.id).toBe("AC-01");
    expect(task.objective).toContain("修复轮次 2");
  });
});
