/**
 * OpenCode 插件入口（§3.2 plugin.ts）：
 * 事件接入、交互入口（启动/审批/取消/报告）、v1.1 UI 通道装配，不承载核心业务逻辑。
 * 注册命令：
 *   /dual <需求>      启动双模型协作开发闭环
 *   /dual-probe       P1 六项能力验证
 *   /dual-resume      从最近检查点恢复运行
 *
 * v1.1：插件 RPC（dual-agent）+ 本地 UI 桥接服务（默认 http://127.0.0.1:4700）。
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
import { runWorkflow, type ModelControl, type RunHandle } from "./orchestrator/workflow";
import { UIChannel } from "./adapters/ui-channel-adapter";
import { formatCapabilityReport, probeCapabilities } from "./adapters/capability-probe";
import { ModelSettings } from "./config/model-settings";
import { FileWorkspace } from "./workspace";
import { LocalVerifier } from "./verification";
import { createStore } from "./storage";
import { FilePromptSource } from "./prompts";
import { createLogger } from "./logging";
import { buildReport } from "./reporting";
import { DualAgent } from "./rpc";
import { startUIServer, type UIServer } from "./ui/server";

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
  /** v1.1：UI 桥接服务（默认 127.0.0.1:4700；uiEnabled=false 关闭）。 */
  uiEnabled?: boolean;
  uiPort?: number;
  uiHost?: string;
}

export default Plugin.define({
  id: "opencode-dual-agent",
  async setup(ctx) {
    const context = ctx as unknown as OpenCodeContextLike;
    const options = (context.options ?? {}) as DualAgentOptions;
    const logger: Logger = createLogger({ level: options.logLevel ?? "info" });

    // ---------------- v1.1：UI 通道（RPC + 本地桥接服务） ----------------
    const channel = new UIChannel(logger);
    const modelSettings = ModelSettings.load(
      path.join(context.location.directory, ".opencode", "dual-agent", "models.json"),
    );
    let rpcDispose: (() => Promise<void>) | undefined;
    if (typeof context.rpc?.register === "function") {
      const registration = await context.rpc.register(DualAgent, channel.handlers() as unknown as Record<string, unknown>);
      channel.attachEmitter(async (envelope) => {
        await registration.events.emit("ui", envelope as unknown);
      });
      rpcDispose = () => registration.dispose();
    }

    let uiServer: UIServer | undefined;
    if (options.uiEnabled !== false) {
      try {
        uiServer = await startUIServer({
          channel,
          logger,
          port: options.uiPort ?? 4700,
          host: options.uiHost,
          listModels: async () => {
            try {
              const raw = (await context.model?.list?.()) as unknown;
              const models: Array<Record<string, unknown>> = Array.isArray(raw)
                ? (raw as Array<Record<string, unknown>>)
                : ((raw as { data?: Array<Record<string, unknown>> })?.data ?? []);
              return models.map((m) => ({
                providerID: String(m.providerID ?? ""),
                id: String(m.id ?? ""),
                name: m.name ? String(m.name) : undefined,
                contextLength:
                  m.limit && typeof m.limit === "object"
                    ? Number((m.limit as { context?: number }).context ?? 0) || undefined
                    : undefined,
                tools: Boolean((m.capabilities as { tools?: boolean } | undefined)?.tools),
              }));
            } catch {
              return [];
            }
          },
        });
      } catch (err) {
        // 插件按位置加载：多个位置并行加载时端口可能被占（服务已在别处启动）。
        // UI 服务不可用不应影响命令与工作流本身。
        logger.warn(
          { err, port: options.uiPort ?? 4700 },
          "UI 桥接服务启动失败（可能已有实例运行），本次仅禁用 UI，命令不受影响",
        );
      }
    }

    await context.command.transform((editor) => {
      editor.add({
        name: "dual",
        description: "启动双模型协作开发闭环：规划/评审 + 编码 + 真实测试验证",
        execute: async (input: { sessionID: string; prompt: { text: string } }) => {
          const requirement = input.prompt.text.replace(/^\s*\/dual\s*/, "").trim();
          if (!requirement) {
            await safeSynthetic(context, input.sessionID, "用法：/dual <需求描述>");
            return;
          }
          await startRun(context, logger, options, input.sessionID, requirement, {
            resume: false,
            channel,
            modelSettings,
          });
        },
      });

      editor.add({
        name: "dual-probe",
        description: "P1 六项能力验证（会话隔离/角色模型/生命周期/权限/工作目录/结果获取）",
        execute: async (input: { sessionID: string }) => {
          try {
            const reports = await probeCapabilities(context, { live: true });
            await safeSynthetic(context, input.sessionID, formatCapabilityReport(reports));
          } catch (err) {
            await safeSynthetic(
              context,
              input.sessionID,
              `能力探测失败：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      });

      editor.add({
        name: "dual-resume",
        description: "从最近检查点恢复双模型协作运行",
        execute: async (input: { sessionID: string; prompt: { text: string } }) => {
          const requirement = input.prompt.text.replace(/^\s*\/dual-resume\s*/, "").trim();
          if (!requirement) {
            await safeSynthetic(context, input.sessionID, "用法：/dual-resume <原始需求描述>");
            return;
          }
          await startRun(context, logger, options, input.sessionID, requirement, {
            resume: true,
            channel,
            modelSettings,
          });
        },
      });
    });

    logger.info(
      { directory: context.location?.directory, ui: uiServer ? `http://127.0.0.1:${uiServer.port}` : "disabled" },
      "opencode-dual-agent 插件已加载（v1.1 UI 通道就绪）",
    );
    return async () => {
      await uiServer?.close();
      await rpcDispose?.();
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
  opts: {
    resume: boolean;
    channel: UIChannel;
    modelSettings: ModelSettings;
  },
): Promise<RunResult> {
  const projectDir = ctx.location.project?.directory ?? ctx.location.directory;
  const dataDir = path.join(projectDir, ".opencode", "dual-agent");
  const runId = `run-${Date.now().toString(36)}`;

  const store: Store = createStore(
    path.join(dataDir, "state.sqlite"),
    path.join(dataDir, "state.json"),
  );
  const guard = new RecursionGuard(runId, store);
  const workspaceBase = options.workspaceBase ?? path.join(dataDir, "workspaces");
  const fallbackModel: ModelRefLike = options.plannerModel ?? { providerID: "xiaomi", id: "mimo-v2.6-pro" };

  // v1.1：模型三级优先级（任务 > 项目 > 全局），调用点解析 → 切换在下一阶段生效（§6.3）
  const taskModels: Record<"planner" | "coder", ModelRefLike | null> = { planner: null, coder: null };
  const modelControl: ModelControl = {
    current: () => ({
      planner: opts.modelSettings.resolve("planner", projectDir, taskModels.planner),
      coder: opts.modelSettings.resolve("coder", projectDir, taskModels.coder),
    }),
    apply: ({ channel: ch, model, scope }) => {
      const ref = model && model.providerID ? (model as ModelRefLike) : null;
      if (scope === "task") taskModels[ch] = ref;
      else if (scope === "project") opts.modelSettings.setProjectOverride(ch, projectDir, ref);
      else opts.modelSettings.setDefault(ch, ref);
      return { model: ref, effectiveFrom: "next-stage" };
    },
  };

  const runHandle: RunHandle = {
    attach(controller, bus) {
      opts.channel.register(controller);
      opts.channel.attachBus(runId, bus);
      bus.subscribe(opts.channel.sink());
    },
  };

  let workspace: FileWorkspace | undefined;
  try {
    workspace = await FileWorkspace.create({
      source: projectDir,
      baseDir: workspaceBase,
      name: runId,
    });
    if (!guard.acquireWorkspaceLock(workspace.root)) {
      await safeSynthetic(ctx, sessionID, "工作区执行锁被占用，本次运行取消（防递归触发）。");
      return abortedResult(runId, workspace.root);
    }

    const gateway = new RoleModelGateway(
      createTextGenerator(ctx),
      () => {
        const current = modelControl.current();
        return {
          planner: current.planner ?? options.plannerModel ?? fallbackModel,
          reviewer: current.planner ?? options.plannerModel ?? fallbackModel,
          default: options.plannerModel ?? fallbackModel,
        };
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

    const coder = new SessionCoderExecutor(ctx, new FilePromptSource(), logger, guard, {
      model: () => modelControl.current().coder ?? options.coderModel ?? null,
    });

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
        runHandle,
        modelControl,
      },
      { requirement, resume: opts.resume },
    );

    await safeSynthetic(ctx, sessionID, buildReport(result));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "运行失败");
    await safeSynthetic(ctx, sessionID, `双模型协作运行失败：${message}`);
    return abortedResult(runId, workspace?.root);
  } finally {
    if (workspace) guard.releaseWorkspaceLock(workspace.root);
    await store.close();
  }
}

/**
 * 合成消息投递（带超时保护）：目标会话繁忙时投递可能长时间阻塞，
 * 命令执行器不得因此悬挂。
 */
async function safeSynthetic(
  ctx: OpenCodeContextLike,
  sessionID: string,
  text: string,
  timeoutMs = 15_000,
): Promise<void> {
  try {
    await Promise.race([
      ctx.session.synthetic({ sessionID, text }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (err) {
    // 投递失败不影响命令完成；报告内容已生成
    void err;
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
