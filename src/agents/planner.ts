/** 思考模型：需求分析 / 规划 / 重规划（Planner）。 */
import type { Logger, ModelGateway, RepoMaterials } from "../ports";
import {
  AnalysisResultSchema,
  PlanSchema,
  type AnalysisResult,
  type Plan,
  type ReviewResult,
  type TestReport,
} from "../protocols";
import type { PromptSource } from "../prompts";
import { generateStructured } from "./structured";

const SYSTEM = "你是双模型协作开发流程中的思考模型（Planner）。只输出符合要求的 JSON。";

export class Planner {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly prompts: PromptSource,
    private readonly logger: Logger,
    private readonly maxRetries = 2,
  ) {}

  async analyze(input: {
    requirement: string;
    materials: RepoMaterials;
  }): Promise<{ analysis: AnalysisResult; usage: UsageLike }> {
    const result = await generateStructured({
      gateway: this.gateway,
      role: "planner",
      system: SYSTEM,
      prompt: this.prompts.render("planner-analyze", {
        requirement: input.requirement,
        materials: formatMaterials(input.materials),
      }),
      schema: AnalysisResultSchema,
      logger: this.logger,
      maxRetries: this.maxRetries,
    });
    return { analysis: result.value, usage: usageOf(result) };
  }

  async plan(input: {
    requirement: string;
    analysis: AnalysisResult;
    materials: RepoMaterials;
  }): Promise<{ plan: Plan; usage: UsageLike }> {
    const result = await generateStructured({
      gateway: this.gateway,
      role: "planner",
      system: SYSTEM,
      prompt: this.prompts.render("planner-plan", {
        requirement: input.requirement,
        analysis: JSON.stringify(input.analysis, null, 2),
        materials: formatMaterials(input.materials),
      }),
      schema: PlanSchema,
      logger: this.logger,
      maxRetries: this.maxRetries,
    });
    return { plan: validatePlan(result.value), usage: usageOf(result) };
  }

  async replan(input: {
    requirement: string;
    analysis: AnalysisResult;
    previousPlan: Plan;
    review: ReviewResult;
    reports: readonly TestReport[];
    materials: RepoMaterials;
  }): Promise<{ plan: Plan; usage: UsageLike }> {
    const result = await generateStructured({
      gateway: this.gateway,
      role: "planner",
      system: SYSTEM,
      prompt: this.prompts.render("planner-replan", {
        requirement: input.requirement,
        analysis: JSON.stringify(input.analysis, null, 2),
        previousPlan: JSON.stringify(input.previousPlan, null, 2),
        review: JSON.stringify(input.review, null, 2),
        reports: JSON.stringify(input.reports, null, 2),
      }),
      schema: PlanSchema,
      logger: this.logger,
      maxRetries: this.maxRetries,
    });
    return { plan: validatePlan(result.value), usage: usageOf(result) };
  }
}

/** 技术栈锁定（§2）：任务语言必须与计划语言一致。 */
function validatePlan(plan: Plan): Plan {
  const language = plan.languageChoice.language;
  for (const task of plan.tasks) {
    if (task.stack.language !== language) {
      throw new Error(
        `技术栈锁定违规: 任务 ${task.taskId} 语言 ${task.stack.language} 与计划语言 ${language} 不一致`,
      );
    }
  }
  return plan;
}

export function formatMaterials(materials: RepoMaterials): string {
  const parts: string[] = [`项目根目录: ${materials.root}`];
  parts.push(`目录树（截断）:\n${materials.tree.join("\n")}`);
  if (materials.packageJson) {
    parts.push(`package.json 摘要:\n${JSON.stringify(materials.packageJson, null, 2)}`);
  }
  if (materials.testDirs.length) parts.push(`测试文件:\n${materials.testDirs.join("\n")}`);
  if (materials.conventions.length) parts.push(`项目约定:\n${materials.conventions.join("\n")}`);
  return parts.join("\n\n");
}

export interface UsageLike {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function usageOf(r: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): UsageLike {
  return { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd };
}
