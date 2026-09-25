/**
 * P2 MVP 演示：对 examples/demo-project（含可复现缺陷）执行完整闭环。
 * - 模型输出用脚本化响应代替（离线可跑）；测试执行是真实的（node --test）。
 * - 展示：定位 → 实现 → 真实测试失败 → 评审 → 修复 → 真实测试通过 → 报告。
 *
 * 运行：npx vite-node examples/run-demo.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "../src/orchestrator/workflow";
import { createStore } from "../src/storage";
import { FilePromptSource } from "../src/prompts";
import { createLogger } from "../src/logging";
import { FileWorkspace } from "../src/workspace";
import { LocalVerifier } from "../src/verification";
import { buildReport } from "../src/reporting";
import type {
  ApprovalGate,
  CoderExecutor,
  CoderInput,
  CoderResult,
  ModelGateway,
  ModelRequest,
  Verifier,
  VerifierInput,
} from "../src/ports";
import type { TestReport } from "../src/protocols";

const here = path.dirname(fileURLToPath(import.meta.url));
const demoSource = path.join(here, "demo-project");

const ANALYSIS = {
  understanding: "add 函数对数字字符串输入错误地做了字符串拼接，需要按数字语义实现并有测试证明",
  questions: [],
  constraints: ["不引入新依赖"],
  acceptanceCriteria: [{ id: "AC-01", description: "add(1,2)===3 且 add('1',2)===3 有测试证明" }],
  risks: ["无"],
};

const PLAN = {
  architecture: "单模块 src/index.js + node:test 测试",
  languageChoice: { language: "TypeScript", rationale: "示例项目为 JS，实际项目 v1 锁定 TypeScript" },
  stackLocked: true,
  tasks: [
    {
      taskId: "task-001",
      objective: "修复 add 的类型处理缺陷",
      stack: { language: "TypeScript", framework: "none" },
      constraints: ["不引入新依赖"],
      acceptanceCriteria: [{ id: "AC-01", description: "add(1,2)===3 且 add('1',2)===3 有测试证明" }],
      allowedPaths: ["src/**", "tests/**"],
      verificationProfile: "library",
      deliverables: ["实现代码", "相关测试", "修改摘要"],
    },
  ],
  notes: [],
};

const REVIEW_FIX = {
  decision: "request_changes",
  findings: [
    {
      issueId: "ISSUE-001",
      severity: "major",
      relatedCriteria: ["AC-01"],
      location: "src/index.js",
      causeHypothesis: "add 对字符串数字输入执行了字符串拼接",
      suggestedFix: "对入参做 Number() 归一化后再相加",
      requiredRegressionTest: "tests/add.test.js 覆盖 add('1', 2) === 3",
    },
  ],
  summary: "真实测试显示 add('1',2) 失败，需要修复",
  questions: [],
};

const REVIEW_PASS = {
  decision: "approve",
  findings: [],
  summary: "缺陷已修复，真实测试全部通过",
  questions: [],
};

function scriptedGateway(): ModelGateway {
  let reviewCalls = 0;
  return {
    async generate(req: ModelRequest) {
      let payload: unknown;
      if (req.prompt.includes("架构重规划")) {
        payload = PLAN;
      } else if (req.prompt.includes("架构与任务规划")) {
        payload = PLAN;
      } else if (req.prompt.includes("需求分析")) {
        payload = ANALYSIS;
      } else {
        payload = reviewCalls === 0 ? REVIEW_FIX : REVIEW_PASS;
        reviewCalls += 1;
      }
      return { text: JSON.stringify(payload), inputTokens: 120, outputTokens: 260, costUsd: 0.002 };
    },
  };
}

class DemoCoder implements CoderExecutor {
  constructor(private readonly workspaceRoot: string) {}

  async execute(input: CoderInput): Promise<CoderResult> {
    const target = path.join(this.workspaceRoot, "src", "index.js");
    if (input.round >= 2) {
      // 第 2 轮：应用真实修复
      fs.writeFileSync(
        target,
        [
          "// 修复：显式按数字处理输入",
          "export function add(a, b) {",
          "  return Number(a) + Number(b);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    return {
      revision: await input.workspace.revision(),
      summary: `第 ${input.round} 轮：${input.round >= 2 ? "应用类型归一化修复" : "初步实现（缺陷仍在）"}`,
      changedFiles: ["src/index.js"],
    };
  }
}

/** 包一层：逐轮打印真实测试证据。 */
class LoggingVerifier implements Verifier {
  constructor(private readonly inner: Verifier) {}

  async run(input: VerifierInput): Promise<TestReport[]> {
    const reports = await this.inner.run(input);
    console.log(`\n=== 真实测试证据（revision=${input.revision}）===`);
    for (const r of reports) {
      console.log(`- [${r.checkId}] ${r.status} exit=${r.exitCode ?? "-"} log=${r.logArtifact ?? "-"}`);
      for (const failed of r.failedTests) console.log(`    ✖ ${failed.name}: ${failed.summary}`);
    }
    return reports;
  }
}

const approvals: ApprovalGate = {
  async requestPlanApproval() {
    return "approve";
  },
  async askUser(questions) {
    return Object.fromEntries(questions.map((q) => [q, "（演示自动回答）"]));
  },
  async requestOperation() {
    return true;
  },
};

async function main(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-demo-"));
  const workspace = await FileWorkspace.create({
    source: demoSource,
    baseDir,
    name: "ws",
    mode: "copy",
  });
  const store = createStore(path.join(baseDir, "state.sqlite"), path.join(baseDir, "state.json"));

  try {
    const result = await runWorkflow(
      {
        gateway: scriptedGateway(),
        coder: new DemoCoder(workspace.root),
        verifier: new LoggingVerifier(
          new LocalVerifier({
            artifactsDir: path.join(baseDir, "artifacts"),
            checks: [
              {
                id: "test",
                description: "node:test 单元测试",
                npmScript: "test",
                fallback: ["node", "--test"],
                timeoutMs: 60_000,
              },
            ],
          }),
        ),
        workspace,
        approvals,
        store,
        prompts: new FilePromptSource(),
        logger: createLogger({ level: "warn" }),
        budget: { maxRounds: 5, maxDurationMs: 5 * 60_000 },
        runId: "run-demo",
      },
      { requirement: "修复 add 函数对数字字符串输入的处理缺陷，并保证有测试证明" },
    );

    console.log("\n" + buildReport(result));
  } finally {
    await store.close();
    await workspace.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
