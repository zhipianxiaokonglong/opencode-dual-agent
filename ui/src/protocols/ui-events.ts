/**
 * UI 事件协议（v1.1 §4.2）—— 纯类型定义。
 *
 * 依据 `docs/v1.1/ui-api-contract.md` 与 `src/protocols/ui-event.ts` 复制，
 * 去掉 zod 运行时依赖，仅保留 TS 类型。验收标准 #6：UI 不 import 任何 `src/**`，
 * 故类型在此独立维护（字段与 `src/protocols/ui-event.ts` 严格一致）。
 */

export const STAGES = [
  "CREATED",
  "ANALYZING",
  "WAITING_USER",
  "PLANNING",
  "WAITING_APPROVAL",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "REPLANNING",
  "CONSULTING",
  "BLOCKED",
  "FINALIZING",
  "COMPLETED",
  "STOPPED",
  "CANCELLED",
  "FAILED",
] as const;
export type Stage = (typeof STAGES)[number];

export interface ModelRef {
  providerID: string;
  id: string;
}

export const CHECK_STATUSES = ["passed", "failed", "skipped", "error", "not_run"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface FailedTest {
  name: string;
  summary: string;
}

/** 测试报告（Verifier → Reviewer），见 `src/protocols/verification.ts`。 */
export interface TestReport {
  checkId: string;
  revision: string;
  profile: string;
  status: CheckStatus;
  exitCode: number | null;
  failedTests: FailedTest[];
  logArtifact: string | null;
  durationMs: number;
}

export const PLANNER_OUTPUT_KINDS = ["analysis", "decision", "plan", "review", "fix"] as const;
export type PlannerOutputKind = (typeof PLANNER_OUTPUT_KINDS)[number];

export const CODER_ACTIONS = ["read", "edit", "test", "summary"] as const;
export type CoderAction = (typeof CODER_ACTIONS)[number];

export type UIEvent =
  | { type: "run.started"; runId: string; requirement: string }
  | { type: "run.finished"; runId: string; status: string; summary: string }
  | { type: "stage.changed"; stage: Stage; at: string; note: string }
  | { type: "planner.output"; kind: PlannerOutputKind; content: string; payload?: unknown }
  | { type: "coder.progress"; taskId: string; action: CoderAction; content: string }
  | { type: "test.report"; report: TestReport }
  | { type: "chat.message"; channel: "planner"; role: "user" | "assistant"; content: string }
  | { type: "model.changed"; channel: "planner" | "coder"; model: ModelRef }
  | { type: "workflow.paused"; reason: string }
  | { type: "workflow.resumed"; reason: string };

export type UIEventType = UIEvent["type"];

export const UI_EVENT_TYPES: readonly UIEventType[] = [
  "run.started",
  "run.finished",
  "stage.changed",
  "planner.output",
  "coder.progress",
  "test.report",
  "chat.message",
  "model.changed",
  "workflow.paused",
  "workflow.resumed",
];

/** 落库信封：单调序号 + 所属运行 + 时间戳。 */
export interface UIEventEnvelope {
  seq: number;
  runId: string;
  at: string;
  event: UIEvent;
}

/** SSE `data` 载荷的轻量校验（UI 端不做 zod 全量校验，仅防御非法数据）。 */
export function isUIEventEnvelope(value: unknown): value is UIEventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Number.isFinite(v.seq)) return false;
  if (typeof v.runId !== "string" || typeof v.at !== "string") return false;
  const ev = v.event;
  if (typeof ev !== "object" || ev === null) return false;
  const type = (ev as Record<string, unknown>).type;
  return typeof type === "string" && (UI_EVENT_TYPES as readonly string[]).includes(type);
}
