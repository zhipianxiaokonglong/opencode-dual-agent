/**
 * 核心端口（依赖倒置）：
 * 业务状态机只依赖这些窄接口，OpenCode 具体 API 全部封装在 adapters/（§7.1）。
 */
import type {
  AnalysisResult,
  IssueLedgerEntry,
  Plan,
  ReviewResult,
  TaskPackage,
  TestReport,
} from "./protocols";

export type ModelRole = "planner" | "reviewer";

export interface ModelRequest {
  role: ModelRole;
  system: string;
  prompt: string;
}

export interface ModelResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** 模型网关：按角色调用思考模型（结构化输出由 agents 层解析）。 */
export interface ModelGateway {
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export interface RepoMaterials {
  root: string;
  /** 相对路径列表（已限制深度与数量）。 */
  tree: string[];
  packageJson?: {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  testDirs: string[];
  conventions: string[];
}

/** 隔离工作区（Git worktree / 副本）。 */
export interface Workspace {
  readonly root: string;
  /** 当前代码修订号：所有测试结果必须绑定它。 */
  revision(): Promise<string>;
  diff(): Promise<string>;
  changedFiles(): Promise<string[]>;
  materials(): Promise<RepoMaterials>;
  destroy(): Promise<void>;
}

export interface CoderInput {
  workspace: Workspace;
  round: number;
  task: TaskPackage;
  openIssues: IssueLedgerEntry[];
  /** 上一轮评审的修复指引（若有）。 */
  fixGuidance?: ReviewResult;
  signal: AbortSignal;
}

export interface CoderResult {
  revision: string;
  summary: string;
  changedFiles: string[];
}

/** 开发模型执行器：在指定工作区与白名单路径内实现任务。 */
export interface CoderExecutor {
  execute(input: CoderInput): Promise<CoderResult>;
}

export interface VerifierInput {
  workspace: Workspace;
  profile: string;
  revision: string;
  signal: AbortSignal;
}

/** 测试执行器：真实运行检查并输出绑定 revision 的结构化报告。 */
export interface Verifier {
  run(input: VerifierInput): Promise<TestReport[]>;
}

export type ApprovalDecision = "approve" | "reject" | "cancel";

export interface ApprovalRequest {
  kind: "plan" | "operation" | "test-modification";
  detail: string;
}

/** 人类审批入口（计划审批、依赖安装/网络、测试修改确认）。 */
export interface ApprovalGate {
  requestPlanApproval(plan: Plan): Promise<ApprovalDecision>;
  askUser(questions: string[]): Promise<Record<string, string>>;
  requestOperation(req: ApprovalRequest): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Checkpoint {
  runId: string;
  state: string;
  round: number;
  createdAt: string;
  payload: unknown;
}

/** 持久化层（SQLite 落地，接口可替换）：状态、产物、预算、检查点。 */
export interface Store {
  saveCheckpoint(cp: Checkpoint): Promise<void>;
  latestCheckpoint(runId: string): Promise<Checkpoint | undefined>;
  addIssues(runId: string, entries: readonly IssueLedgerEntry[]): Promise<void>;
  updateIssueStatus(runId: string, issueId: string, status: IssueLedgerEntry["status"]): Promise<void>;
  listIssues(runId: string): Promise<IssueLedgerEntry[]>;
  putSessionRef(runId: string, role: string, sessionKey: string): Promise<void>;
  listSessionRefs(runId: string): Promise<Array<{ role: string; sessionKey: string }>>;
  setMeta(runId: string, key: string, value: unknown): Promise<void>;
  getMeta<T = unknown>(runId: string, key: string): Promise<T | undefined>;
  close(): Promise<void>;
}

/** 一次运行的最终结果（成功/失败/暂停均输出，见 §10）。 */
export interface RunResult {
  runId: string;
  status: "completed" | "stopped" | "blocked" | "cancelled" | "failed";
  state: string;
  roundsUsed: number;
  analysis?: AnalysisResult;
  plan?: Plan;
  finalRevision?: string;
  finalReports: TestReport[];
  review?: ReviewResult;
  issues: IssueLedgerEntry[];
  changedFiles: string[];
  workspaceRoot?: string;
  stats: {
    startedAt: number;
    endedAt: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  stopReason?: string;
}
