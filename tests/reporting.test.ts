import { describe, expect, it } from "vitest";
import { buildReport } from "../src/reporting";
import type { RunResult } from "../src/ports";
import { makeReport } from "./helpers";

function fixtureResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-test",
    status: "completed",
    state: "COMPLETED",
    roundsUsed: 2,
    analysis: {
      understanding: "实现 add",
      questions: [],
      constraints: [],
      acceptanceCriteria: [{ id: "AC-01", description: "add 有测试证明" }],
      risks: [],
    },
    plan: {
      architecture: "单模块 + 测试",
      languageChoice: { language: "TypeScript", rationale: "v1 仅支持 TS" },
      stackLocked: true,
      tasks: [
        {
          taskId: "task-001",
          objective: "实现 add",
          stack: { language: "TypeScript", framework: "none" },
          constraints: [],
          acceptanceCriteria: [{ id: "AC-01", description: "add 有测试证明" }],
          allowedPaths: ["src/**"],
          verificationProfile: "library",
          deliverables: [],
        },
      ],
      notes: [],
    },
    finalRevision: "rev-7",
    finalReports: [
      makeReport("rev-7", { checkId: "typecheck" }),
      makeReport("rev-7", {
        checkId: "test",
        status: "failed",
        exitCode: 1,
        failedTests: [{ name: "add works", summary: "expected 3" }],
        logArtifact: "test-rev-7.log",
      }),
    ],
    issues: [
      {
        issueId: "ISSUE-001",
        summary: "空值未处理",
        severity: "major",
        status: "verified",
        relatedCriteria: ["AC-01"],
        location: "src/index.ts",
        round: 1,
      },
    ],
    changedFiles: ["src/index.ts", "tests/index.test.ts"],
    workspaceRoot: "/ws",
    stats: {
      startedAt: 0,
      endedAt: 30_000,
      durationMs: 30_000,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.12,
    },
    ...overrides,
  };
}

describe("交付报告（§10）", () => {
  it("包含全部必需段落", () => {
    const report = buildReport(fixtureResult());
    for (const section of ["## 任务状态", "## 实现内容", "## 技术方案", "## 验证结果", "## 交付物", "## 限制", "## 执行统计"]) {
      expect(report).toContain(section);
    }
  });

  it("验证结果绑定代码版本并列出检查", () => {
    const report = buildReport(fixtureResult());
    expect(report).toContain("rev-7");
    expect(report).toContain("| typecheck | 通过 |");
    expect(report).toContain("| test | 失败 |");
    expect(report).toContain("test-rev-7.log");
    expect(report).toContain("add works");
  });

  it("失败/暂停状态输出终止原因与部分成果提示", () => {
    const report = buildReport(
      fixtureResult({
        status: "stopped",
        state: "STOPPED",
        stopReason: "连续 2 轮无进展（同类问题无改善）",
      }),
    );
    expect(report).toContain("已停止");
    expect(report).toContain("连续 2 轮无进展");
    expect(report).toContain("部分成果");
  });

  it("执行统计包含轮次/token/费用", () => {
    const report = buildReport(fixtureResult());
    expect(report).toContain("修复轮次：2");
    expect(report).toContain("输入 1000 / 输出 500");
    expect(report).toContain("$0.1200");
  });
});
