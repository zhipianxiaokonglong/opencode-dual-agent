import { z } from "zod";

/**
 * 任务包协议（Planner → Coder），见任务概要 §5.1。
 * 模型间交互只允许该结构化协议，禁止自由文本协议。
 */

export const StackSchema = z
  .object({
    language: z.string().min(1),
    framework: z.string().min(1),
  })
  .strict();
export type Stack = z.infer<typeof StackSchema>;

export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-\d+$/, "验收项 ID 必须形如 AC-01"),
    description: z.string().min(1),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TaskPackageSchema = z
  .object({
    taskId: z.string().regex(/^task-\d+$/, "任务 ID 必须形如 task-001"),
    objective: z.string().min(1),
    stack: StackSchema,
    constraints: z.array(z.string().min(1)).default([]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
    allowedPaths: z.array(z.string().min(1)).min(1),
    verificationProfile: z.string().min(1),
    deliverables: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type TaskPackage = z.infer<typeof TaskPackageSchema>;

/** 问题台账条目（§8.6），用于上下文传递与审计。 */
export const IssueStatusSchema = z.enum(["open", "fixing", "fixed", "verified", "wontfix"]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssueLedgerEntrySchema = z
  .object({
    issueId: z.string().min(1),
    summary: z.string().min(1),
    severity: z.enum(["blocker", "major", "minor"]),
    status: IssueStatusSchema,
    relatedCriteria: z.array(z.string()).default([]),
    location: z.string().default(""),
    round: z.number().int().nonnegative(),
  })
  .strict();
export type IssueLedgerEntry = z.infer<typeof IssueLedgerEntrySchema>;
