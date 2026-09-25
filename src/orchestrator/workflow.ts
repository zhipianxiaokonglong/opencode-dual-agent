/**
 * 工作流编排器（§3.2 orchestrator/、§4 状态机）：
 * 需求 → 分析 → 规划 → 审批 → 实现 → 真实测试 → 评审 →（≤N 轮修复）→ 报告。
 * 模型负责判断，程序负责约束，工具负责证据；任何"完成"结论绑定真实测试结果。
 */
import { randomUUID } from "node:crypto";
import type {
  ApprovalGate,
  Clock,
  CoderExecutor,
  Logger,
  ModelGateway,
  RunResult,
  Store,
  Verifier,
  Workspace,
} from "../ports";
import { systemClock } from "../ports";
import {
  TaskPackageSchema,
  type AnalysisResult,
  type IssueLedgerEntry,
  type Plan,
  type ReviewResult,
  type TaskPackage,
  type TestReport,
} from "../protocols";
import type { PromptSource } from "../prompts";
import { Planner, type UsageLike } from "../agents/planner";
import { Reviewer } from "../agents/reviewer";
import { detectTestTampering } from "../security/permissions";
import { BudgetTracker, DEFAULT_BUDGET, NoProgressTracker, type BudgetConfig, type ProgressSignature } from "./budget";
import { saveCheckpoint, restoreRun, type CheckpointPayload } from "./recovery";
import { WorkflowMachine, type WorkflowState } from "./transitions";

export interface WorkflowDeps {
  gateway: ModelGateway;
  coder: CoderExecutor;
  verifier: Verifier;
  workspace: Workspace;
  approvals: ApprovalGate;
  store: Store;
  prompts: PromptSource;
  logger: Logger;
  clock?: Clock;
  budget?: Partial<BudgetConfig>;
  runId?: string;
  signal?: AbortSignal;
}

export interface WorkflowOptions {
  requirement: string;
  /** 从最近检查点恢复（§8.5）。 */
  resume?: boolean;
}

interface RunStateData {
  requirement: string;
  analysis?: AnalysisResult;
  plan?: Plan;
  review?: ReviewResult;
  reports: TestReport[];
  issues: IssueLedgerEntry[];
  changedFiles: string[];
  finalRevision?: string;
  userAnswers: Record<string, string>;
}

export async function runWorkflow(deps: WorkflowDeps, options: WorkflowOptions): Promise<RunResult> {
  const clock = deps.clock ?? systemClock;
  const runId = deps.runId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, ...deps.budget };
  const startedAt = clock.now();

  const planner = new Planner(deps.gateway, deps.prompts, deps.logger);
  const reviewer = new Reviewer(deps.gateway, deps.prompts, deps.logger);

  const state: RunStateData = {
    requirement: options.requirement,
    reports: [],
    issues: [],
    changedFiles: [],
    userAnswers: {},
  };
  let budget = new BudgetTracker(budgetConfig, clock);
  const progress = new NoProgressTracker();
  let machine = new WorkflowMachine(() => clock.now());
  let round = 0;
  let stopReason: string | undefined;

  const usageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const addUsage = (u: UsageLike) => {
    budget.addUsage(u);
    usageTotals.inputTokens += u.inputTokens;
    usageTotals.outputTokens += u.outputTokens;
    usageTotals.costUsd += u.costUsd;
  };

  const snapshotPayload = (): CheckpointPayload => ({
    requirement: state.requirement,
    analysis: state.analysis,
    plan: state.plan,
    review: state.review,
    reports: state.reports,
    issues: state.issues,
    changedFiles: state.changedFiles,
    finalRevision: state.finalRevision,
    budget: budget.snapshot(),
    progress: progress.snapshot(),
    userAnswers: state.userAnswers,
  });

  const checkpoint = async () => {
    await saveCheckpoint(deps.store, {
      runId,
      state: machine.state,
      round,
      payload: snapshotPayload(),
    });
  };

  const finish = (): RunResult => {
    const statusMap: Record<string, RunResult["status"]> = {
      COMPLETED: "completed",
      STOPPED: "stopped",
      BLOCKED: "blocked",
      CANCELLED: "cancelled",
      FAILED: "failed",
    };
    return {
      runId,
      status: statusMap[machine.state] ?? "failed",
      state: machine.state,
      roundsUsed: round,
      analysis: state.analysis,
      plan: state.plan,
      finalRevision: state.finalRevision,
      finalReports: state.reports,
      review: state.review,
      issues: [...state.issues],
      changedFiles: [...state.changedFiles],
      workspaceRoot: deps.workspace.root,
      stats: {
        startedAt,
        endedAt: clock.now(),
        durationMs: clock.now() - startedAt,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        costUsd: usageTotals.costUsd,
      },
      stopReason,
    };
  };

  const cancelled = () => {
    if (machine.can("CANCEL")) machine.send("CANCEL");
  };

  try {
    // ---------------- 恢复（§8.5） ----------------
    if (options.resume) {
      const restored = await restoreRun(deps.store, runId);
      if (restored && !isTerminalState(restored.state)) {
        Object.assign(state, {
          analysis: restored.payload.analysis,
          plan: restored.payload.plan,
          review: restored.payload.review,
          reports: restored.payload.reports,
          issues: restored.payload.issues,
          changedFiles: restored.payload.changedFiles,
          finalRevision: restored.payload.finalRevision,
          userAnswers: restored.payload.userAnswers,
        });
        if (restored.payload.budget) budget = new BudgetTracker(budgetConfig, clock, restored.payload.budget);
        if (restored.payload.progress) progress.restore(restored.payload.progress);
        round = restored.payload.budget?.roundsUsed ?? 0;
        machine = new WorkflowMachine(() => clock.now(), {
          state: "IMPLEMENTING",
          history: [],
        });
        deps.logger.info({ runId, from: restored.state, round }, "从检查点恢复运行");
      }
    }

    const resumed = machine.state !== "CREATED";
    if (!resumed) {
      machine.send("START");
      await checkpoint();

      // ---------------- ANALYZING ----------------
      const materials = await deps.workspace.materials();
      const analyzed = await planner.analyze({ requirement: state.requirement, materials });
      addUsage(analyzed.usage);
      state.analysis = analyzed.analysis;

      if (analyzed.analysis.questions.length > 0) {
        machine.send("ANALYSIS_QUESTIONS");
        await checkpoint();
        const answers = await deps.approvals.askUser(analyzed.analysis.questions);
        Object.assign(state.userAnswers, answers);
        machine.send("USER_RESPONDED");
      } else {
        machine.send("ANALYSIS_READY");
      }
      await checkpoint();

      // ---------------- PLANNING ----------------
      const planned = await planner.plan({
        requirement: state.requirement,
        analysis: state.analysis,
        materials,
      });
      addUsage(planned.usage);
      state.plan = planned.plan;
      machine.send("PLAN_READY");
      await checkpoint();

      // ---------------- WAITING_APPROVAL ----------------
      let planRejections = 0;
      for (;;) {
        const decision = await deps.approvals.requestPlanApproval(state.plan!);
        if (decision === "cancel") {
          cancelled();
          await checkpoint();
          return finish();
        }
        if (decision === "approve") {
          machine.send("PLAN_APPROVED");
          break;
        }
        planRejections += 1;
        machine.send("PLAN_REJECTED");
        if (planRejections >= 2) {
          stopReason = "计划两次被用户拒绝";
          machine.send("NO_PROGRESS");
          await checkpoint();
          return finish();
        }
        const feedback = await deps.approvals.askUser(["计划被拒绝：请说明需要调整的方向"]);
        Object.assign(state.userAnswers, feedback);
        const replanned = await planner.replan({
          requirement: state.requirement,
          analysis: state.analysis!,
          previousPlan: state.plan!,
          review: {
            decision: "replan",
            findings: [],
            summary: `用户拒绝计划：${Object.values(feedback).join("；") || "未说明原因"}`,
            questions: [],
          },
          reports: state.reports,
          materials,
        });
        addUsage(replanned.usage);
        state.plan = replanned.plan;
        machine.send("REPLAN_DONE");
        await checkpoint();
        break;
      }
    } else if (!state.plan) {
      throw new Error("检查点缺少计划，无法恢复");
    }

    // ---------------- 修复循环：IMPLEMENTING → VERIFYING → REVIEWING ----------------
    for (;;) {
      if (deps.signal?.aborted) {
        cancelled();
        await checkpoint();
        return finish();
      }

      round += 1;
      budget.beginRound(round);
      const budgetStatus = budget.check();
      if (!budgetStatus.ok) {
        stopReason = budgetStatus.detail;
        machine.send("BUDGET_EXCEEDED");
        await checkpoint();
        return finish();
      }

      // ---------------- IMPLEMENTING ----------------
      const materials = await deps.workspace.materials();
      const useFixTask = round > 1 || state.review !== undefined;
      const tasksToRun: TaskPackage[] = useFixTask
        ? [buildFixTask(state.plan!, state.review, round)]
        : state.plan!.tasks;

      for (const task of tasksToRun) {
        const coderResult = await deps.coder.execute({
          workspace: deps.workspace,
          round,
          task,
          openIssues: state.issues.filter((i) => i.status === "open" || i.status === "fixing"),
          fixGuidance: state.review,
          signal: deps.signal ?? new AbortController().signal,
        });
        for (const f of coderResult.changedFiles) {
          if (!state.changedFiles.includes(f)) state.changedFiles.push(f);
        }
      }

      const revision = await deps.workspace.revision();
      state.finalRevision = revision;
      const diff = await deps.workspace.diff();

      // 防"改测试作弊"（§8.3）：差异显式标记 + 人工审批
      const tamper = detectTestTampering(diff, state.changedFiles);
      if (tamper.length > 0) {
        const approved = await deps.approvals.requestOperation({
          kind: "test-modification",
          detail: tamper.map((t) => `${t.kind}: ${t.file} — ${t.detail}`).join("\n"),
        });
        if (!approved) {
          state.issues.push({
            issueId: `ISSUE-TAMPER-${round}`,
            summary: `测试被修改且未获人工批准：${tamper.map((t) => t.kind).join(", ")}`,
            severity: "blocker",
            status: "open",
            relatedCriteria: [],
            location: tamper[0]?.file ?? "",
            round,
          });
        }
      }

      machine.send("IMPL_DONE");
      await checkpoint();

      // ---------------- VERIFYING ----------------
      const profile = tasksToRun[0]!.verificationProfile;
      const reports = await deps.verifier.run({
        workspace: deps.workspace,
        profile,
        revision,
        signal: deps.signal ?? new AbortController().signal,
      });
      state.reports = reports;
      machine.send("VERIFY_DONE");
      await checkpoint();

      // ---------------- REVIEWING ----------------
      const reviewed = await reviewer.review({
        task: tasksToRun[0]!,
        diff,
        reports,
        issues: state.issues,
        materials,
      });
      addUsage(reviewed.usage);
      state.review = reviewed.review;
      mergeFindings(state, reviewed.review, round);
      await deps.store.addIssues(runId, state.issues);

      const signature = progressSignature(state);
      const { stalled } = progress.record(signature);
      await checkpoint();

      switch (reviewed.review.decision) {
        case "approve": {
          const allChecksOk = reports.every(
            (r) => r.status === "passed" || r.status === "not_run" || r.status === "skipped",
          );
          const openBlockers = state.issues.some((i) => i.status === "open" && i.severity === "blocker");
          if (!allChecksOk || openBlockers) {
            // 防御：评审结论与证据不一致时，以真实证据为准（§2 证据优先）
            deps.logger.warn(
              { runId, round, allChecksOk, openBlockers },
              "评审 approve 但存在失败检查/未决 blocker，按 request_changes 处理",
            );
            if (stalled) {
              stopReason = "连续 2 轮无进展且测试未通过";
              machine.send("NO_PROGRESS");
              await checkpoint();
              return finish();
            }
            machine.send("REVIEW_FIXABLE");
            await checkpoint();
            break;
          }
          for (const issue of state.issues) {
            if (issue.status !== "wontfix") issue.status = "verified";
          }
          await deps.store.addIssues(runId, state.issues);
          machine.send("REVIEW_APPROVE");
          await checkpoint();
          machine.send("FINALIZE_DONE");
          await checkpoint();
          return finish();
        }
        case "request_changes": {
          if (stalled) {
            stopReason = "连续 2 轮无进展（同类问题无改善）";
            machine.send("NO_PROGRESS");
            await checkpoint();
            return finish();
          }
          machine.send("REVIEW_FIXABLE");
          await checkpoint();
          break;
        }
        case "replan": {
          machine.send("REVIEW_REPLAN");
          await checkpoint();
          const replanned = await planner.replan({
            requirement: state.requirement,
            analysis: state.analysis!,
            previousPlan: state.plan!,
            review: reviewed.review,
            reports,
            materials,
          });
          addUsage(replanned.usage);
          state.plan = replanned.plan;
          machine.send("REPLAN_DONE");
          await checkpoint();
          break;
        }
        case "blocked": {
          machine.send("REVIEW_BLOCKED");
          await checkpoint();
          return finish();
        }
        case "ask_user": {
          machine.send("REVIEW_ASK");
          await checkpoint();
          const questions =
            reviewed.review.questions.length > 0
              ? reviewed.review.questions
              : ["评审需要用户决策，请给出继续方向"];
          const answers = await deps.approvals.askUser(questions);
          Object.assign(state.userAnswers, answers);
          machine.send("USER_RESPONDED");
          await checkpoint();

          // 用户答复进入重规划，产出的新计划需重新审批
          const replanned = await planner.replan({
            requirement: state.requirement,
            analysis: state.analysis!,
            previousPlan: state.plan!,
            review: {
              ...reviewed.review,
              summary: `${reviewed.review.summary}\n用户答复：${JSON.stringify(answers)}`,
            },
            reports,
            materials,
          });
          addUsage(replanned.usage);
          state.plan = replanned.plan;
          machine.send("PLAN_READY");
          await checkpoint();

          const decision = await deps.approvals.requestPlanApproval(state.plan!);
          if (decision === "cancel") {
            cancelled();
            await checkpoint();
            return finish();
          }
          if (decision !== "approve") {
            stopReason = "重规划后的计划被用户拒绝";
            machine.send("PLAN_REJECTED");
            machine.send("NO_PROGRESS");
            await checkpoint();
            return finish();
          }
          machine.send("PLAN_APPROVED");
          await checkpoint();
          break;
        }
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err);
    deps.logger.error({ runId, err: stopReason }, "工作流异常终止");
    if (machine.can("ERROR")) machine.send("ERROR");
    await checkpoint().catch(() => {});
    return finish();
  }
}

// ---------------------------------------------------------------------------

/** 修复任务包：由评审结论派生，沿用计划的栈与白名单（最小授权）。 */
export function buildFixTask(plan: Plan, review: ReviewResult | undefined, round: number): TaskPackage {
  const allowedPaths = [...new Set(plan.tasks.flatMap((t) => t.allowedPaths))];
  const criteriaMap = new Map<string, string>();
  for (const task of plan.tasks) {
    for (const ac of task.acceptanceCriteria) criteriaMap.set(ac.id, ac.description);
  }
  const acceptanceCriteria =
    criteriaMap.size > 0
      ? [...criteriaMap.entries()].map(([id, description]) => ({ id, description }))
      : [{ id: "AC-01", description: "评审问题全部修复且必需检查通过" }];

  return TaskPackageSchema.parse({
    taskId: `task-${String(100 + round).padStart(3, "0")}`,
    objective: `修复评审发现的问题并补齐回归测试（修复轮次 ${round}）`,
    stack: plan.tasks[0]!.stack,
    constraints: plan.tasks.flatMap((t) => t.constraints).slice(0, 10),
    acceptanceCriteria,
    allowedPaths,
    verificationProfile: plan.tasks[0]!.verificationProfile,
    deliverables: ["修复代码", "回归测试", "修改摘要"],
  });
}

/** 问题台账合并（§8.6）：本轮未复现的问题标记 fixed，approve 后统一 verified。 */
function mergeFindings(state: RunStateData, review: ReviewResult, round: number): void {
  const mentioned = new Set<string>();
  for (const f of review.findings) {
    mentioned.add(f.issueId);
    const entry: IssueLedgerEntry = {
      issueId: f.issueId,
      summary: f.causeHypothesis || f.suggestedFix,
      severity: f.severity,
      status: "open",
      relatedCriteria: f.relatedCriteria,
      location: f.location,
      round,
    };
    const existing = state.issues.find((i) => i.issueId === f.issueId);
    if (existing) Object.assign(existing, entry);
    else state.issues.push(entry);
  }
  for (const issue of state.issues) {
    // 程序生成的人工升级问题（如未批准的测试修改）只能由人工解除，不自动收敛
    if (issue.issueId.startsWith("ISSUE-TAMPER")) continue;
    if (issue.status === "open" && !mentioned.has(issue.issueId)) {
      issue.status = review.decision === "approve" ? "verified" : "fixed";
    }
  }
}

function progressSignature(state: RunStateData): ProgressSignature {
  const open = state.issues.filter((i) => i.status === "open");
  const failedChecks = state.reports
    .filter((r) => r.status === "failed" || r.status === "error")
    .map((r) => r.checkId);
  const score =
    open.reduce((sum, i) => sum + (i.severity === "blocker" ? 10 : i.severity === "major" ? 3 : 1), 0) +
    failedChecks.length * 5;
  return { openIssueIds: open.map((i) => i.issueId), failedChecks, score };
}

function isTerminalState(state: string): boolean {
  return state === "COMPLETED" || state === "STOPPED" || state === "CANCELLED" || state === "FAILED";
}

export type { WorkflowState };
