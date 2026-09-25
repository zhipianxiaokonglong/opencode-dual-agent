import { z } from "zod";

/**
 * 评审协议（Reviewer 输出），见任务概要 §5.3。
 */

export const ReviewDecisionSchema = z.enum([
  "approve",
  "request_changes",
  "replan",
  "blocked",
  "ask_user",
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const ReviewFindingSchema = z
  .object({
    issueId: z.string().min(1),
    severity: z.enum(["blocker", "major", "minor"]),
    relatedCriteria: z.array(z.string()).default([]),
    location: z.string().min(1),
    causeHypothesis: z.string().min(1),
    suggestedFix: z.string().min(1),
    requiredRegressionTest: z.string().nullable().default(null),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewResultSchema = z
  .object({
    decision: ReviewDecisionSchema,
    findings: z.array(ReviewFindingSchema).default([]),
    summary: z.string().min(1),
    questions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
