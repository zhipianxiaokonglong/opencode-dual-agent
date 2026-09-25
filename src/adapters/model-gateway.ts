/**
 * 模型网关（§6 adapters/model-gateway.ts）：
 * 角色 → 模型解析。思考模型走结构化生成（不落会话历史，不需要工具）。
 * v1.1：支持动态模型配置（每次调用时解析，实现"切换在下一阶段生效"语义 §6.3）。
 */
import type { Logger, ModelGateway, ModelRequest, ModelResponse } from "../ports";

export interface ModelRefLike {
  providerID: string;
  id: string;
}

export interface RoleModelConfig {
  planner?: ModelRefLike | null;
  reviewer?: ModelRefLike | null;
  /** 兜底：两角色共用。 */
  default: ModelRefLike;
}

export type TextGenerator = (input: {
  model: ModelRefLike;
  system: string;
  prompt: string;
}) => Promise<{
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}>;

/**
 * 生成式模型网关。Planner 与 Reviewer 使用同一思考模型实例
 * （不同提示词与会话上下文），不引入第三模型。
 */
export class RoleModelGateway implements ModelGateway {
  constructor(
    private readonly generateText: TextGenerator,
    private readonly models: RoleModelConfig | (() => RoleModelConfig),
    private readonly logger: Logger,
  ) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const model = this.resolve(req.role);
    this.logger.debug({ role: req.role, model: `${model.providerID}/${model.id}` }, "调用思考模型");
    const result = await this.generateText({ model, system: req.system, prompt: req.prompt });
    return {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      model,
    };
  }

  private resolve(role: ModelRequest["role"]): ModelRefLike {
    const config = typeof this.models === "function" ? this.models() : this.models;
    if (role === "planner" && config.planner) return config.planner;
    if (role === "reviewer" && config.reviewer) return config.reviewer;
    return config.default;
  }
}
