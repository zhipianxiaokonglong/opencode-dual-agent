/** 测试替身：脚本化模型网关、内存工作区、假开发模型与假测试执行器。 */
import type {
  CoderExecutor,
  CoderInput,
  CoderResult,
  ModelGateway,
  ModelRequest,
  RepoMaterials,
  Verifier,
  VerifierInput,
  Workspace,
} from "../src/ports";
import type { TestReport } from "../src/protocols";

export type FakeKind = "analyze" | "plan" | "replan" | "review";

export function detectKind(prompt: string): FakeKind {
  if (prompt.includes("架构重规划")) return "replan";
  if (prompt.includes("架构与任务规划")) return "plan";
  if (prompt.includes("需求分析")) return "analyze";
  return "review";
}

export interface FakeGatewayOptions {
  analyze?: unknown[];
  plan?: unknown[];
  replan?: unknown[];
  review?: unknown[];
  /** 自定义失败输出（用于结构化重试测试）。 */
  raw?: Partial<Record<FakeKind, string[]>>;
}

export class FakeGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  readonly consumed: FakeKind[] = [];

  constructor(private readonly options: FakeGatewayOptions = {}) {}

  async generate(req: ModelRequest): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }> {
    this.calls.push(req);
    const kind = detectKind(req.prompt);
    this.consumed.push(kind);

    const rawQueue = this.options.raw?.[kind];
    if (rawQueue && rawQueue.length > 0) {
      return { text: rawQueue.shift()!, inputTokens: 10, outputTokens: 20, costUsd: 0.001 };
    }
    const queue = (this.options[kind] ?? []) as unknown[];
    if (queue.length === 0) throw new Error(`FakeGateway: 没有为 ${kind} 预置响应`);
    return {
      text: JSON.stringify(queue.shift()),
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
    };
  }
}

export class FakeWorkspace implements Workspace {
  #rev = 0;

  constructor(
    readonly root: string = "/tmp/fake-workspace",
    public diffText = "",
    public files: string[] = [],
  ) {}

  async revision(): Promise<string> {
    return `rev-${this.#rev}`;
  }

  async diff(): Promise<string> {
    return this.diffText;
  }

  async changedFiles(): Promise<string[]> {
    return this.files;
  }

  async materials(): Promise<RepoMaterials> {
    return {
      root: this.root,
      tree: ["src/index.ts", "tests/index.test.ts", "package.json"],
      packageJson: {
        name: "fake-project",
        scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "tsc" },
        dependencies: {},
        devDependencies: { typescript: "^5.7.0" },
      },
      testDirs: ["tests/index.test.ts"],
      conventions: [],
    };
  }

  async destroy(): Promise<void> {}

  bumpRevision(): void {
    this.#rev += 1;
  }
}

export class FakeCoder implements CoderExecutor {
  readonly executed: CoderInput[] = [];

  constructor(private readonly onChange?: (input: CoderInput) => void | Promise<void>) {}

  async execute(input: CoderInput): Promise<CoderResult> {
    this.executed.push(input);
    if (this.onChange) await this.onChange(input);
    return {
      revision: await input.workspace.revision(),
      summary: `完成 ${input.task.taskId}`,
      changedFiles: ["src/index.ts"],
    };
  }
}

export class FakeVerifier implements Verifier {
  readonly calls: VerifierInput[] = [];

  constructor(private readonly reportsFor: (input: VerifierInput) => TestReport[]) {}

  async run(input: VerifierInput): Promise<TestReport[]> {
    this.calls.push(input);
    return this.reportsFor(input);
  }
}

export function makeReport(
  revision: string,
  overrides: Partial<TestReport> = {},
): TestReport {
  return {
    checkId: "test",
    revision,
    profile: "backend",
    status: "passed",
    exitCode: 0,
    failedTests: [],
    logArtifact: "test.log",
    durationMs: 5,
    ...overrides,
  };
}

export const ANALYSIS_OK = {
  understanding: "实现一个加法函数并覆盖测试",
  questions: [],
  constraints: ["不得引入新依赖"],
  acceptanceCriteria: [{ id: "AC-01", description: "add(1,2) === 3 有测试证明" }],
  risks: ["无"],
};

export function planFixture(overrides: Record<string, unknown> = {}) {
  return {
    architecture: "单一模块 + 单元测试",
    languageChoice: { language: "TypeScript", rationale: "v1 仅支持 TS" },
    stackLocked: true,
    tasks: [
      {
        taskId: "task-001",
        objective: "实现 add 函数",
        stack: { language: "TypeScript", framework: "none" },
        constraints: ["不得明文保存密码"],
        acceptanceCriteria: [{ id: "AC-01", description: "add(1,2) === 3 有测试证明" }],
        allowedPaths: ["src/**", "tests/**"],
        verificationProfile: "library",
        deliverables: ["实现代码", "相关测试", "修改摘要"],
      },
    ],
    notes: [],
    ...overrides,
  };
}

export function reviewFixture(
  decision: "approve" | "request_changes" | "replan" | "blocked" | "ask_user",
  findings: unknown[] = [],
  extra: Record<string, unknown> = {},
) {
  return { decision, findings, summary: `评审结论：${decision}`, questions: [], ...extra };
}

export function findingFixture(issueId: string, severity: "blocker" | "major" | "minor" = "major") {
  return {
    issueId,
    severity,
    relatedCriteria: ["AC-01"],
    location: "src/index.ts",
    causeHypothesis: "边界条件未处理",
    suggestedFix: "补充空值判断",
    requiredRegressionTest: "tests/index.test.ts 增加空值用例",
  };
}
