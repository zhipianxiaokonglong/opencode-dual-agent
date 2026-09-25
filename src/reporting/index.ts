/**
 * 交付报告（§10）：成功/失败/暂停均输出。
 * 任务状态 | 实现内容 | 技术方案 | 验证结果 | 交付物 | 限制 | 执行统计
 */
import type { RunResult } from "../ports";
import type { UIEventEnvelope } from "../protocols/ui-event";
import { redactText } from "../security/redaction";

const STATUS_LABEL: Record<RunResult["status"], string> = {
  completed: "✅ 已完成",
  stopped: "⏹ 已停止（预算/无进展）",
  blocked: "🚧 已阻塞（环境问题）",
  cancelled: "🚫 已取消",
  failed: "❌ 失败",
};

const CHECK_LABEL: Record<string, string> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  error: "执行错误",
  not_run: "未运行",
};

export function buildReport(result: RunResult): string {
  const lines: string[] = [];
  const stats = result.stats;

  lines.push(`# 双模型协作开发报告（run: ${result.runId}）`);
  lines.push("");
  lines.push("## 任务状态");
  lines.push(`- 状态：${STATUS_LABEL[result.status]}（${result.state}）`);
  if (result.stopReason) lines.push(`- 终止原因：${result.stopReason}`);

  lines.push("");
  lines.push("## 实现内容");
  if (result.changedFiles.length > 0) {
    for (const f of result.changedFiles) lines.push(`- ${f}`);
  } else {
    lines.push("- （无文件变更）");
  }

  lines.push("");
  lines.push("## 技术方案");
  if (result.plan) {
    lines.push(`- 语言：${result.plan.languageChoice.language}（选型理由：${result.plan.languageChoice.rationale}）`);
    const frameworks = [...new Set(result.plan.tasks.map((t) => t.stack.framework))];
    lines.push(`- 框架：${frameworks.join(", ")}`);
    lines.push(`- 架构：${result.plan.architecture}`);
  } else {
    lines.push("- （未产出方案）");
  }

  lines.push("");
  lines.push("## 验证结果");
  lines.push(`- 代码版本（revision）：${result.finalRevision ?? "（未产生）"}`);
  if (result.finalReports.length > 0) {
    lines.push("");
    lines.push("| 检查 | 结果 | 退出码 | 失败用例 | 证据 | 对应代码版本 |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of result.finalReports) {
      const failed =
        r.failedTests.length > 0
          ? r.failedTests.slice(0, 3).map((t) => t.name).join("<br>") + (r.failedTests.length > 3 ? "<br>…" : "")
          : "-";
      lines.push(
        `| ${r.checkId} | ${CHECK_LABEL[r.status] ?? r.status} | ${r.exitCode ?? "-"} | ${failed} | ${r.logArtifact ?? "-"} | ${r.revision} |`,
      );
    }
  } else {
    lines.push("- （未执行任何检查）");
  }

  lines.push("");
  lines.push("## 交付物");
  lines.push(`- 工作区位置：${result.workspaceRoot ?? "（无）"}`);
  if (result.review) lines.push(`- 修改摘要：${result.review.summary}`);
  if (result.issues.length > 0) {
    lines.push("- 问题台账：");
    for (const i of result.issues) {
      lines.push(`  - ${i.issueId}：${i.summary} → ${i.status}（${i.severity}）`);
    }
  }
  lines.push("- 启动与验证说明：在工作区执行 `npm install`（需人工审批）后，运行验证 profile 对应命令（如 `npm test`）复核。");

  lines.push("");
  lines.push("## 限制");
  lines.push("- 工作区（worktree/副本）只隔离文件，不隔离运行时；测试执行的容器隔离见 P3 计划。");
  if (result.status !== "completed") {
    lines.push("- 任务未全部完成，以上变更与结论为部分成果，需人工复核。");
  }
  lines.push("- 未验证环境：其他操作系统/Node 版本、CI 环境。");

  lines.push("");
  lines.push("## 执行统计");
  lines.push(`- 修复轮次：${result.roundsUsed}`);
  lines.push(`- 耗时：${(stats.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- token：输入 ${stats.inputTokens} / 输出 ${stats.outputTokens}`);
  lines.push(`- 费用估算：$${stats.costUsd.toFixed(4)}`);
  if (result.stageModels && Object.keys(result.stageModels).length > 0) {
    lines.push("");
    lines.push("### 各阶段实际使用模型（审计）");
    for (const [stage, model] of Object.entries(result.stageModels)) {
      lines.push(`- ${stage}：${model}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// v1.1 FR-09：双栏过程导出（Markdown，已脱敏）
// ---------------------------------------------------------------------------

export interface ProcessExportInput {
  runId: string;
  requirement: string;
  state: string;
  round: number;
  stageModels: Record<string, string>;
  events: readonly UIEventEnvelope[];
  chatLog: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

/** 将双栏会话（过程流 + 对话）导出为脱敏 Markdown。 */
export function exportProcessMarkdown(input: ProcessExportInput): string {
  const lines: string[] = [];
  lines.push(`# 双模型协作过程记录（run: ${input.runId}）`);
  lines.push("");
  lines.push(`- 需求：${redactText(input.requirement)}`);
  lines.push(`- 状态：${input.state}（修复轮次 ${input.round}）`);
  if (Object.keys(input.stageModels).length > 0) {
    lines.push(
      `- 实际模型：${Object.entries(input.stageModels)
        .map(([stage, model]) => `${stage}→${model}`)
        .join("，")}`,
    );
  }

  lines.push("");
  lines.push("## 阶段时间线");
  for (const e of input.events) {
    if (e.event.type === "stage.changed") {
      lines.push(`- \`${e.at}\` ${e.event.stage}${e.event.note ? `（${e.event.note}）` : ""}`);
    }
  }

  lines.push("");
  lines.push("## 过程流（思考模型）");
  for (const e of input.events) {
    const ev = e.event;
    if (ev.type === "planner.output") {
      lines.push(`### [${ev.kind}] ${e.at}`);
      lines.push("");
      lines.push(redactText(ev.content));
      lines.push("");
    } else if (ev.type === "test.report") {
      const r = ev.report;
      lines.push(
        `- [test] ${e.at} \`${r.checkId}\` ${r.status}（revision=${r.revision}${r.failedTests.length ? `，失败 ${r.failedTests.length} 个用例` : ""}）`,
      );
    } else if (ev.type === "coder.progress") {
      lines.push(`- [coder] ${e.at} \`${ev.taskId}\` ${redactText(ev.content)}`);
    }
  }

  if (input.chatLog.length > 0) {
    lines.push("");
    lines.push("## 思考模型对话（旁路）");
    for (const m of input.chatLog) {
      lines.push(`**${m.role === "user" ? "用户（介入）" : "思考模型"}**：${redactText(m.content)}`);
      lines.push("");
    }
  }

  lines.push("");
  lines.push("> 本导出已自动脱敏（[REDACTED:*] 为遮蔽的疑似凭证）；模型原始推理内容不导出（§8.1）。");
  return lines.join("\n");
}
