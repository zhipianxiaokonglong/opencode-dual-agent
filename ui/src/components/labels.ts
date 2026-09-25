/** 展示用文案与格式化工具。 */
import type { CoderAction, ModelRef, PlannerOutputKind, Stage } from "../protocols/ui-events";
import type { ChatAction, ModelInfo } from "../api/client";

export const STAGE_LABELS: Record<Stage, string> = {
  CREATED: "已创建",
  ANALYZING: "分析",
  WAITING_USER: "等待用户",
  PLANNING: "规划",
  WAITING_APPROVAL: "等待审批",
  IMPLEMENTING: "实现",
  VERIFYING: "验证",
  REVIEWING: "审查",
  REPLANNING: "重规划",
  CONSULTING: "咨询",
  BLOCKED: "阻塞",
  FINALIZING: "收尾",
  COMPLETED: "已完成",
  STOPPED: "已停止",
  CANCELLED: "已取消",
  FAILED: "失败",
};

export function stageLabel(stage: Stage | null | undefined): string {
  return stage ? (STAGE_LABELS[stage] ?? stage) : "—";
}

/** 主线阶段（阶段时间线的“未达”序列）。 */
export const MAIN_FLOW_STAGES: readonly Stage[] = [
  "CREATED",
  "ANALYZING",
  "PLANNING",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINALIZING",
  "COMPLETED",
];

export const PLANNER_KIND_LABELS: Record<PlannerOutputKind, string> = {
  analysis: "分析",
  decision: "决策",
  plan: "计划",
  review: "审查",
  fix: "修复",
};

export const CODER_ACTION_LABELS: Record<CoderAction, string> = {
  read: "读取文件",
  edit: "修改摘要",
  test: "测试执行",
  summary: "任务总结",
};

export const CHAT_ACTION_LABELS: Record<ChatAction, string> = {
  inline: "直接答复",
  consult: "咨询介入",
  "review-context": "评审上下文",
  "post-task": "任务后处理",
};

/** 时间戳 → HH:MM:SS（本地时区）。 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 模型引用 → 展示名（优先 name，其次 id；附 provider）。 */
export function modelLabel(model: ModelRef | ModelInfo | null | undefined): string {
  if (!model) return "自动选择";
  const info = model as ModelInfo;
  const name = info.name && info.name.length > 0 ? info.name : model.id;
  return `${name} · ${model.providerID}`;
}
