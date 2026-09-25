/**
 * 工作流编排器（§3.2 orchestrator/、§4 状态机）：
 * 需求 → 分析 → 规划 → 审批 → 实现 → 真实测试 → 评审 →（≤N 轮修复）→ 报告。
 * 模型负责判断，程序负责约束，工具负责证据；任何"完成"结论绑定真实测试结果。
 *
 * v1.1 增量：
 * - UI 事件总线（先落库后推送，§4.2）
 * - 用户介入策略与 CONSULTING 状态（§5.2）
 * - 旁路对话（FR-03，只产出建议，不执行修改）
 * - 模型切换审计（§6.3，阶段 → 实际使用模型）
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
import type { ModelRef, UIEvent } from "../protocols/ui-event";
import type { PromptSource } from "../prompts";
import { Planner, type UsageLike } from "../agents/planner";
import { Reviewer } from "../agents/reviewer";
import { detectTestTampering } from "../security/permissions";
import { BudgetTracker, DEFAULT_BUDGET, NoProgressTracker, type BudgetConfig, type ProgressSignature } from "./budget";
import { saveCheckpoint, restoreRun, type CheckpointPayload } from "./recovery";
import { EventBus } from "./event-bus";
import { PauseController, classifyIntervention } from "./interventions";
import { WorkflowMachine, isTerminal, type WorkflowEvent, type WorkflowState } from "./transitions";
import type { WorkflowController, RunStatus, ModelChannelName, ModelScope } from "../adapters/ui-channel-adapter";
import { exportProcessMarkdown } from "../reporting";

export interface ModelControl {
  current(): Record<string, ModelRef | null>;
  apply(input: {
    channel: ModelChannelName;
    model: ModelRef | null;
    scope: ModelScope;
  }): { model: ModelRef | null; effectiveFrom: string };
}

export interface RunHandle {
  attach(controller: WorkflowController, bus: EventBus): void;
}

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
  /** v1.1：UI 运行装配入口。 */
  runHandle?: RunHandle;
  /** v1.1：模型设置（任务/项目/全局）。 */
  modelControl?: ModelControl;
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

  // ---------------- v1.1：UI 事件总线 / 暂停 / 模型审计 ----------------
  const bus = new EventBus(deps.store, runId);
  const stageModels: Record<string, string> = {};
  const chatLog: Array<{ role: "user" | "assistant"; content: string }> = [];

  const ui = async (event: UIEvent): Promise<void> => {
    await bus.emit(event).catch((err: unknown) => {
      deps.logger.warn({ err }, "UI 事件落库失败");
    });
  };

  const recordUsage = (phase: string, usage: UsageLike) => {
    addUsage(usage);
    if (usage.model) stageModels[phase] = `${usage.model.providerID}/${usage.model.id}`;
  };

  const pause = new PauseController({
    onPause: (reason) => ui({ type: "workflow.paused", reason }),
    onResume: (reason) => ui({ type: "workflow.resumed", reason }),
  });

  /** 状态机跳转 + 阶段时间线事件。 */
  const send = async (event: WorkflowEvent, note = ""): Promise<WorkflowState> => {
    const to = machine.send(event);
    await ui({ type: "stage.changed", stage: to, at: new Date(clock.now()).toISOString(), note });
    return to;
  };
  const canSend = (event: WorkflowEvent): boolean => machine.can(event);

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

  const finish = async (): Promise<RunResult> => {
    const statusMap: Record<string, RunResult["status"]> = {
      COMPLETED: "completed",
      STOPPED: "stopped",
      BLOCKED: "blocked",
      CANCELLED: "cancelled",
      FAILED: "failed",
    };
    const status = statusMap[machine.state] ?? "failed";
    await ui({
      type: "run.finished",
      runId,
      status,
      summary: stopReason ?? state.review?.summary ?? "",
    });
    return {
      runId,
      status,
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
      stageModels,
      stopReason,
    };
  };

  const cancelled = () => {
    if (machine.can("CANCEL")) machine.send("CANCEL");
  };

  // ---------------- v1.1：运行控制器（UI 命令入口） ----------------
  const controller: WorkflowController = {
    status: (): RunStatus => ({
      runId,
      state: machine.state,
      stage: machine.state,
      round,
      running: !isTerminal(machine.state),
      paused: pause.paused,
      models: deps.modelControl?.current() ?? {},
    }),
    chat: async (message: string) => {
      const action = classifyIntervention(machine.state);
      await ui({ type: "chat.message", channel: "planner", role: "user", content: message });
      chatLog.push({ role: "user", content: message });

      if (action === "consult") {
        pause.request(`用户介入咨询：${message.slice(0, 80)}`);
      }

      // 思考模型只产出建议/计划；不得直接执行代码修改（§5.2）
      const { reply } = await planner.sideChat({
        context: {
          requirement: state.requirement,
          analysis: state.analysis,
          plan: state.plan,
          review: state.review,
          reports: state.reports,
          issues: state.issues,
        },
        history: chatLog.slice(-12, -1),
        message,
      });
      chatLog.push({ role: "assistant", content: reply });
      await ui({ type: "chat.message", channel: "planner", role: "assistant", content: reply });
      return { reply, action };
    },
    setModel: (input) => {
      const result = deps.modelControl?.apply(input) ?? { model: input.model, effectiveFrom: "next-stage" };
      // 运行中切换不热切换：当前阶段完成后生效（§6.3）
      void ui({
        type: "model.changed",
        channel: input.channel,
        model: input.model ?? { providerID: "", id: "" },
      });
      return result;
    },
    pause: (reason?: string) => pause.request(reason ?? "user-paused"),
    resume: () => pause.resume(),
    exportMarkdown: async () =>
      exportProcessMarkdown({
        runId,
        requirement: state.requirement,
        state: machine.state,
        round,
        stageModels,
        events: await bus.since(0),
        chatLog,
      }),
  };
  deps.runHandle?.attach(controller, bus);

  try {
    await ui({ type: "run.started", runId, requirement: options.requirement });

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
      await send("START");
      await checkpoint();

      // ---------------- ANALYZING ----------------
      const materials = await deps.workspace.materials();
      const analyzed = await planner.analyze({ requirement: state.requirement, materials });
      recordUsage("ANALYZING", analyzed.usage);
      state.analysis = analyzed.analysis;
      await ui({
        type: "planner.output",
        kind: "analysis",
        content: analyzed.analysis.understanding,
        payload: analyzed.analysis,
      });

      if (analyzed.analysis.questions.length > 0) {
        await send("ANALYSIS_QUESTIONS");
        await checkpoint();
        const answers = await deps.approvals.askUser(analyzed.analysis.questions);
        Object.assign(state.userAnswers, answers);
        await send("USER_RESPONDED");
      } else {
        await send("ANALYSIS_READY");
      }
      await checkpoint();

      // ---------------- PLANNING ----------------
      const planned = await planner.plan({
        requirement: state.requirement,
        analysis: state.analysis,
        materials,
      });
      recordUsage("PLANNING", planned.usage);
      state.plan = planned.plan;
      await ui({
        type: "planner.output",
        kind: "plan",
        content: planned.plan.architecture,
        payload: planned.plan,
      });
      await send("PLAN_READY");
      await checkpoint();

      // ---------------- WAITING_APPROVAL ----------------
      let planRejections = 0;
      for (;;) {
        const decision = await deps.approvals.requestPlanApproval(state.plan!);
        if (decision === "cancel") {
          cancelled();
          await checkpoint();
          return await finish();
        }
        if (decision === "approve") {
          await send("PLAN_APPROVED");
          break;
        }
        planRejections += 1;
        await send("PLAN_REJECTED");
        if (planRejections >= 2) {
          stopReason = "计划两次被用户拒绝";
          await send("NO_PROGRESS");
          await checkpoint();
          return await finish();
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
        recordUsage("REPLANNING", replanned.usage);
        state.plan = replanned.plan;
        await ui({ type: "planner.output", kind: "fix", content: replanned.plan.notes.join("\n"), payload: replanned.plan });
        await send("REPLAN_DONE");
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
        return await finish();
      }

      round += 1;
      budget.beginRound(round);
      const budgetStatus = budget.check();
      if (!budgetStatus.ok) {
        stopReason = budgetStatus.detail;
        await send("BUDGET_EXCEEDED");
        await checkpoint();
        return await finish();
      }

      // 安全点（§5.2）：暂停在原子操作之间生效
      await pause.safePoint(`round-${round}-start`);

      // ---------------- IMPLEMENTING ----------------
      const materials = await deps.workspace.materials();
      const useFixTask = round > 1 || state.review !== undefined;
      const tasksToRun: TaskPackage[] = useFixTask
        ? [buildFixTask(state.plan!, state.review, round)]
        : state.plan!.tasks;

      for (const task of tasksToRun) {
        await pause.safePoint(`task-${task.taskId}`);
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
        await ui({
          type: "coder.progress",
          taskId: task.taskId,
          action: "summary",
          content: coderResult.summary,
        });
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

      await send("IMPL_DONE");
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
      for (const report of reports) {
        await ui({ type: "test.report", report });
      }
      await send("VERIFY_DONE");
      await checkpoint();

      // ---------------- REVIEWING ----------------
      const reviewed = await reviewer.review({
        task: tasksToRun[0]!,
        diff,
        reports,
        issues: state.issues,
        materials,
      });
      recordUsage("REVIEWING", reviewed.usage);
      state.review = reviewed.review;
      await ui({
        type: "planner.output",
        kind: "review",
        content: reviewed.review.summary,
        payload: reviewed.review,
      });
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
              await send("NO_PROGRESS");
              await checkpoint();
              return await finish();
            }
            await send("REVIEW_FIXABLE");
            await checkpoint();
            break;
          }
          for (const issue of state.issues) {
            if (issue.status !== "wontfix") issue.status = "verified";
          }
          await deps.store.addIssues(runId, state.issues);
          await send("REVIEW_APPROVE");
          await checkpoint();
          await send("FINALIZE_DONE");
          await checkpoint();
          return await finish();
        }
        case "request_changes": {
          if (stalled) {
            stopReason = "连续 2 轮无进展（同类问题无改善）";
            await send("NO_PROGRESS");
            await checkpoint();
            return await finish();
          }
          await send("REVIEW_FIXABLE");
          await checkpoint();
          break;
        }
        case "replan": {
          await send("REVIEW_REPLAN");
          await checkpoint();
          const replanned = await planner.replan({
            requirement: state.requirement,
            analysis: state.analysis!,
            previousPlan: state.plan!,
            review: reviewed.review,
            reports,
            materials,
          });
          recordUsage("REPLANNING", replanned.usage);
          state.plan = replanned.plan;
          await ui({ type: "planner.output", kind: "fix", content: replanned.plan.notes.join("\n"), payload: replanned.plan });
          await send("REPLAN_DONE");
          await checkpoint();
          break;
        }
        case "blocked": {
          await send("REVIEW_BLOCKED");
          await checkpoint();
          return await finish();
        }
        case "ask_user": {
          await send("REVIEW_ASK");
          await checkpoint();
          const questions =
            reviewed.review.questions.length > 0
              ? reviewed.review.questions
              : ["评审需要用户决策，请给出继续方向"];
          const answers = await deps.approvals.askUser(questions);
          Object.assign(state.userAnswers, answers);
          await send("USER_RESPONDED");
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
          recordUsage("REPLANNING", replanned.usage);
          state.plan = replanned.plan;
          await ui({ type: "planner.output", kind: "fix", content: replanned.plan.notes.join("\n"), payload: replanned.plan });
          await send("PLAN_READY");
          await checkpoint();

          const decision = await deps.approvals.requestPlanApproval(state.plan!);
          if (decision === "cancel") {
            cancelled();
            await checkpoint();
            return await finish();
          }
          if (decision !== "approve") {
            stopReason = "重规划后的计划被用户拒绝";
            await send("PLAN_REJECTED");
            await send("NO_PROGRESS");
            await checkpoint();
            return await finish();
          }
          await send("PLAN_APPROVED");
          await checkpoint();
          break;
        }
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err);
    deps.logger.error({ runId, err: stopReason }, "工作流异常终止");
    if (canSend("ERROR")) await send("ERROR");
    await checkpoint().catch(() => {});
    return await finish();
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
