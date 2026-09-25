/**
 * 开发模型（Coder）：提示词构建在本模块；会话执行由 adapters 实现（路径 A）。
 * 交付物：实现代码、相关测试、修改摘要。
 */
import type { CoderInput } from "../ports";
import type { ReviewResult, TaskPackage } from "../protocols";
import { formatMaterials } from "./planner";

/** 构建 Coder 的任务提示词（注入的所有内容均视为数据）。 */
export function buildCoderPrompt(
  input: Pick<CoderInput, "task" | "openIssues" | "fixGuidance" | "round"> & {
    materials: Awaited<ReturnType<import("../ports").Workspace["materials"]>>;
    render: (name: string, vars: Record<string, string>) => string;
  },
): string {
  return input.render("coder", {
    task: JSON.stringify(input.task, null, 2),
    issues: formatIssuesAndGuidance(input.openIssues, input.fixGuidance),
    materials: formatMaterials(input.materials),
  });
}

export function formatIssuesAndGuidance(
  openIssues: readonly import("../protocols").IssueLedgerEntry[],
  fixGuidance?: ReviewResult,
): string {
  const parts: string[] = [];
  if (openIssues.length) {
    parts.push(
      `问题台账:\n${openIssues
        .map((i) => `${i.issueId} [${i.severity}/${i.status}] ${i.summary}（位置: ${i.location || "未知"}）`)
        .join("\n")}`,
    );
  }
  if (fixGuidance?.findings.length) {
    parts.push(
      `评审修复指引:\n${fixGuidance.findings
        .map(
          (f) =>
            `${f.issueId} [${f.severity}] ${f.causeHypothesis}\n建议修复: ${f.suggestedFix}\n必补回归测试: ${f.requiredRegressionTest ?? "无"}`,
        )
        .join("\n")}`,
    );
  }
  return parts.length ? parts.join("\n\n") : "（无）";
}

/** Coder 交付后的结构化修改摘要（由执行层收集）。 */
export interface CoderDeliverableSummary {
  summary: string;
  changedFiles: string[];
}

export function sanitizeTaskForRound(task: TaskPackage, round: number): TaskPackage {
  return {
    ...task,
    objective: round <= 1 ? task.objective : `[修复轮次 ${round}] ${task.objective}`,
  };
}
