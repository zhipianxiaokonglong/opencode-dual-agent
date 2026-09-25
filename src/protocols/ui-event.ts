/**
 * UI 事件协议（v1.1 §4.2）：编排器 → UI 的过程事件。
 * 约束：
 * - 事件先落库后推送（Store.events，单调序号 seq），UI 断线按 seq 补发
 * - 只展示"可公开的过程产物"，不展示原始链式推理（§3.3）
 */
import { z } from "zod";
import { TestReportSchema } from "./verification";

export const ModelRefSchema = z
  .object({
    providerID: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const StageSchema = z.enum([
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
]);
export type Stage = z.infer<typeof StageSchema>;

export const UIEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run.started"),
      runId: z.string(),
      requirement: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.finished"),
      runId: z.string(),
      status: z.string(),
      summary: z.string().default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.changed"),
      stage: StageSchema,
      at: z.string(),
      note: z.string().default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("planner.output"),
      kind: z.enum(["analysis", "decision", "plan", "review", "fix"]),
      content: z.string(),
      payload: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("coder.progress"),
      taskId: z.string(),
      action: z.enum(["read", "edit", "test", "summary"]),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("test.report"),
      report: TestReportSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.message"),
      channel: z.literal("planner"),
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("model.changed"),
      channel: z.enum(["planner", "coder"]),
      model: ModelRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow.paused"),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow.resumed"),
      reason: z.string(),
    })
    .strict(),
]);
export type UIEvent = z.infer<typeof UIEventSchema>;

/** 落库信封：单调序号 + 所属运行 + 时间戳。 */
export const UIEventEnvelopeSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    runId: z.string(),
    at: z.string(),
    event: UIEventSchema,
  })
  .strict();
export type UIEventEnvelope = z.infer<typeof UIEventEnvelopeSchema>;
