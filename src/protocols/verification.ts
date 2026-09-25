import { z } from "zod";

/**
 * 测试报告协议（Verifier → Reviewer），见任务概要 §5.2。
 * 关键规则：测试结果必须绑定代码 revision；代码变更后旧通过结果作废。
 */

export const CheckStatusSchema = z.enum(["passed", "failed", "skipped", "error", "not_run"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const FailedTestSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().default(""),
  })
  .strict();
export type FailedTest = z.infer<typeof FailedTestSchema>;

export const TestReportSchema = z
  .object({
    checkId: z.string().min(1),
    revision: z.string().min(1),
    profile: z.string().min(1),
    status: CheckStatusSchema,
    exitCode: z.number().int().nullable().default(null),
    failedTests: z.array(FailedTestSchema).default([]),
    logArtifact: z.string().nullable().default(null),
    durationMs: z.number().nonnegative().default(0),
  })
  .strict();
export type TestReport = z.infer<typeof TestReportSchema>;

/** 所有“通过”结论都必须绑定同一个 revision 才有效。 */
export function reportsValidForRevision(reports: readonly TestReport[], revision: string): boolean {
  return reports.every((r) => r.revision === revision);
}

/** 报告是否包含至少一个真实执行且失败的检查。 */
export function hasFailingChecks(reports: readonly TestReport[]): boolean {
  return reports.some((r) => r.status === "failed" || r.status === "error");
}
