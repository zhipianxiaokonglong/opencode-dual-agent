import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, JsonExtractionError } from "../src/protocols/json";
import {
  AnalysisResultSchema,
  PlanSchema,
  ReviewResultSchema,
  TaskPackageSchema,
  TestReportSchema,
  reportsValidForRevision,
} from "../src/protocols";
import { generateStructured, StructuredOutputError } from "../src/agents/structured";
import { silentLogger } from "../src/logging";
import { FakeGateway, ANALYSIS_OK, planFixture, reviewFixture } from "./helpers";

describe("extractJson", () => {
  it("提取裸 JSON", () => {
    expect(JSON.parse(extractJson('{"a":1}'))).toEqual({ a: 1 });
  });

  it("提取代码围栏中的 JSON", () => {
    const text = "说明文字\n```json\n{\"a\": 1}\n```\n结束";
    expect(JSON.parse(extractJson(text))).toEqual({ a: 1 });
  });

  it("提取嵌在长文本中的平衡对象（含字符串括号）", () => {
    const text = '前置 {oops}\n最终结果: {"s":"a}b","n":2} 后记';
    expect(JSON.parse(extractJson(text))).toEqual({ s: "a}b", n: 2 });
  });

  it("无 JSON 抛错", () => {
    expect(() => extractJson("没有任何对象")).toThrow(JsonExtractionError);
  });
});

describe("协议 Schema（§5）", () => {
  it("任务包 Schema 校验", () => {
    const task = TaskPackageSchema.parse({
      taskId: "task-001",
      objective: "实现登录",
      stack: { language: "TypeScript", framework: "none" },
      constraints: ["不得明文保存密码"],
      acceptanceCriteria: [{ id: "AC-01", description: "重复邮箱被拒绝" }],
      allowedPaths: ["src/auth/**"],
      verificationProfile: "backend",
      deliverables: ["实现代码"],
    });
    expect(task.deliverables).toEqual(["实现代码"]);

    expect(() =>
      TaskPackageSchema.parse({
        taskId: "bad-id",
        objective: "x",
        stack: { language: "TypeScript", framework: "none" },
        acceptanceCriteria: [{ id: "AC-01", description: "d" }],
        allowedPaths: ["src/**"],
        verificationProfile: "backend",
      }),
    ).toThrow();

    expect(() =>
      TaskPackageSchema.parse({
        taskId: "task-001",
        objective: "x",
        stack: { language: "TypeScript", framework: "none" },
        acceptanceCriteria: [],
        allowedPaths: ["src/**"],
        verificationProfile: "backend",
      }),
    ).toThrow();
  });

  it("测试报告绑定 revision", () => {
    const report = TestReportSchema.parse({
      checkId: "check-003",
      revision: "workspace-revision-2",
      profile: "backend",
      status: "failed",
      exitCode: 1,
      failedTests: [{ name: "登录失败", summary: "expected 200" }],
      logArtifact: "artifacts/check-003.log",
    });
    expect(reportsValidForRevision([report], "workspace-revision-2")).toBe(true);
    expect(reportsValidForRevision([report], "workspace-revision-3")).toBe(false);
  });

  it("评审结论 Schema 校验", () => {
    const review = ReviewResultSchema.parse(reviewFixture("request_changes", [
      {
        issueId: "ISSUE-001",
        severity: "major",
        relatedCriteria: ["AC-01"],
        location: "src/a.ts",
        causeHypothesis: "缺边界",
        suggestedFix: "补判断",
        requiredRegressionTest: null,
      },
    ]));
    expect(review.findings).toHaveLength(1);
  });

  it("分析与计划 Schema 校验", () => {
    expect(() => AnalysisResultSchema.parse({ ...ANALYSIS_OK, acceptanceCriteria: [] })).toThrow();
    const plan = PlanSchema.parse(planFixture());
    expect(plan.tasks[0]?.taskId).toBe("task-001");
  });
});

describe("generateStructured", () => {
  it("解析失败后携带校验错误重试成功", async () => {
    const gateway = new FakeGateway({
      analyze: [],
      raw: { analyze: ["不是 JSON", JSON.stringify(ANALYSIS_OK)] },
    });
    const result = await generateStructured({
      gateway,
      role: "planner",
      system: "s",
      prompt: "需求分析",
      schema: AnalysisResultSchema,
      logger: silentLogger,
    });
    expect(result.attempts).toBe(2);
    expect(result.value.understanding).toContain("加法");
  });

  it("重试耗尽抛 StructuredOutputError", async () => {
    const gateway = new FakeGateway({ raw: { analyze: ["无效1", "无效2", "无效3"] } });
    await expect(
      generateStructured({
        gateway,
        role: "planner",
        system: "s",
        prompt: "需求分析",
        schema: z.object({ ok: z.boolean() }),
        logger: silentLogger,
        maxRetries: 2,
      }),
    ).rejects.toThrow(StructuredOutputError);
  });
});
