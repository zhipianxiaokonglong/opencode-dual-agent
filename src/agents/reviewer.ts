/** 思考模型：独立评审（Reviewer）。与 Planner 同模型实例，不同提示词与上下文。 */
import type { Logger, ModelGateway, RepoMaterials } from "../ports";
import {
  ReviewResultSchema,
  type IssueLedgerEntry,
  type ReviewResult,
  type TaskPackage,
  type TestReport,
} from "../protocols";
import type { PromptSource } from "../prompts";
import { generateStructured } from "./structured";
import { formatMaterials, usageOf, type UsageLike } from "./planner";

const SYSTEM = "你是双模型协作开发流程中的思考模型（Reviewer）。只输出符合要求的 JSON。";

export class Reviewer {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly prompts: PromptSource,
    private readonly logger: Logger,
    private readonly maxRetries = 2,
  ) {}

  async review(input: {
    task: TaskPackage;
    diff: string;
    reports: readonly TestReport[];
    issues: readonly IssueLedgerEntry[];
    materials: RepoMaterials;
  }): Promise<{ review: ReviewResult; usage: UsageLike }> {
    const result = await generateStructured({
      gateway: this.gateway,
      role: "reviewer",
      system: SYSTEM,
      prompt: this.prompts.render("reviewer", {
        task: JSON.stringify(input.task, null, 2),
        diff: truncate(input.diff, 60_000),
        reports: JSON.stringify(input.reports, null, 2),
        issues: JSON.stringify(input.issues, null, 2),
      }),
      schema: ReviewResultSchema,
      logger: this.logger,
      maxRetries: this.maxRetries,
    });
    return { review: result.value, usage: usageOf(result) };
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[差异已截断，共 ${text.length} 字符]`;
}

export { formatMaterials };
