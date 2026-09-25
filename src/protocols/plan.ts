import { z } from "zod";
import { AcceptanceCriterionSchema, TaskPackageSchema } from "./task";

/**
 * 规划协议（Planner 输出），见任务概要 §4.1 ANALYZING / PLANNING 阶段。
 */

export const AnalysisResultSchema = z
  .object({
    understanding: z.string().min(1),
    questions: z.array(z.string().min(1)).default([]),
    constraints: z.array(z.string().min(1)).default([]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
    risks: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const PlanSchema = z
  .object({
    architecture: z.string().min(1),
    languageChoice: z
      .object({
        language: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
    /** 技术栈锁定：任务中途不得更换（§2）。 */
    stackLocked: z.boolean().default(true),
    tasks: z.array(TaskPackageSchema).min(1),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;
