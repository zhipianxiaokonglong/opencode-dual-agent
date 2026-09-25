/**
 * 检查点与恢复（§8.5）：
 * 每阶段保存检查点（状态、补丁、模型输出、测试证据、预算、问题台账），重启可恢复。
 */
import { z } from "zod";
import type { Checkpoint, Store } from "../ports";
import { AnalysisResultSchema, PlanSchema, ReviewResultSchema, TestReportSchema } from "../protocols";
import { IssueLedgerEntrySchema } from "../protocols/task";

export const CheckpointPayloadSchema = z
  .object({
    requirement: z.string(),
    analysis: AnalysisResultSchema.optional(),
    plan: PlanSchema.optional(),
    review: ReviewResultSchema.optional(),
    reports: z.array(TestReportSchema).default([]),
    issues: z.array(IssueLedgerEntrySchema).default([]),
    changedFiles: z.array(z.string()).default([]),
    finalRevision: z.string().optional(),
    budget: z
      .object({
        startedAt: z.number(),
        roundsUsed: z.number().int().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        costUsd: z.number().nonnegative(),
      })
      .optional(),
    progress: z
      .object({
        last: z
          .object({
            openIssueIds: z.array(z.string()),
            failedChecks: z.array(z.string()),
            score: z.number(),
          })
          .nullable(),
        staleRounds: z.number().int().nonnegative(),
      })
      .optional(),
    userAnswers: z.record(z.string()).default({}),
  })
  .strict();

export type CheckpointPayload = z.infer<typeof CheckpointPayloadSchema>;

export async function saveCheckpoint(
  store: Store,
  input: { runId: string; state: string; round: number; payload: unknown },
): Promise<Checkpoint> {
  const cp: Checkpoint = {
    runId: input.runId,
    state: input.state,
    round: input.round,
    createdAt: new Date().toISOString(),
    payload: input.payload,
  };
  await store.saveCheckpoint(cp);
  return cp;
}

export interface RestoredRun {
  state: string;
  round: number;
  payload: CheckpointPayload;
  createdAt: string;
}

/** 恢复最近检查点；载荷不符合 Schema 时返回 undefined（防御式恢复）。 */
export async function restoreRun(store: Store, runId: string): Promise<RestoredRun | undefined> {
  const cp = await store.latestCheckpoint(runId);
  if (!cp) return undefined;
  const parsed = CheckpointPayloadSchema.safeParse(cp.payload);
  if (!parsed.success) return undefined;
  return {
    state: cp.state,
    round: cp.round,
    payload: parsed.data,
    createdAt: cp.createdAt,
  };
}
