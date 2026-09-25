/**
 * OpenCode 插件入口（§3.2 plugin.ts）：
 * 事件接入、交互入口（启动/审批/取消/报告），不承载核心业务逻辑。
 * 注册命令：
 *   /dual <需求>      启动双模型协作开发闭环
 *   /dual-probe       P1 六项能力验证
 *   /dual-resume      从最近检查点恢复运行
 */
import * as path from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Logger, RunResult, Store } from "./ports";
import { RoleModelGateway, type ModelRefLike } from "./adapters/model-gateway";
import {
  SessionApprovalGate,
  SessionCoderExecutor,
  createTextGenerator,
  type OpenCodeContextLike,
} from "./adapters/opencode-adapter";
import { RecursionGuard } from "./adapters/recursion-guard";
import { formatCapabilityReport, probeCapabilities } from "./adapters/capability-probe";
import { FileWorkspace } from "./workspace";
import { LocalVerifier } from "./verification";
import { SqliteStore } from "./storage";
import { FilePromptSource } from "./prompts";
import { createLogger } from "./logging";
import { runWorkflow } from "./orchestrator/workflow";
import { buildReport } from "./reporting";

interface DualAgentOptions {
  plannerModel?: ModelRefLike;
  coderModel?: ModelRefLike;
  maxRounds?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  workspaceBase?: string;
  artifactsBase?: string;
  /** CI / 无人值守：自动审批计划与操作。 */
  autoApprove?: boolean;
  logLevel?: string;
}

export default Plugin.define({
  id: "opencode-dual-agent",
  async setup(ctx) {
    const context = ctx as unknown as OpenCodeContextLike;
    const options = (context.options ?? {}) as DualAgentOptions;
    const logger: Logger = createLogger({ level: options.logLevel ?? "info" });

    await context.command.transform((editor) => {
      editor.add({
        name: "dual",
        description: "启动双模型协作开发闭环：规划/评审 + 编码 + 真实测试验证",
        execute: async (input: { sessionID: string; prompt: { text: string } }) => {
          const requirement = input.prompt.text.replace(/^\s*\/dual\s*/, "").trim();
          if (!requirement) {
            await context.session.synthetic({
              sessionID: input.sessionID,
              text: "用法：/dual <需求描述>",
            });
            return;
          }
          await startRun(context, logger, options, input.sessionID, requirement, { resume: false });
        },
      });

      editor.add({
        name: "dual-probe",
        description: "P1 六项能力验证（会话隔离/角色模型/生命周期/权限/工作目录/结果获取）",
        execute: async (input: { sessionID: string }) => {
          const reports = await probeCapabilities(context, { live: true });
          await context.session.synthetic({
            sessionID: input.sessionID,
            text: formatCapabilityReport(reports),
          });
        },
      });

      editor.add({
        name: "dual-resume",
        description: "从最近检查点恢复双模型协作运行",
        execute: async (input: { sessionID: string; prompt: { text: string } }) => {
          const requirement = input.prompt.text.replace(/^\s*\/dual-resume\s*/, "").trim();
          if (!requirement) {
            await context.session.synthetic({
              sessionID: input.sessionID,
              text: "用法：/dual-resume <原始需求描述>",
            });
            return;
          }
          await startRun(context, logger, options, input.sessionID, requirement, { resume: true });
        },
      });
    });

    logger.info({ directory: context.location?.directory }, "opencode-dual-agent 插件已加载");
    return async () => {
      logger.info({}, "opencode-dual-agent 插件卸载");
    };
  },
});

async function startRun(
  ctx: OpenCodeContextLike,
  logger: Logger,
  options: DualAgentOptions,
  sessionID: string,
  requirement: string,
  opts: { resume: boolean },
): Promise<RunResult> {
  const projectDir = ctx.location.project?.directory ?? ctx.location.directory;
  const dataDir = path.join(projectDir, ".opencode", "dual-agent");
  const runId = `run-${Date.now().toString(36)}`;

  const store: Store = new SqliteStore(path.join(dataDir, "state.sqlite"));
  const guard = new RecursionGuard(runId, store);
  const workspaceBase = options.workspaceBase ?? path.join(dataDir, "workspaces");

  let workspace: FileWorkspace | undefined;
  try {
    workspace = await FileWorkspace.create({
      source: projectDir,
      baseDir: workspaceBase,
      name: runId,
    });
    if (!guard.acquireWorkspaceLock(workspace.root)) {
      await ctx.session.synthetic({
        sessionID,
        text: "工作区执行锁被占用，本次运行取消（防递归触发）。",
      });
      return abortedResult(runId, workspace.root);
    }

    const gateway = new RoleModelGateway(
      createTextGenerator(ctx),
      {
        planner: options.plannerModel,
        reviewer: options.plannerModel,
        default: options.plannerModel ?? { providerID: "anthropic", id: "claude-sonnet-4-6" },
      },
      logger,
    );

    const verifier = new LocalVerifier({
      artifactsDir: options.artifactsBase ?? path.join(dataDir, "artifacts"),
    });

    const approvals = new SessionApprovalGate(ctx, logger, {
      sessionID,
      auto: options.autoApprove ? { plan: "approve", operation: true } : undefined,
      onTimeout: "reject",
    });

    const coder = new SessionCoderExecutor(
      ctx,
      new FilePromptSource(),
      logger,
      guard,
      { model: options.coderModel },
    );

    const result = await runWorkflow(
      {
        gateway,
        coder,
        verifier,
        workspace,
        approvals,
        store,
        prompts: new FilePromptSource(),
        logger,
        budget: {
          maxRounds: options.maxRounds,
          maxDurationMs: options.maxDurationMs,
          maxCostUsd: options.maxCostUsd,
          maxTokens: options.maxTokens,
        },
        runId,
      },
      { requirement, resume: opts.resume },
    );

    await ctx.session.synthetic({ sessionID, text: buildReport(result) });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "运行失败");
    await ctx.session
      .synthetic({ sessionID, text: `双模型协作运行失败：${message}` })
      .catch(() => {});
    return abortedResult(runId, workspace?.root);
  } finally {
    if (workspace) guard.releaseWorkspaceLock(workspace.root);
    await store.close();
  }
}

function abortedResult(runId: string, workspaceRoot?: string): RunResult {
  const now = Date.now();
  return {
    runId,
    status: "failed",
    state: "FAILED",
    roundsUsed: 0,
    finalReports: [],
    issues: [],
    changedFiles: [],
    workspaceRoot,
    stats: {
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    stopReason: "运行未能启动",
  };
}
