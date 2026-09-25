/**
 * OpenCode 适配器（§7.1）：
 * 所有 OpenCode 版本相关操作封装在本模块，业务状态机不得直接依赖具体事件名或 SDK 方法。
 * 两条执行路径（§7.2）：
 * - 路径 A：开发模型走 OpenCode 会话（会话隔离 + 权限规则 + 工作目录）
 * - 路径 B：思考模型走独立生成（ctx.generate.text，只读材料 + 结构化输出）
 */
import * as path from "node:path";
import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
  CoderExecutor,
  CoderInput,
  CoderResult,
  Logger,
  Workspace,
} from "../ports";
import type { PromptSource } from "../prompts";
import { buildCoderPrompt } from "../agents/coder";
import type { TextGenerator } from "./model-gateway";
import { RecursionGuard } from "./recursion-guard";

// ---------------------------------------------------------------------------
// 宽松的上下文结构（唯一允许触碰 OpenCode API 的类型）
// ---------------------------------------------------------------------------

export interface OpenCodeContextLike {
  location: {
    directory: string;
    project?: { id?: string; directory?: string; canonical?: string };
    workspaceID?: string;
  };
  options?: Record<string, unknown>;
  generate: {
    text(input: {
      model: { providerID: string; id: string };
      system?: string | string[];
      prompt: string;
    }): Promise<unknown>;
  };
  session: {
    create(input?: Record<string, unknown>): Promise<{ id: string }>;
    get(input: { sessionID: string }): Promise<unknown>;
    prompt(input: Record<string, unknown>): Promise<unknown>;
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    interrupt(input: { sessionID: string; continue?: boolean }): Promise<void>;
    context(input: { sessionID: string }): Promise<unknown>;
    switchModel?(input: { sessionID: string; model: { providerID: string; id: string } }): Promise<void>;
  };
  permission: {
    rules?(input: Record<string, unknown>): Promise<void>;
    list(input?: Record<string, unknown>): Promise<unknown>;
  };
  model?: {
    list(input?: Record<string, unknown>): Promise<unknown>;
  };
  rpc: {
    register(
      definition: unknown,
      handlers: Record<string, unknown>,
    ): Promise<{
      events: { emit(name: string, data: unknown): Promise<void> };
      dispose(): Promise<void>;
    }>;
  };
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; [key: string]: unknown }>;
  };
  command: {
    transform(callback: (editor: { add(def: Record<string, unknown>): void }) => void): Promise<{
      dispose(): Promise<void>;
    }>;
  };
}

// ---------------------------------------------------------------------------
// 路径 B：思考模型文本生成
// ---------------------------------------------------------------------------

export function createTextGenerator(ctx: OpenCodeContextLike): TextGenerator {
  return async ({ model, system, prompt }) => {
    const result = (await ctx.generate.text({
      model: { providerID: model.providerID, id: model.id },
      system,
      prompt,
    })) as { text?: string; content?: string };
    return { text: result.text ?? result.content ?? JSON.stringify(result) };
  };
}

// ---------------------------------------------------------------------------
// 路径 A：开发模型会话执行
// ---------------------------------------------------------------------------

export interface SessionCoderOptions {
  /** Coder 使用的模型（按角色指定）；支持函数实现"切换在下一阶段生效"（§6.3）。 */
  model?: { providerID: string; id: string } | (() => { providerID: string; id: string } | null | undefined);
  /** 会话内单次任务的最大等待时间。 */
  timeoutMs?: number;
}

export class SessionCoderExecutor implements CoderExecutor {
  private readonly coderSessions = new Map<string, string>();

  constructor(
    private readonly ctx: OpenCodeContextLike,
    private readonly prompts: PromptSource,
    private readonly logger: Logger,
    private readonly guard: RecursionGuard,
    private readonly options: SessionCoderOptions = {},
  ) {}

  async execute(input: CoderInput): Promise<CoderResult> {
    const root = input.workspace.root;
    const sessionID = await this.ensureSession(root);
    await this.applyPermissionRules(sessionID, input.task.allowedPaths);

    const materials = await input.workspace.materials();
    const prompt = buildCoderPrompt({
      task: input.task,
      openIssues: input.openIssues,
      fixGuidance: input.fixGuidance,
      round: input.round,
      materials,
      render: (name, vars) => this.prompts.render(name, vars),
    });

    this.logger.info({ sessionID, taskId: input.task.taskId }, "Coder 会话执行任务");
    await this.ctx.session.prompt({ sessionID, text: prompt });

    const waiter = this.ctx.session.wait({ sessionID });
    const timeout = this.options.timeoutMs ?? 25 * 60_000;
    await Promise.race([
      waiter,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("Coder 会话执行超时")), timeout),
      ),
    ]);

    return {
      revision: await input.workspace.revision(),
      summary: `任务 ${input.task.taskId} 已在会话 ${sessionID} 中执行`,
      changedFiles: await input.workspace.changedFiles(),
    };
  }

  private async ensureSession(workspaceRoot: string): Promise<string> {
    const existing = this.coderSessions.get(workspaceRoot);
    const model = typeof this.options.model === "function" ? this.options.model() : this.options.model;
    if (existing) {
      // 模型切换语义（§6.3）：调用点解析，下次执行生效
      if (model && this.ctx.session.switchModel) {
        await this.ctx.session.switchModel({ sessionID: existing, model });
      }
      return existing;
    }
    const created = await this.ctx.session.create({
      title: `dual-agent coder (${path.basename(workspaceRoot)})`,
      // 能力探测项：指定工作目录（不同版本字段可能不同，见 docs/P1-verification.md）
      directory: workspaceRoot,
      worktree: workspaceRoot,
    });
    if (model && this.ctx.session.switchModel) {
      await this.ctx.session.switchModel({
        sessionID: created.id,
        model,
      });
    }
    this.coderSessions.set(workspaceRoot, created.id);
    await this.guard.registerSession("coder", created.id);
    return created.id;
  }

  /**
   * 权限执行层落地（§8.2）：先全拒绝，再放行白名单路径。
   * 平台不支持 rules 时降级为提示词约束 + 差异审计（能力验证见 P1）。
   */
  private async applyPermissionRules(sessionID: string, allowedPaths: readonly string[]): Promise<void> {
    const rules = this.ctx.permission.rules;
    if (typeof rules !== "function") {
      this.logger.warn({ sessionID }, "当前 OpenCode 版本不支持会话级权限规则，降级为提示词约束");
      return;
    }
    const normalized = allowedPaths.map((p) => p.replace(/\\/g, "/"));
    await rules({
      sessionID,
      permissions: [
        { action: "*", effect: "deny" },
        ...normalized.map((p) => ({
          action: "edit",
          resource: `${this.ctx.location.directory.replace(/\\/g, "/")}/${p}`,
          effect: "allow",
        })),
        ...normalized.map((p) => ({
          action: "write",
          resource: `${this.ctx.location.directory.replace(/\\/g, "/")}/${p}`,
          effect: "allow",
        })),
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// 人工审批
// ---------------------------------------------------------------------------

export interface SessionApprovalOptions {
  /** 提交审批问题的会话（用户所在会话）。 */
  sessionID: string;
  /** 等待用户回复超时（毫秒），超时按 fail-safe 处理。 */
  timeoutMs?: number;
  /** 超时/无用户时的默认决策。 */
  onTimeout?: ApprovalDecision;
  /** 自动决策（CI / 无人值守模式），设置后跳过询问。 */
  auto?: { plan?: ApprovalDecision; operation?: boolean };
}

export class SessionApprovalGate implements ApprovalGate {
  constructor(
    private readonly ctx: OpenCodeContextLike,
    private readonly logger: Logger,
    private readonly options: SessionApprovalOptions,
  ) {}

  async requestPlanApproval(plan: PlanLike): Promise<ApprovalDecision> {
    if (this.options.auto?.plan) return this.options.auto.plan;
    const question = [
      "【双模型协作】规划方案待审批（回复 approve / reject / cancel）：",
      `语言选型：${plan.languageChoice.language} — ${plan.languageChoice.rationale}`,
      `架构：${plan.architecture}`,
      `任务包：${plan.tasks.map((t) => t.taskId).join(", ")}`,
    ].join("\n");
    return this.askDecision(question);
  }

  async askUser(questions: string[]): Promise<Record<string, string>> {
    const text = `【双模型协作】需要你回答：\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
    const answer = await this.askFreeText(text);
    return Object.fromEntries(questions.map((q) => [q, answer]));
  }

  async requestOperation(req: ApprovalRequest): Promise<boolean> {
    if (this.options.auto?.operation !== undefined) return this.options.auto.operation;
    const decision = await this.askDecision(
      `【双模型协作】需要审批操作（${req.kind}，回复 approve / reject）：\n${req.detail}`,
    );
    return decision === "approve";
  }

  /** 提问并等待下一条用户消息（生命周期信号由事件流提供，见 P1 验证）。 */
  private async askDecision(question: string): Promise<ApprovalDecision> {
    const answer = (await this.askFreeText(question)).trim().toLowerCase();
    if (answer.startsWith("approve") || answer.startsWith("同意")) return "approve";
    if (answer.startsWith("cancel") || answer.startsWith("取消")) return "cancel";
    return "reject";
  }

  private async askFreeText(question: string): Promise<string> {
    await this.ctx.session
      .prompt({ sessionID: this.options.sessionID, text: question, delivery: "steer" })
      .catch((err: unknown) => {
        this.logger.warn({ err }, "审批提问发送失败");
      });

    const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const rawEvent of this.ctx.event.subscribe({ signal: controller.signal })) {
        const event = rawEvent as unknown as Record<string, unknown>;
        if (event.type !== "message.updated" && event.type !== "message.created") continue;
        const properties = (event.properties ?? {}) as Record<string, unknown>;
        const message = (properties.message ?? event.message) as
          | { role?: string; sessionID?: string }
          | undefined;
        if (!message || message.role !== "user") continue;
        if (message.sessionID && message.sessionID !== this.options.sessionID) continue;
        const text = extractText(message);
        if (text) return text;
      }
    } catch (err) {
      this.logger.warn({ err }, "等待用户回复失败/超时");
    } finally {
      clearTimeout(timer);
    }
    this.logger.warn({}, "未收到用户回复，按 fail-safe 处理");
    return this.options.onTimeout === "approve"
      ? "approve"
      : this.options.onTimeout === "cancel"
        ? "cancel"
        : "reject";
  }
}

interface PlanLike {
  architecture: string;
  languageChoice: { language: string; rationale: string };
  tasks: Array<{ taskId: string }>;
}

function extractText(message: unknown): string {
  const m = message as {
    parts?: Array<{ type?: string; text?: string }>;
    content?: string;
    text?: string;
  };
  if (Array.isArray(m.parts)) {
    const joined = m.parts
      .filter((p) => p.type === "text" || typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  return (m.content ?? m.text ?? "").trim();
}
